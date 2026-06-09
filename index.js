const express = require('express');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');
const rateLimit = require('express-rate-limit');
const https = require('https');
const app = express();
app.set('trust proxy', 1); // Railway à¹à¸à¹ reverse proxy

// ===== CONFIG (à¹à¸ªà¹à¸à¹à¸²à¸à¸£à¸´à¸à¹à¸ .env) =====
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const ADMIN_USER_ID   = process.env.ADMIN_USER_ID;
const SPREADSHEET_ID  = process.env.SPREADSHEET_ID;
const LIFF_URL        = process.env.LIFF_URL;
const LIFF_CHANNEL_ID = process.env.LIFF_CHANNEL_ID;  // Channel ID (à¸à¸±à¸§à¹à¸¥à¸) à¸à¸²à¸ LINE Developers
const ADMIN_SECRET    = process.env.ADMIN_SECRET;      // à¸£à¸«à¸±à¸ªà¸¥à¸±à¸à¸ªà¸³à¸«à¸£à¸±à¸ Admin API

const client = new line.Client(config);

// ===== GOOGLE SHEETS AUTH =====
function getSheetClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// --- à¸­à¹à¸²à¸à¸à¹à¸­à¸¡à¸¹à¸¥ Sheet ---
async function readSheet(sheetName, range) {
  const sheets = getSheetClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!${range}`,
  });
  return res.data.values || [];
}

// --- à¹à¸à¸´à¹à¸¡à¹à¸à¸§à¹à¸«à¸¡à¹ ---
async function appendRow(sheetName, values) {
  const sheets = getSheetClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [values] },
  });
}

// --- à¸­à¸±à¸à¹à¸à¸à¹à¸à¸§à¸à¸²à¸¡ row index ---
async function updateRow(sheetName, rowIndex, values) {
  const sheets = getSheetClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [values] },
  });
}

// ===== HELPERS =====

// à¸ªà¸£à¹à¸²à¸ Order ID à¹à¸à¹à¸ BET250605001
function generateOrderId() {
  const d = new Date();
  const date = `${d.getFullYear().toString().slice(-2)}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const rand = String(Math.floor(Math.random() * 900) + 100);
  return `BET${date}${rand}`;
}

// DEFAULT RATES fallback
const DEFAULT_RATES = { r3_bon:500, r3_tode:100, r2_bon:70, r2_lang:70, rw_bon:3, rw_lang:4 };

// à¸à¸¶à¸à¸­à¸±à¸à¸£à¸²à¸à¹à¸²à¸¢à¸à¸¸à¸à¸à¸¥à¸¸à¹à¸¡à¸à¸²à¸ Sheet "rates_by_group"
// à¸à¸­à¸¥à¸±à¸¡à¸à¹: group, r3_bon, r3_tode, r2_bon, r2_lang, rw_bon, rw_lang
async function getAllGroupRates() {
  const rows = await readSheet('rates_by_group', 'A2:G10');
  const result = { normal:{...DEFAULT_RATES}, vip:{...DEFAULT_RATES}, agent:{...DEFAULT_RATES} };
  for (const r of rows) {
    const g = r[0];
    if (!result[g]) continue;
    result[g] = {
      r3_bon:  Number(r[1]) || DEFAULT_RATES.r3_bon,
      r3_tode: Number(r[2]) || DEFAULT_RATES.r3_tode,
      r2_bon:  Number(r[3]) || DEFAULT_RATES.r2_bon,
      r2_lang: Number(r[4]) || DEFAULT_RATES.r2_lang,
      rw_bon:  Number(r[5]) || DEFAULT_RATES.rw_bon,
      rw_lang: Number(r[6]) || DEFAULT_RATES.rw_lang,
    };
  }
  return result;
}

// à¸à¸¶à¸à¸­à¸±à¸à¸£à¸²à¸à¹à¸²à¸¢à¸à¸­à¸à¸à¸¥à¸¸à¹à¸¡à¸à¸µà¹à¸à¸³à¸«à¸à¸
async function getRatesByGroup(group = 'normal') {
  const all = await getAllGroupRates();
  return all[group] || all.normal;
}

// à¸à¸¶à¸ capital à¸à¸²à¸ Sheet "rates" (à¹à¸à¸§à¹à¸à¸´à¸¡)
async function getCapital() {
  const rows = await readSheet('rates', 'G2:G2');
  return Number(rows?.[0]?.[0]) || 50000;
}

// à¸à¸¶à¸à¸à¹à¸­à¸¡à¸¹à¸¥ user à¸à¸²à¸ Sheet "users"
// à¸à¸­à¸¥à¸±à¸¡à¸à¹: userId, displayName, group, discount
async function getUser(userId) {
  const rows = await readSheet('users', 'A2:D500');
  const row  = rows.find(r => r[0] === userId);
  if (!row) return null;
  return { userId: row[0], displayName: row[1], group: row[2] || 'normal', discount: Number(row[3]) || 0 };
}

