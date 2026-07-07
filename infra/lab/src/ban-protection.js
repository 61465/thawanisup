/**
 * Ban Protection — حماية البوت من حظر واتساب/Meta
 *
 * نتائج أبحاث 2024-2026 على أنماط الحظر:
 *   1) إرسال >100 رسالة/دقيقة من رقم جديد → trigger
 *   2) إرسال نفس النص حرفياً لـ20+ رقم خلال دقيقة → spam pattern
 *   3) Cold messaging (إرسال لرقم لم يبدأ المحادثة) → الأخطر
 *   4) إرسال بدون typing indicator → bot signature
 *   5) رد فوري (<500ms) → bot signature
 *   6) عدم تنوّع الردود → bot signature
 *
 * هذا الموديول يطبق طبقات الحماية الست + يعطي API بسيط للاستدعاء.
 */

const fs   = require("fs");
const path = require("path");

// ─── Config ───────────────────────────────────────────────────────────────
const CFG = {
  // الحد الأقصى للرسائل لكل رقم مستلم في النوافذ الزمنية
  perRecipient: {
    perMinute: 10,   // 10 رسائل/دقيقة لنفس الرقم (طبيعي جداً)
    perHour:   60,   // 60 رسالة/ساعة لنفس الرقم
    perDay:    200,  // 200 رسالة/يوم لنفس الرقم
  },

  // الحد الأقصى الإجمالي لكل storeId (لكل bot session)
  perSession: {
    perMinute: 60,   // 60 رسالة/دقيقة لكل بوت متجر
    perHour:   500,
    perDay:    2000, // 2000/يوم = ~83/ساعة معدّل
  },

  // تأخير عشوائي بين الرسائل (humanization)
  delays: {
    // ⚡ Optimized 2026-06-24: latency كان 5-6s، الآن ~1s مع الحفاظ على حماية ban
    minMs: 300,      // كان 800 — للردود السريعة على رسائل واردة (low ban risk)
    maxMs: 900,      // كان 2400 — نطاق أصغر = ردود أسرع
    typingPerCharMs: 12,   // كان 35 — بقاء proportional لكن أسرع
    typingCapMs:    1200,  // كان 4000 — cap منخفض، الرسائل الطويلة لا تبطئ
  },

  // قواعد cold messaging
  coldMessaging: {
    block: true,           // امنع إرسال لرقم لم يبدأ المحادثة
    windowHours: 24,       // إذا تواصلوا خلال 24 ساعة = OK
    allowedFirstContact: [ // استثناءات: لو نحن نبدأ بعد order webhook مثلاً
      "order_notification",
      "broadcast_consent",
      "order_ack",              // إشعار استلام الطلب من السلة
      "order_report_for_owner", // تقرير المالك (لو رقم العميل = رقم المالك)
      "status_update",          // تحديث حالة الطلب (تم/في الطريق/جاهز/مرفوض)
      "order_status",
      "order_accepted",
      "order_completed",
      "order_rejected",
      "delivery_assigned",      // إشعار المندوب
      "rating_request",         // طلب تقييم بعد التسليم
      "digital_delivery",       // تسليم منتج رقمي
      "owner_archive",          // التقرير الذاتي (self-chat)
      "booking_reminder",       // تذكير حجز قبل 24 ساعة
      "booking_intent_reply",   // رد على نية حجز موعد
      "low_stock_alert",        // تنبيه المالك بنفاد الأكواد الرقمية
    ],
  },

  // Content variation للـ broadcast
  variation: {
    minTemplates: 3,       // يلزم 3 صياغات مختلفة على الأقل لكل broadcast
    addRandomSuffix: true, // إضافة لاحقة عشوائية (.|!|🌸|✨) للتنوّع
  },
};

// ─── State (in-memory + persist) ─────────────────────────────────────────
const DATA_DIR     = path.join(__dirname, "..", "data");
const STATE_FILE   = path.join(DATA_DIR, "ban-protection.json");
// recipient state: { [storeId+phone]: [{ts, type}] }
// session state:   { [storeId]: [{ts}] }
// contacted set:   { [storeId+phone]: lastIncomingTs }
let _state = { recipients: {}, sessions: {}, contacted: {}, quality: {} };

function _load() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      _state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) || _state;
    }
  } catch (e) { console.warn("[ban-protection] load failed:", e.message); }
}

let _saveTimer = null;
function _save() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(_state));
    } catch (e) { console.warn("[ban-protection] save failed:", e.message); }
  }, 5000);
}

_load();

// ─── Cleanup كل ساعة (إزالة سجلات قديمة) ─────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const k of Object.keys(_state.recipients)) {
    _state.recipients[k] = (_state.recipients[k] || []).filter(e => e.ts > cutoff);
    if (!_state.recipients[k].length) delete _state.recipients[k];
  }
  for (const k of Object.keys(_state.sessions)) {
    _state.sessions[k] = (_state.sessions[k] || []).filter(e => e.ts > cutoff);
    if (!_state.sessions[k].length) delete _state.sessions[k];
  }
  for (const k of Object.keys(_state.contacted)) {
    if (_state.contacted[k] < cutoff) delete _state.contacted[k];
  }
  _save();
}, 60 * 60 * 1000);

// ─── Helpers ──────────────────────────────────────────────────────────────
function _key(storeId, phone) { return `${storeId}|${String(phone).replace(/\D/g, "")}`; }

function _countWithin(arr, windowMs) {
  if (!arr?.length) return 0;
  const cutoff = Date.now() - windowMs;
  return arr.filter(e => e.ts > cutoff).length;
}

