const express = require('express')
const line = require('@line/bot-sdk')
const { handleAdminCommand } = require('./adminCommands')
const { handleCustomerMessage } = require('./customerHandler')

const app = express()

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
}

const client = new line.Client(lineConfig)

// ────────────────────────────────────────────
// Webhook endpoint
// ────────────────────────────────────────────
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  res.status(200).send('OK')

  const events = req.body.events
  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue
    await dispatch(event)
  }
})

// ────────────────────────────────────────────
// Router: แยก Admin vs ลูกค้า
// ────────────────────────────────────────────
async function dispatch(event) {
  const userId = event.source.userId
  const text = event.message.text.trim()
  const isOwner = userId === process.env.OWNER_LINE_USER_ID

  try {
    if (isOwner && text.startsWith('/')) {
      // เจ้าของพิมพ์คำสั่ง Admin
      const reply = await handleAdminCommand(text)
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: reply,
      })
    } else {
      // ลูกค้าทั่วไป
      await handleCustomerMessage(event, client)
    }
  } catch (err) {
    console.error('dispatch error:', err)
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: '❌ เกิดข้อผิดพลาด กรุณาลองใหม่ค่ะ',
    })
  }
}

// ────────────────────────────────────────────
// Health check
// ────────────────────────────────────────────
app.get('/', (req, res) => res.send('LINE OA Lottery Webhook is running 🎰'))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
