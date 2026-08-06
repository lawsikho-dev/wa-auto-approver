// WhatsApp group auto-approver for paid GrowthX community leads.
// - Groups are configured in a Google Sheet (CSV URL below) or FALLBACK_GROUPS.
// - Each WhatsApp group maps to its GrowthX funnel(s); only status=Paid leads
//   with amount MIN-MAX in the last DAYS_BACK days are approved.
// - Human-like behavior: jittered intervals, night pause (IST), delayed approvals.
// - Unpaid requests are left pending for manual review.

try { require('dotenv').config(); } catch { /* dotenv optional — env vars may be set directly */ }
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// ================== CONFIG ==================
const API_BASE = 'https://growthx.skillarbitra.ge/api/public/leads';

// MASTER SHEET ID — all config comes from Google Sheet tabs
// Update this to YOUR sheet ID
const MASTER_SHEET_ID = '1axEuQqoaGT6b5niI5lk_MHERyTVLDx9OjqjhVPEZOjk';

// Sheet tab URLs (gid = sheet tab ID)
const CONFIG_SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${MASTER_SHEET_ID}/export?format=csv&gid=2`; // "Config" tab
const GROUPS_SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${MASTER_SHEET_ID}/export?format=csv&gid=0`; // "Groups" tab
const ALTERNATE_NUMBERS_SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${MASTER_SHEET_ID}/export?format=csv&gid=1339372007`; // "Alternate_number_Requests" tab

// Default config (fallback if sheet doesn't load)
let config = {
  API_TOKEN: process.env.GROWTHX_API_KEY || 'Hubxev<pNl3sUu79', // Use env var or fallback
  MIN_AMOUNT: 100,
  MAX_AMOUNT: 300,
  DAYS_BACK: 14,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL || '',
  ROSTER_WEBHOOK_URL: process.env.ROSTER_WEBHOOK_URL || '',
};

// Shorthand to access current config values
const getConfig = (key) => config[key];

// Friendly sheet names -> exact GrowthX API group values
const API_GROUP_ALIASES = {
  'criminal': 'Criminal Litigation',
  'criminal litigation': 'Criminal Litigation',
  'women ai': 'AI for Women',
  'ai for women': 'AI for Women',
  'ai for legal': 'Legal AI',
  'legal ai': 'Legal AI',
  'm&a': 'MnA',
  'm & a': 'MnA',
  'mna': 'MnA',
  'sqe': 'SQE',
  'sqe 7 day': 'SQE',
  'arbitration': 'Arbitration',
  'contract drafting': 'Contract Drafting',
  'independent director': 'Independent Director',
  'id': 'Independent Director',
};

function canonicalApiGroup(name) {
  const k = String(name).trim().toLowerCase().replace(/\s+/g, ' ');
  return API_GROUP_ALIASES[k] || String(name).trim();
}

// Does an alternate-form record belong to this WhatsApp group?
// Form answers are messy composites like "63/CRIMINAL/LITIGATION",
// "10/M&A/Community/Apr/26", "33/AI For Women Program", or free text like
// "21 days contract drafting workshop". Match by (a) leading group number
// against the sheet's whatsapp Group number, then (b) cleaned text against
// the funnel aliases.
function altMatchesEntry(entry, altRec) {
  // Match ONLY on the form's Funnel name column (G), and only by its FUNNEL
  // TEXT — leading numbers are internal references and ignored (they collide
  // across funnels: SQE #5/#6 vs Arbitration #6/#5).
  // One cell may list SEVERAL funnels ("55/CRIMINAL/LITIGATION, 5/Arbitration/
  // community/2026") — approve if ANY listed funnel matches this group.
  const t = altRec.funnel;
  if (!t) return false;
  const entryCanons = entry.apiGroups.map((gf) => canonicalApiGroup(gf));
  const keys = Object.keys(API_GROUP_ALIASES).sort((a, b) => b.length - a.length);
  for (const part of String(t).split(/[,;&+]/)) {
    const cleaned = part.toLowerCase()
      .replace(/[\/\-_:.]+/g, ' ')
      .replace(/\b(community|program|workshop|days?|lawsikho|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d+)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    const direct = API_GROUP_ALIASES[cleaned];
    if (direct && entryCanons.includes(direct)) return true;
    // Check EVERY alias appearing in this part (not just the first found).
    for (const k of keys) {
      if (new RegExp(`(^| )${k}( |$)`).test(cleaned) && entryCanons.includes(API_GROUP_ALIASES[k])) return true;
    }
  }
  return false;
}

const FALLBACK_GROUPS = [
  { label: 'ID 76',             inviteLink: 'https://chat.whatsapp.com/D2UdMmSHy4x3TrDMQVRFu5', apiGroups: ['Independent Director'] },
  { label: 'Contract Drafting', inviteLink: 'https://chat.whatsapp.com/HSGGdhy8KYL7IJpSsEsfuf', apiGroups: ['Contract Drafting'] },
  { label: 'Criminal 63',       inviteLink: 'https://chat.whatsapp.com/GNoZXzBaNrzHKNPkq2N6hx', apiGroups: ['Criminal Litigation'] },
  { label: 'Women AI 33',       inviteLink: 'https://chat.whatsapp.com/JMtnfp3iFhEDZx3TqSNFYx', apiGroups: ['AI for Women'] },
  { label: 'AI for Legal 11',   inviteLink: 'https://chat.whatsapp.com/HYe9QW1DvTiK0zCkVZl03N', apiGroups: ['Legal AI'] },
  { label: 'MnA 10',            inviteLink: 'https://chat.whatsapp.com/E2uDiOo9fBi2cn80kuw4V3', apiGroups: ['MnA'] },
  { label: 'SQE 6',             inviteLink: 'https://chat.whatsapp.com/B9KbqL4OWKT3nW6dhVNiRO', apiGroups: ['SQE'] },
  { label: 'Arbitration 5',     inviteLink: 'https://chat.whatsapp.com/GC9YAFTr8AK5YTCEcfvwN5', apiGroups: ['Arbitration'] },
];

const DRY_RUN = false;

// Human-like pacing
const CHECK_MIN_MINUTES = 3,  CHECK_MAX_MINUTES = 7;    // pending-request sweep
const REFRESH_MIN_MINUTES = 12, REFRESH_MAX_MINUTES = 18; // sheet + paid-list refresh
const APPROVE_DELAY_MIN_S = 20, APPROVE_DELAY_MAX_S = 90; // pause before approving a batch
const NIGHT_START_HOUR = 23, NIGHT_END_HOUR = 7;          // IST quiet hours

// Fresh-payer check: someone who paid minutes ago isn't in the cached list yet.
// For requests newer than this, do a targeted 2-day API lookup before rejecting.
const FRESH_REQUEST_MAX_AGE_MIN = 90;
const FRESH_CHECK_COOLDOWN_MIN = 20;   // don't re-query the same number more often

// Daily summary sent to this number on WhatsApp ('' = the linked account itself).
const SUMMARY_TO_NUMBER = '';
const SUMMARY_HOUR_IST = 21;

// Member roster audit: every current group member tallied against payment records.
const ROSTER_HOURS_IST = [10, 19];     // runs once per listed hour, per day
const ROSTER_DAYS_BACK = 90;           // wider window — members may have paid months ago
// Apps Script web-app URL that appends rows to your sheet (see roster-appscript.gs).
// One URL handles everything: logs, approvals, alternate approvals, roster.
const ROSTER_WEBHOOK_URL = process.env.SHEET_WEBHOOK_URL || '';

const LOG_FILE = path.join(__dirname, 'approvals.log');
const STATUS_FILE = path.join(__dirname, 'status.json');   // heartbeat for watchdog.js
const PAID_CACHE_FILE = path.join(__dirname, 'paid-cache.json');
const LID_CACHE_FILE = path.join(__dirname, 'lid-cache.json'); // member id -> phone, reused across runs
const ROSTER_DIR = path.join(__dirname, 'rosters');
// ============================================

let watched = [];        // active group entries (state carried across refreshes)
let nightLogged = false;
const freshCheckedAt = new Map();  // "label|phone" -> ms of last targeted lookup
let stats = { date: '', approved: 0, pending: 0, names: [] };
// Persist daily stats so restarts don't reset the day's approved counter.
const STATS_FILE = path.join(__dirname, 'stats.json');
try {
  const savedStats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  const todayIstStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (savedStats && savedStats.date === todayIstStr) stats = savedStats;
} catch { /* first run */ }
let alternateNumbers = new Map();  // alternate_phone -> {original_phone, name, group, funnel}
// "label|phone|date" — pending rows already sent to the sheet today.
// Persisted to disk so bot restarts don't re-post the same people (which
// created duplicate Pending rows and caused double AiSensy messages).
const PENDING_REPORTED_FILE = path.join(__dirname, 'pending-reported.json');
const pendingReported = new Set();
try {
  for (const k of JSON.parse(fs.readFileSync(PENDING_REPORTED_FILE, 'utf8'))) pendingReported.add(k);
} catch { /* first run — file absent */ }
function savePendingReported() {
  try { fs.writeFileSync(PENDING_REPORTED_FILE, JSON.stringify([...pendingReported])); } catch {}
}

// ---- Google Sheet logging ----
// Every log line is buffered and flushed to the Apps Script webhook once a
// minute, so the sheet is the primary log store (local file kept as backup).
const sheetLogBuffer = [];

async function postToSheet(payload) {
  if (!ROSTER_WEBHOOK_URL) return;
  try {
    await fetch(ROSTER_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });
  } catch (e) {
    console.log(`(sheet webhook post failed: ${e.message})`);
  }
}

setInterval(() => {
  if (sheetLogBuffer.length === 0) return;
  const lines = sheetLogBuffer.splice(0, sheetLogBuffer.length);
  postToSheet({ type: 'logs', lines });
}, 60 * 1000);

function log(msg) {
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  sheetLogBuffer.push([ts, msg]);
}

function istNow() {
  // "2026-08-05, 14:29:00 IST" — readable Indian time for all sheet rows
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST';
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function fmtDate(d) { return d.toISOString().slice(0, 10); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

function istHour() {
  return parseInt(new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }), 10);
}

function isNight() {
  const h = istHour();
  return NIGHT_START_HOUR > NIGHT_END_HOUR
    ? (h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR)
    : (h >= NIGHT_START_HOUR && h < NIGHT_END_HOUR);
}

function istDateStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Heartbeat for watchdog.js — written after every sweep and on session events
function writeStatus(extra = {}) {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      updatedAt: Date.now(),
      updatedAtIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      groups: watched.length,
      paidCounts: Object.fromEntries(watched.map((e) => [e.label, e.paidSet ? e.paidSet.size : 0])),
      night: isNight(),
      today: stats,
      ...extra,
    }, null, 2));
  } catch (e) { /* status file is best-effort */ }
}

// Persist paid lists so a restart starts warm and a failed refresh can't empty them
function savePaidCache() {
  try {
    const dump = watched.map((e) => ({
      inviteLink: e.inviteLink,
      phones: e.paidSet ? [...e.paidSet] : [],
      info: e.paidInfo || {},
    }));
    fs.writeFileSync(PAID_CACHE_FILE, JSON.stringify(dump));
  } catch (e) { log(`Could not save paid cache: ${e.message}`); }
}

function loadPaidCache() {
  try {
    if (!fs.existsSync(PAID_CACHE_FILE)) return;
    const dump = JSON.parse(fs.readFileSync(PAID_CACHE_FILE, 'utf8'));
    const byLink = new Map(dump.map((d) => [d.inviteLink, d]));
    let restored = 0;
    for (const entry of watched) {
      const d = byLink.get(entry.inviteLink);
      if (d && d.phones.length) {
        entry.paidSet = new Set(d.phones);
        entry.paidInfo = d.info || {};
        restored += d.phones.length;
      }
    }
    if (restored) log(`Warm start: restored ${restored} cached paid numbers from disk.`);
  } catch (e) { log(`Could not load paid cache: ${e.message}`); }
}

// GET with one retry on rate-limit / transient failure
async function apiGet(url, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const token = config.API_TOKEN || getConfig('API_TOKEN');
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (resp.ok) return await resp.json();
      if (resp.status === 429 && attempt === 1) {
        log(`[${label}] API 429 — retrying in 20s`);
        await sleep(20000);
        continue;
      }
      log(`[${label}] API error ${resp.status}`);
      return null;
    } catch (e) {
      if (attempt === 1) { await sleep(5000); continue; }
      log(`[${label}] API fetch failed: ${e.message}`);
      return null;
    }
  }
  return null;
}

// Targeted lookup for someone whose payment may not be in the cached list yet.
// Scoped to the day they requested to join (payment normally precedes the request
// by hours or a day or two), which also covers requests older than the cache window.
async function lookupRecentPayment(entry, phone, requestUnixTime) {
  const key = `${entry.label}|${phone}`;
  const last = freshCheckedAt.get(key) || 0;
  if (Date.now() - last < FRESH_CHECK_COOLDOWN_MIN * 60 * 1000) return null;
  freshCheckedAt.set(key, Date.now());

  const anchor = requestUnixTime ? new Date(requestUnixTime * 1000) : new Date();
  const from = new Date(anchor); from.setDate(from.getDate() - 3);
  const to = new Date(anchor);   to.setDate(to.getDate() + 1);
  const today = new Date();
  if (to > today) to.setTime(today.getTime());
  const url = `${API_BASE}?from=${fmtDate(from)}&to=${fmtDate(to)}&group=${encodeURIComponent(entry.apiGroups.join(','))}`;
  const data = await apiGet(url, entry.label);
  if (!data) return null;

  for (const l of data.leads || []) {
    const amt = parseFloat(l.amount);
    if (l.status === 'Paid' && amt >= config.MIN_AMOUNT && amt <= config.MAX_AMOUNT && normalizePhone(l.whatsapp) === phone) {
      const info = { name: l.name, amount: l.amount, group: l.group };
      if (!entry.paidSet) { entry.paidSet = new Set(); entry.paidInfo = {}; }
      entry.paidSet.add(phone);
      entry.paidInfo[phone] = info;
      return info;
    }
  }
  return null;
}

// ---- Name-based fallback (paid with a different number, no form filled) ----
// If the requester's number has no payment, compare their WhatsApp profile name
// against paid leads in this group's funnel from the last 2 days. Requires an
// exact, UNIQUE full-name match. Each paid record can only ever approve one
// requester this way (tracked in name-approvals.json) so one payment can't
// admit multiple numbers. Every such approval is recorded in
// alternate-approvals.csv for audit.
const NAME_APPROVALS_FILE = path.join(__dirname, 'name-approvals.json');
const ALT_APPROVALS_CSV = path.join(__dirname, 'alternate-approvals.csv');
let usedPaidForName = {};
try { usedPaidForName = JSON.parse(fs.readFileSync(NAME_APPROVALS_FILE, 'utf8')); } catch {}

function recordAltApproval(rec) {
  const row = [istNow(), rec.group, rec.requesterPhone, rec.name, rec.paidPhone, rec.amount, rec.funnel, rec.method];
  const header = 'timestamp,group,requester_phone,matched_name,paid_phone,amount,funnel,method\n';
  try {
    if (!fs.existsSync(ALT_APPROVALS_CSV)) fs.writeFileSync(ALT_APPROVALS_CSV, header);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    fs.appendFileSync(ALT_APPROVALS_CSV, row.map(esc).join(',') + '\n');
  } catch {}
  postToSheet({ type: 'alt_approval', row });
}

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

async function lookupByName(client, entry, req, phone) {
  const key = `name|${entry.label}|${phone}`;
  const last = freshCheckedAt.get(key) || 0;
  if (Date.now() - last < FRESH_CHECK_COOLDOWN_MIN * 60 * 1000) return null;
  freshCheckedAt.set(key, Date.now());

  let waName = '';
  try {
    const contact = await client.getContactById(req.id._serialized);
    waName = normName(contact && (contact.pushname || contact.name || contact.verifiedName));
  } catch { /* contact not fetchable — skip */ }
  // Single-word names are too risky for identity matching — require full name.
  if (!waName || waName.split(' ').length < 2) return null;

  const anchor = req.t ? new Date(req.t * 1000) : new Date();
  const from = new Date(anchor); from.setDate(from.getDate() - 1);
  const to = new Date();
  const url = `${API_BASE}?from=${fmtDate(from)}&to=${fmtDate(to)}&group=${encodeURIComponent(entry.apiGroups.join(','))}`;
  const data = await apiGet(url, entry.label);
  if (!data) return null;

  const matches = [];
  for (const l of data.leads || []) {
    const amt = parseFloat(l.amount);
    if (l.status === 'Paid' && amt >= config.MIN_AMOUNT && amt <= config.MAX_AMOUNT && normName(l.name) === waName) {
      matches.push(l);
    }
  }
  if (matches.length !== 1) {
    if (matches.length > 1) log(`[${entry.label}] Name "${waName}" matches ${matches.length} paid leads — ambiguous, leaving pending`);
    return null;
  }
  const lead = matches[0];
  const paidPhone = normalizePhone(lead.whatsapp);
  // If the paid number is the requester itself, the phone check would have caught it.
  if (usedPaidForName[paidPhone] && usedPaidForName[paidPhone] !== phone) {
    log(`[${entry.label}] Name match for ${phone} → paid record ${paidPhone} already used to approve ${usedPaidForName[paidPhone]} — skipping`);
    return null;
  }
  usedPaidForName[paidPhone] = phone;
  try { fs.writeFileSync(NAME_APPROVALS_FILE, JSON.stringify(usedPaidForName, null, 2)); } catch {}
  recordAltApproval({ group: entry.label, requesterPhone: phone, name: lead.name, paidPhone, amount: lead.amount, funnel: lead.group, method: 'name-match' });
  log(`[${entry.label}] NAME MATCH: requester ${phone} = "${lead.name}" who paid via different number ${paidPhone} (₹${lead.amount})`);
  return { name: lead.name, amount: `${lead.amount} (via alt# ${paidPhone})`, group: lead.group };
}

