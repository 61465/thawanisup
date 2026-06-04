# 🤖 WhatsApp Commerce Bot — للمتاجر المحلية العربية

> بوت واتساب تجاري كامل + قابل للاستنساخ لأي متجر (مقهى، حلويات، صيدلية، تجزئة) — يعمل عبر **Meta Cloud API الرسمي** بدون BSP وسيط.

---

## ✨ المميزات

- 🗣️ **شجرة محادثة عربية كاملة** — ترحيب → قائمة → سلة → فاتورة → تأكيد
- 🛒 **إدارة سلة متعددة** — جلسة لكل عميل، تنتهي بعد 30 دقيقة عدم نشاط
- 📊 **منتجات من Google Sheets** — صاحب المتجر يعدّل الأسعار من هاتفه
- 🖼️ **صور المنتجات** — دعم image_url اختياري لكل منتج
- 📃 **Pagination تلقائية** — لا تنكسر مع >10 منتجات في فئة
- 💾 **تسجيل الطلبات** — `data/orders.jsonl` + API بسيط `/orders`
- 🔔 **إشعار صاحب المتجر** — تفاصيل الطلب على رقمه فور التأكيد
- 🌙 **أوقات العمل** — رد ذكي خارج الساعات المحددة
- 🔐 **تحقق توقيع Meta** — `META_APP_SECRET` يحمي من webhook مزوّر
- 🧪 **اختبار محلي** — جرّب الشجرة في الـ terminal بدون نشر
- 📦 **قابل للاستنساخ** — `.env` مختلف لكل عميل، نفس الكود

---

## 🚀 البدء السريع

### 1. الإعداد
```bash
git clone <repo>
cd whatsapp-cafe-bot
npm install
cp .env.example .env
# عدّل .env بقيمك
```

### 2. اختبر محلياً
```bash
npm run simulate
# اكتب رسائل وشاهد ردود البوت كأنك في واتساب
```

### 3. تحقق من التدفق الكامل
```bash
npm test
# يجب أن ترى: 🎉 All tests passed!
```

### 4. للنشر الحقيقي
اتبع 📖 [`DEPLOYMENT.md`](./DEPLOYMENT.md) — دليل خطوة بخطوة لربط Meta + Railway

### 5. لاستنساخ بوت لعميل جديد
اتبع 📦 [`CLONE.md`](./CLONE.md) — playbook 30 دقيقة لإطلاق بوت لكل عميل

---

## 📁 بنية المشروع

```
whatsapp-cafe-bot/
├── src/
│   ├── server.js       ← Webhook + شجرة المحادثة + Meta API
│   ├── session.js      ← Sessions في الذاكرة (30 دقيقة TTL)
│   ├── sheets.js       ← قارئ CSV قوي من Google Sheets
│   ├── invoice.js      ← مولّد الفواتير العربية
│   └── orders.js       ← تسجيل الطلبات JSONL
├── test/
│   ├── simulate.js     ← محاكي تفاعلي للـ terminal
│   └── flow.test.js    ← اختبار E2E للتدفق الكامل
├── docs/
│   └── products-template.csv  ← قالب جدول المنتجات
├── data/                ← يُنشأ تلقائياً، يحوي orders.jsonl
├── .env.example         ← قالب المتغيرات (انسخه إلى .env)
├── Dockerfile           ← للنشر على أي منصة
├── railway.toml         ← إعدادات Railway
├── package.json
├── README.md            ← أنت هنا
├── DEPLOYMENT.md        ← دليل النشر التفصيلي
├── CLONE.md             ← دليل استنساخ لعملاء جدد
└── TROUBLESHOOTING.md   ← حلول للمشاكل الشائعة
```

---

## 🛠️ المتغيرات (.env)

