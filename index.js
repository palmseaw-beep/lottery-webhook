require('dotenv').config()

const express = require('express')
const line    = require('@line/bot-sdk')
const { google } = require('googleapis')
const rateLimit  = require('express-rate-limit')
const https      = require('https')

const app = express()

// ──────────────────────────────────────────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────────────────────────────────────────
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.LINE_CHANNEL_SECRET,
}
const ADMIN_USER_ID   = process.env.ADMIN_USER_ID
const SPREADSHEET_ID  = process.env.SPREADSHEET_ID
const LIFF_CHANNEL_ID = process.env.LIFF_CHANNEL_ID
const ADMIN_SECRET    = process.env.ADMIN_SECRET

const client = new line.Client(lineConfig)

// ──────────────────────────────────────────────────────────────────────────────
// GOOGLE SHEETS
// ──────────────────────────────────────────────────────────────────────────────
function getSheetClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  return google.sheets({ version: 'v4', auth })
}

async function readSheet(sheetName, range) {
  const sheets = getSheetClient()
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!${range}`,
  })
  return res.data.values || []
}

async function appendRow(sheetName, values) {
  const sheets = getSheetClient()
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  })
}

async function updateRow(sheetName, rowIndex, values) {
  const sheets = getSheetClient()
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  })
}

// ──────────────────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────────────────
function generateOrderId() {
  const d    = new Date()
  const date = `${d.getFullYear().toString().slice(-2)}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`
  const rand = String(Math.floor(Math.random() * 900) + 100)
  return `BET${date}${rand}`
}

const DEFAULT_RATES = { r3_bon:500, r3_tode:100, r2_bon:70, r2_lang:70, rw_bon:3, rw_lang:4 }

async function getAllGroupRates() {
  const rows   = await readSheet('rates_by_group', 'A2:G10')
  const result = {
    normal: { ...DEFAULT_RATES },
    vip:    { ...DEFAULT_RATES },
    agent:  { ...DEFAULT_RATES },
  }
  for (const r of rows) {
    const g = r[0]
    if (!result[g]) continue
    result[g] = {
      r3_bon:  Number(r[1]) || DEFAULT_RATES.r3_bon,
      r3_tode: Number(r[2]) || DEFAULT_RATES.r3_tode,
      r2_bon:  Number(r[3]) || DEFAULT_RATES.r2_bon,
      r2_lang: Number(r[4]) || DEFAULT_RATES.r2_lang,
      rw_bon:  Number(r[5]) || DEFAULT_RATES.rw_bon,
      rw_lang: Number(r[6]) || DEFAULT_RATES.rw_lang,
    }
  }
  return result
}

async function getRatesByGroup(group = 'normal') {
  const all = await getAllGroupRates()
  return all[group] || all.normal
}

async function getCapital() {
  const rows = await readSheet('rates', 'G2:G2')
  return Number(rows?.[0]?.[0]) || 50000
}

async function getUser(userId) {
  const rows = await readSheet('users', 'A2:D500')
  const row  = rows.find(r => r[0] === userId)
  if (!row) return null
  return { userId: row[0], displayName: row[1], group: row[2] || 'normal', discount: Number(row[3]) || 0 }
}

async function upsertUser(userId, displayName, group = 'normal', discount = 0) {
  const rows = await readSheet('users', 'A2:D500')
  const idx  = rows.findIndex(r => r[0] === userId)
  if (idx < 0) {
    await appendRow('users', [userId, displayName, group, discount])
  } else {
    const existing = rows[idx]
    await updateRow('users', idx + 2, [
      userId,
      displayName || existing[1],
      group    !== undefined ? group    : (existing[2] || 'normal'),
      discount !== undefined ? discount : (Number(existing[3]) || 0),
    ])
  }
}

async function getRates() {
  const rates   = await getRatesByGroup('normal')
  const capital = await getCapital()
  return { ...rates, capital }
}

async function getBlocked() {
  const rows = await readSheet('blocked', 'A2:D100')
  return rows.map(r => ({
    num:    r[0] || '',
    type:   r[1] || 'ทั้งหมด',
    status: r[2] || 'closed',
    limit:  Number(r[3]) || 0,
  }))
}

async function calcAutoBlocked(rates) {
  const rows    = await readSheet('orders', 'A2:H1000')
  const capital = rates.capital
  const warn    = capital * 0.2
  const map     = {}
  let totalBoard = 0

  for (const r of rows) {
    if (r[7] === 'cancelled') continue
    const num  = r[3]
    const type = r[4]
    const amt  = Number(r[5]) || 0
    const key  = `${num}|${type}`
    map[key]    = (map[key] || 0) + amt
    totalBoard += amt
  }

  const autoBlocked = []
  for (const [key, bet] of Object.entries(map)) {
    const [num, type] = key.split('|')
    let rate = rates.r2_bon
    if      (type === 'โต้ด'    && num.length === 3) rate = rates.r3_tode
    else if (type === 'บน'      && num.length === 3) rate = rates.r3_bon
    else if (type === 'บน')                          rate = rates.r2_bon
    else if (type === 'ล่าง')                        rate = rates.r2_lang
    else if (type === 'วิ่งบน')                      rate = rates.rw_bon
    else if (type === 'วิ่งล่าง')                    rate = rates.rw_lang

    const maxPay    = bet * rate
    const remaining = capital - maxPay + totalBoard
    if      (remaining < 0)    autoBlocked.push({ num, type, status: 'closed', remaining })
    else if (remaining < warn) autoBlocked.push({ num, type, status: 'limit',  remaining })
  }
  return autoBlocked
}

// ──────────────────────────────────────────────────────────────────────────────
// RATE LIMITING
// ──────────────────────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false })
const betLimiter    = rateLimit({ windowMs: 60000, max: 10, message: { error: 'Too many bet requests.' } })
const configLimiter = rateLimit({ windowMs: 60000, max: 30, message: { error: 'Too many config requests.' } })

// ──────────────────────────────────────────────────────────────────────────────
// LINE ID TOKEN VERIFICATION
// ──────────────────────────────────────────────────────────────────────────────
async function verifyLineToken(idToken) {
  return new Promise((resolve, reject) => {
    const body    = `id_token=${encodeURIComponent(idToken)}&client_id=${encodeURIComponent(LIFF_CHANNEL_ID)}`
    const options = {
      hostname: 'api.line.me',
      path:     '/oauth2/v2.1/verify',
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (json.error) return reject(new Error(json.error_description || 'invalid token'))
          resolve(json)
        } catch { reject(new Error('parse error')) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function requireLineAuth(req, res, next) {
  const idToken = req.headers['x-line-id-token'] || req.body?.idToken
  if (!idToken) return res.status(401).json({ error: 'Missing LINE ID token' })
  try {
    const profile       = await verifyLineToken(idToken)
    req.lineUserId      = profile.sub
    req.lineDisplayName = profile.name
    next()
  } catch (e) {
    console.warn('[AUTH] Invalid token:', e.message)
    return res.status(401).json({ error: 'Invalid LINE ID token' })
  }
}

function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key']
  if (!key || key !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' })
  next()
}

// ──────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// LINE middleware ต้อง register ก่อน express.json() เพราะต้องอ่าน raw body
// ──────────────────────────────────────────────────────────────────────────────
app.set('trust proxy', 1)
app.use('/webhook', line.middleware(lineConfig))
app.use(express.json())
app.use(globalLimiter)

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Line-Id-Token, X-Admin-Key')
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} — IP:${req.ip}`)
  next()
})

