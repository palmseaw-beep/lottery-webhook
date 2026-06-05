# LINE OA Lottery Webhook 🎰

## ไฟล์ในโปรเจ็ค

```
webhook/
├── index.js          ← Server หลัก + Router (Admin vs ลูกค้า)
├── adminCommands.js  ← คำสั่ง Admin ทั้งหมด
├── customerHandler.js← จัดการข้อความลูกค้า
├── sheets.js         ← เชื่อมต่อ Google Sheets
├── package.json      ← dependencies
└── .env.example      ← ตัวอย่างค่า config (copy เป็น .env)
```

## คำสั่ง Admin (พิมพ์ผ่าน LINE มือถือได้เลย)

| คำสั่ง | ทำอะไร |
|--------|--------|
| `/สต็อก` | ดูสต็อกหวยทั้งหมด |
| `/ยอดวันนี้` | สรุปยอดขายวันนี้ |
| `/รายการ` | ดูออร์เดอร์ล่าสุด 10 รายการ |
| `/ปิดเลข 45` | ปิดสต็อกเลข 45 |
| `/เปิดเลข 45` | เปิดสต็อกเลข 45 กลับมา |
| `/ช่วยเหลือ` | แสดงคำสั่งทั้งหมด |

## วิธีติดตั้ง

### ขั้นที่ 1 — ติดตั้ง Node.js
ดาวน์โหลดจาก https://nodejs.org (เลือก LTS)

### ขั้นที่ 2 — ติดตั้ง dependencies
```bash
cd webhook
npm install
```

### ขั้นที่ 3 — ตั้งค่า .env
```bash
cp .env.example .env
# แล้วเปิดไฟล์ .env แก้ค่าต่างๆ
```

### ขั้นที่ 4 — หา OWNER_LINE_USER_ID
1. Deploy server ขึ้น Railway ก่อน (ขั้นที่ 5)
2. ส่งข้อความอะไรก็ได้หา LINE OA ของตัวเอง
3. ดู log ใน Railway จะเห็น userId ของคุณ
4. เอา userId นั้นใส่ใน `.env`

### ขั้นที่ 5 — Deploy บน Railway (ฟรี)
1. ไปที่ https://railway.app แล้ว login ด้วย GitHub
2. New Project → Deploy from GitHub Repo
3. ใส่ค่า Environment Variables ทั้งหมดใน Railway
4. Railway จะให้ URL เช่น `https://xxx.railway.app`

### ขั้นที่ 6 — ตั้ง Webhook URL ใน LINE
1. ไปที่ LINE Developers → Channel → Messaging API
2. ใส่ Webhook URL: `https://xxx.railway.app/webhook`
3. กด Verify ✅

## Google Sheets Structure

สร้าง Google Sheets มี 2 tab:

**tab "สต็อก"**
| number | total | remaining | status |
|--------|-------|-----------|--------|
| 45 | 100 | 85 | open |
| 99 | 50 | 0 | closed |

**tab "ออร์เดอร์"**
| timestamp | userId | name | number | quantity | amount |
|-----------|--------|------|--------|----------|--------|