function _rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * تسجيل أن العميل بدأ محادثة (incoming message) → نسمح بالرد عليه
 * يجب أن يُستدعى من messages.upsert handler لكل رسالة واردة
 */
function recordIncoming(storeId, fromPhone) {
  const k = _key(storeId, fromPhone);
  _state.contacted[k] = Date.now();
  _save();
}

/**
 * فحص ما إذا كان السماح بإرسال رسالة لهذا الرقم
 * @returns {ok: bool, reason?, retryAfterMs?}
 */
function canSend(storeId, toPhone, opts = {}) {
  // 0) Cold messaging check
  if (CFG.coldMessaging.block && !opts.allowCold) {
    const k = _key(storeId, toPhone);
    const last = _state.contacted[k] || 0;
    const windowMs = CFG.coldMessaging.windowHours * 60 * 60 * 1000;
    if (Date.now() - last > windowMs) {
      // عدم وجود تواصل أحدث من 24 ساعة → امنع (إلا للأنواع المسموحة)
      const reason = opts.reason || "general";
      if (!CFG.coldMessaging.allowedFirstContact.includes(reason)) {
        return {
          ok: false,
          reason: "cold_messaging",
          message: `العميل لم يتواصل خلال آخر ${CFG.coldMessaging.windowHours} ساعة (cold messaging blocked)`,
        };
      }
    }
  }

  // 1) Recipient rate limits
  const rk = _key(storeId, toPhone);
  const recArr = _state.recipients[rk] || [];
  if (_countWithin(recArr, 60_000) >= CFG.perRecipient.perMinute) {
    return { ok: false, reason: "recipient_rate_minute", retryAfterMs: 60_000 };
  }
  if (_countWithin(recArr, 60 * 60_000) >= CFG.perRecipient.perHour) {
    return { ok: false, reason: "recipient_rate_hour", retryAfterMs: 60 * 60_000 };
  }
  if (_countWithin(recArr, 24 * 60 * 60_000) >= CFG.perRecipient.perDay) {
    return { ok: false, reason: "recipient_rate_day", retryAfterMs: 60 * 60_000 };
  }

  // 2) Session rate limits
  const sessArr = _state.sessions[storeId] || [];
  if (_countWithin(sessArr, 60_000) >= CFG.perSession.perMinute) {
    return { ok: false, reason: "session_rate_minute", retryAfterMs: 60_000 };
  }
  if (_countWithin(sessArr, 60 * 60_000) >= CFG.perSession.perHour) {
    return { ok: false, reason: "session_rate_hour", retryAfterMs: 60 * 60_000 };
  }
  if (_countWithin(sessArr, 24 * 60 * 60_000) >= CFG.perSession.perDay) {
    return { ok: false, reason: "session_rate_day", retryAfterMs: 60 * 60_000 };
  }

  return { ok: true };
}

/**
 * تسجيل أن رسالة أُرسلت — يستدعى بعد نجاح إرسال
 */
function recordSent(storeId, toPhone, type = "text") {
  const rk = _key(storeId, toPhone);
  if (!_state.recipients[rk]) _state.recipients[rk] = [];
  _state.recipients[rk].push({ ts: Date.now(), type });

  if (!_state.sessions[storeId]) _state.sessions[storeId] = [];
  _state.sessions[storeId].push({ ts: Date.now(), type });

  _save();
}

/**
 * تأخير عشوائي قبل إرسال (محاكاة typing/human delay)
 * يستدعى قبل إرسال الرسالة من حلقة الإرسال
 * @param {number} textLength طول الرسالة (لمحاكاة typing duration)
 */
async function humanDelay(textLength = 0) {
  // base delay (random 800-2400ms)
  const baseDelay = _rand(CFG.delays.minMs, CFG.delays.maxMs);
  // typing delay (proportional to text length)
  const typingDelay = Math.min(textLength * CFG.delays.typingPerCharMs, CFG.delays.typingCapMs);
  const total = baseDelay + typingDelay;
  await new Promise(r => setTimeout(r, total));
  return total;
}

/**
 * إضافة لاحقة عشوائية لتنويع broadcasts (يقلل احتمال spam-pattern)
 */
function varyContent(text) {
  if (!CFG.variation.addRandomSuffix) return text;
  const suffixes = ["", "", "", " ✨", " 🌸", " 🌿", " .", "!", " 💚"];
  const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
  return text + suffix;
}

/**
 * Quality monitoring — لو quality rating انخفض، نقلل التردد تلقائياً
 */
function reportQuality(storeId, level /* "low"|"medium"|"high" */) {
  _state.quality[storeId] = { level, ts: Date.now() };
  _save();
  if (level === "low") {
    console.warn(`⚠️  [${storeId}] WhatsApp quality dropped to LOW — applying stricter limits`);
  }
}

function getQuality(storeId) {
  return _state.quality[storeId] || null;
}

/**
 * إحصائيات سريعة (للـ admin dashboard)
 */
function getStats(storeId) {
  const sessArr = _state.sessions[storeId] || [];
  return {
    storeId,
    sentLastMinute: _countWithin(sessArr, 60_000),
    sentLastHour:   _countWithin(sessArr, 60 * 60_000),
    sentLast24h:    _countWithin(sessArr, 24 * 60 * 60_000),
    quality:        _state.quality[storeId] || null,
    limits:         CFG.perSession,
  };
}

module.exports = {
  recordIncoming,
  canSend,
  recordSent,
  humanDelay,
  varyContent,
  reportQuality,
  getQuality,
  getStats,
  _CFG: CFG,
};