// à¹à¸à¸´à¹à¸¡ / à¸­à¸±à¸à¹à¸à¸ user à¹à¸ Sheet "users"
async function upsertUser(userId, displayName, group = 'normal', discount = 0) {
  const rows = await readSheet('users', 'A2:D500');
  const idx  = rows.findIndex(r => r[0] === userId);
  if (idx < 0) {
    await appendRow('users', [userId, displayName, group, discount]);
  } else {
    const existing = rows[idx];
    await updateRow('users', idx + 2, [
      userId,
      displayName || existing[1],
      group !== undefined ? group : (existing[2] || 'normal'),
      discount !== undefined ? discount : (Number(existing[3]) || 0),
    ]);
  }
}

// getRates (global, à¹à¸à¹à¹à¸ risk calc â à¹à¸à¹à¸­à¸±à¸à¸£à¸² normal à¹à¸à¹à¸ base)
async function getRates() {
  const rates   = await getRatesByGroup('normal');
  const capital = await getCapital();
  return { ...rates, capital };
}

// à¸à¸¶à¸à¹à¸¥à¸à¸­à¸±à¹à¸à¸à¸²à¸ Sheet "blocked"
// à¸à¸­à¸¥à¸±à¸¡à¸à¹: à¹à¸¥à¸, à¸à¸£à¸°à¹à¸ à¸, à¸ªà¸à¸²à¸à¸°(closed/limit), à¸à¸³à¸à¸§à¸à¸à¸³à¸à¸±à¸
async function getBlocked() {
  const rows = await readSheet('blocked', 'A2:D100');
  return rows.map(r => ({
    num:    r[0] || '',
    type:   r[1] || 'à¸à¸±à¹à¸à¸«à¸¡à¸',
    status: r[2] || 'closed',   // closed | limit
    limit:  Number(r[3]) || 0,
  }));
}

// à¸à¸³à¸à¸§à¸ Risk à¸­à¸±à¸à¹à¸à¸¡à¸±à¸à¸´à¸à¸²à¸à¸¢à¸­à¸à¹à¸à¸à¸à¸±à¸à¸à¸¸à¸à¸±à¸
async function calcAutoBlocked(rates) {
  const rows = await readSheet('orders', 'A2:H1000');
  const capital = rates.capital;
  const warn    = capital * 0.2;

  // à¸£à¸§à¸¡à¸¢à¸­à¸à¹à¸à¸à¹à¸à¹à¸¥à¸°à¹à¸¥à¸+à¸à¸£à¸°à¹à¸ à¸
  const map = {};
  let totalBoard = 0;
  for (const r of rows) {
    if (r[7] === 'cancelled') continue;
    const num  = r[3]; // à¹à¸¥à¸
    const type = r[4]; // à¸à¸£à¸°à¹à¸ à¸
    const amt  = Number(r[5]) || 0;
    const key  = `${num}|${type}`;
    map[key] = (map[key] || 0) + amt;
    totalBoard += amt;
  }

  const autoBlocked = [];
  for (const [key, bet] of Object.entries(map)) {
    const [num, type] = key.split('|');
    let rate = rates.r2_bon;
    if (type === 'à¹à¸à¹à¸' && num.length === 3) rate = rates.r3_tode;
    else if (type === 'à¸à¸' && num.length === 3) rate = rates.r3_bon;
    else if (type === 'à¸à¸')    rate = rates.r2_bon;
    else if (type === 'à¸¥à¹à¸²à¸')  rate = rates.r2_lang;
    else if (type === 'à¸§à¸´à¹à¸à¸à¸')   rate = rates.rw_bon;
    else if (type === 'à¸§à¸´à¹à¸à¸¥à¹à¸²à¸') rate = rates.rw_lang;

    const maxPay  = bet * rate;
    const remaining = capital - maxPay + totalBoard;

    if (remaining < 0)    autoBlocked.push({ num, type, status: 'closed', remaining });
    else if (remaining < warn) autoBlocked.push({ num, type, status: 'limit', remaining });
  }
  return autoBlocked;
}

// ============================================================
// ===== SECURITY LAYER 1: RATE LIMITING =====
// ============================================================

// Global: 60 req/à¸à¸²à¸à¸µ à¸à¹à¸­ IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// /bet: 10 req/à¸à¸²à¸à¸µ à¸à¹à¸­ IP (à¸à¹à¸­à¸à¸à¸±à¸ spam order)
const betLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many bet requests.' },
});

// /config: 30 req/à¸à¸²à¸à¸µ à¸à¹à¸­ IP
const configLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many config requests.' },
});

// ============================================================
// ===== SECURITY LAYER 2: LINE ID TOKEN VERIFICATION =====
// ============================================================

