/**
 * Bot Outage Monitor — يراقب انقطاع جلسات بوتات المتاجر ويُخطر المالك
 *
 * كل دقيقتين:
 *   1) يفحص كل جلسات الواتساب
 *   2) لو جلسة متجر active انتقلت من open → closed/disconnected/timeout
 *   3) ينتظر 5 دقائق grace (لتفادي ضوضاء reconnect السريع)
 *   4) لو ما رجعت → يرسل تحذير للمالك من بوت platform
 *   5) لا يرسل أكثر من تحذير واحد كل 6 ساعات لنفس المتجر
 */

const fs   = require("fs");
const path = require("path");
const waMgr = require("./whatsapp-manager");

const DATA_DIR    = path.join(__dirname, "..", "data");
const STORES_FILE = path.join(DATA_DIR, "stores.json");

const TICK_MS         = 2 * 60 * 1000;       // فحص كل دقيقتين
const GRACE_MS        = 5 * 60 * 1000;       // 5 دقائق إنذار قبل التحذير
const REWARN_COOLDOWN = 6 * 60 * 60 * 1000;  // 6 ساعات بين التحذيرات

// حالة في الذاكرة فقط (تُنشأ من جديد عند إعادة التشغيل)
const _firstSeenDown = new Map(); // storeId → timestamp
const _lastWarned    = new Map(); // storeId → timestamp

function _readStores() {
  try { return JSON.parse(fs.readFileSync(STORES_FILE, "utf8")).stores || []; }
  catch { return []; }
}

function _pickSenderBot() {
  const sessions = waMgr.listSessions();
  return sessions.find(s => s.storeId === "platform" && s.status === "open")
      || sessions.find(s => s.storeId === "lead"     && s.status === "open")
      || null;
}

async function _notifyOwner(store, reason) {
  const phone = String(store.ownerPhone || "").replace(/\D/g, "");
  if (!phone) return false;
  const sender = _pickSenderBot();
  if (!sender) return false;
  const jid = phone + "@s.whatsapp.net";

  const reasons = {
    "logged_out":     "تم تسجيل الخروج من الواتساب (تم فتح الواتساب على جهاز آخر؟)",
    "disconnected":   "انقطع اتصال البوت بالواتساب",
    "timeout":        "انتهت مهلة اتصال البوت",
    "unknown":        "حدث عطل غير معروف في البوت",
  };
  const reasonText = reasons[reason] || reasons.unknown;

  const msg =
`🚨 *تنبيه: بوت متجرك متوقف*

عزيزنا تاجر *${store.storeName || store.id}*،

نلفت انتباهك أن بوت الواتساب الخاص بمتجرك *لا يعمل حالياً*.

📋 *السبب المحتمل:*
${reasonText}

⏰ منذ متى؟ منذ ${Math.round((Date.now() - (_firstSeenDown.get(store.id) || Date.now())) / 60000)} دقيقة تقريباً

🔧 *الحل السريع:*
1. ادخل لوحة التحكم
2. اذهب إلى *📱 ربط واتساب*
3. اضغط *إعادة الربط* وامسح الـ QR

❓ *لا تنزعج* — بياناتك ومتجرك وكل الطلبات محفوظة. فقط البوت محتاج إعادة ربط.

للدعم: wa.me/966508572902

نعتذر عن أي إزعاج 🌹
*منصة ثواني*`;

  try {
    await waMgr.sendMessage(sender.storeId, jid, msg, { allowCold: true, reason: "bot_outage_alert" });
    _lastWarned.set(store.id, Date.now());
    console.log(`🚨 [bot-outage] alert sent to ${store.id} (${store.storeName}) — reason: ${reason}`);
    return true;
  } catch (e) {
    console.warn(`[bot-outage] notify failed for ${store.id}:`, e.message);
    return false;
  }
}

async function runTick() {
  const stores = _readStores();
  if (!stores.length) return;
  const sessions = waMgr.listSessions();
  const sessByStore = {};
  sessions.forEach(s => { sessByStore[s.storeId] = s; });

  const now = Date.now();

  for (const store of stores) {
    // نراقب فقط المتاجر النشطة المشتركة
    if (store.active === false || store.subscriptionStatus !== "active") {
      _firstSeenDown.delete(store.id);
      continue;
    }
    const sess = sessByStore[store.id];
    const isHealthy = sess && sess.status === "open";

    if (isHealthy) {
      // المتجر متصل — امسح أي علم سابق
      _firstSeenDown.delete(store.id);
      continue;
    }

    // المتجر غير متصل — سجّل الوقت لو ما سجّلناه
    if (!_firstSeenDown.has(store.id)) {
      _firstSeenDown.set(store.id, now);
      continue;
    }

    // مرّ على الانقطاع grace period؟
    const downSince = _firstSeenDown.get(store.id);
    if (now - downSince < GRACE_MS) continue;

    // تحذرنا مؤخراً؟
    const lastWarn = _lastWarned.get(store.id) || 0;
    if (now - lastWarn < REWARN_COOLDOWN) continue;

    // حدد السبب من حالة الجلسة
    let reason = "unknown";
    if (sess) {
      const st = String(sess.status || "").toLowerCase();
      if (st.includes("logged_out") || st.includes("loggedout")) reason = "logged_out";
      else if (st.includes("disconnect") || st.includes("close")) reason = "disconnected";
      else if (st.includes("timeout")) reason = "timeout";
    } else {
      reason = "disconnected";
    }

    await _notifyOwner(store, reason);
  }
}

let _timer = null;
function start() {
  if (_timer) return;
  // أول فحص بعد دقيقتين (لإعطاء الـ sessions فرصة boot كاملة)
  setTimeout(() => runTick().catch(e => console.warn("[bot-outage] boot tick:", e.message)), 2 * 60 * 1000);
  _timer = setInterval(() => {
    runTick().catch(e => console.warn("[bot-outage] tick:", e.message));
  }, TICK_MS);
  console.log("🚨 [bot-outage-monitor] active — يفحص كل دقيقتين (grace 5د، cooldown 6س)");
}

function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, stop, runTick };