// Minimal CSV parser (handles quoted fields with commas)
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Sync configuration from "Config" sheet tab (key-value pairs)
// Format: Column A = Key, Column B = Value
// Keys: GROWTHX_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ALERT_WEBHOOK_URL, ROSTER_WEBHOOK_URL, etc.
async function syncConfigSheet() {
  try {
    const resp = await fetch(CONFIG_SHEET_CSV_URL, { redirect: 'follow' });
    if (!resp.ok) {
      log(`Config sheet fetch error ${resp.status} — using existing config`);
      return;
    }
    const rows = parseCsv(await resp.text());
    let updated = 0;
    rows.slice(1).forEach((r) => {
      if (r.length >= 2) {
        const key = String(r[0] || '').trim();
        const value = String(r[1] || '').trim();
        if (key && value && config.hasOwnProperty(key)) {
          config[key] = value;
          updated++;
        }
      }
    });
    if (updated > 0) log(`Config sheet synced: ${updated} values loaded`);
  } catch (e) {
    log(`Config sheet sync failed: ${e.message}`);
  }
}

// Load desired group list from the sheet (or fallback), merge into `watched`
// keeping resolved groupIds and paid lists for unchanged entries.
async function syncAlternateNumbers() {
  const newMap = new Map();
  if (!ALTERNATE_NUMBERS_SHEET_CSV_URL) return;
  try {
    const resp = await fetch(ALTERNATE_NUMBERS_SHEET_CSV_URL, { redirect: 'follow' });
    if (!resp.ok) {
      log(`Alternate numbers sheet fetch error ${resp.status}`);
      return;
    }
    const rows = parseCsv(await resp.text());
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const findCol = (...terms) => header.findIndex((h) => terms.some((t) => h.includes(t)));
    const tsCol = findCol('timestamp');
    const altCol = findCol('alternate');
    const origCol = findCol('used in payment') ? header.findIndex((h) => h.includes('used in payment') && h.includes('mobile')) : -1;
    const nameCol = findCol('name');
    const groupCol = findCol('group');
    const funnelCol = findCol('funnel');

    if (altCol === -1 || origCol === -1 || funnelCol === -1) {
      log(`Alternate sheet missing a required column (alternate=${altCol}, original=${origCol}, funnel=${funnelCol})`);
      return;
    }

    // Form timestamps are dd/mm/yyyy (e.g. "04/08/2026 20:15:33"). Index the
    // current and previous month so month-boundary requests still match.
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const fmtMY = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    const prev = new Date(now); prev.setMonth(prev.getMonth() - 1);
    const allowedMonths = [fmtMY(now), fmtMY(prev)];
    rows.slice(1).forEach((r) => {
      if (tsCol >= 0) {
        const m = String(r[tsCol] || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // dd/mm/yyyy
        if (m && !allowedMonths.includes(`${m[2].padStart(2, '0')}/${m[3]}`)) return; // skip old entries
      }
      const alt = normalizePhone(r[altCol]);
      const orig = normalizePhone(r[origCol]);
      const funnel = (r[funnelCol] || '').trim();
      const group = (r[groupCol] || '').trim();
      // HARD RULE: the Funnel name column (G) must be filled — rows with a
      // blank funnel are never used for approval.
      // One number can file MULTIPLE forms (e.g. for two different groups) —
      // keep every entry, not just the newest.
      if (alt && orig && funnel) {
        if (!newMap.has(alt)) newMap.set(alt, []);
        newMap.get(alt).push({
          original_phone: orig,
          name: (r[nameCol] || '').trim(),
          group: group,
          funnel: funnel,
        });
      }
    });

    if (newMap.size > 0) {
      const countRecs = (m) => [...m.values()].reduce((n, v) => n + v.length, 0);
      const changed = countRecs(newMap) !== countRecs(alternateNumbers);
      alternateNumbers = newMap;
      // The 60s watcher calls this every minute — only log when something changed.
      if (changed) log(`Alternate numbers sheet (${allowedMonths.join(' + ')}): ${newMap.size} alternate→original mappings loaded`);
    }
  } catch (e) {
    log(`Alternate numbers sheet fetch failed: ${e.message}`);
  }
}

async function syncConfig() {
  let desired = FALLBACK_GROUPS;
  if (GROUPS_SHEET_CSV_URL) {
    try {
      const resp = await fetch(GROUPS_SHEET_CSV_URL, { redirect: 'follow' });
      if (resp.ok) {
        const rows = parseCsv(await resp.text());
        const header = rows[0].map((h) => h.trim().toLowerCase());
        const findCol = (...terms) => header.findIndex((h) => terms.some((t) => h.includes(t)));
        const groupCol = findCol('group');
        const linkCol = findCol('invite', 'link');
        const labelCol = findCol('label');
        const activeCol = findCol('active');
        const numCol = findCol('number'); // "whatsapp Group number" column
        if (groupCol === -1 || linkCol === -1) {
          log('Sheet missing a group or invite-link column — using fallback config');
          return;
        }
        const parsed = rows.slice(1)
          .filter((r) => (r[linkCol] || '').includes('chat.whatsapp.com'))
          .filter((r) => activeCol === -1 || /^y/i.test((r[activeCol] || 'yes').trim() || 'yes'))
          .map((r) => ({
            label: ((labelCol !== -1 && r[labelCol]) || r[groupCol] || '').trim(),
            inviteLink: r[linkCol].trim(),
            apiGroups: (r[groupCol] || '').split(',').map(canonicalApiGroup).filter(Boolean),
            groupNumber: numCol !== -1 ? String(r[numCol] || '').trim() : '',
          }))
          .filter((e) => e.apiGroups.length);
        if (parsed.length) desired = parsed;
        else log('Sheet loaded but no valid active rows — using fallback config');
      } else {
        log(`Sheet fetch error ${resp.status} — keeping current config`);
        return;
      }
    } catch (e) {
      log(`Sheet fetch failed: ${e.message} — keeping current config`);
      return;
    }
  }

  const prev = new Map(watched.map((e) => [e.inviteLink, e]));
  watched = desired.map((d) => {
    const old = prev.get(d.inviteLink);
    return old ? Object.assign(old, { label: d.label, apiGroups: d.apiGroups, groupNumber: d.groupNumber }) : { ...d };
  });
}

async function resolveGroups(client) {
  for (const entry of watched) {
    if (entry.groupId || !entry.inviteLink) continue;
    const code = String(entry.inviteLink).split('chat.whatsapp.com/')[1];
    if (!code) { log(`[${entry.label}] Could not parse invite link`); continue; }
    try {
      const info = await client.getInviteInfo(code.replace(/[/?#].*$/, ''));
      entry.groupId = info.id._serialized || `${info.id.user}@g.us`;
      entry.groupName = info.subject || '';
      log(`[${entry.label}] Resolved "${info.subject}" -> ${entry.groupId}`);
    } catch (e) {
      log(`[${entry.label}] Failed to resolve invite link: ${e.message}`);
    }
  }
}

async function refreshPaidListFor(entry, opts = {}) {
  // opts.days: window size (default full DAYS_BACK); opts.mergeOnly: add-only,
  // never replace the list (used by the frequent 2-day refresh).
  const days = opts.days || config.DAYS_BACK;
  const newSet = new Set();
  const newInfo = {};
  const today = new Date();
  const groupFilter = encodeURIComponent(entry.apiGroups.join(','));

  let chunksOk = 0, chunksTotal = 0;
  for (let start = days; start > 0; start -= 7) {
    chunksTotal++;
    const from = new Date(today); from.setDate(from.getDate() - start);
    const to = new Date(today);   to.setDate(to.getDate() - Math.max(start - 7, 0));
    const url = `${API_BASE}?from=${fmtDate(from)}&to=${fmtDate(to)}&group=${groupFilter}`;
    {
      const data = await apiGet(url, entry.label);
      if (!data) continue;
      chunksOk++;
      for (const l of data.leads || []) {
        const amt = parseFloat(l.amount);
        // HARD RULE: only successful payments count — never Form only/Expired/Failed
        if (l.status === 'Paid' && amt >= config.MIN_AMOUNT && amt <= config.MAX_AMOUNT) {
          const phone = normalizePhone(l.whatsapp);
          if (phone) {
            newSet.add(phone);
            newInfo[phone] = { name: l.name, amount: l.amount, group: l.group };
          }
        }
      }
    }
  }

  if (newSet.size === 0) {
    if (!opts.mergeOnly) log(`[${entry.label}] Paid list refresh returned 0 rows — keeping previous list (${entry.paidSet ? entry.paidSet.size : 0})`);
    return;
  }

  if (opts.mergeOnly) {
    // Frequent short-window refresh: only ever ADD numbers.
    if (!entry.paidSet) { entry.paidSet = new Set(); entry.paidInfo = {}; }
    let added = 0;
    for (const p of newSet) { if (!entry.paidSet.has(p)) { entry.paidSet.add(p); added++; } }
    Object.assign(entry.paidInfo, newInfo);
    if (added > 0) log(`[${entry.label}] Quick paid refresh: +${added} new (last ${days} days; total ${entry.paidSet.size})`);
    return;
  }

  if (chunksOk === chunksTotal) {
    entry.paidSet = newSet;
    entry.paidInfo = newInfo;
    log(`[${entry.label}] Paid list refreshed: ${newSet.size} paid numbers (${entry.apiGroups.join(', ')}; ₹${config.MIN_AMOUNT}-${config.MAX_AMOUNT}; last ${days} days)`);
  } else {
    // Partial pull (a chunk errored) — merge instead of replacing, so a transient
    // API failure can never shrink the allowlist.
    if (!entry.paidSet) { entry.paidSet = new Set(); entry.paidInfo = {}; }
    for (const p of newSet) entry.paidSet.add(p);
    Object.assign(entry.paidInfo, newInfo);
    log(`[${entry.label}] Partial refresh (${chunksOk}/${chunksTotal} chunks) — merged, now ${entry.paidSet.size} paid numbers`);
  }
}

// Fast same-day + yesterday pull for one group. Most join requests come from
// people who paid today or yesterday, so this small 2-day fetch runs right
// before processing a group's pending requests — new payments land in the
// allowlist immediately instead of waiting for the next full 14-day refresh.
// Rate-limit protection: at most one pull per funnel per 10 minutes (twin
// groups share the funnel's paid list, so one pull covers them all). Truly
// fresh payers are still caught by the per-person targeted lookup.
const QUICK_REFRESH_COOLDOWN_MIN = 10;
const quickRefreshedAt = new Map(); // funnel key -> ms of last pull
async function quickRefreshRecent(entry) {
  const funnelKey = entry.apiGroups.join(',');
  const lastPull = quickRefreshedAt.get(funnelKey) || 0;
  if (Date.now() - lastPull < QUICK_REFRESH_COOLDOWN_MIN * 60 * 1000) return;
  quickRefreshedAt.set(funnelKey, Date.now());
  const today = new Date();
  const from = new Date(today); from.setDate(from.getDate() - 1); // yesterday
  const url = `${API_BASE}?from=${fmtDate(from)}&to=${fmtDate(today)}&group=${encodeURIComponent(entry.apiGroups.join(','))}`;
  const data = await apiGet(url, entry.label);
  if (!data) return;
  if (!entry.paidSet) { entry.paidSet = new Set(); entry.paidInfo = {}; }
  let added = 0;
  for (const l of data.leads || []) {
    const amt = parseFloat(l.amount);
    if (l.status === 'Paid' && amt >= config.MIN_AMOUNT && amt <= config.MAX_AMOUNT) {
      const phone = normalizePhone(l.whatsapp);
      if (phone && !entry.paidSet.has(phone)) {
        entry.paidSet.add(phone);
        entry.paidInfo[phone] = { name: l.name, amount: l.amount, group: l.group };
        added++;
      }
    }
  }
  if (added > 0) log(`[${entry.label}] Quick refresh: ${added} new paid number(s) from today/yesterday`);
}

async function checkAndApprove(client) {
  // Refresh the alternate-number form on every sweep — pending learners get
  // our AiSensy nudge and fill the form; this approves them within one sweep
  // (3-7 min) instead of waiting for the 12-18 min config refresh. It is a
  // single lightweight Google CSV fetch, no GrowthX API cost.
  try { await syncAlternateNumbers(); } catch { /* keep last known map */ }

  const approvedNames = [];
  let stillPending = 0;

  for (const entry of watched) {
    if (!entry.groupId) continue;
    try {
      const requests = await client.getGroupMembershipRequests(entry.groupId);
      if (!requests || requests.length === 0) continue;
      log(`[${entry.label}] Pending requests: ${requests.length}`);

      // Priority order: same-day/yesterday payments first (fetched fresh here),
      // then alternate-number match, then targeted lookup, then 14-day cache.
      await quickRefreshRecent(entry);

      const toApprove = [];
      for (const req of requests) {
        let phone = '';
        const wid = req.id._serialized || '';
        if (wid.endsWith('@c.us')) {
          phone = normalizePhone(req.id.user);
        } else {
          try {
            const res = await client.pupPage.evaluate(async (uid) => {
              try { return await window.WWebJS.enforceLidAndPnRetrieval(uid); }
              catch (e) { return { err: e.message }; }
            }, wid);
            if (res && res.phone) {
              phone = normalizePhone(res.phone.user || res.phone._serialized || String(res.phone));
            } else if (res && res.err) {
              log(`[${entry.label}] LID resolution error for ${wid}: ${res.err}`);
            }
          } catch (e) {
            log(`[${entry.label}] Could not resolve ${wid} to a number: ${e.message}`);
          }
        }

        let method = 'number-match';
        let info = phone && entry.paidSet && entry.paidSet.has(phone) ? entry.paidInfo[phone] : null;

        // Check if they paid with a different number (alternate number override).
        // A number may have several form entries (different groups) — approve
        // if ANY of them matches this group's funnel.
        if (!info && phone) {
          const altRecs = alternateNumbers.get(phone);
          if (altRecs && altRecs.length) {
            const altRec = altRecs.find((r) => altMatchesEntry(entry, r));
            if (altRec) {
              info = { name: altRec.name, amount: '(paid via alt#)', group: altRec.group };
              method = 'alternate-number-form';
              recordAltApproval({ group: entry.label, requesterPhone: phone, name: altRec.name, paidPhone: altRec.original_phone, amount: '', funnel: altRec.funnel || altRec.group, method: 'alt-sheet' });
              log(`[${entry.label}] Alternate number found for ${phone} (original: ${altRec.original_phone}, form: ${altRec.funnel || altRec.group})`);
            } else {
              log(`[${entry.label}] Alternate number ${phone} found but no form entry matches this group (forms: ${altRecs.map((r) => r.funnel).join(' | ')}, this group: #${entry.groupNumber} ${entry.apiGroups.join(', ')})`);
            }
          }
        }

        // Cache miss on a recent request: they may have paid minutes ago, before
        // the last list refresh. Do a targeted 2-day lookup before writing them off.
        if (!info && phone) {
          info = await lookupRecentPayment(entry, phone, req.t);
          if (info) { method = 'number-match'; log(`[${entry.label}] Payment found on targeted lookup for ${phone} (${info.name}, ₹${info.amount})`); }
        }

        // Last resort: paid under a different number and never filled the form?
        // Match the requester's WhatsApp profile name against the last 2 days of
        // paid leads in this group's funnel (exact, unique full-name match only).
        if (!info && phone) {
          info = await lookupByName(client, entry, req, phone);
          if (info) method = 'name-match-growthx';
        }

        const groupNo = entry.groupNumber || entry.groupName || '';
        if (info) {
          toApprove.push(req.id._serialized);
          approvedNames.push(info.name);
          postToSheet({ type: 'approval', row: [istNow(), entry.label, groupNo, info.name, phone || req.id.user, String(info.amount), info.group, method] });
          // If they were reported in the Pending tab earlier, mark that row APPROVED.
          postToSheet({ type: 'pending_resolve', phone: phone || req.id.user, group: entry.label, method });
          if (pendingReported.delete(`${entry.label}|${phone || req.id.user}`)) savePendingReported();
          log(`[${entry.label} #${groupNo}] ${DRY_RUN ? '[DRY RUN] WOULD APPROVE' : 'MATCHED PAID'} ${phone || req.id.user} — ${info.name} (₹${info.amount}, ${info.group}) [${method}]`);
        } else {
          stillPending++;
          // Report each pending person to the sheet once per day (sweeps repeat
          // every few minutes — without this the tab would fill with duplicates).
          const pKey = `${entry.label}|${phone || req.id.user}`;
          if (!pendingReported.has(pKey)) {
            pendingReported.add(pKey);
            savePendingReported();
            postToSheet({ type: 'pending', row: [istNow(), entry.label, groupNo, '', phone || req.id.user, '', '', 'no payment found (₹100-300)'] });
          }
          log(`[${entry.label} #${groupNo}] NOT PAID (leaving pending): ${phone || req.id.user}${phone ? '' : ' (number unresolved)'}`);
        }
      }

      if (toApprove.length > 0 && !DRY_RUN) {
        const delayS = Math.round(rand(APPROVE_DELAY_MIN_S, APPROVE_DELAY_MAX_S));
        log(`[${entry.label}] Waiting ${delayS}s before approving ${toApprove.length}...`);
        await sleep(delayS * 1000);
        await client.approveGroupMembershipRequests(entry.groupId, { requesterIds: toApprove });
        log(`[${entry.label}] Approved ${toApprove.length}/${requests.length} (${requests.length - toApprove.length} left pending)`);
      }
    } catch (e) {
      log(`[${entry.label}] Error checking ${entry.groupId}: ${e.message}`);
      // A detached frame never recovers — the page reloaded under us. Exit and let pm2 restart fresh.
      if (String(e.message).includes('detached Frame')) {
        log('Detached frame detected — restarting process for a clean session.');
        process.exit(1);
      }
    }
  }

  const today = istDateStr();
  if (stats.date !== today) stats = { date: today, approved: 0, pending: 0, names: [] };
  if (!DRY_RUN) {
    stats.approved += approvedNames.length;
    stats.names.push(...approvedNames);
  }
  stats.pending = stillPending;
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); } catch {}
  // Daily_Summary tab removed by user preference — the Approvals tab is the
  // source of truth for daily counts (filter by date).
  writeStatus({ lastSweepOk: true });
}

// ============ MEMBER ROSTER AUDIT ============
// Twice a day, list every current member of every watched group and tally them
// against payment records, so members who never paid are visible.
// (Still uses 90-day window since old members may have paid months ago)

let lidCache = {};
function loadLidCache() {
  try { if (fs.existsSync(LID_CACHE_FILE)) lidCache = JSON.parse(fs.readFileSync(LID_CACHE_FILE, 'utf8')); }
  catch (e) { lidCache = {}; }
}
function saveLidCache() {
  try { fs.writeFileSync(LID_CACHE_FILE, JSON.stringify(lidCache)); } catch (e) { /* best effort */ }
}

async function widToPhone(client, wid) {
  if (lidCache[wid]) return lidCache[wid];
  let phone = '';
  if (wid.endsWith('@c.us')) {
    phone = normalizePhone(wid.split('@')[0]);
  } else {
    try {
      const res = await client.pupPage.evaluate(async (uid) => {
        try { return await window.WWebJS.enforceLidAndPnRetrieval(uid); }
        catch (e) { return null; }
      }, wid);
      if (res && res.phone) phone = normalizePhone(res.phone.user || res.phone._serialized || String(res.phone));
    } catch (e) { /* leave unresolved */ }
  }
  if (phone) lidCache[wid] = phone;
  return phone;
}

// Wider payment history than the approval cache — members may have paid months ago
async function fetchPaymentHistory(entry) {
  const map = {};
  const today = new Date();
  for (let start = ROSTER_DAYS_BACK; start > 0; start -= 30) {
    const from = new Date(today); from.setDate(from.getDate() - start);
    const to = new Date(today);   to.setDate(to.getDate() - Math.max(start - 30, 0));
    const url = `${API_BASE}?from=${fmtDate(from)}&to=${fmtDate(to)}&group=${encodeURIComponent(entry.apiGroups.join(','))}`;
    const data = await apiGet(url, `${entry.label} roster`);
    if (!data) continue;
    for (const l of data.leads || []) {
      const phone = normalizePhone(l.whatsapp);
      if (!phone) continue;
      const amt = parseFloat(l.amount);
      const paid = l.status === 'Paid' && amt >= config.MIN_AMOUNT && amt <= config.MAX_AMOUNT;
      // A paid record always wins over an earlier form-only/failed record
      if (paid || !map[phone]) {
        map[phone] = { name: l.name || '', status: l.status, amount: l.amount || '', at: l.capturedAt || '', paid };
      }
    }
    await sleep(1500); // stay gentle on the API
  }
  return map;
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function buildRoster(client) {
  log(`Roster audit starting — ${watched.filter((e) => e.groupId).length} groups to scan...`);
  loadLidCache();
  const rows = [];
  const summary = [];

  for (const entry of watched) {
    if (!entry.groupId) continue;
    try {
      let chat = null, participants = [];
      try {
        // WhatsApp Web internals shift between versions — try several routes
        // and report which one produced the member list.
        const probe = await client.pupPage.evaluate(async (gid) => {
          // Mirrors whatsapp-web.js 1.34.7's own internal group access
          // (window.require modules — window.Store does not exist here).
          try {
            const widFactory = window.require('WAWebWidFactory');
            const groupWid = widFactory.createWid(gid);
            const collections = window.require('WAWebCollections');
            const chat = await collections.Chat.find(groupWid);
            if (!chat || !chat.groupMetadata) return { method: 'no-chat-or-meta', parts: [] };
            try { await window.require('WAWebGroupQueryJob').queryAndUpdateGroupMetadataById({ id: gid }); } catch (e) {}
            const meta = chat.groupMetadata.serialize();
            let toPn = null;
            try { toPn = window.require('WAWebLidMigrationUtils').toPn; } catch (e) {}
            const parts = (meta.participants || []).map(function (p) {
              let id = p.id;
              if (toPn) { try { id = toPn(p.id) || p.id; } catch (e) {} }
              const ser = (id && id._serialized) ? id._serialized : String(id);
              return { id: { _serialized: ser }, isAdmin: !!(p.isAdmin || p.isSuperAdmin) };
            });
            return { method: 'wawebcollections', parts: parts };
          } catch (e) { return { method: 'error: ' + e.message, parts: [] }; }
        }, entry.groupId);
        participants = probe.parts || [];
        try { chat = await client.getChatById(entry.groupId); } catch (e) { chat = null; }
        if (!participants.length) {
          log(`[${entry.label}] Members: 0 via ${probe.method}${probe.diag ? ' | diag ' + probe.diag : ''} — skipping`);
          continue;
        }
        log(`[${entry.label}] Members fetched: ${participants.length} via ${probe.method}`);
      } catch (e) {
        log(`[${entry.label}] Member fetch failed: ${e.message}`);
        continue;
      }

      const history = await fetchPaymentHistory(entry);
      let paidCount = 0, unpaidCount = 0, unknownCount = 0;

      for (const p of participants) {
        const wid = p.id ? (p.id._serialized || p.id) : String(p);
        const phone = await widToPhone(client, wid);
        const rec = phone ? history[phone] : null;
        let verdict;
        if (!phone) { verdict = 'UNRESOLVED'; unknownCount++; }
        else if (rec && rec.paid) { verdict = 'PAID'; paidCount++; }
        else if (rec) { verdict = `NOT PAID (${rec.status})`; unpaidCount++; }
        else { verdict = 'NO RECORD'; unpaidCount++; }

        rows.push([
          (chat && chat.name) || entry.label,
          entry.groupNumber || '',
          entry.inviteLink || '',
          entry.apiGroups.join(' / '),
          phone || wid,
          rec ? rec.name : '',
          verdict,
          rec ? rec.amount : '',
          rec ? rec.at : '',
          (p.isAdmin || p.isSuperAdmin) ? 'admin' : '',
        ]);
      }
      summary.push(`${(chat && chat.name) || entry.label}: ${participants.length} members — ${paidCount} paid, ${unpaidCount} not paid, ${unknownCount} unresolved`);
      log(`[${entry.label}] Roster: ${participants.length} members (${paidCount} paid, ${unpaidCount} not paid, ${unknownCount} unresolved)`);
    } catch (e) {
      log(`[${entry.label}] Roster error: ${e.message}`);
    }
  }

  saveLidCache();

  const header = ['group', 'group_no', 'invite_link', 'funnel', 'phone', 'name', 'payment_status', 'amount', 'paid_at', 'role'];
  const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).replace(/[: ]/g, '-').slice(0, 16);
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  try {
    fs.mkdirSync(ROSTER_DIR, { recursive: true });
    fs.writeFileSync(path.join(ROSTER_DIR, `roster-${stamp}.csv`), csv);
    fs.writeFileSync(path.join(ROSTER_DIR, 'roster-latest.csv'), csv);
  } catch (e) { log(`Could not write roster CSV: ${e.message}`); }

  const webhookUrl = config.ROSTER_WEBHOOK_URL || ROSTER_WEBHOOK_URL; // falls back to SHEET_WEBHOOK_URL
  if (webhookUrl) {
    try {
      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generatedAt: stamp, header, rows }),
      });
      log(resp.ok ? `Roster pushed to sheet (${rows.length} rows).` : `Roster webhook returned ${resp.status}`);
    } catch (e) { log(`Roster webhook failed: ${e.message}`); }
  } else {
    log(`Roster saved locally (${rows.length} rows) — add ROSTER_WEBHOOK_URL to Config sheet to push it to your sheet.`);
  }

  log(`Roster audit done. ${summary.join(' | ')}`);
  return { rows: rows.length, summary };
}