// à¸à¸£à¸§à¸ idToken à¸à¸±à¸ LINE API â à¸¢à¸·à¸à¸¢à¸±à¸à¸§à¹à¸² request à¸¡à¸²à¸à¸²à¸ LINE à¸à¸£à¸´à¸
async function verifyLineToken(idToken) {
  return new Promise((resolve, reject) => {
    const body = `id_token=${encodeURIComponent(idToken)}&client_id=${encodeURIComponent(LIFF_CHANNEL_ID)}`;
    const options = {
      hostname: 'api.line.me',
      path: '/oauth2/v2.1/verify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error_description || 'invalid token'));
          resolve(json); // { sub: userId, name, ... }
        } catch { reject(new Error('parse error')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Middleware: à¸à¸£à¸§à¸ idToken à¸à¸²à¸ Header à¸«à¸£à¸·à¸­ Body
async function requireLineAuth(req, res, next) {
  const idToken = req.headers['x-line-id-token'] || req.body?.idToken;
  if (!idToken) {
    return res.status(401).json({ error: 'Missing LINE ID token' });
  }
  try {
    const profile = await verifyLineToken(idToken);
    req.lineUserId = profile.sub;
    req.lineDisplayName = profile.name;
    next();
  } catch (e) {
    console.warn('[AUTH] Invalid token:', e.message);
    return res.status(401).json({ error: 'Invalid LINE ID token' });
  }
}

// ============================================================
// ===== SECURITY LAYER 3: ADMIN SECRET KEY =====
// ============================================================

function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ============================================================
// ===== MIDDLEWARE =====
// ============================================================
// LINE webhook à¸à¹à¸­à¸à¹à¸à¹ raw body à¸à¹à¸­à¸ â à¸«à¹à¸²à¸¡à¹à¸«à¹ express.json() à¸­à¹à¸²à¸à¸à¹à¸­à¸
app.use('/webhook', line.middleware(config));
// Routes à¸­à¸·à¹à¸à¹ à¹à¸à¹ json parser (à¸¢à¸à¹à¸§à¹à¸ /webhook)
app.use((req, res, next) => {
  if (req.path === '/webhook') return next();
  express.json()(req, res, next);
});
app.use(globalLimiter);

// CORS à¸ªà¸³à¸«à¸£à¸±à¸ LIFF
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Line-Id-Token, X-Admin-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Logger
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} â IP:${ip}`);
  next();
});

// ===== API: GET /config?userId=xxx =====
// LIFF à¹à¸«à¸¥à¸à¸­à¸±à¸à¸£à¸²à¸à¹à¸²à¸¢à¹à¸à¸à¸²à¸°à¸à¸¥à¸¸à¹à¸¡ + à¸ªà¹à¸§à¸à¸¥à¸ + à¹à¸¥à¸à¸­à¸±à¹à¸
app.get('/config', configLimiter, requireLineAuth, async (req, res) => {
  try {
    const userId      = req.lineUserId;
    const displayName = req.lineDisplayName;

    // à¸à¸¶à¸à¸«à¸£à¸·à¸­à¸ªà¸£à¹à¸²à¸ user
    let user = null;
    if (userId) {
      user = await getUser(userId);
      if (!user) {
        await upsertUser(userId, displayName || 'à¸¥à¸¹à¸à¸à¹à¸²à¹à¸«à¸¡à¹');
        user = { userId, displayName, group: 'normal', discount: 0 };
      }
    }

    const group    = user?.group || 'normal';
    const discount = user?.discount || 0;
    const rates    = await getRatesByGroup(group);
    const capital  = await getCapital();
    const manual   = await getBlocked();
    const auto     = await calcAutoBlocked({ ...rates, capital });

    const blocked = [...manual];
    for (const a of auto) {
      const exists = manual.find(m => m.num === a.num && (m.type === a.type || m.type === 'à¸à¸±à¹à¸à¸«à¸¡à¸'));
      if (!exists) blocked.push(a);
    }

    res.json({ rates, blocked, group, discount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'config error' });
  }
});

// ===== ADMIN API: GET /admin/rates =====
app.get('/admin/rates', requireAdminKey, async (req, res) => {
  try {
    const all = await getAllGroupRates();
    const capital = await getCapital();
    res.json({ ...all, capital });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ADMIN API: POST /admin/rates =====
app.post('/admin/rates', requireAdminKey, async (req, res) => {
  try {
    const { normal, vip, agent, capital } = req.body;
    const sheets = getSheetClient();
    // à¹à¸à¸µà¸¢à¸à¸à¸±à¸ Sheet rates_by_group
    await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: 'rates_by_group!A2:G10' });
    const rows = [];
    for (const [g, r] of Object.entries({ normal, vip, agent })) {
      if (!r) continue;
      rows.push([g, r.r3_bon, r.r3_tode, r.r2_bon, r.r2_lang, r.rw_bon, r.rw_lang]);
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: 'rates_by_group!A2',
      valueInputOption: 'USER_ENTERED',
      resource: { values: rows },
    });
    // à¸­à¸±à¸à¹à¸à¸ capital à¹à¸ Sheet rates
    if (capital) await updateRow('rates', 2, [capital]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ADMIN API: GET /admin/users =====
app.get('/admin/users', requireAdminKey, async (req, res) => {
  try {
    const rows = await readSheet('users', 'A2:D500');
    const users = rows.map(r => ({
      userId:      r[0],
      displayName: r[1],
      group:       r[2] || 'normal',
      discount:    Number(r[3]) || 0,
    }));
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ADMIN API: POST /admin/users/:userId =====
app.post('/admin/users/:userId', requireAdminKey, async (req, res) => {
  try {
    const { userId } = req.params;
    const { group, discount } = req.body;
    const existing = await getUser(userId);
    await upsertUser(userId, existing?.displayName || '', group, discount);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== API: POST /bet/check =====
// à¸à¸£à¸§à¸à¸ªà¸­à¸à¹à¸¥à¸à¸­à¸±à¹à¸ â à¸à¸·à¸à¸à¸¥à¹à¸à¹à¹à¸¡à¹à¸à¸±à¸à¸à¸¶à¸à¸­à¸­à¹à¸à¸­à¸£à¹
app.post('/bet/check', betLimiter, requireLineAuth, async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: 'items required' });
    for (const item of items) {
      if (!item.num || !/^\d{1,3}$/.test(item.num))
        return res.status(400).json({ error: `invalid num: ${item.num}` });
      if (!item.type || !['à¸à¸','à¸¥à¹à¸²à¸','à¹à¸à¹à¸','à¸§à¸´à¹à¸à¸à¸','à¸§à¸´à¹à¸à¸¥à¹à¸²à¸'].includes(item.type))
        return res.status(400).json({ error: `invalid type: ${item.type}` });
      if (!item.amount || isNaN(item.amount) || Number(item.amount) <= 0)
        return res.status(400).json({ error: `invalid amount: ${item.amount}` });
      item.amount = Math.abs(Math.round(Number(item.amount)));
    }

    const rates   = await getRates();
    const manual  = await getBlocked();
    const auto    = await calcAutoBlocked(rates);
    const blocked = [...manual];
    for (const a of auto) {
      const exists = manual.find(m => m.num === a.num && (m.type === a.type || m.type === 'à¸à¸±à¹à¸à¸«à¸¡à¸'));
      if (!exists) blocked.push(a);
    }

    const blockedItems = [];
    const allowedItems = [];
    for (const item of items) {
      const hit = blocked.find(b =>
        b.num === item.num &&
        (b.type === item.type || b.type === 'à¸à¸±à¹à¸à¸«à¸¡à¸') &&
        b.status === 'closed'
      );
      const limitHit = blocked.find(b =>
        b.num === item.num &&
        (b.type === item.type || b.type === 'à¸à¸±à¹à¸à¸«à¸¡à¸') &&
        b.status === 'limit' &&
        item.amount > b.limit
      );
      if (hit)           blockedItems.push({ ...item, reason: 'à¸à¸´à¸à¸£à¸±à¸' });
      else if (limitHit) blockedItems.push({ ...item, reason: `à¹à¸à¸´à¸à¸à¸³à¸à¸±à¸ ${limitHit.limit} à¸à¸²à¸` });
      else               allowedItems.push(item);
    }

    res.json({ blockedItems, allowedItems });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'check error' });
  }
});

// ===== API: POST /bet =====
// à¸£à¸±à¸à¸­à¸­à¹à¸à¸­à¸£à¹à¸à¸²à¸ LIFF
app.post('/bet', betLimiter, requireLineAuth, async (req, res) => {
  try {
    const userId      = req.lineUserId;
    const displayName = req.lineDisplayName;
    const { items, memo } = req.body;

    // Validate input
    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: 'items required' });
    for (const item of items) {
      if (!item.num || !/^\d{1,3}$/.test(item.num))
        return res.status(400).json({ error: `invalid num: ${item.num}` });
      if (!item.type || !['à¸à¸','à¸¥à¹à¸²à¸','à¹à¸à¹à¸','à¸§à¸´à¹à¸à¸à¸','à¸§à¸´à¹à¸à¸¥à¹à¸²à¸'].includes(item.type))
        return res.status(400).json({ error: `invalid type: ${item.type}` });
      if (!item.amount || isNaN(item.amount) || Number(item.amount) <= 0)
        return res.status(400).json({ error: `invalid amount: ${item.amount}` });
      item.amount = Math.abs(Math.round(Number(item.amount)));
    }
    // items = [{ num, type, amount }]

    const rates   = await getRates();
    const manual  = await getBlocked();
    const auto    = await calcAutoBlocked(rates);
    const blocked = [...manual];
    for (const a of auto) {
      const exists = manual.find(m => m.num === a.num && (m.type === a.type || m.type === 'à¸à¸±à¹à¸à¸«à¸¡à¸'));
      if (!exists) blocked.push(a);
    }

    // à¹à¸¢à¸à¸£à¸²à¸¢à¸à¸²à¸£à¸à¸µà¹à¸­à¸±à¹à¸
    const blockedItems  = [];
    const allowedItems  = [];
    for (const item of items) {
      const hit = blocked.find(b =>
        b.num === item.num &&
        (b.type === item.type || b.type === 'à¸à¸±à¹à¸à¸«à¸¡à¸') &&
        b.status === 'closed'
      );
      const limitHit = blocked.find(b =>
        b.num === item.num &&
        (b.type === item.type || b.type === 'à¸à¸±à¹à¸à¸«à¸¡à¸') &&
        b.status === 'limit' &&
        item.amount > b.limit
      );
      if (hit)      blockedItems.push({ ...item, reason: 'closed' });
      else if (limitHit) blockedItems.push({ ...item, reason: `à¹à¸à¸´à¸à¸à¸³à¸à¸±à¸ ${limitHit.limit} à¸à¸²à¸` });
      else          allowedItems.push(item);
    }

    // à¸à¹à¸²à¸¡à¸µà¹à¸¥à¸à¸­à¸±à¹à¸ â à¸ªà¹à¸à¸à¸¥à¸±à¸à¹à¸«à¹ client à¸¢à¸·à¸à¸¢à¸±à¸
    if (blockedItems.length > 0) {
      return res.json({
        status:       'confirm_required',
        blockedItems,
        allowedItems,
        message:      'à¸¡à¸µà¹à¸¥à¸à¸­à¸±à¹à¸à¹à¸à¸£à¸²à¸¢à¸à¸²à¸£',
      });
    }

    // à¹à¸¡à¹à¸¡à¸µà¸­à¸±à¹à¸ â à¸ªà¸£à¹à¸²à¸à¸­à¸­à¹à¸à¸­à¸£à¹
    await createOrder(userId, displayName, allowedItems, memo, rates);
    res.json({ status: 'ok' });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'bet error' });
  }
});

// ===== API: POST /bet/confirm =====
// à¸¥à¸¹à¸à¸à¹à¸²à¸à¸à¸¢à¸·à¸à¸¢à¸±à¸ (à¸à¸±à¸à¹à¸¥à¸à¸­à¸±à¹à¸à¸­à¸­à¸ à¹à¸¥à¹à¸§à¸ªà¸£à¹à¸²à¸à¸­à¸­à¹à¸à¸­à¸£à¹)
app.post('/bet/confirm', betLimiter, requireLineAuth, async (req, res) => {
  try {
    const userId      = req.lineUserId;
    const displayName = req.lineDisplayName;
    const { items, memo } = req.body;
    const rates = await getRates();
    await createOrder(userId, displayName, items, memo, rates);
    res.json({ status: 'ok' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'confirm error' });
  }
});

// --- à¸ªà¸£à¹à¸²à¸à¸­à¸­à¹à¸à¸­à¸£à¹à¸à¸£à¸´à¸ ---
async function createOrder(userId, displayName, items, memo, rates) {
  const orderId   = generateOrderId();
  const now       = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  const total     = items.reduce((s, i) => s + Number(i.amount), 0);
  const itemsStr  = items.map(i => `${i.num} ${i.type} ${i.amount}à¸`).join(', ');

  // à¸à¸±à¸à¸à¸¶à¸à¸¥à¸ Sheet "orders"
  // à¸à¸­à¸¥à¸±à¸¡à¸à¹: orderId, à¸§à¸±à¸à¹à¸§à¸¥à¸², userId, à¸à¸·à¹à¸­, à¸£à¸²à¸¢à¸à¸²à¸£, à¸¢à¸­à¸à¸£à¸§à¸¡, à¸«à¸¡à¸²à¸¢à¹à¸«à¸à¸¸, à¸ªà¸à¸²à¸à¸°
  await appendRow('orders', [orderId, now, userId, displayName, itemsStr, total, memo || '', 'pending']);

  // Push à¸¢à¸·à¸à¸¢à¸±à¸à¸«à¸²à¸¥à¸¹à¸à¸à¹à¸²
  const confirmMsg = buildConfirmMsg(orderId, items, total);
  await client.pushMessage(userId, confirmMsg);

  // à¹à¸à¹à¸à¹à¸à¹à¸²à¸à¸­à¸
  const adminMsg = buildAdminNotifyMsg(orderId, displayName, items, total, memo);
  await client.pushMessage(ADMIN_USER_ID, adminMsg);
}

// Push à¸¢à¸·à¸à¸¢à¸±à¸à¸«à¸²à¸¥à¸¹à¸à¸à¹à¸²
function buildConfirmMsg(orderId, items, total) {
  const list = items.map(i => `â¢ ${i.num} ${i.type}  ${Number(i.amount).toLocaleString()} à¸à¸²à¸`).join('\n');
  return {
    type: 'flex',
    altText: `â à¸£à¸±à¸à¹à¸à¸¢ #${orderId}`,
    contents: {
      type: 'bubble',
      header: { type:'box', layout:'vertical', backgroundColor:'#FF6B00', contents:[
        { type:'text', text:'â à¸£à¸±à¸à¹à¸à¸¢à¹à¸¥à¹à¸§à¸à¹à¸°', color:'#ffffff', weight:'bold', size:'md' }
      ]},
      body: { type:'box', layout:'vertical', spacing:'sm', contents:[
        { type:'text', text:`à¸«à¸¡à¸²à¸¢à¹à¸¥à¸à¹à¸à¸¢: ${orderId}`, size:'sm', color:'#555555' },
        { type:'separator' },
        { type:'text', text: list, wrap:true, size:'sm' },
        { type:'separator' },
        { type:'box', layout:'horizontal', contents:[
          { type:'text', text:'à¸¢à¸­à¸à¸£à¸§à¸¡', weight:'bold' },
          { type:'text', text:`${total.toLocaleString()} à¸à¸²à¸`, weight:'bold', color:'#FF6B00', align:'end' }
        ]}
      ]},
      footer: { type:'box', layout:'vertical', contents:[
        { type:'text', text:'à¸£à¸­à¹à¸à¹à¸²à¸à¸­à¸à¸¢à¸·à¸à¸¢à¸±à¸à¸à¸°à¸à¸°', size:'xs', color:'#aaaaaa', align:'center' }
      ]}
    }
  };
}

// à¹à¸à¹à¸à¹à¸à¹à¸²à¸à¸­à¸
function buildAdminNotifyMsg(orderId, displayName, items, total, memo) {
  const list = items.map(i => `â¢ ${i.num} ${i.type} ${Number(i.amount).toLocaleString()}à¸`).join('\n');
  return {
    type: 'flex',
    altText: `ð à¸­à¸­à¹à¸à¸­à¸£à¹à¹à¸«à¸¡à¹ #${orderId}`,
    contents: {
      type: 'bubble',
      header: { type:'box', layout:'vertical', backgroundColor:'#1a237e', contents:[
        { type:'text', text:'ð à¸­à¸­à¹à¸à¸­à¸£à¹à¹à¸«à¸¡à¹', color:'#ffffff', weight:'bold' }
      ]},
      body: { type:'box', layout:'vertical', spacing:'sm', contents:[
        { type:'text', text:`#${orderId}  â  ${displayName}`, weight:'bold', size:'sm' },
        { type:'text', text: list, wrap:true, size:'sm' },
        memo ? { type:'text', text:`à¸«à¸¡à¸²à¸¢à¹à¸«à¸à¸¸: ${memo}`, size:'xs', color:'#888888' } : null,
        { type:'separator' },
        { type:'box', layout:'horizontal', contents:[
          { type:'text', text:'à¸¢à¸­à¸', weight:'bold' },
          { type:'text', text:`${total.toLocaleString()} à¸à¸²à¸`, weight:'bold', color:'#FF6B00', align:'end' }
        ]}
      ].filter(Boolean)},
      footer: { type:'box', layout:'horizontal', spacing:'sm', contents:[
        { type:'button', style:'primary', color:'#2e7d32', action:{ type:'message', label:'â à¸¢à¸·à¸à¸¢à¸±à¸', text:`à¸¢à¸·à¸à¸¢à¸±à¸ ${orderId}` }},
        { type:'button', style:'secondary', action:{ type:'message', label:'â à¸¢à¸à¹à¸¥à¸´à¸', text:`à¸¢à¸à¹à¸¥à¸´à¸ ${orderId}` }}
      ]}
    }
  };
}

// ===== WEBHOOK LINE =====
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events;
  for (const event of events) {
    const userId = event.source?.userId;
    if (!userId) continue;

    const isAdmin = userId === ADMIN_USER_ID;

    // à¹à¸¡à¸·à¹à¸­à¸¡à¸µà¸à¸à¹à¸à¸´à¹à¸¡à¸à¸­à¸à¹à¸à¹à¸à¹à¸à¸·à¹à¸­à¸ â à¸ªà¹à¸ LIFF link
    if (event.type === 'follow') {
      await client.pushMessage(userId, {
        type: 'text',
        text: `à¸ªà¸§à¸±à¸ªà¸à¸µà¸à¹à¸° ð à¸¢à¸´à¸à¸à¸µà¸à¹à¸­à¸à¸£à¸±à¸à¸ªà¸¹à¹à¸£à¸°à¸à¸à¸à¸²à¸¢à¹à¸¥à¸à¸à¹à¸°\n\nà¸à¸à¸¥à¸´à¸à¸à¹à¸à¹à¸²à¸à¸¥à¹à¸²à¸à¹à¸à¸·à¹à¸­à¹à¸à¸à¸«à¸§à¸¢à¹à¸à¹à¹à¸¥à¸¢à¸à¹à¸° ð\n${LIFF_URL}`,
      });
      continue;
    }

    if (event.type !== 'message' || event.message?.type !== 'text') continue;
    const text = event.message.text.trim();

    // Admin commands
    if (isAdmin) {
      await handleAdminCommand(text, userId);
      continue;
    }

    // User à¸à¸±à¹à¸§à¹à¸ â à¸ªà¹à¸ LIFF link à¹à¸ªà¸¡à¸­
    await client.pushMessage(userId, {
      type: 'text',
      text: `à¸à¸à¸¥à¸´à¸à¸à¹à¸à¹à¸²à¸à¸¥à¹à¸²à¸à¹à¸à¸·à¹à¸­à¹à¸à¸à¸«à¸§à¸¢à¸à¹à¸° ð¯\n${LIFF_URL}`,
    });
  }
});

