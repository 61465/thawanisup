# أفكار مستقبلية — Future Ideas

أفكار مبرمجة جاهزة للتفعيل متى قرر المشروع توسعتها.

---

## 🤖 AI Bot — Groq + Llama 3.3-70B (`ai-bot.js`)

**الفكرة:** استبدال البوت الكلاسيكي بمحادثة طبيعية بالعامية.  
العميل يكتب بشكل حر → البوت يفهم → يجمع الطلب → يرسل الفاتورة.

**المتطلبات:**
- `GROQ_API_KEY` في `.env` (مجاني من console.groq.com)
- النموذج: `llama-3.3-70b-versatile`

**للتفعيل:**
1. انقل `ai-bot.js` → `src/ai-bot.js`
2. في `server.js`: أضف `const aiBot = require("./ai-bot");`
3. في `handleMessage`: استدعِ `aiBot.handleAIMessage(storeId, from, incoming, store)` قبل المنطق الكلاسيكي
4. في `plans.js`: أضف `aiBotEnabled: true` للباقة التي تريد تفعيله عليها

**ملاحظات:**
- function calling: `send_menu_image` + `submit_order`
- يحفظ سياق المحادثة (24 رسالة)
- يتكامل مع: `logOrder`, `upsertCustomer`, `addPoints`, `generateInvoiceImage`, `generateMenuImage`