let lastRosterKey = '';
async function maybeRunRoster(client) {
  const h = istHour();
  if (!ROSTER_HOURS_IST.includes(h)) return;
  const key = `${istDateStr()}-${h}`;
  if (lastRosterKey === key) return;
  lastRosterKey = key;
  try { await buildRoster(client); } catch (e) { log(`Roster audit failed: ${e.message}`); }
}
// ============================================

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wa-session') }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

// Orphaned Chromium from a previous run holds the session lock and makes
// startup hang forever — clear them before launching our own browser.
try {
  require('child_process').execSync(`pkill -9 -f "${path.join(__dirname, '.wa-session')}"`, { stdio: 'ignore' });
} catch { /* none running — fine */ }

client.on('qr', (qr) => {
  console.log('\nScan this QR with the ADMIN number (WhatsApp > Linked Devices > Link a Device):\n');
  qrcode.generate(qr, { small: true });
  fs.writeFileSync(path.join(__dirname, 'latest-qr.txt'), qr);
  // Session is gone — approvals are stopped until a human scans. watchdog.js escalates this.
  writeStatus({ needsQrScan: true, lastSweepOk: false });
  log('SESSION LOST — waiting for QR scan. No approvals will happen until then.');
});

client.on('authenticated', () => writeStatus({ needsQrScan: false }));

