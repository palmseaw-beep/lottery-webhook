// ────────────────────────────────────────────
// จัดการข้อความจากลูกค้าทั่วไป
// ────────────────────────────────────────────
async function handleCustomerMessage(event, client) {
  const text = event.message.text.trim()

  // ตัวอย่าง: ตอบกลับพื้นฐาน
  // ในอนาคตจะเชื่อมกับ LIFF และ flow สั่งซื้อจริง
  let reply = ''

  if (text === 'หวย' || text === 'สั่งหวย' || text === 'ซื้อหวย') {
    reply = '🎰 สวัสดีค่ะ!\nกดปุ่มด้านล่างเพื่อสั่งซื้อหวยได้เลยค่ะ'
    await client.replyMessage(event.replyToken, [
      { type: 'text', text: reply },
      {
        type: 'template',
        altText: 'กดเพื่อสั่งซื้อหวย',
        template: {
          type: 'buttons',
          text: 'เลือกบริการค่ะ',
          actions: [
            {
              type: 'uri',
              label: '🎫 สั่งซื้อหวย',
              uri: `https://liff.line.me/${process.env.LIFF_ID}`,
            },
          ],
        },
      },
    ])
  } else {
    reply = 'สวัสดีค่ะ 😊\nพิมพ์ว่า "หวย" เพื่อสั่งซื้อได้เลยนะคะ'
    await client.replyMessage(event.replyToken, { type: 'text', text: reply })
  }
}

module.exports = { handleCustomerMessage }
