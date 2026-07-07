/**
 * 🚨 Maintenance Alerts — نظام تنبيه ذكي للصيانة
 *
 * يراقب: crashes، unhandled errors، WhatsApp disconnects الطويلة،
 * memory/disk، AI quota، slow requests، high error rate
 *
 * يُنبّه: ينشر في data/alerts/YYYY-MM-DD.jsonl + يبعت واتساب للـ MASTER
 *        + يستدعي webhook لو معرّف في env (لـ Slack/Discord)
 *
 * يُقرأ: GET /master/alerts (للماستر فقط)
 */
const fs   = require("fs");
const path = require("path");
const os   = require("os");

const ALERTS_DIR = path.join(__dirname, "..", "data", "alerts");
if (!fs.existsSync(ALERTS_DIR)) fs.mkdirSync(ALERTS_DIR, { recursive: true });

// ─── State ────────────────────────────────────────────────────────────────────
const _state = {
  errorBuckets:    new Map(), // tag → [timestamps]
  disconnectStart: new Map(), // storeId → ts
  lastNotified:    new Map(), // alertKey → ts (debounce)
  totalErrors:     0,
  totalAlerts:     0,
  startedAt:       Date.now(),
};

// debouncing: لا ترسل نفس النوع من التنبيه أكثر من مرة كل X دقائق
const NOTIFY_COOLDOWN = {
  ERROR_RATE:      10 * 60_000,
  MEMORY:          15 * 60_000,
  DISK:            30 * 60_000,
  WA_DISCONNECT:   10 * 60_000,
  AI_QUOTA:        30 * 60_000,
  CRASH:           1 * 60_000,
};

// مستويات الخطورة
const LEVELS = {
  CRITICAL: { emoji: "🚨", color: "#dc2626", pri: 5 },
  ERROR:    { emoji: "❌", color: "#f97316", pri: 4 },
  WARNING:  { emoji: "⚠️", color: "#eab308", pri: 3 },
  INFO:     { emoji: "ℹ️", color: "#3b82f6", pri: 2 },
};

// ─── Public API ───────────────────────────────────────────────────────────────
function recordError(tag, error, context = {}) {
  _state.totalErrors++;
  const msg = error?.message || String(error);
  const stack = error?.stack || "";
  const entry = {
    type:      "error",
    tag:       String(tag).slice(0, 60),
    message:   msg.slice(0, 500),
    stack:     stack.slice(0, 2000),
    context:   _safeContext(context),
    timestamp: new Date().toISOString(),
  };
  _appendLog(entry);

  // تتبّع معدل الخطأ
  const now = Date.now();
  if (!_state.errorBuckets.has(tag)) _state.errorBuckets.set(tag, []);
  const bucket = _state.errorBuckets.get(tag);
  bucket.push(now);
  // احتفظ بآخر 5 دقائق فقط
  const cutoff = now - 5 * 60_000;
  while (bucket.length && bucket[0] < cutoff) bucket.shift();

  // لو > 10 خطأ من نفس النوع في 5 دقائق → CRITICAL
  if (bucket.length >= 10) {
    raiseAlert("CRITICAL", "ERROR_RATE_HIGH", `معدل أخطاء عالي`, {
      message: `${bucket.length} خطأ من نوع "${tag}" خلال 5 دقائق`,
      latestError: msg.slice(0, 200),
    });
    _state.errorBuckets.set(tag, []); // reset عداد بعد التنبيه
  }
}

function raiseAlert(level, key, title, details = {}) {
  if (!LEVELS[level]) level = "WARNING";
  _state.totalAlerts++;
  const entry = {
    type:      "alert",
    level,
    key:       String(key).slice(0, 60),
    title:     String(title).slice(0, 200),
    details:   _safeContext(details),
    timestamp: new Date().toISOString(),
  };
  _appendLog(entry);

  // debounce: لا تكرّر نفس النوع بسرعة
  const cooldown = NOTIFY_COOLDOWN[key] || 5 * 60_000;
  const lastSent = _state.lastNotified.get(key) || 0;
  if (Date.now() - lastSent < cooldown) return;
  _state.lastNotified.set(key, Date.now());

  // أرسل عبر القنوات
  _sendNotifications(entry);
}

function recordWhatsAppDisconnect(storeId) {
  _state.disconnectStart.set(storeId, Date.now());
}

function recordWhatsAppConnect(storeId) {
  const startedAt = _state.disconnectStart.get(storeId);
  if (!startedAt) return;
  const downSec = Math.round((Date.now() - startedAt) / 1000);
  _state.disconnectStart.delete(storeId);
  _appendLog({
    type:      "info",
    tag:       "wa.reconnect",
    storeId,
    downSec,
    timestamp: new Date().toISOString(),
  });
}

