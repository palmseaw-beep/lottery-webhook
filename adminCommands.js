const sheets = require('./sheets')

// ────────────────────────────────────────────
// Admin Command Router
// ────────────────────────────────────────────
async function handleAdminCommand(text) {
  const parts = text.split(' ')
  const cmd = parts[0].toLowerCase()

  switch (cmd) {
    case '/สต็อก':
      return await cmdStock()

    case '/ยอดวันนี้':
      return await cmdTodaySummary()

    case '/รายการ':
      return await cmdOrderList()

    case '/ปิดเลข':
      if (!parts[1]) return '❌ กรุณาระบุเลขที่ต้องการปิด\nตัวอย่าง: /ปิดเลข 45'
      return await cmdCloseNumber(parts[1])

    case '/เปิดเลข':
      if (!parts[1]) return '❌ กรุณาระบุเลขที่ต้องการเปิด\nตัวอย่าง: /เปิดเลข 45'
      return await cmdOpenNumber(parts[1])

    case '/ช่วยเหลือ':
    case '/help':
      return cmdHelp()

    default:
      return `❓ ไม่รู้จักคำสั่ง "${cmd}"\nพิมพ์ /ช่วยเหลือ เพื่อดูคำสั่งทั้งหมดค่ะ`
  }
}

// ────────────────────────────────────────────
// /สต็อก — ดูเลขที่ยังเปิดอยู่
// ────────────────────────────────────────────
async function cmdStock() {
  const stock = await sheets.getStock()
  if (!stock.length) return '📋 ไม่มีสต็อกในระบบค่ะ'

  const open = stock.filter(s => s.status === 'open')
  const closed = stock.filter(s => s.status === 'closed')

  let msg = '📋 สต็อกหวยค่ะ\n'
  msg += '─────────────────\n'
  msg += `✅ เปิดอยู่ (${open.length} เลข):\n`
  open.forEach(s => { msg += `  ${s.number} — เหลือ ${s.remaining}/${s.total}\n` })

  if (closed.length) {
    msg += `\n🚫 ปิดแล้ว (${closed.length} เลข):\n`
    closed.forEach(s => { msg += `  ${s.number}\n` })
  }

  return msg.trim()
}

// ────────────────────────────────────────────
// /ยอดวันนี้ — สรุปยอดขายวันนี้
// ────────────────────────────────────────────
async function cmdTodaySummary() {
  const today = new Date().toLocaleDateString('th-TH')
  const orders = await sheets.getTodayOrders()

  if (!orders.length) return `📊 วันนี้ (${today}) ยังไม่มีออร์เดอร์ค่ะ`

  const totalQty = orders.reduce((sum, o) => sum + Number(o.quantity), 0)
  const totalAmount = orders.reduce((sum, o) => sum + Number(o.amount), 0)

  let msg = `📊 ยอดขายวันนี้ (${today})\n`
  msg += '─────────────────\n'
  msg += `🎫 ออร์เดอร์: ${orders.length} รายการ\n`
  msg += `🔢 จำนวนรวม: ${totalQty} ใบ\n`
  msg += `💰 ยอดรวม: ${totalAmount.toLocaleString()} บาท`

  return msg
}

// ────────────────────────────────────────────
// /รายการ — ดูออร์เดอร์ล่าสุด 10 รายการ
// ────────────────────────────────────────────
async function cmdOrderList() {
  const orders = await sheets.getRecentOrders(10)
  if (!orders.length) return '📝 ยังไม่มีออร์เดอร์ค่ะ'

  let msg = '📝 ออร์เดอร์ล่าสุด 10 รายการ\n'
  msg += '─────────────────\n'
  orders.forEach((o, i) => {
    msg += `${i + 1}. เลข ${o.number} x${o.quantity} — ${o.name}\n`
    msg += `   🕐 ${o.timestamp}\n`
  })

  return msg.trim()
}

// ────────────────────────────────────────────
// /ปิดเลข XX — ปิดสต็อกเลขนั้น
// ────────────────────────────────────────────
async function cmdCloseNumber(number) {
  await sheets.setNumberStatus(number, 'closed')
  return `🚫 ปิดเลข ${number} เรียบร้อยแล้วค่ะ\nลูกค้าจะสั่งเลขนี้ไม่ได้อีกค่ะ`
}

// ────────────────────────────────────────────
// /เปิดเลข XX — เปิดสต็อกเลขนั้นใหม่
// ────────────────────────────────────────────
async function cmdOpenNumber(number) {
  await sheets.setNumberStatus(number, 'open')
  return `✅ เปิดเลข ${number} เรียบร้อยแล้วค่ะ\nลูกค้าสั่งได้แล้วนะคะ`
}

// ────────────────────────────────────────────
// /ช่วยเหลือ — แสดงคำสั่งทั้งหมด
// ────────────────────────────────────────────
function cmdHelp() {
  return `🤖 คำสั่ง Admin ทั้งหมดค่ะ
─────────────────
/สต็อก — ดูสต็อกหวยทั้งหมด
/ยอดวันนี้ — สรุปยอดขายวันนี้
/รายการ — ดูออร์เดอร์ล่าสุด 10 รายการ
/ปิดเลข [เลข] — ปิดสต็อกเลขนั้น
/เปิดเลข [เลข] — เปิดสต็อกเลขนั้น
/ช่วยเหลือ — แสดงคำสั่งทั้งหมด`
}

module.exports = { handleAdminCommand }