// ──────────────────────────────────────────────────────────────────────────────
// GET /config — LIFF โหลดอัตราจ่าย + เลขอั้น + กลุ่มลูกค้า
// ──────────────────────────────────────────────────────────────────────────────
app.get('/config', configLimiter, requireLineAuth, async (req, res) => {
  try {
    const userId      = req.lineUserId
    const displayName = req.lineDisplayName

    let user = await getUser(userId)
    if (!user) {
      await upsertUser(userId, displayName || 'ลูกค้าใหม่')
      user = { userId, displayName, group: 'normal', discount: 0 }
    }

    const group    = user.group    || 'normal'
    const discount = user.discount || 0
    const rates    = await getRatesByGroup(group)
    const capital  = await getCapital()
    const manual   = await getBlocked()
    const auto     = await calcAutoBlocked({ ...rates, capital })

    const blocked = [...manual]
    for (const a of auto) {
      const exists = manual.find(m => m.num === a.num && (m.type === a.type || m.type === 'ทั้งหมด'))
      if (!exists) blocked.push(a)
    }

    res.json({ rates, blocked, group, discount })
  } catch (e) {
    console.error('[/config]', e)
    res.status(500).json({ error: 'config error' })
  }
})

// ──────────────────────────────────────────────────────────────────────────────
// POST /bet — รับออเดอร์จาก LIFF
// ──────────────────────────────────────────────────────────────────────────────
app.post('/bet', betLimiter, requireLineAuth, async (req, res) => {
  try {
    const userId      = req.lineUserId
    const displayName = req.lineDisplayName
    const { items, memo } = req.body

    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: 'items required' })

    for (const item of items) {
      if (!item.num || !/^\d{1,3}$/.test(item.num))
        return res.status(400).json({ error: `invalid num: ${item.num}` })
      if (!item.type || !['บน','ล่าง','โต้ด','วิ่งบน','วิ่งล่าง'].includes(item.type))
        return res.status(400).json({ error: `invalid type: ${item.type}` })
      if (!item.amount || isNaN(item.amount) || Number(item.amount) <= 0)
        return res.status(400).json({ error: `invalid amount: ${item.amount}` })
      item.amount = Math.abs(Math.round(Number(item.amount)))
    }

    const rates   = await getRates()
    const manual  = await getBlocked()
    const auto    = await calcAutoBlocked(rates)
    const blocked = [...manual]
    for (const a of auto) {
      const exists = manual.find(m => m.num === a.num && (m.type === a.type || m.type === 'ทั้งหมด'))
      if (!exists) blocked.push(a)
    }

    const blockedItems = []
    const allowedItems = []
    for (const item of items) {
      const hit = blocked.find(b =>
        b.num === item.num &&
        (b.type === item.type || b.type === 'ทั้งหมด') &&
        b.status === 'closed'
      )
      const limitHit = blocked.find(b =>
        b.num === item.num &&
        (b.type === item.type || b.type === 'ทั้งหมด') &&
        b.status === 'limit' &&
        item.amount > b.limit
      )
      if      (hit)      blockedItems.push({ ...item, reason: 'closed' })
      else if (limitHit) blockedItems.push({ ...item, reason: `เกินจำกัด ${limitHit.limit} บาท` })
      else               allowedItems.push(item)
    }

    if (blockedItems.length > 0) {
      return res.json({ status: 'confirm_required', blockedItems, allowedItems, message: 'มีเลขอั้นในรายการ' })
    }

    await createOrder(userId, displayName, allowedItems, memo, rates)
    res.json({ status: 'ok' })
  } catch (e) {
    console.error('[/bet]', e)
    res.status(500).json({ error: 'bet error' })
  }
})

