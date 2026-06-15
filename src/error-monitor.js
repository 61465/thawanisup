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

const DATA_DIR  = path.join(__dirname, "..", "data");
const RING_SIZE = 100;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 min بين alerts متشابهة

const _ringBuffer  = [];
const _alertedAt   = new Map(); // signature → timestamp آخر alert
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

function capture(err, meta = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    type:      err.name || "Error",
    message:   err.message || String(err),
    stack:     err.stack ? err.stack.split("\n").slice(0, 8).join("\n") : null,
    severity:  meta.severity || "error",
    context:   meta.context || null,
    storeId:   meta.storeId  || null,
    extra:     meta.extra    || null,
  };
  _ringBuffer.push(entry);
  if (_ringBuffer.length > RING_SIZE) _ringBuffer.shift();

  try { fs.appendFileSync(_file(), JSON.stringify(entry) + "\n", "utf8"); }
  catch (e) { console.error("[error-monitor] append failed:", e.message); }

  // alert فقط للأخطاء الحرجة + cooldown لمنع flood
  if (entry.severity === "critical" && _waMgr && _masterPhone) {
    const sig = _signature(err);
    const last = _alertedAt.get(sig) || 0;
    if (Date.now() - last > ALERT_COOLDOWN_MS) {
      _alertedAt.set(sig, Date.now());
      const msg =
        `🚨 *خطأ حرج*\n\n` +
        `النوع: ${entry.type}\n` +
        `الرسالة: ${entry.message.slice(0, 200)}\n` +
        (entry.context ? `السياق: ${entry.context}\n` : "") +
        (entry.storeId ? `المتجر: ${entry.storeId}\n` : "") +
        `الوقت: ${entry.timestamp}`;
      // platform bot كقناة افتراضية لتجنب الاعتماد على متجر معين
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
  return { total: _ringBuffer.length, last24h: recent24.length, bySeverity };
}

module.exports = { install, capture, recent, stats };