// ===== ADMIN COMMANDS =====
async function handleAdminCommand(text, userId) {
  const reply = (msg) => client.pushMessage(userId, { type:'text', text: msg });

  // à¸à¸¹à¸­à¸­à¹à¸à¸­à¸£à¹
  if (text === 'à¸à¸¹à¸­à¸­à¹à¸à¸­à¸£à¹') {
    const rows = await readSheet('orders', 'A2:H200');
    const today = new Date().toLocaleDateString('th-TH', { timeZone:'Asia/Bangkok' });
    const todayOrders = rows.filter(r => r[1]?.includes(today.split('/')[0]));
    if (!todayOrders.length) return reply('à¸¢à¸±à¸à¹à¸¡à¹à¸¡à¸µà¸­à¸­à¹à¸à¸­à¸£à¹à¸§à¸±à¸à¸à¸µà¹à¸à¹à¸°');
    const text2 = todayOrders.map(r => `#${r[0]} ${r[3]} â ${Number(r[5]).toLocaleString()}à¸ [${r[7]}]`).join('\n');
    return reply(`ð à¸­à¸­à¹à¸à¸­à¸£à¹à¸§à¸±à¸à¸à¸µà¹\n${text2}`);
  }

  // à¸¢à¸­à¸à¸£à¸§à¸¡
  if (text === 'à¸¢à¸­à¸') {
    const rows = await readSheet('orders', 'A2:H200');
    const today = new Date().toLocaleDateString('th-TH', { timeZone:'Asia/Bangkok' });
    const active = rows.filter(r => r[7] !== 'cancelled' && r[1]?.includes(today.split('/')[0]));
    const total = active.reduce((s, r) => s + (Number(r[5]) || 0), 0);
    return reply(`ð° à¸¢à¸­à¸à¸£à¸§à¸¡à¸§à¸±à¸à¸à¸µà¹\nà¸à¸±à¹à¸à¸«à¸¡à¸ ${active.length} à¸£à¸²à¸¢à¸à¸²à¸£\nà¸£à¸§à¸¡ ${total.toLocaleString()} à¸à¸²à¸`);
  }

  // à¸à¸¹à¹à¸¥à¸à¸­à¸±à¹à¸
  if (text === 'à¸à¸¹à¸­à¸±à¹à¸') {
    const rows = await readSheet('blocked', 'A2:D100');
    if (!rows.length) return reply('à¹à¸¡à¹à¸¡à¸µà¹à¸¥à¸à¸­à¸±à¹à¸à¸à¹à¸°');
    const text2 = rows.map(r => `â¢ ${r[0]} ${r[1]} â ${r[2]}${r[3] ? ` (à¸à¸³à¸à¸±à¸ ${r[3]}à¸)` : ''}`).join('\n');
    return reply(`ð« à¹à¸¥à¸à¸­à¸±à¹à¸à¸à¸±à¸à¸à¸¸à¸à¸±à¸\n${text2}`);
  }

  // à¸¢à¸·à¸à¸¢à¸±à¸ ORDER_ID
  const matchConfirm = text.match(/^à¸¢à¸·à¸à¸¢à¸±à¸\s+(BET\w+)$/i);
  if (matchConfirm) return await processOrderAction(matchConfirm[1], 'confirmed', userId);

  // à¸¢à¸à¹à¸¥à¸´à¸ ORDER_ID
  const matchCancel = text.match(/^à¸¢à¸à¹à¸¥à¸´à¸\s+(BET\w+)$/i);
  if (matchCancel) return await processOrderAction(matchCancel[1], 'cancelled', userId);

  // à¸­à¸±à¹à¸ à¹à¸¥à¸ à¸à¸£à¸°à¹à¸ à¸  à¹à¸à¹à¸: à¸­à¸±à¹à¸ 58 à¸à¸
  const matchBlock = text.match(/^à¸­à¸±à¹à¸\s+(\S+)\s+(\S+)$/);
  if (matchBlock) {
    await appendRow('blocked', [matchBlock[1], matchBlock[2], 'closed', '']);
    return reply(`ð à¸­à¸±à¹à¸à¹à¸¥à¸ ${matchBlock[1]} ${matchBlock[2]} à¹à¸¥à¹à¸§à¸à¹à¸°`);
  }

  // à¸à¸³à¸à¸±à¸ à¹à¸¥à¸ à¸à¸£à¸°à¹à¸ à¸ à¸à¸³à¸à¸§à¸  à¹à¸à¹à¸: à¸à¸³à¸à¸±à¸ 456 à¸à¸ 500
  const matchLimit = text.match(/^à¸à¸³à¸à¸±à¸\s+(\S+)\s+(\S+)\s+(\d+)$/);
  if (matchLimit) {
    await appendRow('blocked', [matchLimit[1], matchLimit[2], 'limit', matchLimit[3]]);
    return reply(`â¡ à¸à¸³à¸à¸±à¸à¹à¸¥à¸ ${matchLimit[1]} ${matchLimit[2]} à¹à¸¡à¹à¹à¸à¸´à¸ ${matchLimit[3]} à¸à¸²à¸à¸à¹à¸°`);
  }

  // à¹à¸à¸´à¸ à¹à¸¥à¸  à¹à¸à¹à¸: à¹à¸à¸´à¸ 58
  const matchOpen = text.match(/^à¹à¸à¸´à¸\s+(\S+)$/);
  if (matchOpen) {
    // à¸¥à¸à¹à¸à¸§à¸à¸µà¹à¸à¸£à¸à¸à¸±à¸à¸­à¸­à¸à¸à¸²à¸ Sheet blocked (à¸­à¹à¸²à¸à¹à¸¥à¹à¸§ filter à¹à¸¥à¹à¸§ overwrite)
    const rows = await readSheet('blocked', 'A2:D100');
    const filtered = rows.filter(r => r[0] !== matchOpen[1]);
    const sheets = getSheetClient();
    await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: 'blocked!A2:D100' });
    if (filtered.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: 'blocked!A2',
        valueInputOption: 'USER_ENTERED',
        resource: { values: filtered },
      });
    }
    return reply(`â à¹à¸à¸´à¸à¸£à¸±à¸à¹à¸¥à¸ ${matchOpen[1]} à¹à¸¥à¹à¸§à¸à¹à¸°`);
  }

  // à¸à¸¸à¸ à¸à¸³à¸à¸§à¸  à¹à¸à¹à¸: à¸à¸¸à¸ 80000
  const matchCapital = text.match(/^à¸à¸¸à¸\s+(\d+)$/);
  if (matchCapital) {
    const rows = await readSheet('rates', 'A2:G2');
    const current = rows[0] || [500,100,70,70,3,4,50000];
    current[6] = matchCapital[1];
    await updateRow('rates', 2, current);
    return reply(`ð° à¸à¸±à¹à¸à¸à¸¸à¸à¹à¸à¹à¸ ${Number(matchCapital[1]).toLocaleString()} à¸à¸²à¸à¹à¸¥à¹à¸§à¸à¹à¸°`);
  }
}

// à¸¢à¸·à¸à¸¢à¸±à¸/à¸¢à¸à¹à¸¥à¸´à¸ order + à¹à¸à¹à¸à¸¥à¸¹à¸à¸à¹à¸²
async function processOrderAction(orderId, newStatus, adminId) {
  const rows = await readSheet('orders', 'A2:H500');
  const idx  = rows.findIndex(r => r[0] === orderId);
  if (idx < 0) return client.pushMessage(adminId, { type:'text', text:`à¹à¸¡à¹à¸à¸à¸­à¸­à¹à¸à¸­à¸£à¹ ${orderId} à¸à¹à¸°` });

  const row = rows[idx];
  row[7] = newStatus;
  await updateRow('orders', idx + 2, row);

  const emoji  = newStatus === 'confirmed' ? 'â' : 'â';
  const label  = newStatus === 'confirmed' ? 'à¸¢à¸·à¸à¸¢à¸±à¸à¹à¸¥à¹à¸§' : 'à¸¢à¸à¹à¸¥à¸´à¸à¹à¸¥à¹à¸§';
  await client.pushMessage(row[2],