// ──────────────────────────────────────────────────────────────────────────────
// POST /bet/confirm — ลูกค้ากดยืนยัน ตัดเลขอั้นออก
// ──────────────────────────────────────────────────────────────────────────────
app.post('/bet/confirm', betLimiter, requireLineAuth, async (req, res) => {
  try {
    const userId      = req.lineUserId
    const displayName = req.lineDisplayName
    const { items, memo } = req.body
    const rates = await getRates()
    await createOrder(userId, displayName, items, memo, rates)
    res.json({ status: 'ok' })
  } catch (e) {
    console.error('[/bet/confirm]', e)
    res.status(500).json({ error: 'confirm error' })
  }
})

// ──────────────────────────────────────────────────────────────────────────────
// createOrder
// ──────────────────────────────────────────────────────────────────────────────
async function createOrder(userId, displayName, items, memo, rates) {
  const orderId  = generateOrderId()
  const now      = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })
  const total    = items.reduce((s, i) => s + Number(i.amount), 0)
  const itemsStr = items.map(i => `${i.num} ${i.type} ${i.amount}บ`).join(', ')

  // columns: orderId | วันเวลา | userId | ชื่อ | รายการ | ยอดรวม | หมายเหตุ | สถานะ
  await appendRow('orders', [orderId, now, userId, displayName, itemsStr, total, memo || '', 'pending'])

  await client.pushMessage(userId,       buildConfirmMsg(orderId, items, total))
  await client.pushMessage(ADMIN_USER_ID, buildAdminNotifyMsg(orderId, displayName, items, total, memo))
}