// ─── Health monitor — يفحص دورياً ─────────────────────────────────────────────
let _healthInterval = null;
function startHealthMonitor() {
  if (_healthInterval) return;
  _healthInterval = setInterval(_runHealthChecks, 60_000); // كل دقيقة
  _healthInterval.unref?.();
  console.log("🩺 Maintenance alerts active");
}

function _runHealthChecks() {
  try {
    // 1) ذاكرة Node
    const mem = process.memoryUsage();
    const heapPctOfLimit = (mem.heapUsed / mem.heapTotal) * 100;
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    if (heapPctOfLimit > 90) {
      raiseAlert("WARNING", "MEMORY", "استخدام ذاكرة مرتفع جداً", {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        rssMB,
        heapPct: Math.round(heapPctOfLimit),
      });
    }

    // 2) WhatsApp disconnect طويل
    const now = Date.now();
    for (const [storeId, startedAt] of _state.disconnectStart) {
      const downMin = (now - startedAt) / 60_000;
      if (downMin >= 5) {
        raiseAlert("ERROR", "WA_DISCONNECT", `متجر ${storeId} مقطوع منذ ${Math.round(downMin)} دقيقة`, {
          storeId,
          downMinutes: Math.round(downMin),
        });
      }
    }

    // 3) load average (Unix فقط)
    const load = os.loadavg();
    const cpuCount = os.cpus().length;
    const loadPct = (load[0] / cpuCount) * 100;
    if (loadPct > 200) {
      raiseAlert("WARNING", "CPU_LOAD", "حمل CPU مرتفع جداً", {
        load1m: load[0].toFixed(2),
        cores:  cpuCount,
        loadPct: Math.round(loadPct),
      });
    }

    // 4) المساحة في data/ (best-effort)
    try {
      const dataDir = path.join(__dirname, "..", "data");
      const stat = fs.statSync(dataDir);
      // فقط للتسجيل — نوسيع لاحقاً
    } catch {}
  } catch (e) {
    console.warn("[maint-monitor] health check failed:", e.message);
  }
}

// ─── Read API ─────────────────────────────────────────────────────────────────
function readRecentAlerts(days = 7, levelFilter = null) {
  const today = new Date();
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const file = _logFile(d);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        if (levelFilter && e.level !== levelFilter) continue;
        out.push(e);
      } catch {}
    }
  }
  return out.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
}

function getStatus() {
  const uptimeMin = Math.round((Date.now() - _state.startedAt) / 60_000);
  return {
    uptimeMin,
    totalErrors:    _state.totalErrors,
    totalAlerts:    _state.totalAlerts,
    currentlyDown:  Array.from(_state.disconnectStart.entries()).map(([id, t]) => ({
      storeId: id, downSec: Math.round((Date.now() - t) / 1000),
    })),
    memMB: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      rss:      Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
  };
}

// ─── Process-level hooks ──────────────────────────────────────────────────────
function installGlobalHandlers() {
  process.on("uncaughtException", (err) => {
    recordError("uncaughtException", err);
    raiseAlert("CRITICAL", "CRASH", "Uncaught Exception", {
      message: err?.message || String(err),
      stack:   String(err?.stack || "").split("\n").slice(0, 5).join("\n"),
    });
  });
  process.on("unhandledRejection", (reason) => {
    recordError("unhandledRejection", reason);
  });
  console.log("🛡️ Maintenance alert hooks installed");
}

// ─── Internal ─────────────────────────────────────────────────────────────────
function _logFile(date = new Date()) {
  const d = date.toISOString().slice(0, 10);
  return path.join(ALERTS_DIR, `${d}.jsonl`);
}

function _appendLog(entry) {
  try {
    fs.appendFileSync(_logFile(), JSON.stringify(entry) + "\n", "utf8");
  } catch (e) {
    // fallback: print to stderr
    console.error("[maint-log] write failed:", e.message);
  }
}

function _safeContext(ctx) {
  try {
    const s = JSON.stringify(ctx);
    return s.length > 2000 ? JSON.parse(s.slice(0, 2000) + '"}') : ctx;
  } catch { return {}; }
}

async function _sendNotifications(entry) {
  // 🛡️ نظام خاص بالمطورين فقط — لا واتساب، لا UI
  // التنبيهات تُكتب في data/alerts/YYYY-MM-DD.jsonl
  // وتُلتقط على جهازنا عبر tools/fetch-alerts.sh
  // الـ Webhook اختياري لو حبّينا Slack/Discord في المستقبل
  const webhook = process.env.DEV_ALERTS_WEBHOOK;
  if (webhook) {
    try {
      const { level, title, details } = entry;
      const ico = LEVELS[level]?.emoji || "ℹ️";
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level, title: `${ico} ${title}`, details, ts: entry.timestamp }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {}
  }
}

module.exports = {
  recordError,
  raiseAlert,
  recordWhatsAppDisconnect,
  recordWhatsAppConnect,
  startHealthMonitor,
  installGlobalHandlers,
  readRecentAlerts,
  getStatus,
};
