/**
 * Platform Bot — بوت منصة أبو حاتم لجمع بيانات العملاء الجدد
 * يعمل على رقم المنصة المخصص (PLATFORM_PHONE_ID)
 * يجمع المعلومات ويسلّمها لأبو حاتم — لا يُنشئ حساب تلقائياً
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR          = path.join(__dirname, "..", "data");
const PLATFORM_LEADS_FILE = path.join(DATA_DIR, "platform-leads.jsonl");
const OWNER_SETTINGS_FILE = path.join(DATA_DIR, "owner-settings.json");

// ─── Session store ────────────────────────────────────────────────────────────
const platformSessions = new Map();

// ─── Human handoff (أبو حاتم يتولى يدوياً بعد جمع البيانات) ─────────────────
const handedOff = new Set();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readOwnerSettings() {
  try {
    if (!fs.existsSync(OWNER_SETTINGS_FILE)) return null;
    return JSON.parse(fs.readFileSync(OWNER_SETTINGS_FILE, "utf8"));
  } catch { return null; }
}

function saveLead(lead) {
  const line = JSON.stringify({ ...lead, timestamp: new Date().toISOString() });
  fs.appendFileSync(PLATFORM_LEADS_FILE, line + "\n", "utf8");
}

// ─── Business types ───────────────────────────────────────────────────────────
const BUSINESS_TYPES = {
  "1": "مطعم 🍽️",
  "2": "كافيه ☕",
  "3": "محل بقالة 🛒",
  "4": "مخبز 🥐",
  "5": "متجر ملابس 👕",
  "6": "أخرى",
};

// ─── Build plans message using current prices ─────────────────────────────────
function buildPlansMessage() {
  const settings = readOwnerSettings();
  const prices   = settings?.planPrices || { starter: 80, pro: 150, premium: 250 };
  const currency = "ر.س";

  return (
    `إليك *باقاتنا الثلاث:* 📦\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🌱 *1. الأساسية — ${prices.starter} ${currency}/شهر*\n` +
    `✅ استقبال الطلبات تلقائياً عبر واتساب\n` +
    `✅ قائمة منتجات تفاعلية\n` +
    `✅ لوحة تحكم لإدارة الطلبات\n` +
    `✅ إشعارات فورية للمالك\n` +
    `❌ فواتير صور تلقائية\n` +
    `❌ سجل عملاء VIP\n` +
    `❌ دفع إلكتروني\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⭐ *2. الاحترافية — ${prices.pro} ${currency}/شهر*\n` +
    `✅ كل مميزات الأساسية\n` +
    `✅ فاتورة صورة تُرسل للعميل تلقائياً\n` +
    `✅ سجل عملاء VIP مع تاريخ كامل\n` +
    `✅ تقارير المبيعات اليومية\n` +
    `❌ دفع إلكتروني بالفيزا\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👑 *3. المتقدمة — ${prices.premium} ${currency}/شهر*\n` +
    `✅ كل مميزات الاحترافية\n` +
    `✅ دفع إلكتروني بالفيزا مباشرةً\n` +
    `✅ ربط كامل مع بوابة الدفع\n` +
    `✅ أولوية الدعم الفني 24/7\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `اكتب رقم الباقة التي تناسبك:\n` +
    `*1* — الأساسية\n*2* — الاحترافية\n*3* — المتقدمة`
  );
}

// ─── Main handler ─────────────────────────────────────────────────────────────
async function handlePlatformMessage(from, text, sendFn, ownerPhone) {
  const msg = (text || "").trim();

  // Human handoff — forward to Abu Hatim, bot stays silent
  if (handedOff.has(from)) {
    if (ownerPhone && msg) {
      await sendFn(ownerPhone,
        `💬 *رسالة متابعة من عميل*\n\n` +
        `📱 الرقم: ${from}\n` +
        `✉️ الرسالة: ${msg}`
      );
    }
    return;
  }

  let session = platformSessions.get(from) || { step: "START" };

  // Reset words
  const resetWords = ["مرحبا", "هلا", "ابدأ", "ابدا", "0", "البداية", "رجوع", "مرحباً"];
  if (session.step !== "START" && resetWords.includes(msg.toLowerCase())) {
    session = { step: "START" };
    platformSessions.set(from, session);
  }

  // ── START ──
  if (session.step === "START") {
    session = { step: "ASK_NAME" };
    platformSessions.set(from, session);
    await sendFn(from,
      `أهلاً وسهلاً! 👋\n\n` +
      `أنا *بوت منصة واتساب بزنس* 🤖\n\n` +
      `نساعد المطاعم والكافيهات والمحلات على *استقبال الطلبات تلقائياً* عبر واتساب — بدون أي تعقيد!\n\n` +
      `💡 *كيف يعمل البوت؟*\n` +
      `• العميل يكتب للرقم → البوت يعرض القائمة\n` +
      `• يختار ويطلب → أنت تستقبل الطلب فوراً\n` +
      `• كل شيء منظم في لوحة تحكم واضحة\n\n` +
      `دعني آخذ بعض المعلومات لأقترح لك الباقة المناسبة 😊\n\n` +
      `*ما اسمك الكريم؟*`
    );
    return;
  }

  // ── ASK_NAME ──
  if (session.step === "ASK_NAME") {
    session.clientName = msg;
    session.step = "ASK_BUSINESS_NAME";
    platformSessions.set(from, session);
    await sendFn(from,
      `تشرفنا يا *${msg}*! 🎉\n\n` +
      `*ما اسم مشروعك أو متجرك؟*\n` +
      `_(مثلاً: كافيه النخيل، مطعم الشام، بقالة الأهل)_`
    );
    return;
  }

  // ── ASK_BUSINESS_NAME ──
  if (session.step === "ASK_BUSINESS_NAME") {
    session.businessName = msg;
    session.step = "ASK_BUSINESS_TYPE";
    platformSessions.set(from, session);
    await sendFn(from,
      `*${msg}* — اسم رائع! 👏\n\n` +
      `ما نوع مشروعك؟\n\n` +
      `1️⃣ مطعم\n` +
      `2️⃣ كافيه\n` +
      `3️⃣ محل بقالة\n` +
      `4️⃣ مخبز\n` +
      `5️⃣ متجر ملابس\n` +
      `6️⃣ أخرى\n\n` +
      `اكتب رقم النوع:`
    );
    return;
  }

  // ── ASK_BUSINESS_TYPE ──
  if (session.step === "ASK_BUSINESS_TYPE") {
    const btype = BUSINESS_TYPES[msg];
    if (!btype) {
      await sendFn(from, `اختر رقماً من 1 إلى 6 فقط 🙏\n1- مطعم\n2- كافيه\n3- بقالة\n4- مخبز\n5- ملابس\n6- أخرى`);
      return;
    }
    session.businessType = btype;
    session.step = "ASK_CITY";
    platformSessions.set(from, session);
    await sendFn(from,
      `ممتاز! 👍\n\n` +
      `*في أي مدينة يقع مشروعك؟*\n` +
      `_(مثلاً: الرياض، جدة، مكة، الدمام)_`
    );
    return;
  }

  // ── ASK_CITY ──
  if (session.step === "ASK_CITY") {
    session.city = msg;
    session.step = "SHOW_PLANS";
    platformSessions.set(from, session);
    await sendFn(from, buildPlansMessage());
    return;
  }

  // ── SHOW_PLANS ──
  if (session.step === "SHOW_PLANS") {
    const planMap = { "1": "starter", "2": "pro", "3": "premium" };
    const planNameMap = { "1": "الأساسية 🌱", "2": "الاحترافية ⭐", "3": "المتقدمة 👑" };
    const planKey = planMap[msg];
    if (!planKey) {
      await sendFn(from, `اختر *1* أو *2* أو *3* فقط 🙏`);
      return;
    }
    session.planKey  = planKey;
    session.planName = planNameMap[msg];
    session.step = "ASK_BOT_PHONE";
    platformSessions.set(from, session);
    await sendFn(from,
      `اختيار ممتاز! *${session.planName}* 👍\n\n` +
      `*ما رقم الواتساب الذي تريد تشغيل البوت عليه؟*\n\n` +
      `📌 يجب أن يكون رقماً مسجلاً في واتساب\n` +
      `📌 اكتبه مع كود الدولة (مثال: 966501234567)`
    );
    return;
  }

  // ── ASK_BOT_PHONE ──
  if (session.step === "ASK_BOT_PHONE") {
    const cleaned = msg.replace(/[\s\+\-]/g, "");
    if (!/^\d{10,15}$/.test(cleaned)) {
      await sendFn(from, `الرجاء إدخال رقم صحيح مع كود الدولة\nمثال: 966501234567 أو 201012345678`);
      return;
    }
    session.botPhone = cleaned;
    session.step = "ASK_NOTES";
    platformSessions.set(from, session);
    await sendFn(from,
      `تم تسجيل الرقم ✅\n\n` +
      `هل عندك أي متطلبات خاصة أو أسئلة؟\n` +
      `_(مثلاً: عدد المنتجات، التوصيل، العروض، الدفع الإلكتروني)_\n\n` +
      `أو اكتب *"لا"* إذا ما عندك إضافات`
    );
    return;
  }

  // ── ASK_NOTES ──
  if (session.step === "ASK_NOTES") {
    session.notes = (msg === "لا" || msg === "لا يوجد") ? "" : msg;
    session.step = "CONFIRM";
    platformSessions.set(from, session);

    const settings = readOwnerSettings();
    const prices   = settings?.planPrices || { starter: 80, pro: 150, premium: 250 };
    const priceKey = session.planKey;
    const price    = prices[priceKey] || "—";

    await sendFn(from,
      `*ملخص طلبك* 📋\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 الاسم: *${session.clientName}*\n` +
      `🏪 المشروع: *${session.businessName}*\n` +
      `🏷️ النوع: *${session.businessType}*\n` +
      `📍 المدينة: *${session.city}*\n` +
      `📦 الباقة: *${session.planName}*\n` +
      `💰 السعر: *${price} ر.س/شهر*\n` +
      `📱 رقم البوت: *${session.botPhone}*\n` +
      (session.notes ? `📝 ملاحظات: *${session.notes}*\n` : ``) +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `هل المعلومات صحيحة؟\n` +
      `اكتب *نعم* للتأكيد أو *لا* للتعديل`
    );
    return;
  }

  // ── CONFIRM ──
  if (session.step === "CONFIRM") {
    const confirmed = ["نعم", "yes", "اكيد", "أكيد", "صح", "تمام"].includes(msg.toLowerCase());
    const rejected  = ["لا", "no", "تعديل", "عدل"].includes(msg.toLowerCase());

    if (!confirmed && !rejected) {
      await sendFn(from, `اكتب *نعم* للتأكيد أو *لا* للتعديل 🙏`);
      return;
    }

    if (rejected) {
      // Restart from business name
      session = { step: "ASK_NAME", clientName: session.clientName };
      platformSessions.set(from, session);
      await sendFn(from,
        `لا مشكلة! 😊 لنبدأ من جديد.\n\n` +
        `*ما اسمك الكريم؟*`
      );
      return;
    }

    // Confirmed — save and handoff
    session.step = "DONE";
    session.phone = from;
    platformSessions.set(from, session);

    saveLead({
      phone:        from,
      clientName:   session.clientName,
      businessName: session.businessName,
      businessType: session.businessType,
      city:         session.city,
      planKey:      session.planKey,
      planName:     session.planName,
      botPhone:     session.botPhone,
      notes:        session.notes,
    });

    handedOff.add(from);

    await sendFn(from,
      `شكراً جزيلاً يا *${session.clientName}*! ✅\n\n` +
      `*تم تسجيل طلبك بنجاح* 🎉\n\n` +
      `سيتواصل معك فريقنا *خلال 24 ساعة* إن شاء الله لإتمام الإعداد.\n\n` +
      `📋 *رقم طلبك محفوظ*\n` +
      `للاستفسار: wa.me/966508572902\n\n` +
      `نتمنى لك أرباحاً وفيرة مع بوتك الجديد 🚀`
    );

    if (ownerPhone) {
      const settings = readOwnerSettings();
      const prices   = settings?.planPrices || { starter: 80, pro: 150, premium: 250 };
      const price    = prices[session.planKey] || "—";

      await sendFn(ownerPhone,
        `🔔 *طلب اشتراك جديد!*\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 الاسم: *${session.clientName}*\n` +
        `📱 رقمه: *${from}*\n` +
        `🏪 المشروع: *${session.businessName}*\n` +
        `🏷️ النوع: *${session.businessType}*\n` +
        `📍 المدينة: *${session.city}*\n` +
        `📦 الباقة: *${session.planName}*\n` +
        `💰 القيمة: *${price} ر.س/شهر*\n` +
        `📱 رقم البوت: *${session.botPhone}*\n` +
        (session.notes ? `📝 ملاحظات: *${session.notes}*\n` : ``) +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `تواصل معه الآن لإتمام الإعداد 👆`
      );
    }
    return;
  }
}

function readPlatformLeads() {
  if (!fs.existsSync(PLATFORM_LEADS_FILE)) return [];
  return fs.readFileSync(PLATFORM_LEADS_FILE, "utf8")
    .split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

module.exports = { handlePlatformMessage, readPlatformLeads };