function buildConfirmMsg(orderId, items, total) {
  const list = items.map(i => `• ${i.num} ${i.type}  ${Number(i.amount).toLocaleString()} บาท`).join('\n')
  return {
    type: 'flex',
    altText: `✅ รับโพย #${orderId}`,
    contents: {
      type: 'bubble',
      header: { type:'box', layout:'vertical', backgroundColor:'#FF6B00', contents:[
        { type:'text', text:'✅ รับโพยแล้วค่ะ', color:'#ffffff', weight:'bold', size:'md' },
      ]},
      body: { type:'box', layout:'vertical', spacing:'sm', contents:[
        { type:'text', text:`หมายเลขโพย: ${orderId}`, size:'sm', color:'#555555' },
        { type:'separator' },
        { type:'text', text: list, wrap:true, size:'sm' },
        { type:'separator' },
        { type:'box', layout:'horizontal', contents:[
          { type:'text', text:'ยอดรวม', weight:'bold' },
          { type:'text', text:`${total.toLocaleString()} บาท`, weight:'bold', color:'#FF6B00', align:'end' },
        ]},
      ]},
      footer: { type:'box', layout:'vertical', contents:[
        { type:'text', text:'รอเจ้าของยืนยันนะคะ', size:'xs', color:'#aaaaaa', align:'center' },
      ]},
    },
  }
}