// Daily summary to WhatsApp (the linked account itself unless SUMMARY_TO_NUMBER is set)
let lastSummaryDate = '';
async function maybeSendSummary(client) {
  const today = istDateStr();
  if (lastSummaryDate === today || istHour() !== SUMMARY_HOUR_IST) return;
  if (stats.date !== today) return;
  lastSummaryDate = today;
  try {
    const me = client.info && client.info.wid ? client.info.wid._serialized : null;
    const to = SUMMARY_TO_NUMBER ? `${SUMMARY_TO_NUMBER.replace(/\D/g, '')}@c.us` : me;
    if (!to) return;
    const lines = [
      `WA auto-approve — ${today}`,
      `Approved today: ${stats.approved}`,
      `Left pending (unpaid): ${stats.pending}`,
      `Groups watched: ${watched.length}`,
    ];
    await client.sendMessage(to, lines.join('\n'));
    log(`Daily summary sent (${stats.approved} approved, ${stats.pending} pending).`);
  } catch (e) {
    log(`Could not send daily summary: ${e.message}`);
  }
}

// Prevent two sweeps running at once (regular loop + fast alt-form watcher).
let sweeping = false;
async function safeSweep(client) {
  if (sweeping) return;
  sweeping = true;
  try { await checkAndApprove(client); }
  finally { sweeping = false; }
}

