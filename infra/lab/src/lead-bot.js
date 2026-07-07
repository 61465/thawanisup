/**
 * Lead Generation Bot — بوت جمع العملاء المحتملين
 * يعمل على رقم أبو حاتم الحقيقي
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR   = path.join(__dirname, "..", "data");
const LEADS_FILE = path.join(DATA_DIR, "leads.jsonl");

// ─── Session store (phone → lead session) ────────────────────────────────────
const leadSessions = new Map();

// ─── Handed-off phones (bot paused, Abu Hatim handles manually) ───────────────
const handedOff = new Set();

// ─── Save lead ────────────────────────────────────────────────────────────────
function saveLead(lead) {
  const line = JSON.stringify({ ...lead, timestamp: new Date().toISOString() });
  fs.appendFileSync(LEADS_FILE, line + "\n", "utf8");
}

function readLeads() {
  if (!fs.existsSync(LEADS_FILE)) return [];
  return fs.readFileSync(LEADS_FILE, "utf8")
    .split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ─── Package definitions ──────────────────────────────────────────────────────
const PACKAGES = {
  "1": {
    name: "الأساسية 🌱",
    price: "تواصل للاستفسار",
    features: [
      "✅ استقبال الطلبات تلقائياً عبر واتساب",
      "✅ قائمة منتجات تفاعلية",
      "✅ لوحة تحكم لإدارة الطلبات",
      "✅ إشعارات فورية للمالك",
      "❌ صورة فاتورة تلقائية",
      "❌ سجل عملاء VIP",
      "❌ دفع إلكتروني بالفيزا",
    ],
  },
  "2": {
    name: "الاحترافية ⭐",
    price: "تواصل للاستفسار",
    features: [
      "✅ كل مميزات الأساسية",
      "✅ فاتورة صورة تُرسل للعميل تلقائياً",
      "✅ سجل عملاء VIP مع التاريخ الكامل",
      "✅ تقارير المبيعات اليومية",
      "❌ دفع إلكتروني بالفيزا",
    ],
  },
  "3": {
    name: "المتقدمة 👑",
    price: "تواصل للاستفسار",
    features: [
      "✅ كل مميزات الاحترافية",
      "✅ دفع إلكتروني بالفيزا مباشرةً داخل واتساب",
      "✅ ربط كامل مع بوابة الدفع",
      "✅ أولوية الدعم الفني",
    ],
  },
};

// ─── Main handler ─────────────────────────────────────────────────────────────
async function handleLeadMessage(from, text, sendFn, ownerPhone) {
  const msg = (text || "").trim();

  // ── Human Handoff — بعد جمع البيانات أبو حاتم يتولى يدوياً ──────────────────
  if (handedOff.has(from)) {
    // أعد توجيه رسالة العميل لأبو حاتم فقط — لا يرد البوت
    if (ownerPhone && msg) {
      await sendFn(ownerPhone,
        `💬 *رسالة من عميل سابق*\n\n` +
        `📱 الرقم: ${from}\n` +
        `✉️ الرسالة: ${msg}`
      );
    }
    return;
  }

  let session = leadSessions.get(from) || { step: "START" };

  const resetWords = ["مرحبا", "هلا", "ابدأ", "ابدا", "0", "البداية", "رجوع"];
  if (session.step !== "START" && resetWords.includes(msg.toLowerCase())) {
    session = { step: "START" };
    leadSessions.set(from, session);
  }

  // ── START ──
  if (session.step === "START") {
    session = { step: "ASK_NAME" };
    leadSessions.set(from, session);
    await sendFn(from,
      `أهلاً وسهلاً! 👋\n\n` +
      `أنا مساعد *منصة ثواني* لخدمات بوتات واتساب الذكية 🤖\n\n` +
      `قبل أن أريك كيف يمكن لبوتنا أن يُضاعف مبيعاتك...\n\n` +
      `*ما اسمك الكريم؟* 😊`
    );
    return;
  }

  // ── ASK_NAME ──
  if (session.step === "ASK_NAME") {
    session.clientName = msg;
    session.step = "EXPLAIN_BOT";
    leadSessions.set(from, session);
    await sendFn(from,
      `تشرفنا يا *${msg}*! 🎉\n\n` +
      `دعني أشرح لك بسرعة كيف يعمل البوت وكيف سيغير طريقة استقبالك للطلبات 👇\n\n` +
      `🔹 *بدلاً من* أن تستقبل الطلبات يدوياً وتكتب كل شيء بنفسك...\n` +
      `🔸 *البوت يفعل كل شيء تلقائياً:*\n\n` +
      `   📋 يعرض قائمة منتجاتك للعميل\n` +
      `   🛒 يستقبل طلبه ويؤكده\n` +
      `   🔔 يُنبّهك فوراً بكل طلب جديد\n` +
      `   📊 تدير كل الطلبات من لوحة تحكم واضحة\n\n` +
      `النتيجة؟ *توفير وقتك* وعدم ضياع أي طلب حتى وأنت نائم 😴💰\n\n` +
      `اكتب *1* لتعرف الباقات والأسعار ⬇️`
    );
    return;
  }

  // ── EXPLAIN_BOT ──
  if (session.step === "EXPLAIN_BOT") {
    session.step = "SHOW_PACKAGES";
    leadSessions.set(from, session);
    await sendFn(from,
      `رائع! 🚀 إليك *باقاتنا الثلاث:*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🌱 *1. الأساسية*\n` +
      PACKAGES["1"].features.join("\n") + `\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `⭐ *2. الاحترافية*\n` +
      PACKAGES["2"].features.join("\n") + `\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `👑 *3. المتقدمة*\n` +
      PACKAGES["3"].features.join("\n") + `\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `أيّ باقة تناسبك يا *${session.clientName}*؟\n` +
      `اكتب *1* أو *2* أو *3* 👆`
    );
    return;
  }

  // ── SHOW_PACKAGES ──
  if (session.step === "SHOW_PACKAGES") {
    const pkg = PACKAGES[msg];
    if (!pkg) {
      await sendFn(from, `اختر رقماً من 1 إلى 3 فقط 🙏\n1️⃣ الأساسية\n2️⃣ الاحترافية\n3️⃣ المتقدمة`);
      return;
    }
    session.packageChoice = pkg.name;
    session.packageKey = msg;
    session.step = "ASK_STORE";
    leadSessions.set(from, session);
    await sendFn(from,
      `اختيار ممتاز! ${pkg.name} 👍\n\n` +
      `ما اسم متجرك أو مطعمك أو مشروعك؟ 🏪`
    );
    return;
  }

  // ── ASK_STORE ──
  if (session.step === "ASK_STORE") {
    session.storeName = msg;
    session.step = "ASK_NOTES";
    leadSessions.set(from, session);
    await sendFn(from,
      `هل عندك أي متطلبات خاصة أو أسئلة؟\n_(مثلاً: عدد المنتجات، التوصيل، الدفع، إلخ)_\n\n` +
      `أو اكتب *"لا"* إذا ما عندك إضافات`
    );
    return;
  }

  // ── ASK_NOTES ──
  if (session.step === "ASK_NOTES") {
    session.notes = (msg === "لا" || msg === "لا يوجد") ? "" : msg;
    session.step = "DONE";
    session.phone = from;
    leadSessions.set(from, session);

    saveLead({
      phone:         from,
      clientName:    session.clientName,
      storeName:     session.storeName,
      packageChoice: session.packageChoice,
      packageKey:    session.packageKey,
      notes:         session.notes,
    });

    // تسليم المحادثة لأبو حاتم — البوت لا يتدخل بعد الآن لهذا العميل
    handedOff.add(from);

    await sendFn(from,
      `شكراً لك يا *${session.clientName}*! ✅\n\n` +
      `*تم تسجيل طلبك بنجاح* 🎉\n\n` +
      `📋 *ملخص طلبك:*\n` +
      `👤 الاسم: ${session.clientName}\n` +
      `🏪 المتجر: ${session.storeName}\n` +
      `📦 الباقة: ${session.packageChoice}\n` +
      (session.notes ? `📝 ملاحظات: ${session.notes}\n` : ``) +
      `\n` +
      `سيتواصل معك *فريق ثواني* خلال ساعات قليلة إن شاء الله 🙏\n\n` +
      `للتواصل الفوري: wa.me/966508572902`
    );

    if (ownerPhone) {
      await sendFn(ownerPhone,
        `🔔 *عميل محتمل جديد!*\n\n` +
        `👤 الاسم: ${session.clientName}\n` +
        `📱 الرقم: ${from}\n` +
        `🏪 المتجر: ${session.storeName}\n` +
        `📦 الباقة المطلوبة: ${session.packageChoice}\n` +
        `📝 ملاحظات: ${session.notes || "—"}\n\n` +
        `تواصل معه الآن 👆`
      );
    }
    return;
  }

}

module.exports = { handleLeadMessage, readLeads };
