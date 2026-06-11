/**
 * Firebase Setup Helper — يطبع أوامر الإعداد بالترتيب الصحيح
 * تشغيل: node scripts/firebase-setup.js
 */

const ENV_VARS = {
  WHATSAPP_TOKEN:      process.env.WHATSAPP_TOKEN      || "YOUR_TOKEN",
  WHATSAPP_PHONE_ID:   process.env.WHATSAPP_PHONE_ID   || "YOUR_PHONE_ID",
  VERIFY_TOKEN:        process.env.VERIFY_TOKEN         || "YOUR_VERIFY_TOKEN",
  OWNER_PHONE:         process.env.OWNER_PHONE          || "YOUR_PHONE",
  STORE_NAME:          process.env.STORE_NAME           || "متجرك",
  CURRENCY:            process.env.CURRENCY             || "ر.س",
  DELIVERY_FEE:        process.env.DELIVERY_FEE         || "10",
  MASTER_PASSWORD:     process.env.MASTER_PASSWORD      || "YOUR_PASSWORD",
  MASTER_TOKEN:        process.env.MASTER_TOKEN         || "YOUR_TOKEN",
  STRIPE_SECRET_KEY:   process.env.STRIPE_SECRET_KEY    || "",
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || "",
};

console.log(`
╔══════════════════════════════════════════════════════════════╗
║         دليل نشر المشروع على Firebase                       ║
╚══════════════════════════════════════════════════════════════╝

━━━ الخطوة 1: أنشئ مشروع Firebase ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1. اذهب إلى: https://console.firebase.google.com
  2. اضغط "إضافة مشروع" → اختر اسماً (مثل: cafe-bot-prod)
  3. فعّل Firestore Database:
     Firestore Database → إنشاء قاعدة بيانات → وضع الإنتاج
  4. فعّل Storage:
     Storage → البدء → وضع الإنتاج
  5. ارفع الخطة لـ Blaze (مجانية تقريباً):
     ⚙️ إعدادات → ترقية → Blaze (ضع بطاقة، لن تُحاسَب للاستخدام المنخفض)

━━━ الخطوة 2: ربط المشروع بالكود ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  # سجّل دخول Firebase
  firebase login

  # اربط المشروع (استبدل PROJECT_ID بمعرّف مشروعك)
  firebase use --add PROJECT_ID

━━━ الخطوة 3: ضبط المتغيرات البيئية ━━━━━━━━━━━━━━━━━━━━━━━━━━

  انسخ الأوامر التالية وشغّلها:

  firebase functions:config:set \\
    bot.whatsapp_token="${ENV_VARS.WHATSAPP_TOKEN}" \\
    bot.whatsapp_phone_id="${ENV_VARS.WHATSAPP_PHONE_ID}" \\
    bot.verify_token="${ENV_VARS.VERIFY_TOKEN}" \\
    bot.owner_phone="${ENV_VARS.OWNER_PHONE}" \\
    bot.store_name="${ENV_VARS.STORE_NAME}" \\
    bot.currency="${ENV_VARS.CURRENCY}" \\
    bot.delivery_fee="${ENV_VARS.DELIVERY_FEE}" \\
    bot.master_password="${ENV_VARS.MASTER_PASSWORD}" \\
    bot.master_token="${ENV_VARS.MASTER_TOKEN}"

  # بعد تسجيل Stripe أضف:
  # firebase functions:config:set \\
  #   bot.stripe_secret_key="sk_live_..." \\
  #   bot.stripe_webhook="whsec_..."

━━━ الخطوة 4: نشر المشروع ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  firebase deploy

  # أو بشكل منفصل:
  firebase deploy --only hosting    # الصفحات فقط
  firebase deploy --only functions  # البوت فقط
  firebase deploy --only firestore  # قواعد البيانات فقط

━━━ الخطوة 5: تحديث webhook URL في Meta ━━━━━━━━━━━━━━━━━━━━━━

  URL الجديد (ثابت للأبد):
  https://YOUR_PROJECT.web.app/webhook

  اذهب لـ Meta Developers → WhatsApp → Configuration
  غيّر Callback URL للرابط أعلاه

━━━ الخطوة 6: ترحيل البيانات الحالية ━━━━━━━━━━━━━━━━━━━━━━━━━

  node scripts/migrate-to-firestore.js

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅ بعد الانتهاء: البوت يعمل على URL ثابت مجاناً للأبد!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

require("dotenv").config();