async function checkLoop(client) {
  if (isNight()) {
    if (!nightLogged) { log(`Night pause (IST ${NIGHT_START_HOUR}:00-${NIGHT_END_HOUR}:00) — no activity until morning.`); nightLogged = true; }
  } else {
    nightLogged = false;
    try { await safeSweep(client); } catch (e) { log(`Check sweep error: ${e.message}`); }
    await maybeSendSummary(client);
    await maybeRunRoster(client);
  }
  writeStatus();
  setTimeout(() => checkLoop(client), rand(CHECK_MIN_MINUTES, CHECK_MAX_MINUTES) * 60 * 1000);
}

// Fast alternate-form watcher: learners fill the form right after our AiSensy
// nudge, so poll the form every 60s and sweep IMMEDIATELY when a new entry
// appears — approval lands ~1-2 min after form submission instead of waiting
// for the next scheduled sweep. Cheap: one Google CSV fetch per minute.
let lastAltSignature = '';
const ROSTER_NOW_FILE = path.join(__dirname, 'roster-now.txt');
function startAltWatcher(client) {
  setInterval(async () => {
    if (isNight() || sweeping) return;
    // On-demand roster: `touch roster-now.txt` in the bot folder triggers a
    // fresh group-wise member list within a minute (written to the Roster tab).
    if (fs.existsSync(ROSTER_NOW_FILE)) {
      try { fs.unlinkSync(ROSTER_NOW_FILE); } catch {}
      log('On-demand roster requested — building group-wise member list...');
      try { await buildRoster(client); } catch (e) { log(`On-demand roster error: ${e.message}`); }
      return;
    }
    try {
      await syncAlternateNumbers();
      const sig = [...alternateNumbers.entries()].map(([k, v]) => k + ':' + v.length).sort().join(',');
      if (lastAltSignature && sig !== lastAltSignature) {
        log('New alternate-form entry detected — running immediate sweep.');
        await safeSweep(client);
      }
      lastAltSignature = sig;
    } catch { /* transient fetch issue — next minute retries */ }
  }, 60 * 1000);
}

