/**
 * Error Monitor — نسخة محلية بسيطة من Sentry (بدون تكلفة).
 *
 * - يلتقط كل uncaughtException + unhandledRejection
 * - يكتب في data/errors-YYYY-MM.jsonl
 * - يرسل WhatsApp alert لـ MASTER_PHONE عند critical errors (throttled)
 * - يحتفظ بآخر 100 خطأ في الذاكرة للوحة /master/errors
 *
 * الاستخدام:
 *   require("./error-monitor").install(waMgr);
 *   errorMonitor.capture(err, { context: "..." });
 */
const fs   = require("fs");
const path = require("path");
const { sanitize, sanitizeStack } = require("./log-sanitizer");

const DATA_DIR  = path.join(__dirname, "..", "data");
const RING_SIZE = 100;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 min بين alerts متشابهة

const _ringBuffer  = [];
const _alertedAt   = new Map(); // signature → timestamp آخر alert
const _errorCounts = new Map(); // signature → { count, firstSeen, lastSeen, sample }
const RATE_LIMIT_PER_MIN = 60; // أكثر من 60 خطأ/دقيقة بنفس التوقيع → drop
const _minuteWindow = new Map(); // signature → { count, windowStart }
let   _waMgr       = null;
let   _masterPhone = null;

function _file() {
  const ym = new Date().toISOString().slice(0, 7);
  return path.join(DATA_DIR, `errors-${ym}.jsonl`);
}

function _signature(err) {
  // top of stack — يحدد ما إذا كان "نفس الخطأ"
  const s = (err.stack || err.message || String(err)).split("\n").slice(0, 2).join(" | ");
  return s.slice(0, 200);
}

// 🎯 Watchlist — متاجر تحت مراقبة مشددة (تنبيه فوري لأي خطأ)
// أضف storeId للقائمة عند تسجيل تاجر جديد لمدة 7 أيام
const WATCHED_STORES = new Set([
  "store_1782268181037",  // مطعم ساروجه — جديد 2026-06-24، أزله بعد 2026-07-01
]);
function _isWatchedStore(storeId) {
  return storeId && WATCHED_STORES.has(storeId);
}

function capture(err, meta = {}) {
  const sig = _signature(err);
  const now = Date.now();

  // 🎯 رفع severity تلقائياً للمتاجر المراقبة (لضمان alert فوري)
  if (_isWatchedStore(meta.storeId) && meta.severity !== "critical") {
    meta.severity = "critical";
    meta.context = (meta.context || "") + " [WATCHED]";
  }

  // 🚦 Rate limiting: لو نفس التوقيع تكرر أكثر من RATE_LIMIT_PER_MIN في دقيقة
  // → نعدّ فقط بدون كتابة على disk (يحمي من log flood يملأ القرص)
  const w = _minuteWindow.get(sig) || { count: 0, windowStart: now };
  if (now - w.windowStart > 60_000) {
    w.count = 0;
    w.windowStart = now;
  }
  w.count++;
  _minuteWindow.set(sig, w);
  const rateLimited = w.count > RATE_LIMIT_PER_MIN;

  // 🗂️ Grouping: عدّ التكرار لكل توقيع
  const group = _errorCounts.get(sig) || { count: 0, firstSeen: new Date(now).toISOString(), lastSeen: null, sample: null };
  group.count++;
  group.lastSeen = new Date(now).toISOString();

  // 🔒 sanitize كل النصوص الحساسة قبل التخزين
  const entry = {
    timestamp: new Date(now).toISOString(),
    type:      err.name || "Error",
    message:   sanitize(err.message || String(err)),
    stack:     err.stack ? sanitizeStack(err.stack.split("\n").slice(0, 8).join("\n")) : null,
    severity:  meta.severity || "error",
    context:   meta.context ? sanitize(meta.context) : null,
    storeId:   meta.storeId  || null,
    extra:     meta.extra    ? sanitize(meta.extra) : null,
    signature: sig.slice(0, 100),
    occurrences: group.count,
  };
  if (!group.sample) group.sample = entry;
  _errorCounts.set(sig, group);

  _ringBuffer.push(entry);
  if (_ringBuffer.length > RING_SIZE) _ringBuffer.shift();

  // اكتب على disk إلا لو rate-limited
  if (!rateLimited) {
    try { fs.appendFileSync(_file(), JSON.stringify(entry) + "\n", "utf8"); }
    catch (e) { console.error("[error-monitor] append failed:", e.message); }
  }

  // alert فقط للأخطاء الحرجة + cooldown لمنع flood
  if (entry.severity === "critical" && _waMgr && _masterPhone) {
    const last = _alertedAt.get(sig) || 0;
    if (now - last > ALERT_COOLDOWN_MS) {
      _alertedAt.set(sig, now);
      const occurStr = group.count > 1 ? `\nالتكرار: *${group.count} مرة* منذ ${group.firstSeen.slice(11,16)}` : "";
      const msg =
        `🚨 *خطأ حرج*\n\n` +
        `النوع: ${entry.type}\n` +
        `الرسالة: ${entry.message.slice(0, 200)}${occurStr}\n` +
        (entry.context ? `السياق: ${entry.context}\n` : "") +
        (entry.storeId ? `المتجر: ${entry.storeId}\n` : "") +
        `الوقت: ${entry.timestamp}`;
      _waMgr.sendMessage("platform", _masterPhone, msg).catch(() => {});
    }
  }
}

function install(waMgr) {
  _waMgr = waMgr;
  _masterPhone = String(process.env.MASTER_PHONE || "").replace(/\D/g, "");
  if (_masterPhone) _masterPhone += "@s.whatsapp.net";

  process.on("uncaughtException", (err) => {
    capture(err, { severity: "critical", context: "uncaughtException" });
    console.error("[uncaught]", err);
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    // ⚠️ تجاهل الأخطاء المعروفة المُعالَجة في الـ queue (تظهر بالفعل في logs بـ "[wa-queue] failed")
    const msg = err.message || "";
    if (/timeout >\d+s|ban-protection|Not connected|not connected/i.test(msg)) {
      // logged بالفعل بشكل أوضح في _enqueueSend — لا تكرّر
      return;
    }
    capture(err, { severity: "critical", context: "unhandledRejection" });
    console.error("[unhandled-rejection]", err);
  });
  console.log("🛡️  Error monitor installed (alerts → MASTER_PHONE)");
}

function recent(limit = 50) {
  return _ringBuffer.slice(-limit).reverse();
}

function stats() {
  const last24h = Date.now() - 24 * 60 * 60 * 1000;
  const recent24 = _ringBuffer.filter(e => new Date(e.timestamp).getTime() > last24h);
  const bySeverity = {};
  for (const e of recent24) bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;
  return {
    total: _ringBuffer.length,
    last24h: recent24.length,
    bySeverity,
    uniqueErrors: _errorCounts.size,
  };
}

// 🗂️ يرجع الأخطاء مُجمّعة بتوقيع — مفيد لـ dashboard
function groupedErrors(limit = 20) {
  return Array.from(_errorCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map(g => ({
      count: g.count,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      type: g.sample?.type,
      message: g.sample?.message?.slice(0, 200),
      context: g.sample?.context,
    }));
}

module.exports = { install, capture, recent, stats, groupedErrors };
