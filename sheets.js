const { google } = require('googleapis')

// ────────────────────────────────────────────
// Google Sheets Auth
// ────────────────────────────────────────────
function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
}

function getSheetsClient() {
  const auth = getAuth()
  return google.sheets({ version: 'v4', auth })
}

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID

// ────────────────────────────────────────────
// Sheet Names (ชื่อ tab ใน Google Sheets)
// ────────────────────────────────────────────
const SHEET_STOCK = 'สต็อก'   // คอลัมน์: number | total | remaining | status
const SHEET_ORDERS = 'ออร์เดอร์' // คอลัมน์: timestamp | userId | name | number | quantity | amount

// ────────────────────────────────────────────
// อ่านสต็อกทั้งหมด
// ────────────────────────────────────────────
async function getStock() {
  const sheets = getSheetsClient()
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_STOCK}!A2:D`,
  })

  const rows = res.data.values || []
  return rows.map(row => ({
    number: row[0] || '',
    total: row[1] || 0,
    remaining: row[2] || 0,
    status: row[3] || 'open',
  }))
}

// ────────────────────────────────────────────
// เช็คสต็อกเลขเดียว
// ────────────────────────────────────────────
async function checkStock(number) {
  const stock = await getStock()
  return stock.find(s => s.number === number) || null
}

// ────────────────────────────────────────────
// ลดสต็อก (เมื่อลูกค้าสั่ง)
// ────────────────────────────────────────────
async function decreaseStock(number, quantity) {
  const sheets = getSheetsClient()
  const stock = await getStock()
  const idx = stock.findIndex(s => s.number === number)
  if (idx === -1) throw new Error(`ไม่พบเลข ${number} ในสต็อก`)

  const newRemaining = Number(stock[idx].remaining) - Number(quantity)
  const rowNumber = idx + 2 // +2 เพราะ header อยู่แถว 1

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_STOCK}!C${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[newRemaining]] },
  })

  // ถ้าหมด ปิดอัตโนมัติ
  if (newRemaining <= 0) {
    await setNumberStatus(number, 'closed')
  }
}

// ────────────────────────────────────────────
// เปิด/ปิดเลข
// ────────────────────────────────────────────
async function setNumberStatus(number, status) {
  const sheets = getSheetsClient()
  const stock = await getStock()
  const idx = stock.findIndex(s => s.number === number)
  if (idx === -1) throw new Error(`ไม่พบเลข ${number} ในสต็อก`)

  const rowNumber = idx + 2
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_STOCK}!D${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[status]] },
  })
}

// ────────────────────────────────────────────
// บันทึกออร์เดอร์
// ────────────────────────────────────────────
async function saveOrder({ userId, name, number, quantity, amount }) {
  const sheets = getSheetsClient()
  const timestamp = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_ORDERS}!A:F`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[timestamp, userId, name, number, quantity, amount]],
    },
  })
}

// ────────────────────────────────────────────
// ออร์เดอร์วันนี้
// ────────────────────────────────────────────
async function getTodayOrders() {
  const orders = await getAllOrders()
  const todayStr = new Date().toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' })
  return orders.filter(o => o.timestamp.includes(todayStr))
}

// ────────────────────────────────────────────
// ออร์เดอร์ล่าสุด N รายการ
// ────────────────────────────────────────────
async function getRecentOrders(limit = 10) {
  const orders = await getAllOrders()
  return orders.slice(-limit).reverse()
}

// ────────────────────────────────────────────
// อ่านออร์เดอร์ทั้งหมด
// ────────────────────────────────────────────
async function getAllOrders() {
  const sheets = getSheetsClient()
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_ORDERS}!A2:F`,
  })

  const rows = res.data.values || []
  return rows.map(row => ({
    timestamp: row[0] || '',
    userId: row[1] || '',
    name: row[2] || '',
    number: row[3] || '',
    quantity: row[4] || 0,
    amount: row[5] || 0,
  }))
}

module.exports = {
  getStock,
  checkStock,
  decreaseStock,
  setNumberStatus,
  saveOrder,
  getTodayOrders,
  getRecentOrders,
  getAllOrders,
}