// Refresh paid lists once per unique funnel-set — groups watching the same
// funnel (e.g. SQE 5 + SQE 6) share one API pull and one in-memory list,
// halving API calls and avoiding 429 rate limits.
async function refreshAllPaidLists(opts = {}) {
  const byFunnel = new Map();
  for (const entry of watched) {
    const key = entry.apiGroups.join(',');
    const src = byFunnel.get(key);
    if (src) {
      entry.paidSet = src.paidSet;
      entry.paidInfo = src.paidInfo;
    } else {
      await refreshPaidListFor(entry, opts);
      byFunnel.set(key, entry);
    }
  }
}

// Nearly all payers are from today/yesterday, so the frequent refresh only
// pulls a 2-day window (merge-only). The rare older payment (up to 14 days)
// is caught by a full deep refresh 3x a day at these IST hours.
const DEEP_REFRESH_HOURS = [7, 13, 19];
const doneDeepSlots = new Set(); // "2026-08-05|13"
function dueDeepSlot() {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  for (const h of DEEP_REFRESH_HOURS) {
    const key = `${istDateStr()}|${h}`;
    if (ist.getHours() >= h && !doneDeepSlots.has(key)) return key;
  }
  return null;
}

async function refreshLoop(client) {
  if (!isNight()) {
    try {
      await syncConfigSheet();    // Load credentials from Config sheet (GROWTHX_API_KEY, Telegram, etc.)
      await syncConfig();         // Load groups from Groups sheet
      await syncAlternateNumbers();
      await resolveGroups(client);
      const slot = dueDeepSlot();
      if (slot) {
        log(`Deep 14-day paid refresh (slot ${slot.split('|')[1]}:00 IST)...`);
        await refreshAllPaidLists(); // full window, replaces lists
        doneDeepSlots.add(slot);
      } else {
        await refreshAllPaidLists({ days: 2, mergeOnly: true }); // today+yesterday only
      }
      savePaidCache();
    } catch (e) { log(`Refresh error: ${e.message}`); }
  }
  writeStatus();
  setTimeout(() => refreshLoop(client), rand(REFRESH_MIN_MINUTES, REFRESH_MAX_MINUTES) * 60 * 1000);
}