| المتغير | مطلوب | الوصف |
|---------|-------|-------|
| `WHATSAPP_TOKEN` | ✅ | Permanent token من Meta Business |
| `WHATSAPP_PHONE_ID` | ✅ | Phone Number ID (15 خانة) |
| `VERIFY_TOKEN` | ✅ | كلمة سرية تخترعها لتأكيد Webhook |
| `OWNER_PHONE` | ✅ | رقم صاحب المتجر (يستقبل إشعارات) |
| `STORE_NAME` | ⬜ | اسم المتجر — يظهر في الرسائل |
| `CURRENCY` | ⬜ | عملة الأسعار (افتراضي: ر.س) |
| `DELIVERY_FEE` | ⬜ | رسوم التوصيل (افتراضي: 10) |
| `WORKING_HOURS_START/END` | ⬜ | أوقات العمل 24h (افتراضي: 8-24) |
| `SHEET_CSV_URL` | ⬜ | رابط Google Sheet (بدونه: منتجات fallback) |
| `META_APP_SECRET` | ⬜ | للتحقق من توقيع Webhook (موصى به في الإنتاج) |
| `PORT` | ⬜ | منفذ الخادم (افتراضي: 3000) |
| `ORDERS_LOG_PATH` | ⬜ | مسار سجل الطلبات (افتراضي: ./data/orders.jsonl) |

---

## 🗺️ شجرة المحادثة

```
       👤 العميل يرسل أي رسالة
                 ↓
         🌟 رسالة ترحيب + 3 أزرار
       [عرض القائمة] [سلتي] [تواصل]
                 ↓
         📋 قائمة الفئات (List)
       [ساخنة] [باردة] [معجنات]
                 ↓
         📋 منتجات الفئة (List) + Pagination
                 ↓
       🖼️ صورة المنتج (اختياري) +
         بطاقة المنتج + 3 أزرار كمية
            [1] [2] [3] أو اكتب رقم
                 ↓
            ✅ تأكيد الإضافة + 3 أزرار
       [إضافة المزيد] [السلة] [إتمام]
                 ↓
              📝 جمع الاسم
                 ↓
              📍 جمع العنوان
                 ↓
            🧾 ملخص الفاتورة + زرين
              [تأكيد] [إلغاء]
                 ↓
            🎉 تأكيد + إشعار للمالك
            💾 حفظ في orders.jsonl
```

---

## 🧪 الاختبار

### محاكي تفاعلي
```bash
npm run simulate
```
يحاكي البوت في الـ terminal — ترسل رسائل وترى ردود البوت بنفس تنسيقها الذي يراه العميل (أزرار، قوائم، نصوص).

### اختبار آلي
```bash
npm test
```
يمر بكل خطوة من البداية للنهاية (welcome → category → product → quantity → cart → checkout → confirm) ويتحقق من 16+ assertion.

---

## 🌐 Endpoints المتاحة

| المسار | الطريقة | الوصف |
|--------|---------|-------|
| `/` | GET | شاشة "أنا حي" |
| `/health` | GET | فحص حياة (Railway/Render) |
| `/webhook` | GET | تأكيد Webhook لـ Meta |
| `/webhook` | POST | استقبال الرسائل من Meta |
| `/orders?token=...` | GET | عرض الطلبات (token = OWNER_PHONE) |

---

## 🔐 الأمان

- ✅ `.env` في `.gitignore` (لا يُرفع لـ Git)
- ✅ Token validation عبر `META_APP_SECRET` (HMAC SHA-256)
- ✅ `/orders` محمي بـ `OWNER_PHONE` كـ shared secret
- ✅ Truncation لكل النصوص حسب حدود WhatsApp (يمنع crashes)
- ✅ Timeout 10s لكل request لـ Meta API
- ✅ Docker يعمل بـ user غير-root

---

## 📜 الترخيص

ملكية المُطوّر. حقوق نسخ المتجر النهائي لصاحب الاشتراك.

---

## 🙋 الدعم

- مشاكل التشغيل → [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
- إعداد كامل لعميل جديد → [`CLONE.md`](./CLONE.md)
- النشر التفصيلي → [`DEPLOYMENT.md`](./DEPLOYMENT.md)

---

*بُني لخدمة المتاجر العربية الصغيرة 🌴*