function buildAdminNotifyMsg(orderId, displayName, items, total, memo) {
  const list = items.map(i => `• ${i.num} ${i.type} ${Number(i.amount).toLocaleString()}บ`).join('\n')
  return {
    type: 'flex',
    altText: `🔔 ออเดอร์ใหม่ #${orderId}`,
    contents: {
      type: 'bubble',
      header: { type:'box', layout:'vertical', backgroundColor:'#1a237e', contents:[
        { type:'text', text:'🔔 ออเดอร์ใหม่', color:'#ffffff', weight:'bold' },
      ]},
      body: { type:'box', layout:'vertical', spacing:'sm', contents:[
        { type:'text', text:`#${orderId}  —  ${displayName}`, weight:'bold', size:'sm' },
        { type:'text', text: list, wrap:true, size:'sm' },
        memo ? { type:'text', text:`หมายเหตุ: ${memo}`, size:'xs', color:'#888888' } : null,
        { type:'separator' },
        { type:'box', layout:'horizontal', contents:[
          { type:'text', text:'ยอด', weight:'bold' },
          { type:'text', text:`${total.toLocaleString()} บาท`, weight:'bold', color:'#FF6B00', align:'end' },
        ]},
      ].filter(Boolean)},
      footer: { type:'box', layout:'horizontal', spacing:'sm', contents:[
        { type:'button', style:'primary',   color:'#2e7d32', action:{ type:'message', label:'✅ ยืนยัน', text:`ยืนยัน ${orderId}` }},
        { type:'button', style:'secondary',                  action:{ type:'message', label:'❌ ยกเลิก', text:`ยกเลิก ${orderId}` }},
      ]},
    },
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// ADMIN API
// ──────────────────────────────────────────────────────────────────────────────
app.get('/admin/rates', requireAdminKey, async (req, res) => {
  try {
    const all     = await getAllGroupRates()
    const capital = await getCapital()
    res.json({ ...all, capital })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/admin/rates', requireAdminKey, async (req, res) => {
  try {
    const { normal, vip, agent, capital } = req.body
    const sheets = getSheetClient()
    await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: 'rates_by_group!A2:G10' })
    const rows = []
    for (const [g, r] of Object.entries({ normal, vip, agent })) {
      if (!r) continue
      rows.push([g, r.r3_bon, r.r3_tode, r.r2_bon, r.r2_lang, r.rw_bon, r.rw_lang])
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: 'rates_by_group!A2',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    })
    if (capital !== undefined) {
      const ratesRows = await readSheet('rates', 'A2:G2')
      const current   = ratesRows[0] || [500,100,70,70,3,4,50000]
      current[6] = capital
      await updateRow('rates', 2, current)
    }
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/admin/users', requireAdminKey, async (req, res) => {
  try {
    const rows  = await readSheet('users', 'A2:D500')
    const users = rows.map(r => ({
      userId:      r[0],
      displayName: r[1],
      group:       r[2] || 'normal',
      discount:    Number(r[3]) || 0,
    }))
    res.json(users)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/admin/users/:userId', requireAdminKey, async (req, res) => {
  try {
    const { userId }          = req.params
    const { group, discount } = req.body
    const existing = await getUser(userId)
    await upsertUser(userId, existing?.displayName || '', group, discount)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ──────────────────────────────────────────────────────────────────────────────
// LINE WEBHOOK
// ──────────────────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200)
  const events = req.body.events
  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue
    const text    = event.message.text.trim()
    const userId  = event.source.userId
    const isAdmin = userId === ADMIN_USER_ID
    if (isAdmin) {
      await handleAdminCommand(text, userId).catch(e => console.error('[admin cmd]', e))
    } else {
      await handleCustomerMessage(event).catch(e => console.error('[customer]', e))
    }
  }
})

// ──────────────────────────────────────────────────────────────────────────────
// ADMIN COMMANDS (via LINE text)
// ──────────────────────────────────────────────────────────────────────────────
async function handleAdminCommand(text, userId) {
  const reply = (msg) => client.pushMessage(userId, { type:'text', text: msg })

  if (text === 'ดูออเดอร์') {
    const rows  = await readSheet('orders', 'A2:H200')
    const today = new Date().toLocaleDateString('th-TH', { timeZone:'Asia/Bangkok' })
    const todayOrders = rows.filter(r => r[1]?.includes(today.split('/')[0]))
    if (!todayOrders.length) return reply('ยังไม่มีออเดอร์วันนี้ค่ะ')
    const msg = todayOrders.map(r => `#${r[0]} ${r[3]} — ${Number(r[5]).toLocaleString()}บ [${r[7]}]`).join('\n')
    return reply(`📋 ออเดอร์วันนี้\n${msg}`)
  }

  if (text === 'ยอด') {
    const rows   = await readSheet('orders', 'A2:H200')
    const today  = new Date().toLocaleDateString('th-TH', { timeZone:'Asia/Bangkok' })
    const active = rows.filter(r => r[7] !== 'cancelled' && r[1]?.includes(today.split('/')[0]))
    const total  = active.reduce((s, r) => s + (Number(r[5]) || 0), 0)
    return reply(`💰 ยอดรวมวันนี้\nทั้งหมด ${active.length} รายการ\nรวม ${total.toLocaleString()} บาท`)
  }

  if (text === 'ดูอั้น') {
    const rows = await readSheet('blocked', 'A2:D100')
    if (!rows.length) return reply('ไม่มีเลขอั้นค่ะ')
    const msg = rows.map(r => `• ${r[0]} ${r[1]} — ${r[2]}${r[3] ? ` (จำกัด ${r[3]}บ)` : ''}`).join('\n')
    return reply(`🚫 เลขอั้นปัจจุบัน\n${msg}`)
  }

  if (text === 'ช่วยเหลือ' || text === 'help') {
    return reply(
      '🤖 คำสั่ง Admin\n─────────────\n' +
      'ดูออเดอร์ — ออเดอร์วันนี้\n' +
      'ยอด — ยอดรวมวันนี้\n' +
      'ดูอั้น — เลขอั้นทั้งหมด\n' +
      'ยืนยัน BETxxxxxx — ยืนยันออเดอร์\n' +
      'ยกเลิก BETxxxxxx — ยกเลิกออเดอร์\n' +
      'อั้น [เลข] [ประเภท] — ปิดรับ\n' +
      'จำกัด [เลข] [ประเภท] [จำนวน] — จำกัดยอด\n' +
      'เปิด [เลข] — เปิดรับ\n' +
      'ทุน [จำนวน] — ตั้งทุนสำรอง'
    )
  }

  const matchConfirm = text.match(/^ยืนยัน\s+(BET\w+)$/i)
  if (matchConfirm) return processOrderAction(matchConfirm[1], 'confirmed', userId)

  const matchCancel = text.match(/^ยกเลิก\s+(BET\w+)$/i)
  if (matchCancel) return processOrderAction(matchCancel[1], 'cancelled', userId)

  const matchBlock = text.match(/^อั้น\s+(\S+)\s+(\S+)$/)
  if (matchBlock) {
    await appendRow('blocked', [matchBlock[1], matchBlock[2], 'closed', ''])
    return reply(`🔒 อั้นเลข ${matchBlock[1]} ${matchBlock[2]} แล้วค่ะ`)
  }

  const matchLimit = text.match(/^จำกัด\s+(\S+)\s+(\S+)\s+(\d+)$/)
  if (matchLimit) {
    await appendRow('blocked', [matchLimit[1], matchLimit[2], 'limit', matchLimit[3]])
    return reply(`⚡ จำกัดเลข ${matchLimit[1]} ${matchLimit[2]} ไม่เกิน ${matchLimit[3]} บาทค่ะ`)
  }

  const matchOpen = text.match(/^เปิด\s+(\S+)$/)
  if (matchOpen) {
    const rows     = await readSheet('blocked', 'A2:D100')
    const filtered = rows.filter(r => r[0] !== matchOpen[1])
    const sheets   = getSheetClient()
    await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: 'blocked!A2:D100' })
    if (filtered.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: 'blocked!A2',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: filtered },
      })
    }
    return reply(`✅ เปิดรับเลข ${matchOpen[1]} แล้วค่ะ`)
  }

  const matchCapital = text.match(/^ทุน\s+(\d+)$/)
  if (matchCapital) {
    const rows    = await readSheet('rates', 'A2:G2')
    const current = rows[0] || [500,100,70,70,3,4,50000]
    current[6] = matchCapital[1]
    await updateRow('rates', 2, current)
    return reply(`💰 ตั้งทุนเป็น ${Number(matchCapital[1]).toLocaleString()} บาทแล้วค่ะ`)
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// CUSTOMER MESSAGE (via LINE)
// ──────────────────────────────────────────────────────────────────────────────
async function handleCustomerMessage(event) {
  const text = event.message.text.trim()
  if (['หวย','สั่งหวย','ซื้อหวย','แทงหวย'].includes(text)) {
    await client.replyMessage(event.replyToken, [
      { type: 'text', text: '🎰 สวัสดีค่ะ!\nกดปุ่มด้านล่างเพื่อสั่งซื้อได้เลยค่ะ' },
      {
        type:    'template',
        altText: 'กดเพื่อสั่งซื้อหวย',
        template: {
          type:    'buttons',
          text:    'เลือกบริการค่ะ',
          actions: [{ type: 'uri', label: '🎫 สั่งซื้อหวย', uri: process.env.LIFF_URL || `https://liff.line.me/${process.env.LIFF_ID}` }],
        },
      },
    ])
  } else {
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'สวัสดีค่ะ 😊\nพิมพ์ว่า "หวย" เพื่อสั่งซื้อได้เลยนะคะ',
    })
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// processOrderAction — ยืนยัน/ยกเลิก order แล้วแจ้งลูกค้า
// ──────────────────────────────────────────────────────────────────────────────
async function processOrderAction(orderId, newStatus, adminId) {
  const rows = await readSheet('orders', 'A2:H500')
  const idx  = rows.findIndex(r => r[0] === orderId)
  if (idx < 0) return client.pushMessage(adminId, { type:'text', text:`ไม่พบออเดอร์ ${orderId} ค่ะ` })
  const row = rows[idx]
  row[7] = newStatus
  await updateRow('orders', idx + 2, row)
  const emoji = newStatus === 'confirmed' ? '✅' : '❌'
  const label = newStatus === 'confirmed' ? 'ยืนยันแล้ว' : 'ยกเลิกแล้ว'
  await client.pushMessage(row[2],  { type:'text', text:`${emoji} โพย #${orderId} ${label} แล้วนะคะ` })
  await client.pushMessage(adminId, { type:'text', text:`${emoji} ${label} #${orderId} เรียบร้อยค่ะ` })
}

// ──────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK
// ──────────────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('LINE OA Lottery Webhook is running 🎰'))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