let started = false;
client.on('ready', async () => {
  log(`WhatsApp client ready.${DRY_RUN ? ' (DRY RUN mode)' : ''}${GROUPS_SHEET_CSV_URL ? ' Config: Google Sheet' : ' Config: built-in list'}`);
  if (started) return; // 'ready' can re-fire on page reloads — don't stack duplicate loops
  started = true;
  await sleep(10000); // let the chat store finish loading

  await syncConfigSheet();     // Load all credentials from Config sheet
  await syncConfig();
  await syncAlternateNumbers();
  loadPaidCache();          // warm start — usable allowlist before the first API pull
  await resolveGroups(client);
  if (!isNight()) {
    await checkAndApprove(client);   // act on anything queued while we were down
  } else {
    log('Startup during night pause — no sweeps until 7:00 IST.');
  }
  await refreshAllPaidLists(); // full 14-day pull once at startup
  // Startup deep pull counts for all deep slots already passed today.
  let slot; while ((slot = dueDeepSlot())) doneDeepSlots.add(slot);
  savePaidCache();
  if (!isNight()) await checkAndApprove(client);

  if (process.env.ROSTER_NOW) {
    log('ROSTER_NOW set — running a one-off roster audit.');
    await buildRoster(client);
  }

  setTimeout(() => checkLoop(client), rand(CHECK_MIN_MINUTES, CHECK_MAX_MINUTES) * 60 * 1000);
  setTimeout(() => refreshLoop(client), rand(REFRESH_MIN_MINUTES, REFRESH_MAX_MINUTES) * 60 * 1000);
  startAltWatcher(client);
  log(`Live: ${watched.length} groups; sweeps every ${CHECK_MIN_MINUTES}-${CHECK_MAX_MINUTES} min (jittered), refresh every ${REFRESH_MIN_MINUTES}-${REFRESH_MAX_MINUTES} min, quiet ${NIGHT_START_HOUR}:00-${NIGHT_END_HOUR}:00 IST.`);
});

client.on('disconnected', (reason) => {
  log(`WhatsApp disconnected: ${reason}. Exiting — process manager will restart.`);
  process.exit(1);
});

client.initialize();
