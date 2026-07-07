/**
 * WhatsApp Commerce Bot — Main Server (Baileys Edition)
 * Multi-tenant: كل متجر = جلسة Baileys منفصلة
 *
 * Routes:
 *   GET  /health        → liveness probe
 *   GET  /demo.html     → web simulator
 *   POST /api/sim       → demo message handler
 *   /master/*           → admin panel API
 *   /store/*            → store admin API
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const express   = require("express");
const helmet    = require("helmet");
const rateLimit = require("express-rate-limit");
const axios     = require("axios");
const path      = require("path");
const fs        = require("fs");
const { AsyncLocalStorage } = require("async_hooks");

const { sessionManager: _sessionRaw }              = require("./session");
const { buildInvoice }                             = require("./invoice");
// ─── Extracted pure helpers (Phase 1 refactor) ─────────────────────────────
const {
  getBusinessType, shouldAskDeliveryTime, computeETAText, computeETAChipText, businessLabels,
  isGibberish, isOffTopicQuery, isValidName, isEditIntent, isValidLocation,
  isProductInStock, truncate, phoneNum,
} = require("./utils/server-helpers");
// canvas-pool: لو CANVAS_WORKERS>0 يولّد الصور في worker threads (لا يحجب event-loop)
// بدونه يعمل sync كالمعتاد (fallback شفاف)
const { generateInvoiceImage, generateSummaryImage } = require("./canvas-pool");
const { generateMenuImage } = require("./menu-image");
const { logOrder, readOrders, updateOrderStatus }  = require("./orders");
const { upsertCustomer }                           = require("./customers");
const { hasFeature }                               = require("./plans");
const botMsg                                       = require("./bot-messages");
const { handleLeadMessage }                        = require("./lead-bot");
const { handlePlatformMessage }                    = require("./platform-bot");
const waMgr                                        = require("./whatsapp-manager");
const firestoreAuth                                = require("./firestore-auth");
const { addPoints, redeemPoints, getPoints, pointsMessage } = require("./loyalty");
const { validateCoupon, useCoupon }               = require("./coupons");
const { saveRating, ratingRequestMessage, isRatingInput }   = require("./ratings");
const aiParser                                              = require("./ai-parser");
const sessionWatchdog = require("./session-watchdog");
const dailyReport     = require("./daily-report");
const orderScheduler  = require("./order-scheduler");
const { addScheduledOrder } = orderScheduler;

const {
  getProducts,
  getProductById,
  getAllCategories,
} = require("./sheets");

const app = express();
app.set("trust proxy", 1);

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const allowed = [
    "https://botwats-fae4e.web.app",
    "https://botwats-fae4e.firebaseapp.com",
    "https://nakheelbot.web.app",
    "https://nakheelbot.firebaseapp.com",
    "https://61465.github.io",
    "http://localhost:3000",
  ];
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-store-token,x-master-token");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src":      ["'self'"],
      "script-src":       ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://www.gstatic.com", "https://api.qrserver.com"],
      "script-src-attr":  ["'unsafe-inline'"],
      "style-src":        ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "img-src":          ["'self'", "data:", "blob:", "https:"],
      "media-src":        ["'self'", "blob:", "https:"],
      "font-src":         ["'self'", "data:", "https://fonts.gstatic.com"],
      "connect-src":      ["'self'", "https:", "wss:"],
      "frame-src":        ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com", "https://player.vimeo.com", "https://drive.google.com"],
      "object-src":       ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  crossOriginResourcePolicy: { policy: "cross-origin" },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
}));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "طلبات كثيرة، حاول بعد قليل" },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, // 20 attempts per 15 min (skipSuccess → only failures count)
  standardHeaders: true, legacyHeaders: false,
  message: { error: "محاولات دخول كثيرة، انتظر 15 دقيقة" },
  skipSuccessfulRequests: true,
});
// rate limiter لـ web tokens (/c/:token, /o/:slug, /do/:token) — منع brute-force على tokens قصيرة
const webTokenLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "طلبات كثيرة على الروابط، حاول بعد قليل" },
});
// 🛡️ AI/heavy endpoints: حد أقل لمنع abuse على المفاتيح
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30, // 30 طلب AI/ساعة لكل IP
  standardHeaders: true, legacyHeaders: false,
  message: { error: "حد طلبات AI تم تجاوزه — انتظر ساعة" },
});
app.use("/store/menu/ai-import",          aiLimiter);
app.use("/store/bot-questions/generate",  aiLimiter);
app.use("/store/accounting/ai-advice",    aiLimiter);
app.use("/store/ratings/ai-analysis",     aiLimiter);

app.use("/store/",        apiLimiter);
// /api/master-notifications يُستدعى polling كل 30s من ماستر مفتوحين — استثناء
app.use("/api/", (req, res, next) => {
  if (req.path === "/master-notifications") return next();
  return apiLimiter(req, res, next);
});
app.use("/master/login",  loginLimiter);
// تطبيق login limiter على /store/login بشكل صريح (لتفادي 429 على فتح صفحات متعددة)
app.use("/store/login",   loginLimiter);
// web tokens — تطبق على الـ prefix routes
app.use("/c/",            webTokenLimiter);
app.use("/do/",           webTokenLimiter);
app.use("/order/",        webTokenLimiter);
app.use("/o/",            webTokenLimiter);
app.use("/try/",          webTokenLimiter);

// 🔗 Trace ID — UUID لكل request يربط audit entries + logs بنفس الـ HTTP call
app.use((req, res, next) => {
  const incoming = req.headers["x-trace-id"];
  req.traceId = (incoming && /^[a-zA-Z0-9_-]{6,40}$/.test(incoming))
    ? incoming
    : require("crypto").randomUUID();
  res.setHeader("X-Trace-Id", req.traceId);
  next();
});

// 🗜️ gzip compression للـ text responses (HTML/JS/CSS/JSON)
//    472KB → ~80KB = 5× أسرع على روابط بطيئة (Tailscale Funnel، 3G، إلخ)
const _zlib = require("zlib");
app.use((req, res, next) => {
  const accept = String(req.headers["accept-encoding"] || "");
  if (!/\bgzip\b/.test(accept)) return next();
  // اعترض على write/end لتمرير المحتوى عبر gzip
  const _origWrite = res.write.bind(res);
  const _origEnd   = res.end.bind(res);
  const chunks = [];
  let aborted = false;
  res.write = function(chunk, encoding, cb) {
    if (aborted) return _origWrite(chunk, encoding, cb);
    if (chunk) chunks.push(typeof chunk === "string" ? Buffer.from(chunk, encoding || "utf8") : chunk);
    if (cb) cb();
    return true;
  };
  res.end = function(chunk, encoding, cb) {
    if (chunk) chunks.push(typeof chunk === "string" ? Buffer.from(chunk, encoding || "utf8") : chunk);
    const buf = Buffer.concat(chunks);
    const ct = String(res.getHeader("Content-Type") || "");
    const compressible = /text|json|javascript|xml|svg/i.test(ct);
    // لا تضغط لو صغير (< 1KB) أو غير compressible أو binary
    if (!compressible || buf.length < 1024 || res.getHeader("Content-Encoding")) {
      aborted = true;
      _origWrite(buf);
      return _origEnd(null, null, cb);
    }
    _zlib.gzip(buf, { level: 6 }, (err, gz) => {
      // HEADERS_GUARD_v1 — العميل قد يكون قطع الاتصال أثناء الضغط
      if (res.headersSent || res.writableEnded) { try { _origEnd(null, null, cb); } catch {} return; }
      if (err) { _origWrite(buf); return _origEnd(null, null, cb); }
      try {
        res.setHeader("Content-Encoding", "gzip");
        res.setHeader("Content-Length", gz.length);
        res.removeHeader("ETag");
      } catch (e) {
        // headers were sent between the check and setHeader — swallow
        try { _origEnd(null, null, cb); } catch {} return;
      }
      _origWrite(gz);
      _origEnd(null, null, cb);
    });
    return true;
  };
  next();
});

// ⚡ Gzip compression — يقلل HTML/JS/JSON بنسبة ~70-85% (127KB → ~25KB لمنيو ال QR)
// 🚫 استثناءات مهمة: SSE/streaming endpoints تتعطّب لو ضُغطت (buffering)
const _compressionLib = require("compression");
const SSE_PATHS = new Set([
  "/store/events",
  "/master/events",
  "/api/master-notifications",
  "/store/notifications",
]);
app.use(_compressionLib({
  filter: (req, res) => {
    // 1) استثناء صريح بـ header
    if (req.headers["x-no-compression"]) return false;
    // 2) استثناء بالـ path (SSE وstreaming)
    if (SSE_PATHS.has(req.path)) return false;
    if (req.path.startsWith("/store/events") || req.path.startsWith("/master/events")) return false;
    // 3) استثناء حسب Content-Type المعروف
    const ct = res.getHeader("Content-Type");
    if (ct && /text\/event-stream|application\/octet-stream|video\/|audio\//i.test(String(ct))) return false;
    return _compressionLib.filter(req, res);
  },
  level: 6,
  threshold: 1024,
}));

app.use(express.json({ limit: "60mb" })); // raised for video uploads (videos enforce 50MB inside endpoint)
app.use(express.raw({ type: "video/*", limit: "60mb" }));
app.use(express.static(path.join(__dirname, "..", "public"), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // HTML الكبيرة (master/store-admin/landing): cache قصير 5 د + revalidate في الخلفية
    // قبل: no-cache = revalidate كل refresh عبر Tailscale Funnel = latency 1-2s/asset
    // الآن: max-age=300 + must-revalidate = cache 5 د، ثم 304 لو لم يتغير → toxic أقل
    if (/\.html$/i.test(filePath)) {
      // ⚡ HTML: no-cache يسمح بـ 304 (revalidate via ETag) لكن لا يخزن الـ body
      // النتيجة: لو الملف لم يتغير → الخادم يرد 304 فارغ (1-50KB بدل 714KB)
      // لو تغير → 200 + body كامل. لا cache في القرص (لا "stale" data).
      // remove "no-store" — هو السبب أن الـ ETag تُتجاهَل
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
      res.removeHeader("Pragma");
      res.removeHeader("Expires");
    } else if (/\.(js|css)$/i.test(filePath)) {
      // JS/CSS — cache قصير (10 د) للتطوير السريع
      res.setHeader("Cache-Control", "public, max-age=600, must-revalidate");
    }
  }
}));
app.use("/invoices",     express.static(path.join(__dirname, "..", "data", "invoices"),  { maxAge:"1d" }));
app.use("/store-images", express.static(path.join(__dirname, "..", "data", "images")));
app.use("/store-videos", express.static(path.join(__dirname, "..", "data", "videos"), {
  maxAge: "7d",
  setHeaders: (res) => {
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=604800");
  },
}));

// ─── Env ──────────────────────────────────────────────────────────────────────
const {
  OWNER_PHONE        = "",
  STORE_NAME         = "متجرنا",
  CURRENCY           = "ر.س",
  DELIVERY_FEE       = "10",
  WORKING_HOURS_START = "8",
  WORKING_HOURS_END  = "24",
  PUBLIC_URL         = "",
  PORT               = 3000,
  LEAD_OWNER_PHONE   = "",
  PLATFORM_OWNER_PHONE = "",
} = process.env;

const DATA_DIR    = path.join(__dirname, "..", "data");
const deliveryFee = parseFloat(DELIVERY_FEE) || 0;
const hourStart   = parseInt(WORKING_HOURS_START) || 0;
const hourEnd     = parseInt(WORKING_HOURS_END)   || 24;

// ─── Context stores (AsyncLocalStorage) ──────────────────────────────────────
const demoCtx  = new AsyncLocalStorage(); // web simulator
const storeCtx = new AsyncLocalStorage(); // active storeId + store config

// ─── Session scoping: كل متجر له session منفصل لنفس الرقم ───────────────────
// المفتاح: storeId|phone — يمنع تداخل mute/handoff بين متجرين
function _sessKey(from) {
  const { storeId } = storeCtx.getStore() || {};
  const phone = String(from || "").replace(/\|/g, "");
  return (storeId || "global") + "|" + phone;
}
const sessionManager = {
  get:    (from)         => _sessionRaw.get(_sessKey(from)),
  set:    (from, data)   => _sessionRaw.set(_sessKey(from), data),
  update: (from, patch)  => _sessionRaw.update(_sessKey(from), patch),
  reset:  (from)         => _sessionRaw.reset(_sessKey(from)),
  // للـ watchers خارج storeCtx — يحذف entry بـ full key (storeId|phone)
  resetByFullKey: (fullKey) => _sessionRaw.resetByFullKey(fullKey),
  snapshotAll:    ()        => _sessionRaw.snapshotAll(),
};

// ─── Health (public minimal + admin verbose) + Version ────────────────────────
const _bootTime = Date.now();
let _pkgVersion = "unknown";
try { _pkgVersion = require("../package.json").version || "unknown"; } catch {}

app.get("/health", (req, res) => {
  const masterToken = req.headers["x-master-token"] || req.query.masterToken;
  const isAdmin = masterToken && safeEqualStrLocal(masterToken, process.env.MASTER_PASSWORD || "");
  const uptimeMs = Date.now() - _bootTime;

  const base = { ok: true, version: _pkgVersion, uptimeSec: Math.floor(uptimeMs / 1000) };

  if (isAdmin) {
    let totalStores = 0, activeStores = 0, todayOrders = 0;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "stores.json"), "utf8"));
      totalStores = (data.stores || []).length;
      activeStores = (data.stores || []).filter(s => s.active && s.subscriptionStatus === "active").length;
      const today = new Date().toISOString().slice(0, 10);
      for (const s of (data.stores || [])) {
        const f = s.id === "nakheel_001"
          ? path.join(DATA_DIR, "orders.jsonl")
          : path.join(DATA_DIR, `orders_${s.id}.jsonl`);
        if (!fs.existsSync(f)) continue;
        for (const l of fs.readFileSync(f, "utf8").split("\n")) {
          if (!l) continue;
          try {
            const o = JSON.parse(l);
            if (!o._test && (o.timestamp || "").slice(0, 10) === today) todayOrders++;
          } catch {}
        }
      }
    } catch {}

    const mem = process.memoryUsage();
    return res.json({
      ...base,
      time: new Date().toISOString(),
      sessions: waMgr.listSessions(),
      stats: { totalStores, activeStores, todayOrders },
      memory: { rssMB: Math.round(mem.rss / 1024 / 1024), heapMB: Math.round(mem.heapUsed / 1024 / 1024) },
      node: process.version,
    });
  }
  res.json(base);
});

// timing-safe local compare (server.js)
function safeEqualStrLocal(a, b) {
  if (!a || !b) return false;
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return require("crypto").timingSafeEqual(ab, bb);
}

// ─── Deep health check — public (للـ Uptime Kuma + load balancers) ───────────
app.get("/health/deep", (_req, res) => {
  try {
    const r = require("./health-monitor").deepCheck();
    res.status(r.status === "critical" ? 503 : 200).json(r);
  } catch (e) { res.status(500).json({ status: "error", message: e.message }); }
});

// ─── Public status page — للعملاء (يعرض حالة البوت دون تفاصيل حساسة) ────────
app.get("/status", (_req, res) => {
  const sessions = (() => { try { return waMgr.listSessions() || []; } catch { return []; } })();
  const stores = getAllStores().filter(s => s.active && s.subscriptionStatus === "active");
  const online = sessions.filter(s => s.state === "open" || s.connected).length;
  const total  = stores.length;
  const overallOk = online > 0 && online >= Math.max(1, Math.floor(total * 0.5));
  const uptimeSec = Math.floor((Date.now() - _bootTime) / 1000);
  const dh = Math.floor(uptimeSec / 86400);
  const hh = Math.floor((uptimeSec % 86400) / 3600);
  const mm = Math.floor((uptimeSec % 3600) / 60);
  const upStr = `${dh ? dh + "ي " : ""}${hh}س ${mm}د`;
  const lastCheck = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const esc = s => String(s || "").replace(/[<>&"']/g, c => ({ "<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&#39;" }[c]));
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(`<!DOCTYPE html><html dir="rtl" lang="ar"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>حالة منصة ثواني</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI",Tahoma,Arial,sans-serif;background:linear-gradient(135deg,#0f172a,#1e293b);color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:rgba(15,23,42,.7);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:32px;max-width:520px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.4)}
h1{font-size:22px;font-weight:800;margin-bottom:4px}
.sub{font-size:13px;color:#94a3b8;margin-bottom:24px}
.status{display:flex;align-items:center;gap:14px;padding:18px;border-radius:12px;background:${overallOk ? "rgba(16,185,129,.15)" : "rgba(239,68,68,.15)"};border:1px solid ${overallOk ? "rgba(16,185,129,.4)" : "rgba(239,68,68,.4)"};margin-bottom:20px}
.dot{width:14px;height:14px;border-radius:50%;background:${overallOk ? "#10b981" : "#ef4444"};box-shadow:0 0 14px ${overallOk ? "rgba(16,185,129,.7)" : "rgba(239,68,68,.7)"};animation:pulse 2s ease-in-out infinite}
@keyframes pulse{50%{opacity:.6;transform:scale(.92)}}
.status-text{flex:1}
.status-title{font-size:16px;font-weight:800}
.status-desc{font-size:12.5px;color:#cbd5e1;margin-top:2px}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:6px}
.stat{background:rgba(255,255,255,.04);padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.06)}
.stat-label{font-size:11px;color:#94a3b8;margin-bottom:3px}
.stat-value{font-size:18px;font-weight:800;color:#f1f5f9}
.foot{margin-top:18px;font-size:11px;color:#64748b;text-align:center}
.brand{font-weight:900;color:#10b981}
</style></head><body>
<div class="card">
  <h1>🤖 منصة ثواني — حالة الخدمة</h1>
  <div class="sub">صفحة عامة تعرض حالة بوتات الواتساب لحظياً</div>
  <div class="status">
    <div class="dot"></div>
    <div class="status-text">
      <div class="status-title">${overallOk ? "✅ الخدمة تعمل" : "⚠️ خلل جزئي"}</div>
      <div class="status-desc">${overallOk ? "كل البوتات تعمل أو الأغلبية متصلة" : "بعض البوتات غير متصلة الآن — يعمل الفريق على ذلك"}</div>
    </div>
  </div>
  <div class="grid">
    <div class="stat"><div class="stat-label">البوتات المتصلة</div><div class="stat-value">${online} / ${total}</div></div>
    <div class="stat"><div class="stat-label">مدة التشغيل</div><div class="stat-value">${esc(upStr)}</div></div>
    <div class="stat"><div class="stat-label">إصدار النظام</div><div class="stat-value">${esc(_pkgVersion)}</div></div>
    <div class="stat"><div class="stat-label">آخر فحص</div><div class="stat-value" style="font-size:12px;font-weight:600">${esc(lastCheck)}</div></div>
  </div>
  <div class="foot">منصة <span class="brand">ثواني</span> — تُحدّث الصفحة كل دقيقة</div>
</div>
<script>setTimeout(()=>location.reload(),60000)<\/script>
</body></html>`);
});

// ─── Notifications polling — للماستر فقط ──────────────────────────────────────
// يرجع آخر أحداث (طلبات اشتراك جديدة، طلبات بحاجة قبول)
app.get("/api/master-notifications", (req, res) => {
  const t = req.headers["x-master-token"];
  const masterRouter = require("./master-router");
  const isPassMatch = safeEqualStrLocal(t, process.env.MASTER_PASSWORD || "");
  const isSessionMatch = typeof masterRouter.isValidSession === "function" && masterRouter.isValidSession(t);

  if (!isPassMatch && !isSessionMatch) {
    return res.status(401).json({ error: "غير مصرح" });
  }
  const sinceTs = parseInt(req.query.since) || 0;
  const notif = [];

  // طلبات اشتراك جديدة (pending)
  try {
    const p = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "pending-requests.json"), "utf8"));
    for (const r of (p.requests || [])) {
      if (r.status !== "pending") continue;
      const ts = new Date(r.submittedAt || 0).getTime();
      if (ts > sinceTs) {
        notif.push({ kind: "subscription_request", id: r.id, title: "طلب اشتراك جديد",
                     body: `${r.name} - ${r.store}`, ts, link: "#pending" });
      }
    }
  } catch {}

  res.json({ notifications: notif, serverTime: Date.now() });
});
// الـ landing الرسمي على GitHub Pages — نوجّه إليه لتجنب صفحات تسجيل متعددة
app.get("/", (_req, res) => res.redirect(301, "https://61465.github.io/cafe/docs/"));

// ─── Public APIs ──────────────────────────────────────────────────────────────
app.get("/api/plans", (_req, res) => {
  const DEFAULT_PLANS = {
    starter: { nameAr:"الأساسية", emoji:"🌱", price:80,
      sysFeatures:{ adminPanel:true, invoiceImage:false, customerRegistry:false, stripe:false },
      displayFeatures:[
        {text:"استقبال طلبات غير محدودة",included:true},
        {text:"قائمة منتجات تفاعلية",included:true},
        {text:"لوحة تحكم إدارة الطلبات",included:true},
        {text:"إشعارات فورية للمالك",included:true},
        {text:"فاتورة صورة تلقائية",included:false},
        {text:"سجل عملاء VIP",included:false},
        {text:"دفع إلكتروني بالفيزا",included:false},
      ]},
    pro: { nameAr:"الاحترافية", emoji:"⭐", price:150,
      sysFeatures:{ adminPanel:true, invoiceImage:true, customerRegistry:true, stripe:false },
      displayFeatures:[
        {text:"كل مميزات الأساسية",included:true},
        {text:"فاتورة صورة تُرسل للعميل تلقائياً",included:true},
        {text:"سجل عملاء VIP مع التاريخ الكامل",included:true},
        {text:"تقارير مبيعات يومية",included:true},
        {text:"دفع إلكتروني بالفيزا",included:false},
      ]},
    premium: { nameAr:"المتقدمة", emoji:"👑", price:250,
      sysFeatures:{ adminPanel:true, invoiceImage:true, customerRegistry:true, stripe:true },
      displayFeatures:[
        {text:"كل مميزات الاحترافية",included:true},
        {text:"دفع إلكتروني بالفيزا",included:true},
        {text:"ربط كامل مع بوابة الدفع",included:true},
        {text:"أولوية الدعم الفني 24/7",included:true},
      ]},
  };
  try {
    const f = path.join(DATA_DIR, "owner-settings.json");
    if (!fs.existsSync(f)) return res.json({ plans: DEFAULT_PLANS });
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    if (raw.plans) {
      // Merge with defaults so missing fields are filled
      const plans = {};
      for (const id of ["starter","pro","premium"]) {
        plans[id] = { ...DEFAULT_PLANS[id], ...(raw.plans[id] || {}) };
      }
      return res.json({ plans });
    }
    // Legacy: only planPrices saved
    const plans = { ...DEFAULT_PLANS };
    for (const id of ["starter","pro","premium"]) {
      if (raw.planPrices?.[id]) plans[id] = { ...plans[id], price: raw.planPrices[id] };
    }
    res.json({ plans });
  } catch { res.json({ plans: DEFAULT_PLANS }); }
});

app.get("/api/firebase-config", (_req, res) => {
  res.json({
    apiKey:            process.env.FIREBASE_API_KEY || "",
    authDomain:        process.env.FIREBASE_AUTH_DOMAIN || "",
    projectId:         process.env.FIREBASE_PROJECT_ID || "",
    storageBucket:     process.env.FIREBASE_STORAGE_BUCKET || "",
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "",
    appId:             process.env.FIREBASE_APP_ID || "",
  });
});

// ─── Demo Web Simulator ───────────────────────────────────────────────────────
app.post("/api/sim", async (req, res) => {
  const { from = "demo-user-" + (req.ip || "0"), message = "" } = req.body || {};
  const buffer = [];
  try {
    await demoCtx.run({ buffer }, async () => {
      // Use first active store that has products, fallback to any store
      const store = getAllStores().find(s => s.products?.length > 0) || getAllStores()[0] || null;
      await storeCtx.run({ storeId: "demo", store }, async () => {
        await handleMessage(String(from), String(message));
      });
    });
    res.json({ ok: true, messages: buffer });
  } catch (err) {
    console.error("Demo error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/sim/reset", (req, res) => {
  const { from = "demo-user-" + (req.ip || "0") } = req.body || {};
  sessionManager.reset(String(from));
  res.json({ ok: true });
});

// ─── Orders Feed (master only) — يدعم Bearer header + x-master-token ──────────
// تعطيل query.token تماماً — يكشف في logs
app.get("/orders", (req, res) => {
  const auth = String(req.headers.authorization || "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const token = bearer || req.headers["x-master-token"];
  const expected = process.env.MASTER_PASSWORD;
  if (!token || !expected) {
    return res.status(403).json({ error: "forbidden" });
  }
  // timing-safe comparison
  const a = Buffer.from(String(token));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length || !require("crypto").timingSafeEqual(a, b)) {
    return res.status(403).json({ error: "forbidden" });
  }
  res.json({ orders: readOrders(parseInt(req.query.limit) || 50) });
});

// ─── Public Try Slot endpoints (for /try.html visitors, no auth) ────────────
const TRY_SLOTS = ["try_1", "try_2", "try_3", "try_4", "try_5"];
const tryInitTimes = new Map(); // ip → [timestamps]
const demoStores = require("./demo-stores");

app.post("/try/init", async (req, res) => {
  const ip  = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "unknown";
  const now = Date.now();
  const times = (tryInitTimes.get(ip) || []).filter(t => now - t < 3600_000);
  if (times.length >= 20) {
    return res.status(429).json({ error: "تجاوزت الحد المسموح، حاول لاحقاً" });
  }
  times.push(now);
  tryInitTimes.set(ip, times);

  // اقرأ القطاع لو موصل (للديمو الجديد على GitHub Pages)
  // ?sector=pharmacy|grocery|cafe — اختياري (legacy /try.html لا يرسل sector)
  const sector = String(req.query.sector || req.body?.sector || "").toLowerCase().trim();
  if (sector && !demoStores.SECTORS.includes(sector)) {
    return res.status(400).json({ error: "قطاع غير معروف. القطاعات المتاحة: pharmacy, grocery, cafe" });
  }

  for (const slotId of TRY_SLOTS) {
    const { status } = waMgr.getStatus(slotId);
    if (status === "open") continue; // مستخدم حالياً
    try {
      await waMgr.resetSession(slotId);
      // اربط الـ slot بالقطاع المختار (لو محدد)
      if (sector) demoStores.setSlotSector(slotId, sector);
      else        demoStores.clearSlot(slotId);
      return res.json({
        ok: true,
        slotId,
        sector: sector || null,
        ...(sector ? { storeName: demoStores.DEMO_STORES[sector].storeName } : {}),
      });
    } catch (e) {
      console.warn(`/try/init [${slotId}] failed:`, e.message);
    }
  }
  return res.status(503).json({ error: "جميع فتحات التجربة مشغولة، حاول بعد دقيقة" });
});

app.get("/try/status/:slotId", (req, res) => {
  const { slotId } = req.params;
  if (!TRY_SLOTS.includes(slotId)) return res.status(400).json({ error: "invalid slot" });
  const st = waMgr.getStatus(slotId);
  const info = demoStores.getSlotInfo(slotId);
  res.json({ ...st, ...(info || {}) });
});

// ─── Demo Admin endpoints (read-only، للديمو على GitHub Pages) ──────────────
// رجّع بيانات المتجر الديمو الخاص بالـ slot
app.get("/try/store/:slotId", (req, res) => {
  const { slotId } = req.params;
  if (!TRY_SLOTS.includes(slotId)) return res.status(400).json({ error: "invalid slot" });
  const info = demoStores.getSlotInfo(slotId);
  if (!info) return res.status(404).json({ error: "slot not linked to demo" });
  const store = demoStores.getDemoStoreBySlot(slotId);
  const status = waMgr.getStatus(slotId);
  res.json({
    slotId,
    sector: info.sector,
    storeId: store.id,
    storeName: store.storeName,
    botPhone: status?.phone || null,
    categories: store.categories,
    products: store.products,
    currency: store.currency,
    deliveryFee: store.deliveryFee,
    welcomeMessage: store.welcomeMessage,
    workingHoursStart: store.workingHoursStart,
    workingHoursEnd: store.workingHoursEnd,
    initAt: info.initAt,
    expiresAt: info.initAt ? info.initAt + 45 * 60 * 1000 : null,
  });
});

// ─── Demo: قبول/رفض طلب ─────────────────────────────────────────────────
// POST /try/orders/:slotId/:orderId/confirm
app.post("/try/orders/:slotId/:orderId/confirm", express.json(), async (req, res) => {
  const { slotId, orderId } = req.params;
  if (!TRY_SLOTS.includes(slotId)) return res.status(400).json({ error: "invalid slot" });
  if (!demoStores.getSlotInfo(slotId)) return res.status(404).json({ error: "slot not linked" });
  try {
    const ordersFile = path.join(DATA_DIR, `orders_${slotId}.jsonl`);
    if (!fs.existsSync(ordersFile)) return res.status(404).json({ error: "no orders" });
    const lines = fs.readFileSync(ordersFile, "utf8").split("\n").filter(Boolean);
    let updated = null;
    const newLines = lines.map(l => {
      try {
        const o = JSON.parse(l);
        if (o.orderId === orderId) {
          o.status = "confirmed";
          o.confirmedAt = new Date().toISOString();
          updated = o;
          return JSON.stringify(o);
        }
        return l;
      } catch { return l; }
    });
    if (!updated) return res.status(404).json({ error: "order not found" });
    fs.writeFileSync(ordersFile, newLines.join("\n") + "\n");
    // أبلغ العميل عبر بوت الديمو
    try {
      if (updated.customerPhone) {
        const jid = String(updated.customerPhone).replace(/\D/g, "") + "@s.whatsapp.net";
        const store = demoStores.getDemoStoreBySlot(slotId);
        await waMgr.sendMessage(slotId, jid,
          `✅ *تم تأكيد طلبك!*\n\n` +
          `رقم: *${orderId}*\n` +
          `الإجمالي: *${updated.total} ${store?.currency || "ر.س"}*\n\n` +
          `_(هذه نسخة تجريبية — لا توصيل حقيقي)_`);
      }
    } catch (e) { console.warn("[try/confirm] notify failed:", e.message); }
    res.json({ ok: true, order: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /try/orders/:slotId/:orderId/reject
app.post("/try/orders/:slotId/:orderId/reject", express.json(), async (req, res) => {
  const { slotId, orderId } = req.params;
  if (!TRY_SLOTS.includes(slotId)) return res.status(400).json({ error: "invalid slot" });
  if (!demoStores.getSlotInfo(slotId)) return res.status(404).json({ error: "slot not linked" });
  const reason = String(req.body?.reason || "").slice(0, 200);
  try {
    const ordersFile = path.join(DATA_DIR, `orders_${slotId}.jsonl`);
    if (!fs.existsSync(ordersFile)) return res.status(404).json({ error: "no orders" });
    const lines = fs.readFileSync(ordersFile, "utf8").split("\n").filter(Boolean);
    let updated = null;
    const newLines = lines.map(l => {
      try {
        const o = JSON.parse(l);
        if (o.orderId === orderId) {
          o.status = "rejected";
          o.rejectReason = reason || "غير محدد";
          o.rejectedAt = new Date().toISOString();
          updated = o;
          return JSON.stringify(o);
        }
        return l;
      } catch { return l; }
    });
    if (!updated) return res.status(404).json({ error: "order not found" });
    fs.writeFileSync(ordersFile, newLines.join("\n") + "\n");
    try {
      if (updated.customerPhone) {
        const jid = String(updated.customerPhone).replace(/\D/g, "") + "@s.whatsapp.net";
        await waMgr.sendMessage(slotId, jid,
          `❌ *عذراً، تم رفض طلبك*\n\n` +
          `رقم: *${orderId}*\n` +
          (reason ? `السبب: ${reason}\n\n` : "") +
          `_(هذه نسخة تجريبية)_`);
      }
    } catch (e) { console.warn("[try/reject] notify failed:", e.message); }
    res.json({ ok: true, order: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Demo Accounting ────────────────────────────────────────────────────
app.get("/try/accounting/:slotId", (req, res) => {
  const { slotId } = req.params;
  if (!TRY_SLOTS.includes(slotId)) return res.status(400).json({ error: "invalid slot" });
  const info = demoStores.getSlotInfo(slotId);
  if (!info) return res.status(404).json({ error: "slot not linked" });
  try {
    const ordersFile = path.join(DATA_DIR, `orders_${slotId}.jsonl`);
    let orders = [];
    if (fs.existsSync(ordersFile)) {
      orders = fs.readFileSync(ordersFile, "utf8").split("\n").filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(o => o && new Date(o.timestamp || 0).getTime() >= (info.initAt || 0));
    }
    const confirmed = orders.filter(o => o.status === "confirmed");
    const pending   = orders.filter(o => o.status === "pending_confirmation");
    const rejected  = orders.filter(o => o.status === "rejected");
    const totalRevenue = confirmed.reduce((s, o) => s + (Number(o.total) || 0), 0);
    const avgOrder = confirmed.length ? totalRevenue / confirmed.length : 0;
    // أكثر منتج مبيعاً
    const productCounts = {};
    confirmed.forEach(o => (o.items || []).forEach(it => {
      productCounts[it.name] = (productCounts[it.name] || 0) + (Number(it.qty) || 1);
    }));
    const topProducts = Object.entries(productCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, qty]) => ({ name, qty }));
    const store = demoStores.getDemoStoreBySlot(slotId);
    res.json({
      currency: store?.currency || "ر.س",
      totalOrders: orders.length,
      confirmedCount: confirmed.length,
      pendingCount: pending.length,
      rejectedCount: rejected.length,
      totalRevenue: Number(totalRevenue.toFixed(2)),
      avgOrder: Number(avgOrder.toFixed(2)),
      topProducts,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// رجّع آخر الطلبات على slot الديمو (الطلبات تُحفظ بـ orders_try_X.jsonl)
app.get("/try/orders/:slotId", (req, res) => {
  const { slotId } = req.params;
  if (!TRY_SLOTS.includes(slotId)) return res.status(400).json({ error: "invalid slot" });
  const info = demoStores.getSlotInfo(slotId);
  if (!info) return res.status(404).json({ error: "slot not linked to demo" });
  try {
    const ordersFile = path.join(DATA_DIR, `orders_${slotId}.jsonl`);
    if (!fs.existsSync(ordersFile)) return res.json({ orders: [] });
    const lines = fs.readFileSync(ordersFile, "utf8").split("\n").filter(Boolean);
    const cutoff = info.initAt || 0;
    const orders = [];
    for (let i = lines.length - 1; i >= 0 && orders.length < 50; i--) {
      try {
        const o = JSON.parse(lines[i]);
        const oTime = new Date(o.timestamp || 0).getTime();
        if (oTime >= cutoff) orders.push(o); // فقط طلبات هذه الجلسة
      } catch {}
    }
    res.json({ orders });
  } catch (e) {
    res.status(500).json({ error: "فشل قراءة الطلبات: " + e.message });
  }
});

// ─── Try Page: ربط البوت الفعلي بـ QR للتجربة ────────────────────────────────
app.get("/try.html", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="#050505">
<title>تجربة البوت — اربط رقمك</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{min-height:100%;background:#050505;font-family:'Segoe UI',Tahoma,Arial,sans-serif;color:#eee;overflow-x:hidden}
.wrap{max-width:480px;margin:0 auto;padding:24px 18px;min-height:100vh;display:flex;flex-direction:column}
.hdr{text-align:center;padding:8px 0 22px}
.hdr h1{font-size:22px;font-weight:800;color:#D4AF37;letter-spacing:.3px}
.hdr p{font-size:13px;color:#888;margin-top:6px;line-height:1.6}

.card{background:#0e0e0e;border:1px solid #1e1e1e;border-radius:18px;padding:24px 20px;margin-bottom:14px}

.qr-box{background:#fff;border-radius:14px;padding:18px;display:flex;align-items:center;justify-content:center;min-height:280px;position:relative}
#qrContainer{display:flex;align-items:center;justify-content:center}
#qrContainer img,#qrContainer canvas{display:block;width:100%;max-width:240px;height:auto}

.spinner{width:48px;height:48px;border:4px solid #1e1e1e;border-top-color:#D4AF37;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.steps{margin-top:18px;padding:16px;background:#121212;border-radius:12px;border:1px solid #1a1a1a}
.steps h3{font-size:13px;font-weight:800;color:#D4AF37;margin-bottom:10px;letter-spacing:.5px}
.steps ol{padding-right:18px;color:#aaa;font-size:13px;line-height:1.9}
.steps ol li::marker{color:#D4AF37;font-weight:800}

.status-pill{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:14px;font-size:12px;font-weight:700;background:#121212;border:1px solid #1e1e1e;color:#888}
.status-pill .dot{width:7px;height:7px;border-radius:50%;background:#666}
.status-pill.qr{color:#D4AF37}.status-pill.qr .dot{background:#D4AF37;animation:pulse 1.5s ease-in-out infinite}
.status-pill.open{color:#22c55e}.status-pill.open .dot{background:#22c55e}
.status-pill.error{color:#ef4444}.status-pill.error .dot{background:#ef4444}
@keyframes pulse{50%{opacity:.4}}

.btn{display:inline-block;background:#D4AF37;color:#000;border:none;padding:12px 24px;border-radius:22px;font-size:14px;font-weight:800;cursor:pointer;text-decoration:none;text-align:center}
.btn:active{opacity:.85}
.btn.ghost{background:transparent;border:1.5px solid #333;color:#888}

.success{display:none;text-align:center;padding:30px 20px}
.success .check{font-size:80px;color:#22c55e;margin-bottom:14px;filter:drop-shadow(0 0 16px rgba(34,197,94,.4))}
.success h2{font-size:22px;color:#22c55e;font-weight:800;margin-bottom:10px}
.success p{color:#aaa;font-size:14px;line-height:1.8;margin-bottom:8px}
.success .phone{display:inline-block;background:#121212;border:1px solid #2a2a2a;padding:8px 14px;border-radius:10px;color:#D4AF37;font-weight:700;font-size:15px;direction:ltr;margin:10px 0}
.actions{display:flex;gap:10px;margin-top:18px;justify-content:center;flex-wrap:wrap}

.error-box{display:none;background:#1a0a0a;border:1px solid #3a1a1a;color:#f87171;padding:14px;border-radius:12px;font-size:13px;text-align:center;margin-top:14px}

.footer-note{margin-top:auto;padding-top:20px;text-align:center;color:#444;font-size:11px;line-height:1.6}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>🤖 جرّب البوت برقمك</h1>
    <p>اربط واتساب الخاص بك مؤقتاً (45 دقيقة) لتجربة البوت الحقيقي.<br>لن نحفظ أي بيانات بعد انتهاء التجربة.</p>
  </div>

  <div class="card">
    <div style="text-align:center;margin-bottom:14px">
      <span id="statusPill" class="status-pill"><span class="dot"></span><span id="statusTxt">جاري التحضير…</span></span>
    </div>

    <div class="qr-box" id="qrBox">
      <div class="spinner" id="spinner"></div>
      <div id="qrContainer" style="display:none"></div>
    </div>

    <div class="steps">
      <h3>خطوات الربط</h3>
      <ol>
        <li>افتح واتساب على هاتفك</li>
        <li>اذهب إلى الإعدادات → الأجهزة المرتبطة</li>
        <li>اضغط <b>ربط جهاز</b> وامسح الكود أعلاه</li>
      </ol>
    </div>

    <div class="error-box" id="errorBox"></div>
  </div>

  <div class="card success" id="successBox">
    <div class="check">✅</div>
    <h2>تم الربط بنجاح!</h2>
    <p>رقم البوت المتصل:</p>
    <div class="phone" id="botPhone">—</div>
    <p>افتح واتساب وأرسل أي رسالة من <b>رقم آخر</b> لرقم البوت لتبدأ التجربة.</p>
    <div class="actions">
      <a class="btn ghost" id="restartBtn" href="#" onclick="event.preventDefault();restart()">🔄 ربط جلسة جديدة</a>
    </div>
  </div>

  <div class="footer-note">⏱ كل جلسة تجريبية تنتهي تلقائياً بعد 45 دقيقة</div>
</div>

<script>
var slotId = null;
var pollTimer = null;
var lastQr = null;
var qrInstance = null;

var pill   = document.getElementById('statusPill');
var pillTxt= document.getElementById('statusTxt');
var spinner= document.getElementById('spinner');
var qrCt   = document.getElementById('qrContainer');
var qrBox  = document.getElementById('qrBox');
var errBox = document.getElementById('errorBox');
var successBox = document.getElementById('successBox');
var card   = document.querySelector('.card');

function setStatus(cls, txt) {
  pill.className = 'status-pill ' + cls;
  pillTxt.textContent = txt;
}

function showError(msg) {
  errBox.style.display = 'block';
  errBox.textContent = msg;
  setStatus('error', 'حدث خطأ');
}

function clearError() {
  errBox.style.display = 'none';
  errBox.textContent = '';
}

function renderQR(text) {
  if (text === lastQr) return;
  lastQr = text;
  qrCt.innerHTML = '';
  spinner.style.display = 'none';
  qrCt.style.display = 'flex';
  try {
    qrInstance = new QRCode(qrCt, {
      text: text,
      width: 240,
      height: 240,
      correctLevel: QRCode.CorrectLevel.M,
      colorDark: '#000',
      colorLight: '#fff'
    });
  } catch(e) { console.error('QR render:', e); }
}

function showSuccess(phone) {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  card.style.display = 'none';
  successBox.style.display = 'block';
  document.getElementById('botPhone').textContent = phone ? '+' + phone : '—';
}

async function init() {
  clearError();
  setStatus('', 'جاري التحضير…');
  spinner.style.display = 'block';
  qrCt.style.display = 'none';
  lastQr = null;

  try {
    var r = await fetch('/try/init', { method: 'POST' });
    var d = await r.json();
    if (!r.ok || !d.slotId) {
      showError(d.error || 'فشل بدء الجلسة');
      return;
    }
    slotId = d.slotId;
    pollStatus();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, 2500);
  } catch(e) {
    showError('تعذر الاتصال بالخادم');
  }
}

async function pollStatus() {
  if (!slotId) return;
  try {
    var r = await fetch('/try/status/' + slotId);
    var d = await r.json();
    if (d.status === 'open') {
      setStatus('open', 'متصل ✓');
      showSuccess(d.phone);
      return;
    }
    if (d.qr) {
      setStatus('qr', 'امسح الكود الآن');
      renderQR(d.qr);
      return;
    }
    if (d.status === 'connecting') {
      setStatus('', 'جاري الاتصال…');
      return;
    }
    if (d.status === 'disconnected') {
      setStatus('error', 'تم القطع — أعد المحاولة');
      return;
    }
    setStatus('', d.status || '…');
  } catch(e) {
    /* تجاهل أخطاء polling مؤقتة */
  }
}

function restart() {
  successBox.style.display = 'none';
  card.style.display = 'block';
  slotId = null;
  init();
}

init();
</script>
</body>
</html>`);
});

// ─── One-shot action trigger ──────────────────────────────────────────────────
// Customer taps a link from the bot message → bot processes the button press
app.get("/do/:token", async (req, res) => {
  const sess = waMgr.getActionSession(req.params.token);

  if (!sess) {
    return res.send(`<!DOCTYPE html><html dir="rtl" lang="ar"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0}body{display:flex;align-items:center;justify-content:center;height:100vh;font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#f8f9fa;direction:rtl}.w{text-align:center;padding:20px}.i{font-size:52px;margin-bottom:12px}.p{color:#888;font-size:14px;line-height:1.7}</style>
</head><body><div class="w"><div class="i">⏰</div><div class="p">انتهت صلاحية هذا الرابط<br>أرسل أي رسالة للبوت للمتابعة</div></div></body></html>`);
  }

  // Consume immediately — one-shot
  waMgr.clearActionSession(req.params.token);
  const { storeId, from, buttonId } = sess;

  // Respond instantly with auto-close screen
  res.send(`<!DOCTYPE html><html dir="rtl" lang="ar"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{display:flex;align-items:center;justify-content:center;height:100vh;background:#fff;font-family:'Segoe UI',Tahoma,Arial,sans-serif;direction:rtl}
.w{text-align:center;animation:fi .3s ease}
@keyframes fi{from{opacity:0;transform:scale(.88)}to{opacity:1;transform:scale(1)}}
.i{font-size:64px;margin-bottom:14px}
.p{color:#666;font-size:15px;line-height:1.8}
</style>
<script>setTimeout(function(){try{history.back();}catch(e){}try{window.close();}catch(e){}},800);</script>
</head><body>
<div class="w"><div class="i">✅</div><div class="p">تم!<br>سيصلك الرد على واتساب</div></div>
</body></html>`);

  // Process the action in background after response is flushed
  setImmediate(async () => {
    try {
      if (storeId === "owner_try" || /^try_\d+$/.test(storeId)) {
        const stores    = getAllStores().filter(s => s.active && s.subscriptionStatus === "active");
        const demoStore = stores.find(s => (s.products || []).length > 0) || stores[0] || null;
        await storeCtx.run({ storeId, store: demoStore }, () => handleMessage(from, buttonId));
      } else {
        const store = getStoreById(storeId);
        if (!store) return;
        await storeCtx.run({ storeId, store }, () => handleMessage(from, buttonId));
      }
    } catch (e) {
      console.error(`[do] ${storeId}→${from} ${buttonId}:`, e.message);
    }
  });
});

// ─── Preview Invoice ──────────────────────────────────────────────────────────
app.get("/preview-invoice", async (req, res) => {
  try {
    // 🎯 يقرأ storeId من query لو موجود (لكل تاجر معاينته)، وإلا يأخذ أول متجر
    const reqStoreId = String(req.query.storeId || "").trim();
    const all = getAllStores();
    const store = (reqStoreId && all.find(s => s.storeId === reqStoreId || s.id === reqStoreId)) || all[0] || {};
    // 🆕 query.template يسمح بالمعاينة الفورية قبل الحفظ (لاستخدام theme picker)
    const queryTemplate = String(req.query.template || "").trim();
    // عند المعاينة من theme picker — استخدم ألوان الـ template الأصلية (لا lون المتجر)
    // ليرى التاجر الفروق الفعلية بين الـ templates
    const overrideStoreColor = !!queryTemplate;
    const products = (store.products || []).filter(isProductInStock).slice(0, 4);
    const items    = products.length > 0
      ? products.map(p => ({ id: p.id, name: p.name, price: p.price, qty: 1, imageUrl: p.imageUrl||null }))
      : [
          { id:"h1", name:"كابتشينو",   price:18, qty:2, imageUrl:null },
          { id:"h2", name:"فرابتشينو",  price:22, qty:1, imageUrl:null },
          { id:"f1", name:"كرواسان",    price:15, qty:3, imageUrl:null },
        ];
    const subtotal  = items.reduce((s,i) => s + i.price*i.qty, 0);
    const fee       = store.deliveryFee || 10;
    const { filePath } = await generateInvoiceImage({
      orderId: "PREVIEW-" + Date.now().toString().slice(-6),
      storeName: store.storeName || STORE_NAME,
      // 🎨 لو من theme picker — تجاهل invoiceColor المتجر لرؤية ألوان الـ template الأصلية
      invoiceColor: overrideStoreColor ? null : (store.invoiceColor || "#1b5e20"),
      invoiceLogoUrl: store.invoiceLogoUrl || null,
      customerName: "أحمد محمد العميل",
      customerLocation: "حي النخيل — شارع الملك فهد",
      items, subtotal, deliveryFee: fee, total: subtotal+fee,
      currency: store.currency || CURRENCY,
      date: new Date().toISOString().slice(0,10),
      paymentSummary: require("./invoice-image").buildPaymentSummary(store),
      invoiceTemplate: queryTemplate || store.invoiceTemplate || "classic",
    });
    res.setHeader("Content-Type", "image/png");
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// ─── Public Menu Image (cached 1 hour) ───────────────────────────────────────
// In-memory cache: storeId → { filePath, generatedAt }
const _menuCache = new Map();
const MENU_CACHE_TTL = 60 * 60 * 1000; // 1 hour

app.get("/menu-image/:storeId", async (req, res) => {
  try {
    const { storeId } = req.params;
    const store = getStoreById(storeId);
    if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

    // Check cache
    const cached = _menuCache.get(storeId);
    if (cached && Date.now() - cached.generatedAt < MENU_CACHE_TTL && fs.existsSync(cached.filePath)) {
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.sendFile(cached.filePath);
    }

    const { filePath } = await generateMenuImage({
      storeId:        store.id,
      storeName:      store.storeName,
      invoiceColor:   store.invoiceColor   || null,
      invoiceLogoUrl: store.invoiceLogoUrl || null,
      categories:     store.categories     || [],
      products:       store.products       || [],
      currency:       store.currency       || CURRENCY,
    });

    if (!fs.existsSync(filePath)) {
      return res.status(500).json({ error: "فشل توليد صورة القائمة" });
    }

    _menuCache.set(storeId, { filePath, generatedAt: Date.now() });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.sendFile(filePath);
  } catch (err) {
    console.error("Public menu image error:", err.message);
    res.status(500).json({ error: "خطأ في توليد صورة القائمة" });
  }
});

// ─── Routers ──────────────────────────────────────────────────────────────────
app.use(require("./master-router"));
app.use(require("./store-router"));
app.use(require("./payments-router"));
app.use(require("./storefront-router"));   // v3: Storefront العلني (المتجر + السلة + Checkout)
app.use("/api/salla", require("./salla-router")); // Salla OAuth + Webhooks + Sync

// ─── Store helpers ────────────────────────────────────────────────────────────
// mtime-based cache: قراءة stores.json قد تحدث آلاف المرات/ساعة (كل WA message)
// نُعيد الـ parse فقط لو الملف تغيّر، وإلا نرجع آخر نسخة من الذاكرة.
const _storesCache = { mtimeMs: 0, stores: [], path: null };
function getAllStores() {
  const file = path.join(DATA_DIR, "stores.json");
  try {
    const stat = fs.statSync(file);
    if (stat.mtimeMs === _storesCache.mtimeMs && _storesCache.path === file) {
      return _storesCache.stores;
    }
    const { stores } = JSON.parse(fs.readFileSync(file, "utf8"));
    _storesCache.mtimeMs = stat.mtimeMs;
    _storesCache.stores = stores || [];
    _storesCache.path = file;
    return _storesCache.stores;
  } catch { return _storesCache.stores || []; }
}
// 🔄 إبطال فوري للكاش (يستدعيه store-router عند الحفظ — يضمن أن البوت يقرأ آخر إعدادات)
function invalidateStoresCache() {
  _storesCache.mtimeMs = 0;
  _storesCache.stores = [];
  _storesCache.path = null;
}
global.invalidateStoresCache = invalidateStoresCache;

function getStoreById(storeId) {
  return getAllStores().find(s => s.id === storeId) || null;
}

// try_1..5 / owner_try = demo slots
//  - فقط لو الـ slot مربوط بـ sector (من /try/init?sector=X) → استخدم demo store
//  - ⚠️ لا fallback لمتجر حقيقي (يمنع تسرّب بيانات/بوت متجر فعلي لرقم زائر ديمو)
function resolveStore(storeId) {
  if (/^try_\d+$/.test(storeId) || storeId === "owner_try") {
    return demoStores.getDemoStoreBySlot(storeId);
  }
  return getStoreById(storeId);
}

// ─── Working Hours ────────────────────────────────────────────────────────────
// يقبل ساعة كـ number (0-24) أو string "HH:MM" — backward compatible
function _toHourFloat(v, fallback) {
  if (v == null || v === "") return fallback;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
  if (/^\d{1,2}$/.test(s)) return parseInt(s, 10);
  return fallback;
}

function isStoreOpen(store) {
  const hStart = _toHourFloat(store?.workingHoursStart, hourStart);
  const hEnd   = _toHourFloat(store?.workingHoursEnd,   hourEnd);
  if (hStart === 0 && (hEnd >= 24 || hEnd >= 23.98)) return true; // 24/7
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  return hStart <= hEnd ? h >= hStart && h < hEnd : h >= hStart || h < hEnd;
}

function formatHour(h) {
  const hour = Math.floor(h);
  const min  = Math.round((h - hour) * 60);
  const period = hour < 12 ? "صباحاً" : "مساءً";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const mPart = min > 0 ? `:${String(min).padStart(2,"0")}` : "";
  return `${hour12}${mPart} ${period}`;
}

// ─── Business Type Helpers ────────────────────────────────────────────────────
// helpers getBusinessType/shouldAskDeliveryTime/computeETAText/businessLabels
// → moved to ./utils/server-helpers.js (Phase 1 refactor)

// ─── Pending Rating Requests ──────────────────────────────────────────────────
// ⚠️ isolation: مفتاح مركّب "storeId|phone" — يمنع تسرّب تقييم عميل بين متجرين
//    (نفس العميل يطلب من متجرين → كل متجر له مفتاح مستقل)
const pendingRatings = new Map();
global.pendingRatings = pendingRatings;
// helper لبناء المفتاح المركّب — يقبل storeId + phone بأي صيغة
function _prkey(storeId, phone) {
  const p = String(phone || "").replace(/[^\d]/g, "");
  return String(storeId || "unknown") + "|" + p;
}
// ⚡ compat: يقبل key legacy (phone فقط) — يبحث بكل المفاتيح
function _prfind(from) {
  const p = String(from || "").replace(/[^\d]/g, "");
  const legacy = from;
  // 1) legacy: phone فقط
  if (pendingRatings.has(from)) return { key: from, value: pendingRatings.get(from) };
  if (pendingRatings.has(legacy)) return { key: legacy, value: pendingRatings.get(legacy) };
  // 2) بحث بأي storeId|phone
  for (const [k, v] of pendingRatings) {
    if (k.endsWith("|" + p)) return { key: k, value: v };
  }
  return null;
}
// ⚡ يبحث بمفتاح storeId|phone تحديداً (isolation strict)
function _prget(storeId, from) {
  const key = _prkey(storeId, from);
  if (pendingRatings.has(key)) return { key, value: pendingRatings.get(key) };
  // fallback: legacy phone-only key (during migration)
  const p = String(from || "").replace(/[^\d]/g, "");
  const jid = p + "@s.whatsapp.net";
  for (const legacyKey of [from, p, jid]) {
    if (legacyKey && pendingRatings.has(legacyKey)) {
      const v = pendingRatings.get(legacyKey);
      // فقط ارجع لو نفس المتجر
      if (v?.storeId === storeId) return { key: legacyKey, value: v };
    }
  }
  return null;
}

// ─── Message Deduplication ────────────────────────────────────────────────────
const _seenMsgIds = new Map();
function isDuplicate(id) {
  if (!id) return false;
  if (_seenMsgIds.has(id)) return true;
  _seenMsgIds.set(id, Date.now());
  if (_seenMsgIds.size > 500) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, ts] of _seenMsgIds) if (ts < cutoff) _seenMsgIds.delete(k);
  }
  return false;
}

// ─── Server-Sent Events (SSE) — Tier B/3 ──────────────────────────────────────
// Push للوحة الادمن بدل polling — تأخير 10s → <100ms
// كل store admin يفتح stream، نرسل event عند حدث ذي صلة
const _sseClients = new Map(); // storeId → Set<res>

function sseAdd(storeId, res) {
  if (!_sseClients.has(storeId)) _sseClients.set(storeId, new Set());
  _sseClients.get(storeId).add(res);
}

function sseRemove(storeId, res) {
  const set = _sseClients.get(storeId);
  if (set) {
    set.delete(res);
    if (set.size === 0) _sseClients.delete(storeId);
  }
}

function sseSend(storeId, event, data) {
  const clients = _sseClients.get(storeId);
  if (!clients || clients.size === 0) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch {}
  }
}

// Heartbeat كل 15s — يحافظ على الاتصال خلال Tailscale Funnel/Cloudflare
// نُرسل event صريح "heartbeat" بدل comment لأن EventSource يتعامل معه أوضح
setInterval(() => {
  const now = Date.now();
  for (const [storeId, clients] of _sseClients) {
    for (const res of clients) {
      try { res.write(`event: heartbeat\ndata: ${now}\n\n`); } catch {}
    }
  }
}, 15_000);

// Expose للـ store-router (يستدعيها عند update من الـ HTTP API)
global.sseSend   = sseSend;
global.sseAdd    = sseAdd;
global.sseRemove = sseRemove;

// ─── Invoice send-once guard (defense in depth) ───────────────────────────────
// منع تكرار إرسال الفاتورة لنفس الطلب حتى لو تم استدعاء confirm مرتين بسرعة
// (double-tap من العميل، أو Baileys re-deliver، أو race condition).
//
// طبقة 3: Map في الذاكرة (O(1)) — يحمي من قراءة orders.jsonl المتكررة عند الـ scale
// (مع 5000 طلب، قراءة الملف 50ms+ × كل confirm = bottleneck).
const _invoiceSendingLocks = new Map(); // orderId → Promise (لمنع concurrent race)
const _invoiceSentCache    = new Map(); // orderId → true (سريع جداً، يبقى لـ 24h)

// تنظيف Map كل ساعة (orderIds من أمس لا تُعيد للاستخدام)
setInterval(() => {
  if (_invoiceSentCache.size > 10000) _invoiceSentCache.clear();
}, 60 * 60 * 1000);

function _markInvoiceSent(orderId) {
  _invoiceSentCache.set(orderId, true);
}

function _readOrderInvoiceSent(storeId, orderId) {
  // Fast path 1: cache
  if (_invoiceSentCache.has(orderId)) return true;
  // Fast path 2: in-memory order index (Tier B — O(1))
  try {
    const order = require("./orders").findOrder(storeId, orderId);
    if (order?.invoiceSent) {
      _invoiceSentCache.set(orderId, true);
      return true;
    }
  } catch {}
  return false;
}

// ─── Input Validation: كشف الرسائل العشوائية والأسئلة الخارجية ────────────────

// كشف الكلام العشوائي/spam (gibberish)
// helpers isGibberish/isOffTopicQuery/isValidName/isEditIntent
// → moved to ./utils/server-helpers.js (Phase 1 refactor)

// ─── Location helpers — Reverse Geocoding (Nominatim مجاني) ──────────────────
// يحوّل الإحداثيات إلى اسم منطقة/حي/مدينة بالعربية
async function reverseGeocode(lat, lng) {
  try {
    // zoom=17 يعطي تفصيل الشارع. accept-language=ar للأسماء العربية
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=ar&zoom=17&addressdetails=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const r = await fetch(url, {
      headers: { "User-Agent": "ThawaniPlatform/1.0 (WhatsApp Store Bot)" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const d = await r.json();
    const a = d?.address || {};
    // نُضمّن الشارع لأن الـ suburb من Nominatim ضعيف في السعودية أحياناً
    const parts = [
      a.road || a.pedestrian || a.residential,
      a.suburb || a.neighbourhood || a.quarter,
      a.city_district || a.district,
      a.city || a.town || a.village,
    ].filter(Boolean);
    // إزالة التكرار (لو road و suburb بنفس الاسم)
    const seen = new Set();
    const unique = parts.filter(p => { const k = p.trim(); if (seen.has(k)) return false; seen.add(k); return true; });
    const compact = unique.length ? unique.join("، ") : null;
    return compact || d?.display_name || null;
  } catch (e) {
    console.warn(`[geo] reverse failed: ${e.message}`);
    return null;
  }
}

// يكتشف ويحلّل payload الموقع المشترك القادم من whatsapp-manager
// الصيغة: "📍|lat,lng|directLabel"
async function resolveSharedLocation(payload) {
  const m = String(payload || "").match(/^📍\|(-?\d+\.?\d*),(-?\d+\.?\d*)\|(.*)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  const direct = (m[3] || "").trim();
  // 1) لو واتساب أرسل الاسم/العنوان معه — نستخدمه
  if (direct) return { lat, lng, name: direct, source: "wa" };
  // 2) reverse geocoding من OpenStreetMap
  const name = await reverseGeocode(lat, lng);
  if (name) return { lat, lng, name, source: "osm" };
  // 3) آخر حل: إحداثيات + اقتراح للعميل
  return { lat, lng, name: `موقع جغرافي (${lat.toFixed(4)}, ${lng.toFixed(4)})`, source: "raw" };
}

// ─── Stock helpers ────────────────────────────────────────────────────────────
// isProductInStock → moved to ./utils/server-helpers.js (Phase 1 refactor)

// خصم الكميات المباعة من stores.json بعد تأكيد الطلب
function decrementStock(storeId, cartItems) {
  if (!storeId || !Array.isArray(cartItems) || !cartItems.length) return;
  try {
    const file = path.join(DATA_DIR, "stores.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const store = data.stores.find(s => s.id === storeId);
    if (!store) return;
    let changed = false;
    for (const item of cartItems) {
      const prod = (store.products || []).find(p => String(p.id) === String(item.id));
      if (!prod) continue;
      // null/undefined = لا محدود، نتجاهل
      if (prod.stock === null || prod.stock === undefined) continue;
      const qty = Math.max(0, Number(item.qty) || 0);
      prod.stock = Math.max(0, prod.stock - qty);
      changed = true;
    }
    if (changed) fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn("[stock] decrement failed:", e.message);
  }
}

// ─── Send Functions ───────────────────────────────────────────────────────────
async function sendText(to, body) {
  // Demo context: buffer messages
  const demo = demoCtx.getStore();
  if (demo) {
    demo.buffer.push({ type: "text", body });
    return;
  }
  const ctx = storeCtx.getStore() || {};
  // Cross-bot owner reply override: route reply through a different bot session
  if (ctx.replyVia) {
    try { await waMgr.sendMessage(ctx.replyVia.storeId, ctx.replyVia.to, body); return; }
    catch(e) { console.error(`sendText replyVia [${ctx.replyVia.storeId}]:`, e.message); }
  }
  const { storeId } = ctx;
  if (!storeId) return;
  // ⚡ كل sendText من البوت هو رد على رسالة عميل واردة → fastReply + allowCold آمن
  // (العميل حالياً يراسل، فالرد ليس cold — قد يكون record لم يُحفظ بعد بسبب debounce)
  try { await waMgr.sendMessage(storeId, to, body, { fastReply: true, allowCold: true, reason: "bot_reply" }); } catch(e) {
    console.error(`sendText [${storeId}]:`, e.message);
  }
}

async function sendImage(to, source, caption) {
  const demo = demoCtx.getStore();
  if (demo) {
    demo.buffer.push({ type: "image", source, caption });
    return;
  }
  const { storeId } = storeCtx.getStore() || {};
  if (!storeId) return;
  try {
    let buffer;
    if (Buffer.isBuffer(source)) {
      buffer = source;
    } else if (typeof source === "string") {
      // Extract filename from any /store-images/ path (relative or full URL) → read from disk
      const storeImagesMatch = source.match(/\/store-images\/([^?#]+)/);
      if (storeImagesMatch) {
        const localFile = path.join(DATA_DIR, "images", storeImagesMatch[1]);
        buffer = fs.readFileSync(localFile);
      } else if (source.startsWith("http")) {
        const resp = await axios.get(source, { responseType: "arraybuffer", timeout: 10000 });
        buffer = Buffer.from(resp.data);
      } else {
        buffer = fs.readFileSync(source);
      }
    }
    await waMgr.sendImage(storeId, to, buffer, caption || "");
  } catch(e) {
    console.error(`sendImage [${storeId}]:`, e.message);
    if (caption) await sendText(to, caption);
  }
}

// sendButtons: poll (ضغطة واحدة، بدون كتابة) ← fallback نص مرقّم
async function sendButtons(to, { body, buttons, footer }) {
  const demo  = demoCtx.getStore();
  const { storeId } = storeCtx.getStore() || {};
  const safe  = buttons.slice(0, 10);
  const btnMap = {};
  safe.forEach((b, i) => { btnMap[String(i + 1)] = b.id; });
  sessionManager.update(to, { _btnMap: btnMap });

  // ⚡ default footer = "للاستفسار اكتب: مسؤول"
  const HELP_HINT = "💬 للاستفسار اكتب: مسؤول";
  if (!footer || footer.trim() === "") {
    footer = HELP_HINT;
  } else if (!footer.includes("مسؤول")) {
    footer = footer + "\n" + HELP_HINT;
  }

  const nums = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];

  if (demo) {
    const opts = safe.map((b, i) => `${nums[i] || (i + 1) + "."} ${b.title}`).join("\n");
    demo.buffer.push({ type: "text", body: body + "\n\n" + opts + (footer ? "\n\n" + footer : "") });
    return;
  }
  if (!storeId) return;

  // text plain فقط في الحالات التالية (لا polls):
  // - AI/Numeric/Webview paths
  // - أثناء خطوات checkout (اسم، عنوان، وقت، تأكيد) — لأن polls قد لا تصل بشكل مرئي
  const sess = sessionManager.get(to);
  const checkoutSteps = ["COLLECT_NAME","COLLECT_LOCATION","SCHEDULE_ORDER","COLLECT_TIME","CONFIRM_ORDER"];
  const textOnly = sess?.path === "ai"
                || sess?.path === "numeric"
                || sess?.path === "webview"
                || checkoutSteps.includes(sess?.step);

  if (!textOnly) {
    // محاولة poll — العميل يضغط فقط، لا يكتب شيئاً
    const pollSent = await waMgr.sendNativeButtons(storeId, to, {
      body,
      buttons: safe,
      footer: footer || "",
    });
    if (pollSent) return;
  }

  // text المرقّم — يصلح كـ fallback أو كـ default في AI/Numeric mode
  const opts = safe.map((b, i) => `${nums[i] || (i + 1) + "."} ${b.title}`).join("\n");
  const hint = safe.length > 1 ? "\n\n↩️ *اكتب رقم اختيارك*" : "";
  await waMgr.sendMessage(storeId, to, body + "\n\n" + opts + (footer ? "\n\n" + footer : "") + hint);
}

// sendList: native list message → fallback نص عادي بدون رابط
async function sendList(to, { body, sections, footer, buttonText }) {
  const demo  = demoCtx.getStore();
  const { storeId } = storeCtx.getStore() || {};
  const rows  = sections.flatMap(s => s.rows);
  const rowMap = {};
  rows.forEach((r, i) => { rowMap[String(i + 1)] = r.id; });
  sessionManager.update(to, { _btnMap: rowMap });

  // ⚡ default footer = "للاستفسار اكتب: مسؤول" — يُضاف لو لم يحدد المستدعي footer مختلف
  const HELP_HINT = "💬 للاستفسار اكتب: مسؤول";
  if (!footer || footer.trim() === "") {
    footer = HELP_HINT;
  } else if (!footer.includes("مسؤول")) {
    // لو الـ footer موجود لكن لا يذكر مسؤول، أضف الهينت كسطر إضافي
    footer = footer + "\n" + HELP_HINT;
  }

  const nums = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
  const opts = rows.map((r, i) => `${nums[i] || (i+1)+"."} ${r.title}`).join("\n");

  if (demo) {
    demo.buffer.push({ type: "text", body: body + "\n\n" + opts + (footer ? "\n\n" + footer : "") });
    return;
  }
  if (!storeId) return;

  // ⚠️ Native List (يظهر كاستطلاع رأي في واتساب) — معطّل دائماً
  // نستخدم نص عادي + أرقام للاختيار، تجربة أوضح وأقل إرباكاً للعميل
  const text = body + "\n\n" + opts + (footer ? "\n\n" + footer : "");
  await waMgr.sendMessage(storeId, to, text);
}

// ─── Arabic/Persian digit normalization (٠١٢...٩ + ۰۱۲...۹ → 0123...9) ─────
function normalizeDigits(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(/[٠-٩]/g, d => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(d)])
    .replace(/[۰-۹]/g, d => "0123456789"["۰۱۲۳۴۵۶۷۸۹".indexOf(d)]);
}

// ─── Conversation Router ──────────────────────────────────────────────────────
// ⏸ Mute logic: مدة الصمت بعد إرسال المنيو إذا العميل لم يختار
const MUTE_DURATION_MS = 5 * 60 * 1000;  // 5 دقائق
// إشارات تكسر الـ mute فوراً (طلب مساعدة فعلي)
// بعد normalizeAr: ؤ→و، أ→ا، إ→ا
const UNMUTE_TRIGGERS = /^(مسوول|بشري|انسان|human|الغاء|cancel|start|ابدا|البدايه|الرءيسيه|الرءيسيه|stop|توقف|ايقاف)$/i;

// 🚦 Rate limit per customer (anti-spam) — 30 رسالة/دقيقة
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX       = 30;
const _customerRateLimit = new Map(); // from → [timestamps]

function _isRateLimited(from) {
  const now = Date.now();
  const arr = (_customerRateLimit.get(from) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  arr.push(now);
  _customerRateLimit.set(from, arr);
  // cleanup كل 5 دقائق
  if (_customerRateLimit.size > 1000) {
    for (const [k, v] of _customerRateLimit) {
      if (v.length === 0 || now - v[v.length - 1] > 5 * 60_000) _customerRateLimit.delete(k);
    }
  }
  return arr.length > RATE_LIMIT_MAX;
}

// 🔤 Typo tolerance — Levenshtein distance بسيط
function _levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  const m = [];
  for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      m[i][j] = b[i-1] === a[j-1] ? m[i-1][j-1]
        : Math.min(m[i-1][j-1] + 1, m[i][j-1] + 1, m[i-1][j] + 1);
    }
  }
  return m[b.length][a.length];
}

// يحاول تصحيح الكلمة لو قريبة من keyword معروف (max distance = 2)
function _fuzzyMatch(input, keywords) {
  const s = String(input || "").trim().toLowerCase();
  if (!s) return null;
  for (const kw of keywords) {
    if (s === kw) return kw;
    if (s.length >= 3 && _levenshtein(s, kw) <= 2) return kw;
  }
  return null;
}

const COMMON_KEYWORDS = ["قائمة", "قائمه", "منيو", "menu", "سلة", "سلتي", "cart",
                         "تأكيد", "تاكيد", "اكد", "confirm", "ok",
                         "الغاء", "إلغاء", "cancel", "stop",
                         "مسؤول", "مساعدة", "help", "بشري",
                         "ابدأ", "start", "البداية", "الرئيسية",
                         "تتبع", "track", "نقاطي", "points",
                         "كرر", "كرّر", "اعد", "أعد", "reorder",
                         // ⏰ كلمات الوقت الشائعة — لا يجب تصحيحها لأي شيء آخر
                         "الان", "الآن", "now", "فوراً", "فورا"];

// كلمات تعفى من typo-fix (لو تطابقت تماماً، لا تصحّح حتى لو distance = 1)
const PROTECTED_WORDS = new Set([
  // كلمات الوقت
  "الان", "الآن", "now", "فورا", "فوراً",
  // إجابات قصيرة
  "تم", "نعم", "لا", "اوك", "ok", "ايوه", "ايوة", "اي",
  // ⭐ التحيات الشائعة — لا تُصحَّح إلى منيو/سلة!
  "هلا", "هلاو", "هلو", "هاي", "هاى", "hi", "hello",
  "اهلا", "أهلا", "أهلاً", "مرحبا", "مرحباً", "سلام",
  "السلام", "صباح", "مساء", "حياك", "كيفك", "شخبارك",
  // تخطّي
  "تخطي", "تخطى", "skip",
]);

// 🌍 Language detection — يكتشف لغة الرسالة (ar/en)
function _detectLang(text) {
  const s = String(text || "").trim();
  if (!s) return "ar";
  // عربية: > 30% من الأحرف عربية
  const arabicChars = (s.match(/[؀-ۿ]/g) || []).length;
  const latinChars  = (s.match(/[a-zA-Z]/g) || []).length;
  if (latinChars > arabicChars && latinChars >= 3) return "en";
  return "ar";
}

// 🎛️ Owner commands من واتساب — يحوّل رسالة المالك إلى action على الطلب
// returns: true لو الأمر تمت معالجته، false لو ليس أمر مالك
// ─── Two-phase undo window ───────────────────────────────────────────────────
// Map<storeId|orderId, { prevStatus, timer, action, storeId }> — 30 ث undo بعد قبول/رفض
// 🛡️ isolation: مفتاح مركّب يمنع تصادم لو نفس timestamp نتج orderId مشابه في متجرين
const _orderUndoWindow = new Map();
const UNDO_WINDOW_MS = 30_000;

function _undoKey(storeId, orderId) {
  return String(storeId || "unknown") + "|" + String(orderId || "");
}
function _registerUndo(storeId, orderId, prevStatus, action) {
  const key = _undoKey(storeId, orderId);
  const prev = _orderUndoWindow.get(key);
  if (prev?.timer) clearTimeout(prev.timer);
  const timer = setTimeout(() => _orderUndoWindow.delete(key), UNDO_WINDOW_MS);
  timer.unref?.();
  _orderUndoWindow.set(key, { prevStatus, timer, action, storeId, orderId });
}

// 🎯 الأمر المرتبط بالمحادثة الحالية: المالك في chat عميل + يكتب "قبول"/"رفض"
// → يبحث عن آخر طلب لهذا العميل ويُنفّذ الأمر تلقائياً
// targetPhone = رقم العميل في الـ chat الحالي (من remoteJid)
async function handleInlineOwnerCmd(storeId, targetPhone, cmd, extra) {
  try {
    // 📋 منيو — المالك في chat عميل + يكتب "منيو" → أرسل رابط المنيو للعميل
    // (لا يحتاج طلب سابق — العميل قد يكون يستفسر فقط)
    if (/^(منيو|قاءمه|قاءمة|menu)$/i.test(cmd)) {
      const store = getStoreById(storeId);
      const storeName = store?.storeName || "متجرنا";
      try {
        const token = waMgr.createWebOrderToken(storeId, targetPhone);
        const url = `${process.env.PUBLIC_URL}/${token}`;
        const logoUrl = store?.logoUrl
          ? (store.logoUrl.startsWith("http") ? store.logoUrl : `${(process.env.PUBLIC_URL || "").replace(/\/$/, "")}${store.logoUrl}`)
          : "";
        const ctaSent = await waMgr.sendCtaButton(storeId, targetPhone, {
          body: `🛍️ *${storeName}*\n\nاضغط الزر لفتح القائمة الكاملة + اختيار طلبك 👇`,
          buttonText: "🛒 افتح القائمة",
          url, footer: storeName, thumbnailUrl: logoUrl,
        });
        if (!ctaSent) {
          await waMgr.sendMessage(storeId, targetPhone, `🛍️ *${storeName}*\n\n📱 رابط القائمة الكاملة:\n${url}`);
        }
      } catch (e) {
        console.warn("[inline-menu] failed:", e.message);
        await waMgr.sendMessage(storeId, targetPhone, `🛍️ *${storeName}*\n\nاكتب أي رسالة لي لبدء الطلب 🌸`).catch(() => {});
      }
      return true;
    }

    // 🚀 تسريع: آخر 200 طلب فقط + بحث من النهاية مع early break
    const orders = readOrders(storeId, 200);
    if (!orders.length) return false;

    const norm = String(targetPhone).replace(/\D/g, "");
    const tail = norm.slice(-9);

    // ابحث من النهاية للبداية — أحدث طلب أولاً، break فور جمع 5
    const matchingOrders = [];
    for (let i = orders.length - 1; i >= 0 && matchingOrders.length < 5; i--) {
      const o = orders[i];
      const op = String(o.customerPhone || "").replace(/\D/g, "");
      if (op && (op === norm || op.endsWith(tail) || norm.endsWith(op.slice(-9)))) {
        matchingOrders.push(o);
      }
    }
    if (!matchingOrders.length) return false;
    // matchingOrders الآن من الأحدث للأقدم — لا حاجة لـ reverse()

    // قبول/تأكيد → آخر طلب pending
    if (/^(قبول|اكد|أكد|confirm)$/i.test(cmd)) {
      const target = matchingOrders.find(o => o.status === "pending_confirmation");
      if (!target) return false;
      const store = getStoreById(storeId);
      const ownerJid = (store?.ownerPhone || "").replace(/\D/g, "");
      return storeCtx.run({ storeId, store }, async () => {
        await handleOwnerCommand(ownerJid, `قبول ${target.orderId}`, store, storeId);
        return true;
      });
    }
    // رفض → آخر طلب pending أو confirmed
    if (/^(رفض|reject)$/i.test(cmd)) {
      const target = matchingOrders.find(o => ["pending_confirmation","confirmed"].includes(o.status));
      if (!target) return false;
      const store = getStoreById(storeId);
      const ownerJid = (store?.ownerPhone || "").replace(/\D/g, "");
      const reasonStr = extra ? ` ${extra}` : " غير محدد";
      return storeCtx.run({ storeId, store }, async () => {
        await handleOwnerCommand(ownerJid, `رفض ${target.orderId}${reasonStr}`, store, storeId);
        return true;
      });
    }
    // helper: ابعث رسالة توضيحية للمالك في نفس chat العميل
    async function _replyOwnerInfo(_storeId, _targetPhone, text) {
      try {
        const waMgr = require("./whatsapp-manager");
        await waMgr.sendMessage(_storeId, _targetPhone, text);
      } catch {}
    }

    // 🍽️ جاهز → آخر طلب confirmed/preparing → ready_pickup
    if (/^(جاهز|ready)$/i.test(cmd)) {
      const target = matchingOrders.find(o => ["confirmed","preparing"].includes(o.status));
      if (!target) {
        // وجّه المالك: لو في طلب pending، يحتاج يقبله أولاً
        const pending = matchingOrders.find(o => o.status === "pending_confirmation");
        if (pending) {
          await _replyOwnerInfo(storeId, targetPhone, `⚠️ الطلب *${pending.orderId}* ما زال *بانتظار القبول*.\nاكتب *قبول* أولاً، ثم *جاهز*.`);
          return true;
        }
        return false;
      }
      const store = getStoreById(storeId);
      const ownerJid = (store?.ownerPhone || "").replace(/\D/g, "");
      return storeCtx.run({ storeId, store }, async () => {
        await handleOwnerCommand(ownerJid, `جاهز ${target.orderId}`, store, storeId);
        return true;
      });
    }
    // 🚴 مندوب → آخر طلب confirmed/preparing → out_for_delivery
    if (/^(مندوب|delivery|خرج)$/i.test(cmd)) {
      const target = matchingOrders.find(o => ["confirmed","preparing"].includes(o.status));
      if (!target) {
        const pending = matchingOrders.find(o => o.status === "pending_confirmation");
        if (pending) {
          await _replyOwnerInfo(storeId, targetPhone, `⚠️ الطلب *${pending.orderId}* ما زال *بانتظار القبول*.\nاكتب *قبول* أولاً، ثم *مندوب*.`);
          return true;
        }
        return false;
      }
      const store = getStoreById(storeId);
      const ownerJid = (store?.ownerPhone || "").replace(/\D/g, "");
      return storeCtx.run({ storeId, store }, async () => {
        await handleOwnerCommand(ownerJid, `خرج ${target.orderId}`, store, storeId);
        return true;
      });
    }
    // ✅ تم → آخر طلب نشط → completed (يُرسل طلب التقييم)
    if (/^(تم|completed|تسليم|done)$/i.test(cmd)) {
      const target = matchingOrders.find(o => ["confirmed","preparing","ready_pickup","out_for_delivery","in_progress"].includes(o.status));
      if (!target) {
        const pending = matchingOrders.find(o => o.status === "pending_confirmation");
        if (pending) {
          await _replyOwnerInfo(storeId, targetPhone, `⚠️ الطلب *${pending.orderId}* ما زال *بانتظار القبول*.\nاكتب *قبول* أولاً، ثم *تم*.`);
          return true;
        }
        return false;
      }
      const store = getStoreById(storeId);
      const ownerJid = (store?.ownerPhone || "").replace(/\D/g, "");
      return storeCtx.run({ storeId, store }, async () => {
        await handleOwnerCommand(ownerJid, `تم ${target.orderId}`, store, storeId);
        return true;
      });
    }
    return false;
  } catch (e) {
    console.warn("[inline-owner-cmd] failed:", e.message);
    return false;
  }
}
global.handleInlineOwnerCmd = handleInlineOwnerCmd;

async function handleOwnerCommand(from, text, store, storeId) {
  if (!text || text.length < 2 || text.length > 200) return false;

  // ── 🔄 تراجع — يستعيد آخر قبول/رفض خلال 30 ث ──────────────────────────
  const undoMatch = text.match(/^(تراجع|الغ\s*القبول|undo)\s*(?:ORD-?)?(\d+)?\s*$/i);
  if (undoMatch) {
    const idPart = undoMatch[2];
    let target = null;
    // 🛡️ isolation: نبحث فقط بين undos لهذا المتجر (المفتاح = storeId|orderId)
    const storePrefix = String(storeId || "unknown") + "|";
    const myEntries = [..._orderUndoWindow.entries()].filter(([k]) => k.startsWith(storePrefix));
    if (idPart) {
      for (const [key, info] of myEntries) {
        if ((info.orderId || "").endsWith(idPart)) { target = { key, info }; break; }
      }
    } else {
      // آخر تسجيل للمتجر الحالي فقط
      if (myEntries.length) target = { key: myEntries[myEntries.length - 1][0], info: myEntries[myEntries.length - 1][1] };
    }
    if (!target) { await sendText(from, "❌ لا توجد عملية يمكن التراجع عنها (نافذة 30 ث انتهت)"); return true; }
    const targetOrderId = target.info.orderId;
    const ordersFile = storeId === "nakheel_001" ? path.join(DATA_DIR, "orders.jsonl") : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
    await require("./atomic-fs").updateJsonlLocked(ordersFile, (lines) => {
      const updated = lines.map(l => {
        try {
          const o = JSON.parse(l);
          if (o.orderId === targetOrderId) {
            o.status = target.info.prevStatus;
            o.undoneAt = new Date().toISOString();
            delete o.statusUpdatedAt;
          }
          return JSON.stringify(o);
        } catch { return l; }
      });
      return { lines: updated };
    });
    clearTimeout(target.info.timer);
    _orderUndoWindow.delete(target.key);
    await sendText(from, `↩️ تم التراجع عن *${target.info.action}* للطلب *${targetOrderId}*`);
    return true;
  }

  // الأنماط المدعومة:
  //   "قبول"                       → آخر طلب pending
  //   "قبول ORD-1234567"            → طلب محدد
  //   "رفض ORD-1234567 السبب"
  //   "جاهز ORD-1234567"            → ready_pickup
  //   "بدأ ORD-1234567"             → preparing
  //   "خرج ORD-1234567"             → out_for_delivery
  //   "تم ORD-1234567"              → completed
  //   "إلغاء ORD-1234567 السبب"     → cancelled (by store)
  //   "طلبات"                       → قائمة آخر 5 pending
  //   "مساعدة" أو "help"            → قائمة الأوامر

  const tl = text.toLowerCase();
  const ordersFile = storeId === "nakheel_001"
    ? path.join(DATA_DIR, "orders.jsonl")
    : path.join(DATA_DIR, `orders_${storeId}.jsonl`);

  // قائمة الأوامر / المساعدة
  if (/^(مساعدة|أوامر|اوامر|help|commands)$/i.test(text)) {
    await sendText(from,
      `🎛️ *أوامر إدارة الطلبات من واتساب*\n\n` +
      `📦 *إدارة الطلبات:*\n` +
      `*قبول* — يؤكد آخر طلب pending\n` +
      `*قبول ORD-1234567* — طلب محدد\n` +
      `*رفض ORD-1234567 السبب*\n` +
      `*بدأ ORD-1234567* — قيد التحضير\n` +
      `*جاهز ORD-1234567* — جاهز للاستلام\n` +
      `*خرج ORD-1234567* — المندوب في الطريق\n` +
      `*تم ORD-1234567* — تم التسليم\n` +
      `*إلغاء ORD-1234567 السبب*\n` +
      `*طلبات* — قائمة آخر 5 طلبات pending\n\n` +
      `🆘 *إدارة وضع المسؤول:*\n` +
      `*منتظرين* — قائمة العملاء بانتظار مسؤول\n` +
      `*استئناف 9665XXXXXXX* — أعد البوت لعميل محدد\n` +
      `*استئناف الكل* — أعد البوت لكل العملاء\n\n` +
      `💡 يمكنك حذف "ORD-" والاكتفاء برقم الطلب`
    );
    return true;
  }

  // ── 🆘 إدارة handoffs من واتساب ────────────────────────────
  // قائمة العملاء المنتظرين
  if (/^(منتظرين|handoffs|قائمة\s*المسؤول)$/i.test(text)) {
    try {
      const handoffFile = path.join(__dirname, "..", "data", "handoffs.json");
      const handoffs = fs.existsSync(handoffFile) ? JSON.parse(fs.readFileSync(handoffFile, "utf8")) : {};
      const mine = Object.entries(handoffs).filter(([_, h]) => h.storeId === storeId);
      if (!mine.length) { await sendText(from, "✅ لا يوجد عملاء بانتظار مسؤول حالياً"); return true; }
      const list = mine.map(([key, h], i) => {
        const phStr = h.phone || key.split("|").pop();
        const cleanPh = String(phStr).replace("@s.whatsapp.net", "").replace(/\D/g, "");
        const mins = Math.floor((Date.now() - new Date(h.startedAt || h.at || 0).getTime()) / 60000);
        return `${i+1}. +${cleanPh}\n   منذ ${mins} د — "${(h.lastMsg||"").slice(0,40)}"`;
      }).join("\n\n");
      await sendText(from,
        `🆘 *${mine.length} عميل بانتظار مسؤول:*\n\n${list}\n\n` +
        `للاستئناف: *استئناف 9665XXXXXXX*\n` +
        `للجميع: *استئناف الكل*`
      );
      return true;
    } catch (e) { console.warn("[owner-cmd] منتظرين failed:", e.message); return false; }
  }

  // استئناف البوت لعميل واحد أو الكل
  const resumeMatch = text.match(/^(استئناف|استانف|اعد\s*البوت|resume)\s+(.+)$/i);
  if (resumeMatch) {
    try {
      const target = resumeMatch[2].trim();
      const handoffFile = path.join(__dirname, "..", "data", "handoffs.json");
      const handoffs = fs.existsSync(handoffFile) ? JSON.parse(fs.readFileSync(handoffFile, "utf8")) : {};
      let removed = 0, notified = [];
      if (/^(الكل|all|الجميع)$/i.test(target)) {
        for (const [key, h] of Object.entries(handoffs)) {
          if (h.storeId === storeId) {
            const phStr = h.phone || key.split("|").pop();
            delete handoffs[key];
            removed++;
            notified.push(phStr);
          }
        }
      } else {
        // رقم محدد
        const cleanTarget = target.replace(/\D/g, "");
        for (const [key, h] of Object.entries(handoffs)) {
          if (h.storeId !== storeId) continue;
          const phStr = h.phone || key.split("|").pop();
          const cleanPh = String(phStr).replace(/\D/g, "");
          if (cleanPh === cleanTarget || cleanPh.endsWith(cleanTarget)) {
            delete handoffs[key];
            removed++;
            notified.push(phStr);
          }
        }
      }
      if (!removed) { await sendText(from, "❌ لم أجد عميلاً مطابقاً في وضع المسؤول"); return true; }
      require("./atomic-fs").writeJsonSync(handoffFile, handoffs);
      // أبلغ كل عميل أن البوت عاد
      for (const ph of notified) {
        try {
          await waMgr.sendMessage(storeId, ph,
            `🤖 *البوت يعمل من جديد*\n\nيمكنك الآن متابعة طلبك معنا. اكتب أي شيء للبدء 🌸`);
        } catch (e) { console.warn(`[resume] notify ${ph} failed:`, e.message); }
      }
      await sendText(from, `✅ تم استئناف البوت لـ *${removed}* عميل\nوأُرسلت لهم رسالة إعلام.`);
      return true;
    } catch (e) {
      console.warn("[owner-cmd] استئناف failed:", e.message);
      await sendText(from, "⚠️ فشل: " + e.message);
      return true;
    }
  }

  // قائمة طلبات pending
  if (/^(طلبات|orders|الطلبات)$/i.test(text)) {
    try {
      // 🚀 in-memory (~10ms) بدل قراءة الملف الكاملة (~200ms+)
      const all = readOrders(storeId, 200);
      const orders = all.filter(o => o.status === "pending_confirmation" && !o._test).slice(-5).reverse();
      if (!orders.length) {
        await sendText(from, "✅ لا توجد طلبات بانتظار التأكيد");
        return true;
      }
      const list = orders.map((o, i) =>
        `${i + 1}. *${o.orderId}* — ${o.customerName || o.customerPhone}\n` +
        `   ${o.total} ${o.currency || "ر.س"} | ${(o.items || []).map(it => it.name).join("، ").slice(0, 40)}`
      ).join("\n\n");
      await sendText(from,
        `📋 *آخر ${orders.length} طلبات بانتظار التأكيد:*\n\n${list}\n\n` +
        `للقبول: *قبول ${orders[0].orderId}*\n` +
        `للرفض: *رفض ${orders[0].orderId} السبب*`
      );
      return true;
    } catch (e) {
      console.warn("[owner-cmd] طلبات failed:", e.message);
      return false;
    }
  }

  // أوامر تعديل حالة (قبول/رفض/جاهز/بدأ/خرج/تم/إلغاء)
  const cmdMatch = text.match(/^(قبول|اكد|أكد|confirm|رفض|reject|بدأ|بدا|preparing|جاهز|ready|خرج|delivery|تم|completed|تسليم|إلغاء|الغاء|cancel)\s*(?:ORD-?)?(\d+)?\s*(.*)$/i);
  if (!cmdMatch) return false;

  const cmd     = cmdMatch[1].toLowerCase();
  const orderNumPart = cmdMatch[2] || "";
  const extra   = (cmdMatch[3] || "").trim();

  // 🚀 in-memory index — O(1) للـ lookup بـ orderId
  let order;
  if (orderNumPart) {
    const ordersMod = require("./orders");
    const fullOrderId = orderNumPart.startsWith("ORD-") ? orderNumPart : `ORD-${orderNumPart}`;
    order = ordersMod.findOrder(storeId, fullOrderId);
    if (!order) {
      // fallback: suffix match (للأرقام الجزئية)
      const all = readOrders(storeId, 200);
      order = all.find(o => o.orderId && o.orderId.endsWith(orderNumPart));
    }
  } else if (/^(قبول|اكد|أكد|confirm)$/i.test(cmd)) {
    // قبول بدون orderId → آخر طلب pending
    const all = readOrders(storeId, 100);
    const pending = all.filter(o => o.status === "pending_confirmation" && !o._test);
    order = pending[pending.length - 1];
  }

  if (!order) {
    await sendText(from,
      `❌ لم أعثر على الطلب${orderNumPart ? ` *${orderNumPart}*` : ""}.\n\nاكتب *طلبات* لرؤية القائمة، أو *مساعدة* للأوامر`
    );
    return true;
  }

  // تنفيذ الأمر
  const internalSelfReq = { storeId, impersonatedBy: null };

  try {
    if (/^(قبول|اكد|أكد|confirm)$/i.test(cmd)) {
      if (order.status === "confirmed") {
        await sendText(from, `⚠️ الطلب *${order.orderId}* مؤكد مسبقاً`);
        return true;
      }
      if (["rejected","cancelled","completed"].includes(order.status)) {
        await sendText(from, `⚠️ الطلب *${order.orderId}* حالته *${order.status}* — لا يمكن تأكيده`);
        return true;
      }
      // تنفيذ نفس logic /store/orders/:id/confirm
      const { addPoints } = require("./loyalty");
      const { upsertCustomer } = require("./customers");
      if (order.customerPhone && hasFeature(store?.plan, "customerRegistry")) {
        try {
          upsertCustomer({
            phone: String(order.customerPhone).replace(/\D/g, ""),
            name: order.customerName || "",
            location: order.customerLocation || "",
            total: Number(order.total || 0),
            storeId,
          });
        } catch {}
      }
      let earned = null;
      if (order.customerPhone) {
        try { earned = addPoints(storeId, order.customerPhone, Number(order.total || 0), order.orderId, store); } catch {}
      }
      // حدّث الـ status عبر orders.updateOrderStatus — يُطلق SSE event للوحة الادمن
      const stamp = new Date().toISOString();
      const _prevStatus = order.status;
      const extraMeta = store?.avgDeliveryMin ? { estimatedMinutes: Number(store.avgDeliveryMin), statusUpdatedAt: stamp } : { statusUpdatedAt: stamp };
      try {
        const ordersMod = require("./orders");
        await ordersMod.updateOrderStatus(storeId, order.orderId, "confirmed");
        // حدّث الحقول الإضافية (estimatedMinutes, timestamp) في الـ index + disk
        for (const [k, v] of Object.entries(extraMeta)) {
          await ordersMod.updateOrderField(storeId, order.orderId, k, v);
        }
      } catch (e) {
        console.warn("[owner-cmd.confirm] updateOrderStatus failed:", e.message);
      }
      _registerUndo(storeId, order.orderId, _prevStatus, "قبول");

      // 📨 رسالة موحّدة للعميل: التأكيد + صورة الفاتورة caption في رسالة واحدة (مثل /store/confirm)
      const pointsLine = (earned && earned.newPoints > 0)
        ? `🏆 كسبت *${earned.newPoints}* نقطة! رصيدك: *${earned.totalPoints}*\n` : "";
      const etaLine = store?.avgDeliveryMin ? `⏱️ الوقت المتوقع: *${store.avgDeliveryMin} دقيقة* تقريباً\n` : "";
      const locationLine = require("./order-helpers").buildLocationLine(order, store);
      const confirmCaption =
        `✅ *تم تأكيد طلبك!*\n\n` +
        `رقم الطلب: *${order.orderId}*\n` +
        etaLine +
        pointsLine +
        locationLine +
        `\n📦 لتتبع طلبك في أي وقت اكتب: *تتبع*\n\n` +
        `شكراً لاختيارك *${store?.storeName || ""}* 🙏`;

      const { PUBLIC_URL } = process.env;
      const planFeatures = require("./plans").getPlanFeatures
        ? require("./plans").getPlanFeatures(store?.plan)
        : { invoiceImage: hasFeature(store?.plan, "invoiceImage") };
      let sentMerged = false;
      if (planFeatures.invoiceImage && PUBLIC_URL && !order.invoiceSent) {
        try {
          const img = await generateInvoiceImage({
            orderId:          order.orderId,
            storeName:        store?.storeName || "",
            invoiceColor:     store?.invoiceColor || null,
            invoiceLogoUrl:   store?.invoiceLogoUrl || null,
            customerName:     order.customerName,
            customerLocation: order.customerLocation,
            items:            order.items || [],
            subtotal:         order.subtotal,
            deliveryFee:      order.deliveryFee,
            total:            order.total,
            currency:         order.currency || "ر.س",
            date:             order.date || new Date().toISOString().slice(0, 10),
            notes:            order.notes || order.orderNotes || "",
            customAnswers:    order.customAnswers || null,
            deliveryZone:     order.deliveryZone || null,
            paymentSummary:   require("./invoice-image").buildPaymentSummary(store),
            invoiceTemplate:  store?.invoiceTemplate || "classic",
          });
          await waMgr.sendImage(storeId, order.customerPhone, img.filePath, confirmCaption);
          try { require("./orders").updateOrderField(storeId, order.orderId, "invoiceSent", true); } catch {}
          sentMerged = true;
        } catch (invErr) {
          console.warn("[owner-cmd.confirm] invoice failed:", invErr.message);
        }
      }
      if (!sentMerged) {
        try { await waMgr.sendMessage(storeId, order.customerPhone, confirmCaption, { allowCold: true, reason: "order_accepted" }); } catch {}
      }

      await sendText(from,
        `✅ تأكيد *${order.orderId}*\nأُبلغ العميل ${order.customerName || ""} بالقبول${earned && earned.newPoints > 0 ? ` (+${earned.newPoints} نقطة)` : ""}`
      );
      return true;
    }

    if (/^(رفض|reject)$/i.test(cmd)) {
      const reason = extra || "غير محدد";
      const stamp = new Date().toISOString();
      const _prevStatus = order.status;
      // عبر orders module لإطلاق SSE
      try {
        const ordersMod = require("./orders");
        await ordersMod.updateOrderStatus(storeId, order.orderId, "rejected");
        await ordersMod.updateOrderField(storeId, order.orderId, "rejectedAt", stamp);
        await ordersMod.updateOrderField(storeId, order.orderId, "rejectReason", reason);
        await ordersMod.updateOrderField(storeId, order.orderId, "statusUpdatedAt", stamp);
      } catch (e) {
        console.warn("[owner-cmd.reject] update failed:", e.message);
      }
      _registerUndo(storeId, order.orderId, _prevStatus, "رفض");
      // ⚠️ امسح تقييم معلّق لهذا المتجر فقط (isolation strict)
      const _pcust = order.customerPhone || "";
      const _pcustJid = String(_pcust).replace(/[^\d]/g, "") + "@s.whatsapp.net";
      const _prCompositeKey = _prkey(storeId, _pcust);
      for (const k of [_prCompositeKey, _pcustJid, _pcust]) {
        if (k && pendingRatings.has(k)) {
          const p = pendingRatings.get(k);
          // فقط امسح لو نفس المتجر (isolation)
          if (p?.storeId !== storeId) continue;
          if (p?.timer) clearTimeout(p.timer);
          if (p?.reminderTimer) clearTimeout(p.reminderTimer);
          if (p?.commentTimer) clearTimeout(p.commentTimer);
          pendingRatings.delete(k);
        }
      }
      // أبلغ العميل
      try {
        await waMgr.sendMessage(storeId, order.customerPhone,
          `❌ *نأسف، لم نتمكن من تنفيذ طلبك*\n\nرقم الطلب: *${order.orderId}*\n📋 السبب: ${reason}\n\nنأسف على الإزعاج 🙏\n\n*${store?.storeName || ""}*`);
      } catch {}
      await sendText(from, `❌ رفض *${order.orderId}* (السبب: ${reason})\nأُبلغ العميل`);
      return true;
    }

    // status updates: بدأ/جاهز/خرج/تم
    const STATUS_MAP = {
      "بدأ": ["preparing", "👨‍🍳 *جاري تحضير طلبك الآن*\n\nسنخبرك بمجرد جاهزيته 🚀"],
      "بدا": ["preparing", "👨‍🍳 *جاري تحضير طلبك الآن*\n\nسنخبرك بمجرد جاهزيته 🚀"],
      "preparing": ["preparing", "👨‍🍳 *جاري تحضير طلبك الآن*\n\nسنخبرك بمجرد جاهزيته 🚀"],
      "جاهز": ["ready_pickup", `✅ *طلبك جاهز للاستلام*\n\nيمكنك الحضور لـ *${store?.storeName || ""}* لاستلامه 🏪`],
      "ready": ["ready_pickup", `✅ *طلبك جاهز للاستلام*\n\nيمكنك الحضور لـ *${store?.storeName || ""}* لاستلامه 🏪`],
      "خرج": ["out_for_delivery", `🚴 *المندوب في الطريق إليك*\n\nاستعد لاستلام طلبك من *${store?.storeName || ""}* 📍`],
      "delivery": ["out_for_delivery", `🚴 *المندوب في الطريق إليك*\n\nاستعد لاستلام طلبك من *${store?.storeName || ""}* 📍`],
      "تم": ["completed", null], // null = نُرسل رسالة التقييم
      "completed": ["completed", null],
      "تسليم": ["completed", null],
    };
    const mapEntry = STATUS_MAP[cmd];
    if (mapEntry) {
      const [newStatus, customerMsg] = mapEntry;
      const stamp = new Date().toISOString();
      await require("./atomic-fs").updateJsonlLocked(ordersFile, (lines) => {
        const updated = lines.map(l => {
          try {
            const o = JSON.parse(l);
            if (o.orderId === order.orderId) {
              o.status = newStatus;
              o.statusUpdatedAt = stamp;
              if (newStatus === "completed") o.deliveredAt = stamp;
            }
            return JSON.stringify(o);
          } catch { return l; }
        });
        return { lines: updated };
      });

      if (customerMsg) {
        try { await waMgr.sendMessage(storeId, order.customerPhone, customerMsg, { allowCold: true, reason: "status_update" }); } catch {}
      } else if (newStatus === "completed") {
        // ⭐ احترام إعداد التاجر: لو enableRatings=false → رسالة شكر فقط بدون تقييم
        if (store?.enableRatings === false) {
          const thanksMsg = `✅ *تم تسليم طلبك بنجاح!*\n\nشكراً لاختيارك *${store?.storeName || ""}* 🙏`;
          try { await waMgr.sendMessage(storeId, order.customerPhone, thanksMsg, { allowCold: true, reason: "status_update" }); } catch {}
          // 🚫 لا نضيف pendingRatings لأن التقييم معطّل
          return; // skip rest of rating-setup logic
        }
        // رسالة تقييم
        const ratingMsg =
          `✅ *تم تسليم طلبك بنجاح!*\n\n` +
          `شكراً لاختيارك *${store?.storeName || ""}* 🙏\n\n` +
          `كيف تقيّم تجربتك معنا؟ ⭐\n\n` +
          `*1* — ⭐\n` +
          `*2* — ⭐⭐\n` +
          `*3* — ⭐⭐⭐\n` +
          `*4* — ⭐⭐⭐⭐\n` +
          `*5* — ⭐⭐⭐⭐⭐\n\n` +
          `_اكتب رقم التقييم المناسب لك (من 1 إلى 5) 👇_`;
        try { await waMgr.sendMessage(storeId, order.customerPhone, ratingMsg, { allowCold: true, reason: "rating_request" }); } catch {}
        // 🛡️ ألغِ أي timer سابق (من handleConfirmYes) قبل الاستبدال
        // ⭐ isolation: مفتاح مركّب "storeId|phone" — عزل تقييم كل متجر
        const customerJid = String(order.customerPhone || "").replace(/[^\d]/g, "") + "@s.whatsapp.net";
        const compositeKey = _prkey(storeId, order.customerPhone);
        // نظّف كل المفاتيح القديمة لنفس المتجر فقط (isolation)
        for (const k of [compositeKey, customerJid, order.customerPhone]) {
          const prevPending = pendingRatings.get(k);
          if (!prevPending) continue;
          if (prevPending.storeId !== storeId) continue; // لا تلمس متاجر أخرى
          if (prevPending.timer)         clearTimeout(prevPending.timer);
          if (prevPending.reminderTimer) clearTimeout(prevPending.reminderTimer);
          if (prevPending.commentTimer)  clearTimeout(prevPending.commentTimer);
          pendingRatings.delete(k);
        }
        // 🕐 بعد 5 دقائق نمسح — تنظيف تلقائي
        const cleanupTimer = setTimeout(() => {
          pendingRatings.delete(compositeKey);
          console.log(`[rating-cleanup] ${compositeKey} — تم تنظيف pendingRatings (لم يقيّم خلال 5 دقائق)`);
        }, 5 * 60 * 1000);
        cleanupTimer.unref?.();
        pendingRatings.set(compositeKey, {
          storeId, orderId: order.orderId, storeName: store?.storeName || "", store,
          timer: cleanupTimer, reminderTimer: null,
        });
      }
      const statusLabels = {
        preparing: "🍳 قيد التحضير",
        ready_pickup: "✅ جاهز للاستلام",
        out_for_delivery: "🚴 خرج للتوصيل",
        completed: "✓ تم التسليم",
      };
      await sendText(from, `${statusLabels[newStatus] || newStatus} — *${order.orderId}*\nأُبلغ العميل ${order.customerName || ""}`);
      return true;
    }

    if (/^(إلغاء|الغاء|cancel)$/i.test(cmd)) {
      const reason = extra || "ألغى المالك الطلب";
      const stamp = new Date().toISOString();
      const updated = allOrders.map(o => {
        if (o.orderId === order.orderId) {
          o.status = "cancelled";
          o.cancelledAt = stamp;
          o.cancelledBy = "store";
          o.cancelReason = reason;
        }
        return JSON.stringify(o);
      });
      fs.writeFileSync(ordersFile, updated.join("\n") + "\n");
      try {
        await waMgr.sendMessage(storeId, order.customerPhone,
          `🚫 *تم إلغاء طلبك*\n\nرقم الطلب: *${order.orderId}*\nالسبب: ${reason}\n\nيسعدنا خدمتك مرة أخرى 🌸`);
      } catch {}
      await sendText(from, `🚫 إلغاء *${order.orderId}* (السبب: ${reason})`);
      return true;
    }
  } catch (e) {
    console.error("[owner-cmd] failed:", e.message);
    await sendText(from, `⚠️ خطأ في تنفيذ الأمر: ${e.message}`);
    return true;
  }

  return false;
}

// 🚨 Fraud detection — يحسب عدد cancellations لرقم معين
function _detectFraud(storeId, phone) {
  try {
    const ordersFile = storeId === "nakheel_001"
      ? path.join(DATA_DIR, "orders.jsonl")
      : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
    if (!fs.existsSync(ordersFile)) return { suspicious: false };
    const last30days = Date.now() - 30 * 24 * 60 * 60_000;
    let cancellations = 0, total = 0;
    for (const l of fs.readFileSync(ordersFile, "utf8").split("\n").filter(Boolean)) {
      try {
        const o = JSON.parse(l);
        const oPhone = String(o.customerPhone || "").replace(/\D/g, "");
        if (oPhone !== phone) continue;
        if (new Date(o.timestamp || 0).getTime() < last30days) continue;
        total++;
        if (o.status === "cancelled" && o.cancelledBy === "customer") cancellations++;
        if (o.status === "rejected") cancellations++;
      } catch {}
    }
    // مشبوه: ≥5 cancellations في 30 يوم، أو ratio > 60%
    const suspicious = cancellations >= 5 || (total >= 3 && cancellations / total > 0.6);
    return { suspicious, cancellations, total };
  } catch { return { suspicious: false }; }
}

// 🔗 معالج طلب من رابط /m/ — يتخطى الترحيب، يحلل الأصناف، يطلب العنوان مباشرة
async function _handleShareLinkOrder(from, text, store) {
  const storeId = store.id;
  // استخراج الأصناف من النص (lines starting with •)
  // 🔍 نطابق كل صنف بـ store.products لاسترجاع imageUrl/priceOnRequest/السعر الصحيح
  const cartItems = [];
  const lines = text.split("\n");
  const products = Array.isArray(store.products) ? store.products : [];
  const _normName = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  for (const line of lines) {
    const m = line.match(/^•\s*(.+?)\s*×\s*(\d+)(?:\s*—\s*([\d.]+))?/);
    if (m) {
      const name = m[1].trim();
      const qty = parseInt(m[2], 10) || 1;
      const subtotal = parseFloat(m[3]) || 0;
      const parsedPrice = qty > 0 ? (subtotal / qty) : 0;
      // طابق المنتج الأصلي (exact ثم contains) لاسترجاع imageUrl والسعر الموثوق
      const nameKey = _normName(name);
      const prod = products.find(p => _normName(p.name) === nameKey)
                || products.find(p => _normName(p.name).includes(nameKey) || nameKey.includes(_normName(p.name)));
      const isNegotiable = !!prod?.priceOnRequest;
      cartItems.push({
        id: prod?.id || ("sl_" + Date.now() + "_" + cartItems.length),
        name: prod?.name || name,
        qty,
        price: isNegotiable ? 0 : Number(prod?.price ?? parsedPrice ?? 0),
        imageUrl: prod?.imageUrl || (Array.isArray(prod?.images) ? prod.images[0] : null) || null,
        priceOnRequest: isNegotiable,
      });
    }
  }
  if (!cartItems.length) {
    console.warn(`[share-link/bot] no items parsed for ${from}`);
    return sendText(from, botMsg.msg(store, "freetext.parse_failed", { menuLink: "https://thawani.tail19ddab.ts.net/m/" + (store.shareSlug || "") }));
  }
  // احسب الإجمالي
  const subtotal = cartItems.reduce((s, i) => s + i.price * i.qty, 0);
  const grandTotal = subtotal + (Number(store.deliveryFee || 0));
  // 💾 احفظ السلة في session + اقفز مباشرة لجمع العنوان
  const customerName = "عميل";
  sessionManager.set(from, {
    step: "COLLECT_LOCATION",
    cart: cartItems,
    grandTotal,
    customerName,
    path: "share_link",
    source: "share_link",
    customAnswers: {},
  });
  // اطلب العنوان مباشرة (لا ترحيب)
  const itemsPreview = cartItems.map(i => `• ${i.name} × ${i.qty}`).join("\n");
  await sendText(from,
    `✅ *تم استلام طلبك*\n\n` +
    itemsPreview +
    (subtotal > 0 ? `\n\n💰 الإجمالي: *${subtotal.toFixed(2)} ${store.currency || "ر.س"}*` : "") +
    `\n\n📍 *أرسل عنوان التوصيل*\n` +
    `_شارك موقعك (📎 → موقع) أو اكتب الحي/الشارع_`,
    { fastReply: true }
  );
  console.log(`[share-link/bot] order accepted from ${from} storeId=${storeId} items=${cartItems.length} total=${subtotal}`);
}

async function handleMessage(from, incoming) {
  const { store, storeId } = storeCtx.getStore() || {};
  let session    = sessionManager.get(from);

  // 🔖 احفظ storeId في الـ session — يستخدمه inactivity-watcher لإرسال رسالة الإلغاء
  if (storeId && session._storeId !== storeId) {
    sessionManager.update(from, { _storeId: storeId, _inactivityCancelled: false });
  }

  // ⭐ TRACK=CART: البوت صامت تماماً
  // المتاجر بمسار "سلة فقط":
  //   - لا أي رد تلقائي للعميل من الـ session
  //   - المالك يكلم العميل بنفسه (يفتح المحادثة في الواتس ويرد)
  //   - الـ session فقط ترسل: status updates (تم/في الطريق/...) من لوحة الأدمن
  //   - الـ session لا تعالج أي رسالة واردة (الرسائل تصل المالك مباشرة عبر واتس)
  try {
    const { normalizeTrack } = require("./plans");
    const planTrack = store?.trackOverride
      ? normalizeTrack(store.trackOverride)
      : normalizeTrack(require("./plans").getPlan(store?.plan)?.track);
    if (planTrack === "cart") {
      // أرشف الرسالة في handoff (للمالك يراها في لوحة الأدمن tab "تذاكر / محادثات")
      try {
        const fs = require("fs");
        const path = require("path");
        const atomicFs = require("./atomic-fs");
        const handoffFile = path.join(__dirname, "..", "data", "handoffs.json");
        let handoffs = {};
        try { handoffs = JSON.parse(fs.readFileSync(handoffFile, "utf8")); } catch {}
        const hkey = storeId + "|" + from;
        handoffs[hkey] = {
          storeId,
          phone: from,
          startedAt: handoffs[hkey]?.startedAt || new Date().toISOString(),
          lastMsg: String(incoming).slice(0, 200),
          lastAt: new Date().toISOString(),
          source: "cart_silent",
        };
        atomicFs.writeJsonSync(handoffFile, handoffs);
      } catch {}
      return; // 🛑 صمت تام — لا رد للعميل
    }
  } catch (e) {
    console.warn("[cart-track] track check failed:", e.message);
    // fail-open: استمر للبوت العادي
  }

  // normalize Arabic/Persian digits → English قبل أي معالجة
  incoming = normalizeDigits(incoming);

  // 🚫 Cross-store loop guard: لو الرسالة آتية من رقم مالك متجر آخر في نفس النظام،
  //    أو من رقم البلاتفورم (supportPhone)، تجاهلها لمنع loops.
  const customerPhone = phoneNum(from);
  try {
    const otherOwners = new Set();
    for (const s of getAllStores()) {
      if (s.id === storeId) continue;
      const op = String(s.ownerPhone || "").replace(/\D/g, "");
      if (op) otherOwners.add(op);
    }
    // أضف الـ supportPhone للنظام
    try {
      const masterRouter = require("./master-router");
      const settings = (typeof masterRouter.readOwnerSettings === "function") ? masterRouter.readOwnerSettings() : {};
      const sup = String(settings.supportPhone || "").replace(/\D/g, "");
      if (sup) otherOwners.add(sup);
    } catch {}
    let isOtherOwner = false;
    for (const op of otherOwners) {
      if (isSamePhone(customerPhone, op)) {
        isOtherOwner = true;
        break;
      }
    }
    if (customerPhone && isOtherOwner) {
      console.warn(`[loop-guard] [${storeId}] ignoring message from system phone ${customerPhone.slice(0,6)}***`);
      return;
    }
    // كذلك: تجاهل الرسائل التي تبدو إعادة بث لردود البوت (لكسر loops بأرقام متاجر تستقبل)
    const lower = String(incoming || "").trim();
    if (lower.length > 25 && /^(اهلا|أهلاً|🤖|بسم الله|اختر رقماً|للاستفسار اكتب)/.test(lower)) {
      console.warn(`[loop-guard] [${storeId}] ignoring bot-echo from ${customerPhone.slice(0,6)}***: "${lower.slice(0,30)}..."`);
      return;
    }
  } catch (e) { console.warn("[loop-guard] failed:", e.message); }

  // 🎛️ Owner commands من واتساب: قبول/رفض/جاهز/خرج/تم — للمالك فقط
  if (store?.ownerPhone && isSamePhone(customerPhone, store.ownerPhone)) {
    const result = await handleOwnerCommand(from, String(incoming || "").trim(), store, storeId);
    if (result === true) return; // الأمر تمت معالجته
    // result === false → استكمل الـ flow الطبيعي (المالك يطلب من متجره نفسه)
  }

  // 📅 Booking intent detection — للبيزنس التي تدعم المواعيد
  // عند كلمات: احجز، حجز، موعد، booking → يرشد العميل ويسجّل الطلب للمالك
  const bookingBizTypes = ["salon","clinic","spa","barber","services","home_services","car_services"];
  if (bookingBizTypes.includes(store?.businessType)) {
    const txt = String(incoming || "").trim().toLowerCase();
    if (/^(احجز|أحجز|حجز|موعد|booking|book)\b|اريد موعد|أريد موعد|عايز موعد/i.test(txt)) {
      try {
        const helpMsg =
`📅 *حجز موعد*

شكراً لرغبتك في حجز موعد بـ *${store.storeName}* 🌹

يرجى تزويدنا بـ:
• اسم الخدمة (مثلاً: قص شعر، تنظيف بشرة...)
• التاريخ والوقت المفضّل
• اسمك الكريم

سيرد عليك المسؤول مباشرة لتأكيد الحجز ✅`;
        await waMgr.sendMessage(storeId, from, helpMsg, { allowCold: true, reason: "booking_intent_reply" });
        // أبلغ المالك بطلب الحجز
        if (store.ownerPhone) {
          const ownerNotif = `📅 *طلب حجز جديد*\n\n👤 من: ${customerPhone}\n💬 الرسالة: "${String(incoming).slice(0,100)}"\n\nافتح لوحة الادمن → 📅 الحجوزات لإضافة الموعد.`;
          waMgr.sendMessage(storeId, store.ownerPhone + "@s.whatsapp.net", ownerNotif, { allowCold: true, reason: "owner_archive" }).catch(() => {});
        }
        return;
      } catch (e) { console.warn("[booking-intent] failed:", e.message); }
    }
  }

  // 🛠️ Maintenance mode — per-store عزل تام
  //   يفحص ONLY متجر storeId الحالي. باقي المتاجر غير متأثرة (storeCtx مفصول).
  //   لو maintenanceUntil فات → نفك الصيانة تلقائياً (lazy unset).
  if (store?.maintenanceMode) {
    const untilISO = store.maintenanceUntil;
    const untilMs  = untilISO ? new Date(untilISO).getTime() : 0;
    if (untilMs && Date.now() > untilMs) {
      // فك الصيانة تلقائياً للمتجر الحالي فقط — atomic عبر withLock
      try {
        const af = require("./atomic-fs");
        const storesFile = path.join(DATA_DIR, "stores.json");
        await af.withLock(storesFile, async () => {
          const data = af.readJsonSync(storesFile, { stores: [] });
          const idx = data.stores.findIndex(s => s.id === storeId);
          if (idx >= 0 && data.stores[idx].maintenanceMode) {
            data.stores[idx].maintenanceMode = false;
            af.writeJsonSync(storesFile, data);
            console.log(`[maintenance] [${storeId}] auto-unset (until passed)`);
          }
        });
      } catch (e) { console.warn("[maintenance] auto-unset failed:", e.message); }
    } else {
      // مازال في صيانة → ردّ برسالة وأنهِ
      // throttle: لا نُرسل لنفس العميل أكثر من مرة كل 30 دقيقة
      const lastSent = session.maintNotifiedAt || 0;
      if (Date.now() - lastSent < 30 * 60_000) return;
      sessionManager.update(from, { maintNotifiedAt: Date.now() });
      const baseMsg = store.maintenanceMessage || `🛠️ *${store.storeName || "المتجر"}* مغلق مؤقتاً للصيانة.\nنعتذر عن الإزعاج، نعود قريباً ✨`;
      let extra = "";
      if (untilMs) {
        const ar = new Date(untilMs).toLocaleString("ar-SA", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "long", hour12: true });
        extra = `\n\n⏰ *نعود الساعة:* ${ar}`;
      }
      try { await waMgr.sendMessage(storeId, from, baseMsg + extra); } catch {}
      return;
    }
  }

  // ⏸ Mute check: إذا الجلسة مُسكّتة، تجاهل كل الرسائل (إلا إشارات الكسر)
  if (session.mutedUntil && Date.now() < session.mutedUntil) {
    const trimmed = aiParser.normalizeAr(String(incoming || "").trim());
    if (UNMUTE_TRIGGERS.test(trimmed)) {
      // العميل طلب مساعدة فعلياً — أزل الـ mute واستمر معالجة عادية
      sessionManager.update(from, { mutedUntil: 0, menuAwaitingSince: 0 });
    } else {
      // مكتوم — لا رد، اطبع log فقط
      console.log(`[mute] [${storeId}] ignoring msg from ${from} (muted ${Math.ceil((session.mutedUntil - Date.now())/1000)}s left)`);
      return;
    }
  }

  // 🚦 Rate limit (anti-spam): 30 رسالة/دقيقة
  if (_isRateLimited(from)) {
    console.log(`[rate-limit] ${from} blocked (>${RATE_LIMIT_MAX}/min)`);
    // رد مرة واحدة فقط لإعلام العميل، ثم اصمت
    if (!session._rateLimitWarned) {
      sessionManager.update(from, { _rateLimitWarned: Date.now() });
      return sendText(from,
        `⚠️ *رسائل كثيرة جداً*\n\nيرجى التمهّل قليلاً.\nانتظر دقيقة ثم تابع.`
      );
    }
    return;
  }
  // أعد ضبط الـ rate warn بعد دقيقتين
  if (session._rateLimitWarned && Date.now() - session._rateLimitWarned > 120_000) {
    sessionManager.update(from, { _rateLimitWarned: 0 });
  }

  // 🤐 Aggressive sender protection: 3 رسائل خلال 30 ثانية = mute فوري
  // يحمي من الـ spam حتى لو دون الـ 30/min cap
  const burstWindow = 30_000;
  const recentMsgs = (_customerRateLimit.get(from) || []).filter(t => Date.now() - t < burstWindow);
  if (recentMsgs.length >= 8) {
    // 8 رسائل في 30 ثانية → mute 3 دقائق
    if (!session.mutedUntil || Date.now() > session.mutedUntil) {
      sessionManager.update(from, { mutedUntil: Date.now() + 3 * 60_000 });
      console.log(`[burst-mute] [${storeId}] ${from} muted for 3min (8+ msgs/30s)`);
      return sendText(from,
        `🤖 *البوت في وضع الانتظار*\n\n` +
        `لاحظنا رسائل كثيرة — سيعود الرد خلال *3 دقائق*.\n\n` +
        `للاستعجال: اكتب *مسؤول* للتواصل المباشر`
      );
    }
    return;
  }

  // 🔁 Quick reorder — "كرر" أو "أعد آخر طلب" تستعيد آخر طلب
  if (/^(كرر|اعد|reorder|repeat|نفس\s*الطلب|اطلب\s*مثل|كرر\s*طلبي)/i.test(aiParser.normalizeAr(String(incoming).trim()))) {
    if (session.lastOrderItems && Array.isArray(session.lastOrderItems)) {
      const cart = session.lastOrderItems.map(i => ({
        id: i.id, name: i.name, price: Number(i.price) || 0,
        qty: Number(i.qty) || 1, imageUrl: i.imageUrl || null,
      }));
      sessionManager.set(from, {
        cart,
        path: "webview",
        customerName: "عميل",
        customerLocation: session.lastCustomerLocation || null,
      });
      const summary = cart.map(i => `• ${i.name} ×${i.qty}`).join("\n");
      await sendText(from, `✅ *تم استرجاع آخر طلب*\n\n${summary}`);
      return _moveToNextAfterCart();
    } else {
      return sendText(from, `لا يوجد طلب سابق لاسترجاعه.\nاكتب: *ابدأ* لتصفّح القائمة`);
    }
  }

  // 📎 الرسائل المُرسَلة كصور/صوت/فيديو/ملصقات/مستندات
  // البوت يتجاهلها بصمت — لا يقاطع محادثة الماستر مع العميل
  if (typeof incoming === "string" && incoming.startsWith("📎|")) {
    const kind = incoming.split("|")[1] || "media";
    console.log(`[media-skip] [${storeCtx.getStore()?.storeId}] ${from} sent ${kind} — ignored`);
    return;
  }

  // ── Human Handoff: العميل يطلب مسؤول (بعد normalize ؤ→و: "مسؤول"="مسوول") ─
  const _normIncoming = aiParser.normalizeAr(String(incoming || ""));
  const HANDOFF_TRIGGERS = /(احتاج\s*مسوول|اريد\s*مسوول|عايز\s*مسوول|ابغي\s*مسوول|بدي\s*مسوول|^مسوول$|المسوول|اريد\s*التحدث|بشري|انسان|human\s*agent|live\s*agent|real\s*person|كلم\s*مسوول|تحدث\s*مع\s*مسوول|اطلب\s*مسوول)/i;
  // 🚨 كشف الشكاوى: لو العميل يتذمّر/يشتكي → auto-handoff ساعة كاملة، البوت يصمت تماماً
  const COMPLAINT_TRIGGERS = /(شكوى|شكوي|اشكي|شكاوى|شكاويكم|ازعجني|زعلان|زعلانه|غاضب|مستاء|مو راضي|مش راضي|ما راضي|سيّ?ء|سيىء|سيئ|سيئه|رداءه|رديء|رديئه|قذر|قرف|فاشل|فاشله|كذب|احتيال|نصب|سرقه|سارقين|ضحك|هزيمه|حرام|ظلم|ظالمين|كارثه|كارثي|كارثيه|بطيء|بطيىء|بطيئه|ابطا|فاسد|فاسده|منتهي|منتهيه\s*صلاحي|طلبي\s*(غلط|خطا|ناقص|مو صحيح|مش صحيح)|(لم|ما|مو|مش)\s*(وصل|وصلني|جا|جاني|استلم)|رفضت|رفضنا|قدمت\s*شكوى|شكيت|بلغت|بلاغ|رجعوا\s*فلوسي|ارجعوا\s*فلوسي|استرداد|استرجاع|استعاده)/i;
  if (COMPLAINT_TRIGGERS.test(_normIncoming)) {
    const fs = require("fs");
    const path = require("path");
    const atomicFs = require("./atomic-fs");
    const handoffFile = path.join(__dirname, "..", "data", "handoffs.json");
    let handoffs = {};
    try { handoffs = JSON.parse(fs.readFileSync(handoffFile, "utf8")); } catch {}
    const hkey = storeId + "|" + from;
    // ✅ إذا كان الـ handoff نشطاً بالفعل، لا نفعل شيء (البوت أصلاً صامت)
    if (!handoffs[hkey]) {
      handoffs[hkey] = {
        storeId,
        phone:     from,
        startedAt: new Date().toISOString(),
        lastMsg:   String(incoming).slice(0, 200),
        reason:    "complaint_detected",
        autoStarted: true, // TTL 1h — البوت يعود بعدها لو الأدمن لم يتدخل
        complaintTtlMs: 60 * 60 * 1000, // 1 ساعة
      };
      atomicFs.writeJsonSync(handoffFile, handoffs);
      console.log(`[complaint-handoff] ${from} @ ${storeId}: "${String(incoming).slice(0,60)}"`);
      // أبلغ المالك (إشعار فوري)
      try {
        const ownerJid = (store?.ownerPhone || "").replace(/[^\d]/g,"") + "@s.whatsapp.net";
        if (ownerJid && ownerJid !== "@s.whatsapp.net") {
          await waMgr.sendMessage(storeId, ownerJid,
            `🚨 *شكوى محتملة من عميل*\n\nرقم: \`${phoneNum(from)}\`\nالمتجر: ${store?.storeName || "—"}\n\nآخر رسالة:\n_"${String(incoming).slice(0,150)}"_\n\n⏳ البوت متوقف تلقائياً لهذا العميل لمدة *ساعة كاملة*.\n\nيرجى التواصل معه مباشرة عبر واتساب.`,
            { allowCold: true, reason: "complaint_alert" });
        }
      } catch {}
    }
    // 🔇 صمت تام — لا رد للعميل (المالك يتحدث معه)
    return;
  }

  if (HANDOFF_TRIGGERS.test(_normIncoming)) {
    const fs = require("fs");
    const path = require("path");
    const atomicFs = require("./atomic-fs");
    const handoffFile = path.join(__dirname, "..", "data", "handoffs.json");
    let handoffs = {};
    try { handoffs = JSON.parse(fs.readFileSync(handoffFile, "utf8")); } catch {}
    // 🔑 المفتاح المركّب: storeId|phone — لمنع تداخل الـ handoffs بين متجرين
    const hkey = storeId + "|" + from;
    handoffs[hkey] = {
      storeId,
      phone:     from,
      startedAt: new Date().toISOString(),
      lastMsg:   String(incoming).slice(0, 200),
    };
    atomicFs.writeJsonSync(handoffFile, handoffs); // atomic + safe
    console.log(`[handoff] saved for ${from} @ ${storeId}: "${String(incoming).slice(0,40)}"`);
    // أبلغ الستور owner عبر MASTER_PHONE
    try {
      const ownerJid = (store?.ownerPhone || "").replace(/[^\d]/g,"") + "@s.whatsapp.net";
      if (ownerJid && ownerJid !== "@s.whatsapp.net") {
        await waMgr.sendMessage(storeId, ownerJid,
          `🆘 *عميل يحتاج مساعدة*\n\nرقم: \`${phoneNum(from)}\`\nالمتجر: ${store?.storeName || "—"}\n\nالعميل ينتظرك. افتح واتساب وتحدث معه مباشرة.\nالبوت متوقف لهذا العميل حتى تستأنفه من لوحة الإدارة.`,
          { allowCold: true, reason: "order_notification" });
      }
    } catch {}
    return sendText(from,
      `🙋 *تم تنبيه المسؤول*\n\nسيتواصل معك مسؤول قريباً جداً.\n\n_البوت متوقف الآن لهذه المحادثة — اكتب لنا مباشرة._`);
  }

  // ── 📋 Menu trigger — أُلغي مسار الأرقام نهائياً (project-thawani-paths-simplified)
  // العميل يكتب "منيو" → يحصل على welcome مع رابط الـ webview (لا قائمة أرقام)
  const MENU_TRIGGERS = /^(منيو|قاءمه|قاءمة|قاءمة\s*الطعام|menu|اعرض\s*القاءمه|اعرض\s*المنيو|المنتجات|قاءمة\s*المنتجات)$/i;
  // 🖼️ صورة المنيو الجاهزة — اختصار مباشر
  const MENU_IMAGE_TRIGGERS = /^(صورة\s*المنيو|صوره\s*المنيو|صورة\s*القاءمه|صورة\s*القاءمة|صور\s*المنيو|منيو\s*صوره|منيو\s*صورة|picture|photo)$/i;
  const _menuPages = Array.isArray(store?.menuFiles) && store.menuFiles.length
    ? store.menuFiles
    : (store?.menuImageUrl ? [store.menuImageUrl] : []);
  const _hasMenuImages = _menuPages.length > 0;
  const _menuBookUrl = _hasMenuImages && store?.shareSlug
    ? `${String(process.env.PUBLIC_URL || "").replace(/\/$/, "")}/menu-book/${store.shareSlug}`
    : "";

  if (_hasMenuImages && MENU_IMAGE_TRIGGERS.test(_normIncoming)) {
    if (_menuBookUrl) {
      await sendText(from,
        `📖 *منيو ${store?.storeName || ""}*\n\n` +
        `اضغط لتصفّح المنيو (${_menuPages.length} صفح${_menuPages.length > 1 ? "ات" : "ة"}):\n${_menuBookUrl}\n\n` +
        `_للطلب المباشر اكتب: *منيو*_`
      );
    }
    return;
  }
  if (MENU_TRIGGERS.test(_normIncoming)) {
    sessionManager.reset(from);
    // 📖 لو المتجر رفع منيو جاهز — أرسل رابط الكتاب أولاً ثم welcome
    if (_menuBookUrl) {
      try {
        await sendText(from,
          `📖 *لتصفّح المنيو الرسمي:*\n${_menuBookUrl}\n\n` +
          `👇 أو المنيو التفاعلي للطلب المباشر ⤵️`
        );
      } catch (e) { console.warn("[menu-book-welcome]", e.message); }
    }
    return sendWelcome(from);
  }

  // ── Cancel last order: العميل يكتب "إلغاء" أو "إلغاء طلبي" ─────────────────
  const CANCEL_TRIGGERS = /^(الغاء|الغاء\s*طلبي|الغاء\s*الطلب|cancel|cancel\s*order|الغ|بطل\s*الطلب)$/i;
  if (CANCEL_TRIGGERS.test(aiParser.normalizeAr(String(incoming).trim()))) {
    try {
      const phone = phoneNum(from);
      const ordersFile = storeId === "nakheel_001"
        ? path.join(__dirname, "..", "data", "orders.jsonl")
        : path.join(__dirname, "..", "data", `orders_${storeId}.jsonl`);
      if (!fs.existsSync(ordersFile)) {
        return sendText(from, botMsg.msg(store, "order.no_active_cancel"));
      }
      const lines = fs.readFileSync(ordersFile, "utf8").split("\n").filter(Boolean);
      const customerOrders = [];
      for (const l of lines) {
        try {
          const o = JSON.parse(l);
          // مطابقة قوية: isSamePhone يحل اختلافات @s.whatsapp.net + رمز الدولة + :device
          if (o.customerPhone && isSamePhone(o.customerPhone, phone)) customerOrders.push(o);
        } catch {}
      }
      // ابحث عن آخر طلب قابل للإلغاء (pending_confirmation أو confirmed قبل أن يبدأ التحضير)
      const cancellable = customerOrders
        .filter(o => ["pending_confirmation","confirmed"].includes(o.status))
        .sort((a,b) => (b.timestamp || "").localeCompare(a.timestamp || ""))[0];
      if (!cancellable) {
        // أعطِ تفاصيل: هل لديه طلبات أصلاً أم لا؟
        if (customerOrders.length === 0) {
          return sendText(from, botMsg.msg(store, "order.no_previous"));
        }
        const last = customerOrders.sort((a,b)=>(b.timestamp||"").localeCompare(a.timestamp||""))[0];
        const statusLabels = {
          preparing: "قيد التحضير",
          ready_pickup: "جاهز للاستلام",
          out_for_delivery: "في الطريق إليك",
          completed: "تم التسليم",
          cancelled: "ملغي مسبقاً",
          rejected: "مرفوض",
        };
        const lbl = statusLabels[last?.status] || last?.status || "غير معروف";
        return sendText(from,
          `❌ لا يوجد طلب قابل للإلغاء.\n\nآخر طلب لك: *${last.orderId}* — حالته: *${lbl}*\n\nالطلبات التي بدأ تحضيرها أو سُلِّمت لا يمكن إلغاؤها.\nللتواصل مع المتجر اكتب: *مسؤول*`);
      }
      // حدّث الـ status — atomic locked
      const stamp = new Date().toISOString();
      await require("./atomic-fs").updateJsonlLocked(ordersFile, (fileLines) => {
        const updated = fileLines.map(l => {
          try {
            const o = JSON.parse(l);
            if (o.orderId === cancellable.orderId) {
              o.status = "cancelled";
              o.cancelledAt = stamp;
              o.cancelledBy = "customer";
              o.cancelReason = "ألغى العميل الطلب من واتساب";
              o.statusUpdatedAt = stamp;
            }
            return JSON.stringify(o);
          } catch { return l; }
        });
        return { lines: updated };
      });
      // ⚠️ isolation: امسح تقييم لهذا المتجر فقط (الطلب أُلغي → لا تقييم)
      const _prCanc = _prget(storeId, from);
      if (_prCanc) {
        const pending = _prCanc.value;
        if (pending.timer) clearTimeout(pending.timer);
        if (pending.reminderTimer) clearTimeout(pending.reminderTimer);
        if (pending.commentTimer) clearTimeout(pending.commentTimer);
        pendingRatings.delete(_prCanc.key);
      }
      // أبلغ المالك
      try {
        const ownerJid = (store?.ownerPhone || "").replace(/[^\d]/g, "") + "@s.whatsapp.net";
        if (ownerJid && ownerJid !== "@s.whatsapp.net") {
          await waMgr.sendMessage(storeId, ownerJid,
            `🚫 *العميل ألغى طلبه*\n\nالطلب: *${cancellable.orderId}*\nالعميل: ${cancellable.customerName || phone}\nالإجمالي: ${cancellable.total} ${cancellable.currency || "ر.س"}\n\nالطلب نُقل لقائمة الملغية.`,
            { allowCold: true, reason: "order_notification" });
        }
      } catch {}
      // تأكيد للعميل
      return sendText(from,
        `✅ *تم إلغاء طلبك*\n\nالطلب: *${cancellable.orderId}*\nالإجمالي: ${cancellable.total} ${cancellable.currency || "ر.س"}\n\nيسعدنا خدمتك مرة أخرى 🌸\nاكتب أي رسالة للبدء من جديد.`);
    } catch (e) {
      console.error("[cancel] failed:", e.message);
    }
  }

  // إذا العميل في handoff state، البوت يسكت تماماً (مع TTL تلقائي 24h)
  // مفصول لكل متجر: مفتاح storeId|from + backward compat للـ keys القديمة (from فقط)
  try {
    const fs = require("fs");
    const path = require("path");
    const handoffFile = path.join(__dirname, "..", "data", "handoffs.json");
    if (fs.existsSync(handoffFile)) {
      const handoffs = JSON.parse(fs.readFileSync(handoffFile, "utf8"));
      const hkey = storeId + "|" + from;
      // ابحث في الـ key الجديد أولاً، ثم الـ legacy key (لو موجود من قبل التحديث)
      const entry = handoffs[hkey] || (handoffs[from] && handoffs[from].storeId === storeId ? handoffs[from] : null);
      const legacyMatch = !handoffs[hkey] && handoffs[from] && handoffs[from].storeId === storeId;
      if (entry) {
        // TTL: للشكاوى ساعة (entry.complaintTtlMs)، للـ manual 24 ساعة
        const HANDOFF_TTL_MS = entry.complaintTtlMs || 24 * 60 * 60 * 1000;
        const startedAt = new Date(entry.startedAt || entry.at || 0).getTime();
        const expired = startedAt && (Date.now() - startedAt > HANDOFF_TTL_MS);
        if (expired) {
          delete handoffs[hkey];
          if (legacyMatch) delete handoffs[from];
          try { require("./atomic-fs").writeJsonSync(handoffFile, handoffs); } catch {}
          console.log(`[handoff] auto-resumed (TTL expired) for ${from} @ ${storeId}`);
        } else {
          console.log(`[handoff] silent for ${from} (paused for ${storeId})`);
          return;
        }
      }
    }
  } catch {}

  // Resolve numbered input → button ID using session's _btnMap
  // في AI mode الأرقام تصل كما هي (AI يحلل النص الحر)
  // في Numeric/buttons/webview: تتحول للـ buttonId
  let msg = incoming;
  if (/^\d+$/.test(incoming) && session._btnMap?.[incoming] && session.path !== "ai") {
    msg = session._btnMap[incoming];
  }

  // ── Rating intercept: handle rating reply even after session reset ──────────
  // ⭐ isolation: نبحث فقط عن تقييم لهذا المتجر (يمنع تسرّب رد "5" من متجر لمتجر آخر)
  const _prHit = _prget(storeId, from);
  if (_prHit) {
    const pending = _prHit.value;
    if (pending.awaitingComment) {
      const trimmed = String(incoming || "").trim();
      const norm = aiParser.normalizeAr(trimmed);
      if (/^(تخطي|تخطى|skip|لا|بدون|no)$/i.test(norm)) {
        return _finalizeRating(from, "", storeId);
      }
      if (trimmed.length >= 2) {
        return _finalizeRating(from, trimmed.slice(0, 500), storeId);
      }
    } else if (isRatingInput(incoming)) {
      return handleRatingSubmit(from, incoming, storeId);
    }
  }

  // ── Order tracking command ───────────────────────────────────────────────────
  const trackMatch = /^(تتبع|track)\s*(ORD-\d+)?/i.exec(msg?.trim() || "");
  if (trackMatch) {
    const orderId = trackMatch[2];
    return handleOrderTracking(from, orderId);
  }

  // ── تعديل الموقع لآخر طلب نشط (بعد تأكيد المالك يرى رابطه ويصلح) ──────────
  const editLocMatch = /^(تعديل\s*الموقع|تعديل\s*العنوان|edit\s*location|fix\s*location)\s*(ORD-?\d+)?\s*$/i.exec(msg?.trim() || "");
  if (editLocMatch) {
    return handleEditLocationRequest(from, editLocMatch[2]);
  }

  // ── Loyalty points command ───────────────────────────────────────────────────
  if (/^(نقاطي|رصيد نقاطي|loyalty|points)$/i.test(msg?.trim() || "")) {
    return sendText(from, pointsMessage(storeId, from, store));
  }

  // Block outside working hours (except mid-flow)
  if (!isStoreOpen(store)) {
    const midFlow = ["COLLECT_NAME","COLLECT_LOCATION","DYNAMIC_Q","CONFIRM_ORDER","QUANTITY","CART_ACTION","POST_ORDER","COUPON","RATING","ORDER_BROWSE"]
      .includes(session.step);
    if (!midFlow) {
      sessionManager.reset(from);
      const hStart = _toHourFloat(store?.workingHoursStart, hourStart);
      const hEnd   = _toHourFloat(store?.workingHoursEnd,   hourEnd);
      return sendText(from,
        `عزيزي العميل،\n\n` +
        `🕐 *${store?.storeName || STORE_NAME}* مغلق حالياً.\n\n` +
        `أوقات العمل:\n` +
        `من الساعة *${formatHour(hStart)}* حتى *${formatHour(hEnd)}*\n\n` +
        `يسعدنا خدمتك خلال أوقات العمل 😊`
      );
    }
  }

  // 🔤 Typo tolerance — لو الرسالة قريبة من keyword معروف، صحّحها
  // ⚠️ في خطوة الجدولة/الموقع لا نصحّح (الأوقات والعناوين قد تتداخل مع الكلمات المحمية)
  const skipTypoFix = ["SCHEDULE_ORDER","COLLECT_TIME","COLLECT_LOCATION"].includes(session.step);
  const msgLower = String(msg || "").toLowerCase().trim();
  if (
    msg && msg.length >= 3 &&
    !skipTypoFix &&
    !PROTECTED_WORDS.has(msgLower) &&
    !msg.startsWith("CAT_") && !msg.startsWith("PROD_") && !msg.startsWith("QTY_") &&
    !/^[A-Z_]+$/.test(msg)
  ) {
    const corrected = _fuzzyMatch(msg, COMMON_KEYWORDS);
    if (corrected && corrected !== msgLower) {
      console.log(`[typo-fix] [${storeId}] "${msg}" → "${corrected}"`);
      msg = corrected;
    }
  }

  // أوامر الـ reset الصريحة (تعمل دائماً)
  // 🔄 isHardReset: يفهم كل صياغات "ابدأ من جديد" / "طلب جديد" / "ضيعت" (بـ AI parser)
  // يُطبَّق على كل step حتى لو العميل في وسط الـ flow — لينقذه من الضياع
  let _restartIntent = null;
  try { _restartIntent = aiParser.parseIntent ? null : null; } catch {}
  // Fast path: لو الكلمة واضحة، ادخل _restart
  const _normMsg = aiParser.normalizeAr(String(msg || ""));
  const _restartFastMatch = /^(ابدا|ابدء|طلب\s*جديد|اطلب\s*جديد|اريد\s*طلب\s*جديد|عايز\s*طلب\s*جديد|بدي\s*طلب\s*جديد|ابغي\s*طلب\s*جديد|من\s*البدايه|البدايه|من\s*الاول|ابدا\s*من\s*جديد|ابدا\s*ثاني|ابدا\s*تاني|كانسل\s*و?ابدا|الغي\s*و?ابدا|انسي\s*الطلب|restart|reset|start\s*over|new\s*order|fresh\s*start|ضيعت|تهت|تايه|البوت\s*معلق|في\s*مشكله|اعد\s*من\s*الاول|خلني\s*ابدا|الرءيسيه|home|main)\b/i;
  const isHardReset = msg === "MAIN_MENU" || _restartFastMatch.test(_normMsg) || /^(start|ابدأ|البدايه|البداية|الرئيسية)$/i.test(msg);
  // التحيات (تعمل reset فقط لو خارج mid-flow — لا نُربك العميل وسط إكمال طلبه)
  // 🔓 Phase 6: خروج من DONE — البوت يستأنف فوراً لو الطلب تم تسليمه/رفضه/إلغاؤه
  // أو لو العميل قال "طلب جديد"، أو مرت ساعتين كحماية
  if (session.step === "DONE" && storeId) {
    const isNewOrderKw = /^(طلب\s*جديد|اطلب\s*جديد|اعمل\s*طلب|ابدا|ابدأ|من\s*جديد|new\s*order|start)$/i.test(String(msg||"").trim());
    const doneAt = session._doneAt || 0;
    const veryOld = doneAt && Date.now() - doneAt > 2 * 60 * 60_000; // 2h hard cap
    // ✅ افحص حالة آخر طلب لهذا العميل — لو completed/rejected/cancelled → استأنف
    let orderClosed = false;
    try {
      const customerPhone = phoneNum(from);
      const recent = readOrders(storeId)
        .filter(o => String(o.customerPhone || "").replace(/\D/g, "") === customerPhone)
        .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))[0];
      if (recent && ["completed", "rejected", "cancelled"].includes(recent.status)) {
        orderClosed = true;
      }
    } catch {}
    if (isNewOrderKw || orderClosed || veryOld) {
      sessionManager.reset(from);
      session = sessionManager.get(from);
      const reason = isNewOrderKw ? "keyword" : (orderClosed ? "order_closed" : "timeout");
      console.log(`[done-exit] ${from} — ${reason} → reset`);
    }
  }

  const isGreeting  = /^(مرحبا|مرحباً|السلام عليكم|وعليكم السلام|هلا|هلو|أهلا|اهلا|hi|hello|hey|رجوع)$/i.test(msg);
  // ⚠️ CATEGORY/PRODUCT/PATH_SELECT/MAIN_MENU جزء من الـ flow الفعّال — التحية لا تعيد welcome
  const midFlow     = ["PATH_SELECT","MAIN_MENU","CATEGORY","PRODUCT",
                       "COLLECT_NAME","COLLECT_LOCATION","SCHEDULE_ORDER","COLLECT_TIME",
                       "CONFIRM_ORDER","QUANTITY","CART_ACTION","CART_EDIT","POST_ORDER",
                       "COUPON","DYNAMIC_Q","RATING","ORDER_BROWSE","AI_BROWSE","NUMERIC_MENU","NUMERIC_FEEDBACK",
                       "DONE"] // 🤫 Phase 6: DONE = البوت صامت بعد استلام الطلب — لا ترد على greetings
    .includes(session.step);

  // 🤫 Phase 6: لو الطلب في DONE (ينتظر تأكيد الأدمن) → صمت تام لأي رسالة
  // لا نرد بأي شكل — حتى لو تحية أو رسالة عادية
  if (session.step === "DONE") {
    console.log(`[done-silent] ${from} @ ${storeId} — تجاهل رسالة (الطلب في DONE)`);
    return;
  }

  // 🚫 Anti-spam: لو العميل أرسل تحية قبل أقل من 30 ثانية، عاملها كـ invalid (counter)
  if (isGreeting && !isHardReset) {
    const now = Date.now();
    const lastGreeting = session.lastGreetingAt || 0;
    if (now - lastGreeting < 30_000) {
      // تحية متكررة في < 30s = spam → counter
      console.log(`[greet-spam] ${from} — تحية متكررة بعد ${Math.round((now-lastGreeting)/1000)}s`);
      return triggerMuteOnInvalidMenuChoice(from, session);
    }
    sessionManager.update(from, { lastGreetingAt: now });
  }

  const isResetCmd = isHardReset || (isGreeting && !midFlow);

  if (isResetCmd || (!msg && !midFlow)) {
    sessionManager.reset(from);
    return sendWelcome(from);
  }
  if (!msg) return;

  // ── Back-button global routing ───────────────────────────────────────────────
  if (msg === "BACK_MAIN") { sessionManager.reset(from); return sendWelcome(from); }
  if (msg === "BACK_CAT")  { return sendCategoryMenu(from); }
  if (msg === "BACK_PROD") { return showProductsPage(from, session.currentCategory || "", session.currentPage || 0); }
  if (msg === "BACK_CART") { return showCart(from, sessionManager.get(from)); }
  if (msg === "BACK_SCHED") {
    sessionManager.update(from, { step: "SCHEDULE_ORDER" });
    return sendButtons(from, {
      body: "متى تريد الاستلام؟",
      buttons: [
        { id: "SCHED_NOW",  title: "⚡ الآن" },
        { id: "SCHED_TIME", title: "🕐 وقت محدد" },
        { id: "BACK_CART",  title: "🔙 تعديل الطلب" },
      ],
    });
  }

  // ── Adaptive Bot: AI mode يلتقط أي رسالة قبل الـ switch ──────────────────────
  if (session.path === "ai" && !midFlow) {
    return handleAIMode(from, incoming, session);
  }

  // 🤖 Phase 5: AI Free-text Order — العميل يكتب طلب حر
  const _ftDebug = {
    midFlow,
    step: session?.step,
    enable: store?.enableFreeTextOrder,
    hasStore: !!store,
    hasProducts: Array.isArray(store?.products) ? store.products.length : 0,
    len: typeof incoming === "string" ? incoming.length : 0,
  };
  // 🤖 يقبل في WELCOME أو PATH_SELECT أو بداية الجلسة — لكن ليس DONE (طلب قيد التنفيذ — البوت صامت)
  const _eligibleSteps = ["WELCOME", "PATH_SELECT", "", null, undefined];
  const _ftEligible = _eligibleSteps.includes(session.step)
      && store?.enableFreeTextOrder !== false
      && typeof incoming === "string"
      && incoming.length >= 6
      && incoming.length <= 500
      && Array.isArray(store?.products) && store.products.length > 0;
  if (_ftEligible) {
    const looks = _looksLikeOrder(incoming, store.products);
    console.log(`[free-text] eligible=true step=${_ftDebug.step} looks=${looks} text="${String(incoming).slice(0,60)}"`);
    if (looks) {
      try {
        const handled = await _tryFreeTextOrder(from, incoming, session, store);
        console.log(`[free-text] handled=${handled}`);
        if (handled) return;
      } catch (e) { console.warn("[free-text-order] error:", e.message, e.stack?.slice(0,300)); }
    }
  } else {
    console.log(`[free-text] skipped: ${JSON.stringify(_ftDebug)}`);
  }

  switch (session.step) {
    case "WELCOME":          return sendWelcome(from);
    case "PATH_SELECT":      return handlePathSelect(from, msg);
    case "MAIN_MENU":        return handleMainMenu(from, msg);
    case "CATEGORY":         return handleCategorySelection(from, msg, session);
    case "PRODUCT":          return handleProductSelection(from, msg, session);
    case "QUANTITY":         return handleQuantity(from, msg, session);
    case "CART_ACTION":      return handleCartAction(from, msg, session);
    case "CART_EDIT":        return handleCartEdit(from, msg, session);
    case "COUPON":           return handleCouponStep(from, msg, session);
    case "ORDER_BROWSE":
      if (msg === "ORDER_CONFIRM") return handleOrderBrowse(from, "تأكيد", session);
      if (msg === "ORDER_MENU")    return sendTextOrderMenu(from);
      return handleOrderBrowse(from, msg, session);
    case "DYNAMIC_Q":        return handleDynamicQuestion(from, msg, session);
    case "EDIT_LOCATION":    return handleEditLocationResponse(from, msg, session);
    case "COLLECT_NAME":     return handleCollectName(from, msg, session);
    case "COLLECT_LOCATION": return handleCollectLocation(from, msg, session);
    case "SCHEDULE_ORDER":   return handleScheduleOrder(from, msg, session);
    case "COLLECT_TIME":     return handleCollectTime(from, msg, session);
    case "CONFIRM_ORDER":    return handleConfirmOrder(from, msg, session);
    case "POST_ORDER":       return handlePostOrder(from);
    // ⛔ مسارات الأرقام والكتابة الحرة مُلغاة — أي session عالق يُعاد للترحيب
    case "AI_BROWSE":
    case "NUMERIC_MENU":
    case "NUMERIC_FEEDBACK":
      session.step = "WELCOME";
      return sendWelcome(from);
    case "DONE":             return; // صمت — ينتظر التقييم أو تحية جديدة
    default:                 return sendWelcome(from);
  }
}

// ─── Step Handlers ────────────────────────────────────────────────────────────

// يبني أقسام رسالة الترحيب ديناميكياً حسب toggles كل متجر
// النصوص الافتراضية لأقسام رسالة الترحيب (قابلة للتخصيص من Master)
// 🎯 قسم الرابط — مختصر جداً (بلا شروحات زائدة)
const _DEFAULT_SECTION_WEBVIEW =
`📜 *قائمة الطلب:*
{{order_link}}`;

const _DEFAULT_SECTION_NUMERIC = "";
const _DEFAULT_SECTION_AI      = "";

function _buildWelcomeSections(store, orderLink, custom = {}) {
  const ew = store?.enableWebview !== false; // default true — مسار المنيو فقط
  // ⛔ مسار الأرقام مُلغى نهائياً (قرار 2026-06-23)
  const en = false;
  // 💬 Phase 5: مسار الكتابة الحرة (AI) — يفعّله المتجر، يكشف تلقائياً من النص
  //    العميل لا يضغط "2" — يكتب طلبه مباشرة، الـ AI يفهمه ويُكوّن الـ cart
  const ea = store?.enableFreeTextOrder !== false && (Array.isArray(store?.products) && store.products.length > 0);

  // استبدال المتغيرات في النصوص المخصصة
  const _interp = (s) => String(s || "").replace(/\{\{order_link\}\}/g, orderLink || "");

  // قسم الرابط (مختصر) — بلا شرح زائد
  const webviewShort = (ew && orderLink)
    ? `📜 *قائمة الطلب:*\n${orderLink}`
    : "";

  // قسم الرابط (مفصّل) — مخصص أو افتراضي
  const webviewDetailed = (ew && orderLink)
    ? _interp(custom.welcomeSectionWebview || custom.webview || _DEFAULT_SECTION_WEBVIEW)
    : "";

  // قسم الأرقام
  const numericDetailed = en
    ? _interp(custom.welcomeSectionNumeric || custom.numeric || _DEFAULT_SECTION_NUMERIC)
    : "";

  // قسم الكتابة الحرة
  const aiDetailed = ea
    ? _interp(custom.welcomeSectionAI || custom.ai || _DEFAULT_SECTION_AI)
    : "";

  // 🎯 tipsLine — فارغ افتراضياً (بلا جمل زائدة)، يُستخدم فقط لو المتجر خصّصه
  const customTips = custom.welcomeSectionTips || custom.tips;
  const tipsLine = customTips && String(customTips).trim() ? _interp(customTips) : "";

  // الـ paths_block — فقط الرابط (بلا شرح "اضغط الرابط" أو غيره)
  const blockParts = [];
  if (webviewShort) blockParts.push(webviewShort);
  if (tipsLine && blockParts.length) blockParts.push(tipsLine);
  const pathsBlock = blockParts.join("\n\n");

  return {
    paths_block:     pathsBlock,
    webview_section: webviewDetailed,
    numeric_section: numericDetailed,
    ai_section:      aiDetailed,
    tips_line:       tipsLine,
  };
}

async function sendWelcome(from) {
  // 🛡️ Welcome rate-limit: لا ترسل ترحيب أكثر من 1 كل 5 دقائق لنفس العميل
  // (يحمي من spam الطفل/الأخطاء/الـ loops)
  const session = sessionManager.get(from);
  const lastWelcome = session._lastWelcomeAt || 0;
  const now = Date.now();
  const WELCOME_COOLDOWN = 5 * 60_000; // 5 دقائق
  if (lastWelcome && now - lastWelcome < WELCOME_COOLDOWN) {
    const counter = (session._welcomeBlockCount || 0) + 1;
    sessionManager.update(from, { _welcomeBlockCount: counter });
    console.log(`[welcome-throttle] ${from} — blocked (${counter}x) — last welcome ${Math.round((now-lastWelcome)/1000)}s ago`);
    // عند 5 محاولات في < 5د → mute 10 دقائق (حماية spam)
    if (counter >= 5) {
      sessionManager.update(from, {
        mutedUntil: now + 10 * 60_000,
        _welcomeBlockCount: 0,
      });
      return sendText(from,
        `🤖 *البوت في وضع الانتظار*\n\n` +
        `لاحظنا رسائل متكررة — سيعود الرد خلال *10 دقائق*.\n\n` +
        `للاستعجال اكتب: *مسؤول* 💬`
      );
    }
    // وإلا تجاهل (لا ترسل ترحيب جديد)
    return;
  }
  sessionManager.update(from, { _lastWelcomeAt: now, _welcomeBlockCount: 0 });
  sessionManager.set(from, { step: "PATH_SELECT", cart: [], path: null, _lastWelcomeAt: now });
  const { store, storeId } = storeCtx.getStore() || {};
  const name = store?.storeName || STORE_NAME;

  // 🌙 Out-of-hours queue — استقبل الطلب لكن أبلغ بوقت المعالجة
  if (!isStoreOpen(store)) {
    const hStart = _toHourFloat(store?.workingHoursStart, hourStart);
    const hEnd   = _toHourFloat(store?.workingHoursEnd,   hourEnd);
    // قائمة انتظار: استقبل الطلب لكن أعلِم أنه سيُعالج عند الفتح
    return sendText(from,
      `🌙 *${name}* مغلق حالياً\n\n` +
      `⏰ أوقات العمل: ${formatHour(hStart)} - ${formatHour(hEnd)}\n\n` +
      `📝 يمكنك ترك طلبك الآن، سيُعالج فور الفتح ✨\n` +
      `اكتب: *ابدأ* لتسجيل طلب مؤجل\n` +
      `أو: *مسؤول* للتواصل المباشر`
    );
  }

  // 🎉 Welcome back للعملاء المتكررين — يستعيد آخر طلب
  let welcomeBackLine = "";
  try {
    const phone = phoneNum(from);
    const ordersFile = storeId === "nakheel_001"
      ? path.join(DATA_DIR, "orders.jsonl")
      : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
    if (fs.existsSync(ordersFile)) {
      const lines = fs.readFileSync(ordersFile, "utf8").split("\n").filter(Boolean);
      // اقرأ آخر طلب لهذا العميل (ابحث من النهاية)
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 200; i--) {
        try {
          const o = JSON.parse(lines[i]);
          const oPhone = String(o.customerPhone || "").replace(/\D/g, "");
          // WELCOME_BACK_v1 — تجاهل الاسم الافتراضي "عميل"
          const _custName = String(o.customerName || "").trim();
          const _isRealName = _custName && _custName !== "عميل" && _custName !== "عميلة" && _custName.length > 1;
          if (oPhone === phone && _isRealName && !o._test) {
            // وجدنا عميل سابق
            const items = (o.items || []).map(it => `${it.name} ×${it.qty}`).join("، ");
            const itemsShort = items.length > 80 ? items.slice(0, 77) + "..." : items;
            welcomeBackLine = `👋 *مرحباً ${o.customerName}!*\n\n`;
            // احفظ بيانات العميل في session (للاستخدام التلقائي في الـ checkout)
            sessionManager.update(from, { lastCustomerName: o.customerName, lastCustomerLocation: o.customerLocation });
            break;
          }
        } catch {}
      }
    }
  } catch (e) { console.warn("[welcome-back]", e.message); }

  // أولوية: رسالة الترحيب المخصصة من إعدادات المتجر (إن وُجدت) + سطر welcome-back إضافي
  const customWelcome = String(store?.welcomeMessage || "").trim();
  let greeting;
  if (customWelcome) {
    // طبّق placeholders {{store_name}} {{customer_name}}
    const lastCust = sessionManager.get(from)?.lastCustomerName || "";
    greeting = customWelcome
      .replace(/\{\{\s*store_name\s*\}\}/gi, name)
      .replace(/\{\{\s*customer_name\s*\}\}/gi, lastCust);
    // أضف سطر welcome-back فوق الرسالة المخصصة لو عميل سابق
    if (welcomeBackLine) greeting = welcomeBackLine + greeting;
  } else {
    greeting = welcomeBackLine || `أهلاً وسهلاً في *${name}* 🌴`;
  }
  const hasProducts = (store?.products || []).filter(isProductInStock).length > 0;

  // الرابط مفعّل لو: الباقة تشمل webOrder + المتجر لم يعطّله + يوجد منتجات
  let orderLink = "";
  const webOrderAllowed = hasFeature(store?.plan, "webOrder") && store?.enableWebview !== false;
  if (hasProducts && storeId && webOrderAllowed) {
    try {
      const slug = waMgr.createWebOrderToken(storeId, from);
      const base = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
      orderLink = `${base}/${slug}`;
    } catch (e) { console.warn("welcome-link:", e.message); }
  }

  // قراءة القالب من إعدادات Master
  const masterRouter = require("./master-router");
  const settings = (typeof masterRouter.readOwnerSettings === "function")
    ? masterRouter.readOwnerSettings()
    : {};
  const tplWithLink = settings.welcomeTemplate       || masterRouter.DEFAULT_WELCOME_TEMPLATE;
  const tplNoLink   = settings.welcomeTemplateNoLink || masterRouter.DEFAULT_WELCOME_NO_LINK;

  const template = orderLink ? tplWithLink : tplNoLink;
  const sections = _buildWelcomeSections(store, orderLink, settings);

  // تنظيف ذكي: لو القالب يحتوي على hardcoded لينك معطل، نُلغي السطور المرتبطة
  let cleaned = template;
  if (!sections.webview_section) {
    // أزل أي كتل تتضمن "{{order_link}}" أو ذكر الرابط
    cleaned = cleaned.replace(/\n*[^\n]*\{\{order_link\}\}[^\n]*\n*/g, "\n");
  }

  let msg = cleaned
    .replace(/\{\{greeting\}\}/g,         greeting)
    .replace(/\{\{store_name\}\}/g,       name)
    .replace(/\{\{order_link\}\}/g,       orderLink)
    .replace(/\{\{paths_block\}\}/g,      sections.paths_block)
    .replace(/\{\{webview_section\}\}/g,  sections.webview_section)
    .replace(/\{\{numeric_section\}\}/g,  sections.numeric_section)
    .replace(/\{\{ai_section\}\}/g,       sections.ai_section)
    .replace(/\{\{tips_line\}\}/g,        sections.tips_line);

  // 🏖️ Custom welcome template للحجوزات — يستبدل msg كاملاً
  if (store?.welcomeTemplate && String(store.welcomeTemplate).trim().length > 20) {
    try {
      const products = (store.products || []).filter(isProductInStock);
      const firstUnit = products.find(p => p.accommodation) || products[0];
      const acm = firstUnit?.accommodation || {};
      const pw  = Number(acm.priceWeekday || firstUnit?.price || 0);
      const pwk = Number(acm.priceWeekend || pw);
      const extrasArr = Array.isArray(acm.extras) ? acm.extras : [];
      const extrasList = extrasArr.length
        ? extrasArr.map(e => `• ${e.label}: +${e.price} ر.س`).join("\n")
        : "";
      const rulesArr = String(store.rules || "").split("\n").filter(l => l.trim());
      const rulesText = rulesArr.length ? rulesArr.map(r => `• ${r.trim()}`).join("\n") : "";
      const unitsList = products
        .filter(p => p.accommodation)
        .map((p, i) => `${i+1}️⃣ ${p.name}`)
        .join("\n");
      msg = String(store.welcomeTemplate)
        .replace(/\{\{\s*storeName\s*\}\}/gi,     name)
        .replace(/\{\{\s*store_name\s*\}\}/gi,    name)
        .replace(/\{\{\s*units\s*\}\}/gi,         unitsList || "")
        .replace(/\{\{\s*priceWeekday\s*\}\}/gi,  String(pw))
        .replace(/\{\{\s*priceWeekend\s*\}\}/gi,  String(pwk))
        .replace(/\{\{\s*extrasList\s*\}\}/gi,    extrasList)
        .replace(/\{\{\s*extras\s*\}\}/gi,        extrasList)
        .replace(/\{\{\s*checkInTime\s*\}\}/gi,   store.checkInTime || "3 مساءً")
        .replace(/\{\{\s*checkOutTime\s*\}\}/gi,  store.checkOutTime || "12 ظهراً")
        .replace(/\{\{\s*rules\s*\}\}/gi,         rulesText)
        .replace(/\{\{\s*galleryUrl\s*\}\}/gi,    store.galleryUrl || "")
        .replace(/\{\{\s*order_link\s*\}\}/gi,    orderLink || "");
      // أضف رابط الحجز لو متاح ولم يُذكر في القالب
      if (orderLink && !msg.includes(orderLink)) {
        msg += `\n\n👇 لاستعراض الوحدات والحجز:\n${orderLink}`;
      }
    } catch (e) { console.warn("[welcome-template]", e.message); }
  }

  // ─── تنظيف ذكي للأقسام الفارغة والـ separators المكررة ─────────────────────
  // 1. دمج separators متتالية (مع أو بدون فراغ بينها) في واحدة
  msg = msg.replace(/(━{5,}\s*\n\s*)+━{5,}/g, "━━━━━━━━━━━━━━━━━━");
  // 2. حذف separator في بداية النص
  msg = msg.replace(/^[\s\n]*━{5,}\s*\n+/, "");
  // 3. حذف separator في نهاية النص
  msg = msg.replace(/\n+\s*━{5,}[\s\n]*$/, "");
  // 4. تقليص الأسطر الفارغة المتتالية إلى سطرين كحد أقصى
  msg = msg.replace(/\n{3,}/g, "\n\n");
  // 5. ترتيب أنيق نهائي
  msg = msg.trim();

  // ─── نصوص الـ Master المخصصة: رأس + تذييل ──────────────────────────────────
  const _subVars = (s) => String(s || "")
    .replace(/\{\{store_name\}\}/g, name)
    .replace(/\{\{greeting\}\}/g,   greeting)
    .replace(/\{\{order_link\}\}/g, orderLink);
  const header = _subVars(settings.welcomeHeader || "").trim();
  const footer = _subVars(settings.welcomeFooter || "").trim();
  if (header) msg = header + "\n\n" + msg;
  if (footer) msg = msg + "\n\n" + footer;

  // ─── HELP_HINT: للاستفسار اكتب: مسؤول (في كل رسالة ترحيب) ──────────────────
  const HELP_HINT = "💬 للاستفسار اكتب: *مسؤول*";
  if (!msg.includes("مسؤول") && !msg.includes(HELP_HINT)) {
    msg = msg + "\n\n" + HELP_HINT;
  }

  return sendText(from, msg);
}

async function handleMainMenu(from, msg) {
  if (msg === "ORDER_WEB")  return sendTextOrderMenu(from);
  if (msg === "SEE_MENU")   return sendCategoryMenu(from);
  if (msg === "MY_CART")    return showCart(from, sessionManager.get(from));
  if (msg === "CONTACT_US") {
    const { store } = storeCtx.getStore() || {};
    const hStart = _toHourFloat(store?.workingHoursStart, hourStart);
    const hEnd   = _toHourFloat(store?.workingHoursEnd,   hourEnd);
    return sendText(from,
      `📞 *تواصل معنا*\n\n📱 واتساب: نفس هذا الرقم\n⏰ أوقات العمل: ${formatHour(hStart)} – ${formatHour(hEnd)}\n\nاكتب أي رسالة للعودة للقائمة 😊`
    );
  }
  return sendWelcome(from);
}

// ─── Path Selection (مع توجيه ذكي حسب toggles كل متجر) ──────────────────────
async function handlePathSelect(from, msg) {
  // ⛔ مسارات الأرقام/الكتابة الحرة مُلغاة (قرار 2026-06-23)
  // كل رد من العميل قبل اختيار من المنيو → يُعاد إرسال الترحيب مع رابط الصفحة التفاعلية
  return sendWelcome(from);
}

// ─── Numeric Mode — قائمة بأربع خيارات بالأرقام ──────────────────────────────
async function sendNumericMenu(from) {
  const { store } = storeCtx.getStore() || {};
  const name = store?.storeName || STORE_NAME;
  return sendText(from,
    `مرحباً بك في *${name}* ☕✨\n\n` +
    `للطلب الآلي السريع، يرجى إرسال رقم الخيار المطلوب:\n\n` +
    `‎[1] 📜 عرض المنيو (ملف PDF عالي الجودة)\n` +
    `‎[2] ☕ طلب جديد مباشرة\n` +
    `‎[3] 📍 موقع الفرع وأوقات العمل\n` +
    `‎[4] 📞 شكوى أو اقتراح\n\n` +
    `_اكتب 0 للعودة لاختيار طريقة الطلب_\n` +
    `💬 للاستفسار اكتب: *مسؤول*`
  );
}

async function handleNumericMode(from, msg, session) {
  const raw = String(msg || "").trim();
  const { store, storeId } = storeCtx.getStore() || {};
  const name     = store?.storeName || STORE_NAME;
  const hStart   = _toHourFloat(store?.workingHoursStart, hourStart);
  const hEnd     = _toHourFloat(store?.workingHoursEnd,   hourEnd);
  const address  = store?.address || store?.location || "—";

  // 0 = عودة لقائمة المسارات الرئيسية
  if (raw === "0" || /^(رجوع|عودة|back|main)$/i.test(raw)) {
    sessionManager.reset(from);
    return sendWelcome(from);
  }

  // [1] عرض المنيو PDF
  if (raw === "1") {
    await sendText(from, `📜 *منيو ${name}*\n\nجارٍ إرسال الكتالوج الكامل…`);
    try {
      await sendFullMenuMedia(from, "MENU_PDF");
    } catch (e) {
      await sendText(from, botMsg.msg(store, "menu.pdf_failed"));
      await sendNumericProductsList(from);
    }
    return sendText(from,
      `هل تريد:\n\n` +
      `‎[2] ☕ طلب جديد مباشرة\n` +
      `‎[0] 🔙 العودة لاختيار طريقة الطلب`
    );
  }

  // [2] طلب جديد — flow كامل بالأرقام (لا webview، لا أزرار)
  if (raw === "2") {
    if (!(store?.products || []).filter(isProductInStock).length) {
      return sendText(from, botMsg.msg(store, "menu.empty"));
    }
    sessionManager.update(from, { step: "CATEGORY", path: "numeric" });
    return sendCategoryMenu(from);
  }

  // [3] موقع الفرع وأوقات العمل
  if (raw === "3") {
    const mapsLink = (store?.locationMapUrl || store?.mapsUrl || "");
    return sendText(from,
      `📍 *موقع ${name}*\n\n` +
      `العنوان: ${address}\n` +
      (mapsLink ? `\n🗺️ ${mapsLink}\n` : "") +
      `\n⏰ *أوقات العمل:*\n` +
      `من الساعة ${formatHour(hStart)} حتى ${formatHour(hEnd)}\n\n` +
      `_اكتب 0 للعودة_`
    );
  }

  // [4] شكوى أو اقتراح — استلام النص ثم تأكيد
  if (raw === "4") {
    sessionManager.update(from, { step: "NUMERIC_FEEDBACK" });
    return sendText(from,
      `📞 *شكوى أو اقتراح*\n\n` +
      `اكتب رسالتك في الرسالة التالية، وسيصل إلى إدارة *${name}* مباشرة.\n\n` +
      `_اكتب 0 لإلغاء_`
    );
  }

  // أي إدخال آخر → نعيد القائمة
  return sendNumericMenu(from);
}

async function sendNumericProductsList(from) {
  const { store } = storeCtx.getStore() || {};
  const currency  = store?.currency || CURRENCY;
  const cats = (store?.categories || []).filter(c =>
    (store?.products || []).some(p => p.category === c.id && isProductInStock(p))
  );
  let msg = `📜 *قائمة ${store?.storeName || "المتجر"}*\n`;
  for (const c of cats) {
    const items = (store?.products || []).filter(p => p.category === c.id && isProductInStock(p));
    if (!items.length) continue;
    msg += `\n${c.emoji || "•"} *${c.name}:*\n`;
    items.slice(0, 12).forEach(p => { msg += `  • ${p.name} — ${_priceLabel(p, currency)}\n`; });
  }
  return sendText(from, msg);
}

async function handleNumericFeedback(from, msg, session) {
  const raw = String(msg || "").trim();
  const { store, storeId } = storeCtx.getStore() || {};
  if (raw === "0" || /^(الغاء|إلغاء|cancel)/i.test(raw)) {
    sessionManager.update(from, { step: "NUMERIC_MENU" });
    return sendNumericMenu(from);
  }
  if (raw.length < 5) {
    return sendText(from, botMsg.msg(store, "freetext.too_short"));
  }
  // ⚠️ ديمو: لا fallback لـ MASTER_PHONE (لا نريد إرسال feedback ديمو لرقم النظام)
  const isDemo = store?.isDemo === true;
  const ownerPhone = store?.ownerPhone || (isDemo ? "" : process.env.MASTER_PHONE);
  if (ownerPhone) {
    try {
      await waMgr.sendMessage(storeId, ownerPhone,
        `📩 *رسالة جديدة من عميل*\n\n` +
        `من: ${from}\n` +
        `المحتوى:\n${raw}`
      );
    } catch (e) { console.warn("[feedback→owner] failed:", e.message); }
  }
  sessionManager.update(from, { step: "NUMERIC_MENU" });
  return sendText(from,
    `🙏 *شكراً لك!*\n\n` +
    `وصلت رسالتك إلى إدارة ${store?.storeName || "المتجر"} وسنرد عليك قريباً.\n\n` +
    `_اكتب 0 للعودة لاختيار طريقة الطلب_`
  );
}

// ─── AI Mode Handler — يستخدم Groq Llama لفهم النية وتنفيذها ─────────────────
function _buildMenuCtx(store) {
  const cats  = (store?.categories || []).map(c => c.name);
  const items = {};
  for (const c of (store?.categories || [])) {
    items[c.name] = (store?.products || [])
      .filter(p => p.category === c.id && isProductInStock(p))
      .map(p => ({ name: p.name, price: Number(p.price) || 0 }));
  }
  return { categories: cats, items };
}

function _findProduct(store, name) {
  const target = String(name || "").trim().toLowerCase();
  if (!target) return null;
  const products = (store?.products || []).filter(isProductInStock);
  // مطابقة دقيقة أولاً
  let p = products.find(p => p.name.toLowerCase() === target);
  if (p) return p;
  // مطابقة جزئية (substring)
  p = products.find(p => p.name.toLowerCase().includes(target) || target.includes(p.name.toLowerCase()));
  return p || null;
}

// 💬 helper: نص السعر — يعرض "تفاوض" للمنتجات بسعر عند الطلب
function _priceLabel(product, currency, opts = {}) {
  if (product?.priceOnRequest) {
    return opts.short ? "💬 تفاوض" : "💬 السعر بالتفاوض";
  }
  return `${product?.price || 0} ${currency}`;
}

function _formatCart(cart, currency) {
  if (!cart.length) return "🛒 السلة فارغة";
  let total = 0;
  let hasNegotiable = false;
  let lines = "🛒 *سلتك الحالية:*\n";
  cart.forEach((it, i) => {
    if (it.priceOnRequest) {
      hasNegotiable = true;
      lines += `${i + 1}. ${it.name} × ${it.qty} = 💬 *تفاوض*\n`;
    } else {
      const subtotal = (it.price || 0) * it.qty;
      total += subtotal;
      lines += `${i + 1}. ${it.name} × ${it.qty} = ${subtotal} ${currency}\n`;
    }
  });
  if (hasNegotiable) {
    lines += total > 0
      ? `\n💰 إجمالي المنتجات المسعّرة: ${total} ${currency}\n💬 *والباقي عند الاتفاق مع المتجر*`
      : `\n💬 *كل الأسعار عند الاتفاق مع المتجر*`;
  } else {
    lines += `\n💰 *الإجمالي: ${total} ${currency}*`;
  }
  return lines;
}

async function handleAIMode(from, text, session) {
  const { store, storeId } = storeCtx.getStore() || {};
  const currency = store?.currency || CURRENCY;
  const menuCtx  = _buildMenuCtx(store);
  const cart     = session.cart || [];

  // فلتر أولي: gibberish أو أسئلة شخصية → رد ودود بدل تمرير عشوائي للـ AI
  if (isOffTopicQuery(text)) {
    return sendText(from,
      `🤖 أنا مساعد طلبات *${store?.storeName || "المتجر"}* — أساعدك في الطلب فقط.\n\n` +
      `اكتب ما تريد طلبه (مثال: "عايز كوب قهوة") أو اكتب *"قائمة"* لرؤية المنيو.`
    );
  }
  if (isGibberish(text)) {
    return sendText(from,
      `🤔 لم أفهم رسالتك جيداً!\n\n` +
      `جرّب:\n` +
      `• اكتب اسم منتج تريده\n` +
      `• اكتب *"قائمة"* لرؤية المنيو\n` +
      `• اكتب *"سلة"* لرؤية طلبك الحالي`
    );
  }

  // أضف الرسالة الحالية إلى السياق (آخر 4 رسائل فقط)
  const recentMessages = [...(session.recentMessages || []), text].slice(-4);
  sessionManager.update(from, { recentMessages });
  const intent = await aiParser.parseIntent(text, { step: session.step, cart, path: "ai", recentMessages }, menuCtx);

  // 1️⃣ عرض القائمة
  if (intent.type === "menu") {
    const cats = (store?.categories || []).filter(c =>
      (store?.products || []).some(p => p.category === c.id && isProductInStock(p))
    );
    let msg = `📋 *قائمة ${store?.storeName || "المتجر"}*\n`;
    for (const c of cats) {
      const items = (store?.products || []).filter(p => p.category === c.id && isProductInStock(p));
      if (items.length) {
        msg += `\n${c.emoji || "•"} *${c.name}:*\n`;
        items.slice(0, 8).forEach(p => { msg += `  • ${p.name} — ${_priceLabel(p, currency)}\n`; });
      }
    }
    msg += `\n_اكتب طلبك بحرية_`;
    return sendText(from, msg);
  }

  // 2️⃣ عرض السلة
  if (intent.type === "cart") {
    return sendText(from, _formatCart(cart, currency) + (cart.length ? `\n\n_اكتب "تأكيد" لإتمام الطلب_` : ""));
  }

  // 3️⃣ إضافة منتجات
  if (intent.type === "add" && Array.isArray(intent.value)) {
    const added = [];
    const missed = [];
    for (const item of intent.value) {
      const prod = _findProduct(store, item.name);
      if (!prod) { missed.push(item.name); continue; }
      const qty = Math.max(1, Number(item.qty) || 1);
      const existing = cart.find(c => String(c.id) === String(prod.id));
      if (existing) existing.qty += qty;
      else cart.push({ id: prod.id, name: prod.name, price: Number(prod.price) || 0, qty, imageUrl: prod.imageUrl || null, priceOnRequest: !!prod.priceOnRequest });
      added.push(`${prod.name} × ${qty}`);
    }
    sessionManager.update(from, { cart });
    let reply = "";
    if (added.length) reply += `✅ أُضيف: ${added.join("، ")}\n\n`;
    if (missed.length) reply += `⚠️ غير متوفر: ${missed.join("، ")}\n\n`;
    reply += _formatCart(cart, currency);
    if (cart.length) reply += `\n\n_اكتب "تأكيد" لإتمام الطلب_`;
    return sendText(from, reply);
  }

  // 4️⃣ حذف منتج
  if (intent.type === "remove" && intent.value?.name) {
    const prod = _findProduct(store, intent.value.name);
    const before = cart.length;
    if (prod) {
      const idx = cart.findIndex(c => String(c.id) === String(prod.id));
      if (idx >= 0) cart.splice(idx, 1);
    }
    sessionManager.update(from, { cart });
    const reply = before > cart.length
      ? `✅ تم الحذف.\n\n${_formatCart(cart, currency)}`
      : `لم أجد "${intent.value.name}" في السلة.\n\n${_formatCart(cart, currency)}`;
    return sendText(from, reply);
  }

  // 5️⃣ تعديل الكمية
  if (intent.type === "update" && intent.value?.name) {
    const prod = _findProduct(store, intent.value.name);
    const qty  = Math.max(0, Number(intent.value.qty) || 0);
    if (prod) {
      const existing = cart.find(c => String(c.id) === String(prod.id));
      if (existing) {
        if (qty === 0) {
          const idx = cart.findIndex(c => String(c.id) === String(prod.id));
          if (idx >= 0) cart.splice(idx, 1);
        } else existing.qty = qty;
      } else if (qty > 0) {
        cart.push({ id: prod.id, name: prod.name, price: Number(prod.price) || 0, qty, imageUrl: prod.imageUrl || null, priceOnRequest: !!prod.priceOnRequest });
      }
    }
    sessionManager.update(from, { cart });
    return sendText(from, `✅ حُدِّث.\n\n${_formatCart(cart, currency)}`);
  }

  // 6️⃣ تأكيد الطلب — تخطّ الاسم، اذهب مباشرة للموقع/الجدولة
  if (intent.type === "confirm") {
    if (!cart.length) return sendText(from, botMsg.msg(store, "cart.empty"));
    sessionManager.update(from, { path: "ai" });
    await sendText(from, _formatCart(cart, currency));
    return _moveToNextAfterCart();
  }

  // 7️⃣ إلغاء
  if (intent.type === "cancel") {
    sessionManager.reset(from);
    return sendText(from, botMsg.msg(store, "order.canceled_new"));
  }

  // 🔄 إعادة البدء (العميل تايه أو طلب جديد)
  if (intent.type === "restart") {
    sessionManager.reset(from);
    return sendWelcome(from);
  }

  // 8️⃣ سؤال عام — رد ذكي بـ AI أو رد عام
  if (intent.type === "question") {
    return sendText(from,
      `سؤال جيد! 🤔\n\n` +
      `لمساعدتك، يمكنك:\n` +
      `• كتابة "قائمة" لعرض المنيو\n` +
      `• كتابة اسم المنتج للسؤال عن سعره\n` +
      `• الاتصال بنا مباشرة من رقم المتجر`
    );
  }

  // 9️⃣ غير مفهوم
  return sendText(from,
    `لم أفهم تماماً 🤔\n\n` +
    `جرّب:\n` +
    `• "قائمة" لرؤية المنتجات\n` +
    `• "عايز [اسم منتج]"\n` +
    `• "سلة" لمراجعة طلبك\n` +
    `• "تأكيد" لإتمام الطلب`
  );
}

async function sendCategoryMenu(from) {
  // ⏸ تسجيل وقت إرسال المنيو لـ mute logic
  sessionManager.update(from, { step: "CATEGORY", menuAwaitingSince: Date.now() });
  const { store } = storeCtx.getStore() || {};
  const categories = (store?.categories || []).filter(cat =>
    (store.products || []).some(p => p.category === cat.id && isProductInStock(p))
  );

  if (categories.length === 0) {
    return sendText(from, botMsg.msg(store, "menu.category_empty"));
  }

  const rows = categories.map(cat => ({
    id:          `CAT_${cat.id}`,
    title:       `${cat.emoji} ${cat.name}`,
    description: `اضغط لعرض ${cat.name}`,
  }));

  rows.push(
    { id: "MENU_IMAGE", title: "🖼️ الكتالوج كاملاً بالصور",  description: "صورة شاملة لجميع المنتجات والخدمات" },
    { id: "MENU_PDF",   title: "📄 الكتالوج كملف PDF مصوّر", description: "ملف قابل للتحميل والمشاركة" },
    { id: "BACK_MAIN",  title: "🏠 القائمة الرئيسية",       description: "العودة للقائمة الرئيسية" }
  );

  return sendList(from, {
    body:     "اختر من القائمة التالية:",
    sections: [{ title: "الأصناف المتوفرة", rows }],
    footer:   "💬 للاستفسار اكتب: مسؤول",
  });
}

async function handleCategorySelection(from, msg, session) {
  if (msg === "MENU_IMAGE" || msg === "MENU_PDF") return sendFullMenuMedia(from, msg);
  // ⏸ لو رسالة لا تطابق صنف، فعّل mute
  if (!msg.startsWith("CAT_") && msg !== "BACK_MAIN") {
    return triggerMuteOnInvalidMenuChoice(from, session);
  }
  if (msg === "BACK_MAIN") return sendCategoryMenu(from);
  // اختيار صحيح → reset counter
  sessionManager.update(from, { invalidCount: 0, invalidMenuWarnedAt: 0 });
  return showProductsPage(from, msg.replace("CAT_", ""), 0);
}

// ⏸ Helper: عند رسالة لا تطابق الـ flow الحالي
// counter يتراكم — يصل 2 = تنبيه، 3 = mute 5 دقائق، 5 = mute 15 دقيقة
async function triggerMuteOnInvalidMenuChoice(from, session) {
  const now = Date.now();
  const count = (session.invalidCount || 0) + 1;

  // counter يُعاد تصفيره لو مضى دقيقتان من آخر invalid msg
  const lastInvalid = session.lastInvalidAt || 0;
  const effectiveCount = (now - lastInvalid > 2 * 60_000) ? 1 : count;

  sessionManager.update(from, { invalidCount: effectiveCount, lastInvalidAt: now });

  // 3 محاولات خاطئة → mute 5 دقائق
  if (effectiveCount >= 3) {
    sessionManager.update(from, {
      mutedUntil: now + MUTE_DURATION_MS,
      invalidCount: 0,
      invalidMenuWarnedAt: 0,
    });
    return sendText(from,
      `🤖 *البوت في وضع الانتظار*\n\n` +
      `لاحظنا أن خياراتك لا تطابق القائمة.\n` +
      `سيعود للرد خلال *5 دقائق*.\n\n` +
      `للاستعجال:\n` +
      `• اكتب *ابدأ* للبدء من جديد\n` +
      `• اكتب *مسؤول* للتواصل المباشر`
    );
  }

  // محاولة أولى أو ثانية → تنبيه
  return sendText(from,
    `📋 *اختر من القائمة أعلاه* — اضغط على أحد الخيارات\n\n` +
    `_(محاولة ${effectiveCount}/3 — لو أردت البدء من جديد اكتب: ابدأ)_`
  );
}

async function sendFullMenuMedia(from, type) {
  const { storeId, store } = storeCtx.getStore() || {};
  if (!store) return sendText(from, botMsg.msg(null, "menu.load_failed"));

  try {
    await sendText(from, type === "MENU_PDF"
      ? "📄 جاري إعداد الكتالوج... لحظة من فضلك"
      : "🖼️ جاري إعداد صورة القائمة... لحظة من فضلك"
    );

    const { filePath } = await generateMenuImage({
      storeId:        storeId,
      storeName:      store.storeName,
      invoiceColor:   store.invoiceColor   || null,
      invoiceLogoUrl: store.invoiceLogoUrl || null,
      categories:     store.categories     || [],
      products:       store.products       || [],
      currency:       store.currency       || CURRENCY,
    });

    const caption = type === "MENU_PDF"
      ? `📄 كتالوج ${store.storeName} الكامل\n\nاضغط للتكبير أو حفظ الصورة 💾`
      : `🖼️ قائمة ${store.storeName}\n\nجميع المنتجات والخدمات المتوفرة`;

    await sendImage(from, filePath, caption);
  } catch(e) {
    console.error(`[sendFullMenuMedia] ${storeId}:`, e.message);
    await sendText(from, botMsg.msg(store, "menu.load_failed"));
  }
}

async function showProductsPage(from, cat, page) {
  const { store, storeId } = storeCtx.getStore() || {};
  const currency  = store?.currency || CURRENCY;
  const products  = (store?.products || []).filter(p => p.category === cat && isProductInStock(p));
  const totalAll  = (store?.products || []).filter(isProductInStock).length;

  if (products.length === 0) {
    sessionManager.update(from, { step: "MAIN_MENU" });
    return sendText(from, botMsg.msg(store, "menu.category_empty"));
  }

  const pageSize   = 9;
  const totalPages = Math.ceil(products.length / pageSize);
  const pageItems  = products.slice(page * pageSize, (page + 1) * pageSize);
  const catInfo    = (store?.categories || []).find(c => c.id === cat) || { name: cat, emoji: "📋" };

  sessionManager.update(from, { step: "PRODUCT", currentCategory: cat, currentPage: page });

  // 🛡️ منيو كبير (>30 منتج): اقترح web-view مرة واحدة (يحدث في أول صفحة فقط)
  // يحوي القائمة الكاملة + بحث + فلتر — أسرع للعميل من تصفح list بالـ 9
  const BIG_MENU_THRESHOLD = 30;
  if (totalAll >= BIG_MENU_THRESHOLD && page === 0 && process.env.PUBLIC_URL) {
    try {
      const session = sessionManager.get(from) || {};
      if (!session._webOfferShown) {
        const token = waMgr.createWebOrderToken(storeId, from);
        const url   = `${process.env.PUBLIC_URL}/${token}`;
        const ctaSent = await waMgr.sendCtaButton(storeId, from, {
          body: `🛍️ متجرنا فيه *${totalAll}* منتج — لتسهيل اختيارك، اضغط الزر لفتح القائمة الكاملة مع بحث + فلاتر 👇\n\nأو تابع هنا لتصفح الأصناف يدوياً.`,
          buttonText: "🛒 افتح القائمة الكاملة",
          url, footer: store?.storeName,
        });
        sessionManager.update(from, { _webOfferShown: true });
        if (!ctaSent) {
          await sendText(from, `🛍️ متجرنا فيه *${totalAll}* منتج\n📱 رابط القائمة الكاملة (أسرع):\n${url}\n\nأو تابع هنا لتصفح الأصناف.`);
        }
      }
    } catch (e) { console.warn("[big-menu] web-offer failed:", e.message); }
  }

  const rows = pageItems.map(p => ({
    id:          `PROD_${p.id}`,
    title:       `${p.name} — ${_priceLabel(p, currency, { short: true })}`,
    description: p.description || "",
  }));

  if (page + 1 < totalPages) {
    rows.push({ id: "PAGE_NEXT", title: `➡️ الصفحة التالية (${page+2}/${totalPages})`, description: "عرض المزيد" });
  }
  rows.push({ id: "BACK_CAT", title: "🔙 تغيير الصنف", description: "العودة لقائمة الأصناف" });

  return sendList(from, {
    body:     `${catInfo.emoji} *${catInfo.name}*\n\nاختر المنتج الذي تريده:`,
    sections: [{ title: catInfo.name, rows }],
    footer:   totalPages > 1 ? `صفحة ${page+1} من ${totalPages}` : undefined,
  });
}

async function handleProductSelection(from, msg, session) {
  if (msg === "PAGE_NEXT") {
    return showProductsPage(from, session.currentCategory, (session.currentPage || 0) + 1);
  }
  if (!msg.startsWith("PROD_")) {
    // ⏸ رسالة لا تطابق منتج → counter + mute
    return triggerMuteOnInvalidMenuChoice(from, session);
  }

  const { store } = storeCtx.getStore() || {};
  const currency  = store?.currency || CURRENCY;
  const productId = msg.replace("PROD_", "");
  const product   = (store?.products || []).find(p => String(p.id) === String(productId) && isProductInStock(p));
  if (!product) return triggerMuteOnInvalidMenuChoice(from, session);

  // اختيار صحيح → reset counter
  sessionManager.update(from, { step: "QUANTITY", pendingProduct: product, invalidCount: 0 });

  // ⭐ Send product images — يدعم الصور المتعددة
  // الصورة الأولى تحوي تفاصيل المنتج، الباقي بـ caption صغير
  const imageList = Array.isArray(product.images) && product.images.length
    ? product.images
    : (product.imageUrl || product.image_url ? [product.imageUrl || product.image_url] : []);

  if (imageList.length > 0) {
    const PUB = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
    const _abs = u => u.startsWith("http") ? u : `${PUB}${u}`;

    const priceTxt = product.priceOnRequest ? "💬 السعر عند الطلب (يتفق عليه)" : `💰 ${product.price} ${currency}`;
    for (let i = 0; i < Math.min(imageList.length, 5); i++) {
      const url = _abs(imageList[i]);
      const caption = i === 0
        ? `*${product.name}*\n${product.description || ""}\n${priceTxt}` +
          (imageList.length > 1 ? `\n\n📷 ${imageList.length} صور — اسحب لاستعراضها` : "")
        : `صورة ${i + 1} من ${imageList.length}`;
      try { await sendImage(from, url, caption); }
      catch (e) { console.warn("[product-img] failed:", e.message); break; }
      // small delay between images لتجنّب rate-limit الواتساب
      if (i < imageList.length - 1) await new Promise(r => setTimeout(r, 800));
    }
  }

  // 💬 لمنتج السعر-عند-الطلب: لا تعرض كميات، فقط زر "اطلب الآن" واحد
  if (product.priceOnRequest) {
    return sendList(from, {
      body: `*${product.name}*\n${product.description ? product.description + "\n" : ""}\n💬 *السعر عند الطلب*\nسيتفق المتجر معك على السعر بعد إرسال طلبك.`,
      buttonText: "ابدأ الطلب",
      sections: [{
        title: "الإجراء",
        rows: [
          { id: "QTY_1", title: "📩 إرسال طلب",   description: "سنرسل الطلب وتتفاوض على السعر" },
          { id: "BACK_CAT", title: "🔙 تغيير الصنف", description: "العودة لقائمة الأصناف" },
        ],
      }],
    });
  }
  return sendList(from, {
    body:        `*${product.name}*\n${product.description ? product.description + "\n" : ""}💰 السعر: *${product.price} ${currency}*\n\nاختر الكمية:`,
    buttonText:  "اختر الكمية",
    sections: [{
      title: "الكمية",
      rows: [
        { id: "QTY_1", title: "1️⃣  قطعة واحدة",  description: `${product.price} ${currency}` },
        { id: "QTY_2", title: "2️⃣  قطعتان",       description: `${(product.price * 2).toFixed(2)} ${currency}` },
        { id: "QTY_3", title: "3️⃣  ثلاث قطع",     description: `${(product.price * 3).toFixed(2)} ${currency}` },
        { id: "QTY_5", title: "5️⃣  خمس قطع",      description: `${(product.price * 5).toFixed(2)} ${currency}` },
        { id: "BACK_CAT", title: "🔙 تغيير الصنف", description: "العودة لقائمة الأصناف" },
      ],
    }],
    footer: "أو اكتب الكمية رقماً للكميات الأخرى",
  });
}

async function handleQuantity(from, msg, session) {
  let qty = 1;
  if (msg === "QTY_1")      qty = 1;
  else if (msg === "QTY_2") qty = 2;
  else if (msg === "QTY_3") qty = 3;
  else if (msg === "QTY_5") qty = 5;
  else if (msg === "BACK_CAT") return sendCategoryMenu(from);
  else {
    const parsed = parseInt(msg);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 99) qty = parsed;
    else return triggerMuteOnInvalidMenuChoice(from, session);
  }
  // اختيار كمية صحيحة → reset counter
  sessionManager.update(from, { invalidCount: 0 });
  return addToCart(from, session, qty);
}

async function addToCart(from, session, qty) {
  const { store } = storeCtx.getStore() || {};
  const currency  = store?.currency || CURRENCY;
  const product   = session.pendingProduct;
  if (!product) return sendWelcome(from);

  const cart     = session.cart || [];
  const existing = cart.find(i => i.id === product.id);
  if (existing) existing.qty += qty;
  else cart.push({ id: product.id, name: product.name, price: product.price, qty, imageUrl: product.imageUrl||null, priceOnRequest: !!product.priceOnRequest });

  sessionManager.update(from, { step: "CART_ACTION", cart, pendingProduct: null });
  const hasNegotiable = cart.some(i => i.priceOnRequest);
  const total = cart.reduce((s, i) => s + (i.priceOnRequest ? 0 : i.price * i.qty), 0);
  const totalLine = hasNegotiable
    ? `\n💬 *بعض الأسعار للتفاوض* — سيتم الاتفاق عليها مع المتجر`
    : `\n💰 إجمالي السلة: *${total.toFixed(2)} ${currency}*`;

  return sendList(from, {
    body:       `✅ تمت الإضافة!\n\n*${product.name}* × ${qty}${totalLine}`,
    buttonText: "اختر",
    sections: [{
      title: "ماذا تريد؟",
      rows: [
        { id: "CHECKOUT",  title: "✅ إتمام الطلب",     description: "أكمل الطلب الآن" },
        { id: "CONTINUE",  title: "➕ إضافة صنف آخر",   description: "تصفح باقي الأصناف" },
        { id: "BACK_PROD", title: "🔙 نفس الصنف",        description: "العودة لنفس قائمة المنتجات" },
        { id: "VIEW_CART", title: "🛒 عرض السلة كاملة", description: "راجع جميع مشترياتك" },
      ],
    }],
  });
}

async function handleCartAction(from, msg, session) {
  if (msg === "CONTINUE")   { sessionManager.update(from, { step: "CATEGORY" }); return sendCategoryMenu(from); }
  if (msg === "VIEW_CART")  return showCart(from, session);
  if (msg === "CHECKOUT")   return startCheckout(from, session);
  if (msg === "SEE_MENU")   { sessionManager.update(from, { step: "CATEGORY" }); return sendCategoryMenu(from); }
  if (msg === "EDIT_CART")  { sessionManager.update(from, { step: "CART_EDIT", editingItemId: null }); return showCartEditMenu(from, sessionManager.get(from)); }
  return sendCategoryMenu(from);
}

async function showCart(from, session) {
  const { store } = storeCtx.getStore() || {};
  const currency  = store?.currency || CURRENCY;
  const cart      = session.cart || [];

  if (cart.length === 0) {
    return sendButtons(from, {
      body:    "🛒 سلتك فارغة حالياً!\n\nهل تريد تصفح القائمة؟",
      buttons: [{ id: "SEE_MENU", title: "📋 عرض القائمة" }],
    });
  }

  const lines = cart.map(i => `• ${i.name} × ${i.qty} = ${(i.price*i.qty).toFixed(2)} ${currency}`);
  const total = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const body  = `🛒 *سلة مشترياتك:*\n\n${lines.join("\n")}\n\n──────────────\n💰 *الإجمالي: ${total.toFixed(2)} ${currency}*`;

  sessionManager.update(from, { step: "CART_ACTION" });
  return sendList(from, {
    body,
    buttonText: "اختر",
    sections: [{
      title: "خيارات السلة",
      rows: [
        { id: "CHECKOUT",   title: "✅ إتمام الطلب",      description: "أكمل عملية الشراء" },
        { id: "EDIT_CART",  title: "✏️ تعديل الكميات",    description: "غيّر كميات المنتجات" },
        { id: "CONTINUE",   title: "➕ إضافة المزيد",      description: "أضف منتجات أخرى" },
        { id: "BACK_MAIN",  title: "🏠 القائمة الرئيسية", description: "العودة للبداية" },
      ],
    }],
  });
}

// ─── Cart Edit ────────────────────────────────────────────────────────────────
async function showCartEditMenu(from, session) {
  const { store } = storeCtx.getStore() || {};
  const currency  = store?.currency || CURRENCY;
  const cart      = session.cart || [];
  if (cart.length === 0) return showCart(from, session);

  const rows = cart.map(item => ({
    id:          `EDIT_ITEM_${item.id}`,
    title:       `${item.name} × ${item.qty}`,
    description: `💰 ${(item.price * item.qty).toFixed(2)} ${currency} — اضغط للتعديل`,
  }));
  rows.push({ id: "BACK_CART", title: "🔙 رجوع للسلة", description: "" });

  return sendList(from, {
    body:       `✏️ *تعديل الكميات*\n\nاختر المنتج الذي تريد تعديله:`,
    buttonText: "اختر منتجاً",
    sections:   [{ title: "مشترياتك الحالية", rows }],
  });
}

async function handleCartEdit(from, msg, session) {
  const { store } = storeCtx.getStore() || {};
  const currency  = store?.currency || CURRENCY;

  // Select item
  if (msg.startsWith("EDIT_ITEM_")) {
    const itemId = msg.replace("EDIT_ITEM_", "");
    const item   = (session.cart || []).find(i => String(i.id) === String(itemId));
    if (!item) return showCartEditMenu(from, session);
    sessionManager.update(from, { editingItemId: itemId });
    return sendList(from, {
      body:       `✏️ *${item.name}*\n\nالكمية الحالية: *${item.qty}*\n\nاختر الكمية الجديدة:`,
      buttonText: "اختر الكمية",
      sections: [{
        title: "الكمية الجديدة",
        rows: [
          { id: "SET_QTY_1",    title: "1️⃣ قطعة واحدة",       description: `${item.price} ${currency}` },
          { id: "SET_QTY_2",    title: "2️⃣ قطعتان",            description: `${(item.price*2).toFixed(2)} ${currency}` },
          { id: "SET_QTY_3",    title: "3️⃣ ثلاث قطع",          description: `${(item.price*3).toFixed(2)} ${currency}` },
          { id: "SET_QTY_5",    title: "5️⃣ خمس قطع",           description: `${(item.price*5).toFixed(2)} ${currency}` },
          { id: "DELETE_ITEM",  title: "🗑️ إزالة من السلة",    description: "حذف هذا المنتج نهائياً" },
          { id: "BACK_EDIT",    title: "🔙 رجوع",                description: "العودة لقائمة المنتجات" },
        ],
      }],
      footer: "أو اكتب الكمية رقماً للكميات الأخرى",
    });
  }

  // Apply preset quantity
  if (msg.startsWith("SET_QTY_")) {
    const qty = parseInt(msg.replace("SET_QTY_", ""));
    return applyCartQtyChange(from, session, qty);
  }

  // Delete item
  if (msg === "DELETE_ITEM") {
    const itemId = session.editingItemId;
    if (!itemId) return showCartEditMenu(from, session);
    const cart = (session.cart || []).filter(i => String(i.id) !== String(itemId));
    sessionManager.update(from, { cart, editingItemId: null });
    if (cart.length === 0) {
      sessionManager.update(from, { step: "MAIN_MENU" });
      return sendButtons(from, {
        body:    "🗑️ تم حذف المنتج.\n\n🛒 سلتك فارغة الآن.\n\nهل تريد تصفح القائمة؟",
        buttons: [{ id: "SEE_MENU", title: "📋 عرض القائمة" }],
      });
    }
    return showCartEditMenu(from, sessionManager.get(from));
  }

  // Back to item list
  if (msg === "BACK_EDIT") return showCartEditMenu(from, session);

  // Text qty input
  const parsed = parseInt(msg);
  if (!isNaN(parsed) && parsed > 0 && parsed <= 99 && session.editingItemId) {
    return applyCartQtyChange(from, session, parsed);
  }

  return showCartEditMenu(from, session);
}

async function applyCartQtyChange(from, session, qty) {
  const { store } = storeCtx.getStore() || {};
  const currency  = store?.currency || CURRENCY;
  const itemId    = session.editingItemId;
  if (!itemId) return showCartEditMenu(from, session);

  const cart = session.cart || [];
  const item = cart.find(i => String(i.id) === String(itemId));
  if (!item) return showCartEditMenu(from, session);

  const oldQty = item.qty;
  item.qty = qty;
  const total = cart.reduce((s, i) => s + i.price * i.qty, 0);
  sessionManager.update(from, { cart, editingItemId: null, step: "CART_ACTION" });

  return sendList(from, {
    body:       `✅ *تم التعديل!*\n\n${item.name}: ${oldQty} ← *${qty}*\n💰 الإجمالي الجديد: *${total.toFixed(2)} ${currency}*`,
    buttonText: "اختر",
    sections: [{
      title: "ماذا تريد؟",
      rows: [
        { id: "CHECKOUT",   title: "✅ إتمام الطلب",          description: "أكمل الطلب الآن" },
        { id: "EDIT_CART",  title: "✏️ تعديل كميات أخرى",    description: "" },
        { id: "CONTINUE",   title: "➕ إضافة منتج آخر",       description: "" },
        { id: "VIEW_CART",  title: "🛒 عرض السلة كاملة",      description: "" },
      ],
    }],
  });
}

async function startCheckout(from, session) {
  const _s = storeCtx.getStore()?.store || null;
  if (!session.cart || session.cart.length === 0) {
    return sendText(from, botMsg.msg(_s, "cart.empty_start"));
  }
  const { store, storeId } = storeCtx.getStore() || {};
  const currency  = store?.currency || CURRENCY;
  const subtotal  = (session.cart || []).reduce((s, i) => s + i.price * i.qty, 0);
  const pts       = getPoints(storeId, from);
  const _loySet   = require("./loyalty").getSettings(store);
  const redeemable = Math.floor(pts.points / _loySet.pointsForDiscount) * _loySet.pointsForDiscount;

  // ── ميزة الكوبونات: مفعّلة افتراضياً، تتعطّل من store-admin ──
  const couponsEnabled = store?.enableCoupons !== false;
  const pointsEnabled  = redeemable >= 100; // النقاط فقط لو فيه رصيد

  // لو الكوبونات معطّلة ولا توجد نقاط → تخطّ مباشرة لطلب الموقع/الجدولة
  if (!couponsEnabled && !pointsEnabled) {
    return _moveToNextAfterCart();
  }

  sessionManager.update(from, { step: "COUPON", couponWaiting: false });

  const couponRows = [
    { id: "COUPON_SKIP",  title: "⏭️ متابعة بدون خصم", description: "إكمال الطلب مباشرة" },
  ];
  if (couponsEnabled) {
    couponRows.push({ id: "COUPON_ENTER", title: "🎟️ لدي كود خصم", description: "أدخل كود الخصم" });
  }
  if (pointsEnabled) {
    couponRows.push({ id: "POINTS_REDEEM", title: `🏆 استبدل ${redeemable} نقطة`, description: `خصم إضافي على طلبك` });
  }
  couponRows.push({ id: "BACK_CART", title: "🔙 تعديل السلة", description: "العودة لتعديل مشترياتك" });

  // عنوان السؤال يتكيف حسب الميزات المفعلة
  let question;
  if (couponsEnabled && pointsEnabled)      question = "هل لديك كود خصم أو تريد استبدال نقاطك؟";
  else if (couponsEnabled)                  question = "هل لديك كود خصم؟";
  else if (pointsEnabled)                   question = "هل تريد استبدال نقاطك؟";

  return sendList(from, {
    body:
      `🛍️ *تأكيد الطلب*\n\n` +
      `إجمالي السلة: *${subtotal.toFixed(2)} ${currency}*\n` +
      (pts.points > 0 && pointsEnabled ? `🏆 رصيد نقاطك: *${pts.points}* نقطة\n` : "") +
      `\n${question}`,
    buttonText: "اختر",
    sections:   [{ title: couponsEnabled ? "خيارات الخصم" : "خيارات النقاط", rows: couponRows }],
    footer:     couponsEnabled ? "أو اكتب كود الخصم مباشرة" : "",
  });
}

async function handleCouponStep(from, msg, session) {
  const { store, storeId } = storeCtx.getStore() || {};
  const currency  = store?.currency || CURRENCY;
  const subtotal  = (session.cart || []).reduce((s, i) => s + i.price * i.qty, 0);

  // ── Cart navigation from old polls (user tapped a cart action while coupon shown) ──
  if (msg === "CONTINUE") { sessionManager.update(from, { step: "CATEGORY", couponWaiting: false }); return sendCategoryMenu(from); }
  if (msg === "VIEW_CART") { sessionManager.update(from, { step: "CART_ACTION", couponWaiting: false }); return showCart(from, sessionManager.get(from)); }
  if (msg === "BACK_PROD") { sessionManager.update(from, { step: "PRODUCT",    couponWaiting: false }); return showProductsPage(from, session.currentCategory || "", session.currentPage || 0); }

  // Skip coupon → تخطّ مباشرة لطلب الموقع/الجدولة (لا اسم)
  // يدعم زر COUPON_SKIP + نص "تخطي/skip/لا/بدون"
  const trimmed = String(msg || "").trim();
  if (msg === "COUPON_SKIP" || /^(تخطي|تخطى|skip|لا|بدون|لا\s*يوجد|ليس\s*لدي|no)$/i.test(aiParser.normalizeAr(trimmed))) {
    sessionManager.update(from, { couponWaiting: false });
    return _moveToNextAfterCart();
  }

  // Open text entry for coupon code
  if (msg === "COUPON_ENTER") {
    sessionManager.update(from, { couponWaiting: true });
    return sendButtons(from, {
      body:    "🎟️ أرسل *كود الخصم* الخاص بك:",
      buttons: [{ id: "BACK_CART", title: "🔙 تعديل السلة" }],
    });
  }

  // ⚡ Helper: ينقل لمرحلة الموقع/الجدولة مباشرة (تخطي طلب الاسم)
  // يستخدم botQuestions.fields[] المخصصة إن وُجدت، وإلا الـ flow القديم.
  function _moveToNextAfterCart() {
    sessionManager.update(from, { customerName: "عميل", customerLocation: null, customAnswers: {} });
    // ⭐ يستخدم botQuestions.fields[] المحفوظة من المتجر،
    //    وإن لم يحفظ → يأخذ default questions حسب businessType (helper من store-router)
    const sr = require("./store-router");
    const btype = store?.businessType || "delivery";
    const activeFields = sr._getActiveStoreQuestions(store, btype);
    if (activeFields && activeFields.length) {
      sessionManager.update(from, { step: "DYNAMIC_Q", questionIdx: 0 });
      return _askDynamicQuestion(from, activeFields, 0);
    }
    // Legacy fallback (نادر: لو _getStoreQuestions رجع فارغ)
    const _btype = getBusinessType(store);
    const labels = businessLabels(_btype);
    if (!labels.needsLocation) {
      sessionManager.update(from, { step: "SCHEDULE_ORDER" });
      return sendScheduleAsk(from, "");
    }
    sessionManager.update(from, { step: "COLLECT_LOCATION" });
    return sendText(from,
      `📍 *${labels.locationPrompt}*\n\n` +
      `🗺️ *الطريقة الأسرع:* أرسل موقعك من واتساب\n` +
      `   اضغط 📎 (أو ➕) ← *الموقع* ← *موقعي الحالي*\n\n` +
      `أو اكتب اسم الحي / العنوان كنص 👇\n\n` +
      `_اكتب *"تعديل"* للعودة للسلة_`
    );
  }

  // Redeem loyalty points
  if (msg === "POINTS_REDEEM") {
    const pts = getPoints(storeId, from);
    const _loySet2 = require("./loyalty").getSettings(store);
    const redeemable = Math.floor(pts.points / _loySet2.pointsForDiscount) * _loySet2.pointsForDiscount;
    if (redeemable < _loySet2.pointsForDiscount) {
      await sendText(from, botMsg.msg(store, "loyalty.insufficient"));
      return _moveToNextAfterCart();
    }
    const result = redeemPoints(storeId, from, redeemable, store);
    if (!result) {
      await sendText(from, botMsg.msg(store, "loyalty.redeem_failed"));
      return _moveToNextAfterCart();
    }
    const newSubtotal = Math.max(0, subtotal - result.discount);
    sessionManager.update(from, {
      couponWaiting: false,
      appliedDiscount: result.discount,
      discountLabel: `🏆 استبدال ${redeemable} نقطة`,
      discountedSubtotal: newSubtotal,
    });
    await sendText(from,
      `✅ تم استبدال *${redeemable}* نقطة!\n💰 خصم: *${result.discount.toFixed(2)} ${currency}*\n🏆 المتبقي: *${result.remainingPoints}*`
    );
    return _moveToNextAfterCart();
  }

  // User typed a coupon code — only process when explicitly waiting for one
  if (session.couponWaiting) {
    const result = validateCoupon(msg.trim(), storeId, subtotal, from, { channel: "bot" });
    if (!result.valid) {
      return sendButtons(from, {
        body: result.message + "\n\nحاول مجدداً أو اختر أحد الخيارات:",
        buttons: [
          { id: "COUPON_SKIP",  title: "⏭️ بدون كوبون" },
          { id: "COUPON_ENTER", title: "🎟️ كود آخر" },
          { id: "BACK_CART",    title: "🔙 تعديل السلة" },
        ],
      });
    }
    const newSubtotal = Math.max(0, subtotal - result.discount);
    sessionManager.update(from, {
      couponWaiting: false,
      appliedCoupon: result.code,
      appliedDiscount: result.discount,
      discountLabel: result.message,
      discountedSubtotal: newSubtotal,
    });
    await sendText(from, `${result.message}\n💰 وفرت: *${result.discount.toFixed(2)} ${currency}*`);
    return _moveToNextAfterCart();
  }

  // Fallback — ننتقل مباشرة للمرحلة التالية (بدون طلب الاسم)
  sessionManager.update(from, { couponWaiting: false });
  return _moveToNextAfterCart();
}

// ═════════ 🤖 Dynamic Bot Questions Flow ═════════════════════════════
// يستخدم botQuestions.fields[] المعرّفة في إعدادات المتجر، يطرح كل سؤال بدوره
// ويحفظ الإجابات في session.customAnswers[fieldId]

async function _askDynamicQuestion(from, fields, idx) {
  const f = fields[idx];
  if (!f) return _finishDynamicQuestions(from);

  // 🚀 تخطّي سؤال schedule تلقائياً — فقط لو النوع "schedule" فعلياً (widget موعد)
  //   القاعدة: إذا المتجر غيّر النوع إلى "text" رغم أن id="schedule"، يعني يريد سؤالاً يدوياً
  //   (كنا نتخطى أي سؤال بـ id="schedule" حتى لو نوعه text → البوت يتجاهل سؤال المتجر)
  if (f.type === "schedule") {
    const { store } = storeCtx.getStore() || {};
    if (!shouldAskDeliveryTime(store)) {
      const etaText = computeETAText(store);
      const ans = sessionManager.get(from)?.customAnswers || {};
      ans[f.id] = etaText;
      sessionManager.update(from, {
        customAnswers: ans,
        scheduledTime: etaText,
        questionIdx: idx + 1,
      });
      return _askDynamicQuestion(from, fields, idx + 1);
    }
  }

  // 🎯 تحكم 100%: أرسل نص المتجر كما هو بالضبط.
  // للـ choice: أضف الخيارات فقط لأنها ضرورية للعميل ليعرف الأرقام (بدون تلميح تخطي أو عدّاد)
  if (f.type === "choice" && Array.isArray(f.options) && f.options.length) {
    return sendText(from, `${f.prompt}\n\n${f.options.map((o, i) => `${i + 1}️⃣ ${o}`).join("\n")}`);
  }
  return sendText(from, f.prompt);
}

async function handleDynamicQuestion(from, msg, session) {
  const { store } = storeCtx.getStore() || {};
  // ⭐ نفس الـ helper المستخدم في _moveToNextAfterCart — يضمن الـ defaults حسب businessType
  const sr = require("./store-router");
  const btype = store?.businessType || "delivery";
  const fields = sr._getActiveStoreQuestions(store, btype);
  const idx = Number(session.questionIdx || 0);
  const f = fields[idx];
  if (!f) return _finishDynamicQuestions(from);

  // 🎯 تحكم 100%: عند خطأ validation، أعِد إرسال نص المتجر كما هو (بلا "❌ لم أفهم")
  const _err = (_defaultMsg) => f.prompt;

  const trimmed = String(msg || "").trim();
  const normalized = aiParser.normalizeAr(trimmed);

  // الرجوع للسلة في أي وقت
  if (/^(تعديل|رجوع|السلة|سلتي|back)$/i.test(normalized)) {
    return showCart(from, sessionManager.get(from));
  }

  // تخطي للأسئلة الاختيارية
  if (!f.required && /^(تخطي|تخطى|skip|لا)$/i.test(normalized)) {
    return _saveAnswerAndNext(from, fields, idx, "");
  }

  // validation حسب النوع
  if (f.type === "location") {
    if (!isValidLocation(trimmed) && !trimmed.startsWith("📍|")) {
      return sendText(from, _err(`❌ لم أفهم الموقع. أرسل موقعاً من واتساب أو اكتب اسم الحي/العنوان.\n\n${f.prompt}`));
    }
    // 🗺️ شارك موقع → استخرج الإحداثيات + reverse geocoding + رابط maps
    if (trimmed.startsWith("📍|")) {
      const resolved = await resolveSharedLocation(trimmed);
      if (resolved) {
        const { lat, lng, name } = resolved;
        const mapsUrl = `https://maps.google.com/?q=${lat},${lng}`;
        sessionManager.update(from, {
          customerLocation:         `${name} (📍 ${mapsUrl})`,
          customerLocationName:     name,
          customerLocationLat:      lat,
          customerLocationLng:      lng,
          customerLocationMapsUrl:  mapsUrl,
        });
        // نحفظ اسم الموقع المقروء في customAnswers (لا الـ payload الخام)
        return _saveAnswerAndNext(from, fields, idx, name);
      }
    } else {
      // 📍 عنوان نصي — نحفظه كما كتبه + نمسح أي GPS سابق
      sessionManager.update(from, {
        customerLocation: trimmed,
        customerLocationName: trimmed,
        customerLocationLat: null,
        customerLocationLng: null,
        customerLocationMapsUrl: null,
      });
    }
  } else if (f.type === "schedule") {
    let parsed = orderScheduler.parseArabicTime(trimmed);
    if (!parsed) { try { parsed = await aiParser.aiParseTime(trimmed); } catch {} }
    if (!parsed) {
      return sendText(from, _err(`❌ لم أفهم الوقت. مثال: *الان* أو "بعد ساعة" أو "8 مساءً"\n\n${f.prompt}`));
    }
    sessionManager.update(from, { scheduledTime: trimmed });
  } else if (f.type === "date") {
    const dateParser = require("./date-parser");
    let parsed = dateParser.parseDate(trimmed);
    // 🤖 AI fallback لو date-parser فشل (يفهم "بعد العشاء" → null + يقترح تاريخ، أو "نهاية الأسبوع" → السبت)
    if (!parsed) {
      try {
        const ai = await aiParser.aiSmartFallback(f.prompt, trimmed, "date");
        if (ai.understood && ai.confidence > 0.6 && ai.extracted) {
          parsed = dateParser.parseDate(ai.extracted);
        }
      } catch {}
    }
    if (!parsed) {
      return sendText(from, _err(`❌ لم أفهم التاريخ. أمثلة صحيحة:\n• *اليوم* أو *غداً* أو *بعد غد*\n• *24 يونيو* أو *الخميس*\n• *2026-06-24* أو *24/6*\n\n${f.prompt}`));
    }
    const iso = dateParser.toISODate(parsed);
    const human = dateParser.toArabicDate(parsed);
    return _saveAnswerAndNext(from, fields, idx, `${human} (${iso})`);
  } else if (f.type === "phone") {
    if (!/^[\d+\s\-()]{7,20}$/.test(trimmed)) {
      return sendText(from, _err(`❌ رقم غير صحيح. أرسل رقم هاتف صالح (7-20 رقم).\n\n${f.prompt}`));
    }
  } else if (f.type === "number") {
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      // 🤖 AI fallback: "أنا مع أهلي 5" → 5
      try {
        const ai = await aiParser.aiSmartFallback(f.prompt, trimmed, "number");
        if (ai.understood && ai.confidence > 0.6 && /^\d+(\.\d+)?$/.test(ai.extracted)) {
          return _saveAnswerAndNext(from, fields, idx, ai.extracted);
        }
      } catch {}
      return sendText(from, _err(`❌ من فضلك أرسل رقماً فقط.\n\n${f.prompt}`));
    }
  } else if (f.type === "choice" && Array.isArray(f.options)) {
    const n = parseInt(trimmed);
    if (n >= 1 && n <= f.options.length) {
      return _saveAnswerAndNext(from, fields, idx, f.options[n - 1]);
    }
    const matched = f.options.find(o => aiParser.normalizeAr(o) === normalized);
    if (matched) return _saveAnswerAndNext(from, fields, idx, matched);
    // 🤖 AI fallback: "الأول من فضلك" → 1
    try {
      const ai = await aiParser.aiSmartFallback(f.prompt, trimmed, "choice", f.options);
      if (ai.understood && ai.confidence > 0.6) {
        const aiN = parseInt(ai.extracted);
        if (aiN >= 1 && aiN <= f.options.length) {
          return _saveAnswerAndNext(from, fields, idx, f.options[aiN - 1]);
        }
      }
    } catch {}
    return sendText(from, _err(`❌ اختر رقماً من 1 إلى ${f.options.length} أو اكتب أحد الخيارات.\n\n${f.prompt}\n\n${f.options.map((o, i) => `${i+1}. ${o}`).join("\n")}`));
  } else if (f.type === "text") {
    if (trimmed.length < 2) {
      return sendText(from, _err(`❌ من فضلك أرسل إجابة أطول.\n\n${f.prompt}`));
    }
  }

  return _saveAnswerAndNext(from, fields, idx, trimmed);
}

function _saveAnswerAndNext(from, fields, idx, answer) {
  const session = sessionManager.get(from);
  const answers = { ...(session.customAnswers || {}) };
  // لا تكتب الـ payload الخام للموقع في customAnswers — استخدم الاسم المقروء فقط
  let storedAnswer = answer;
  if (fields[idx].type === "location" && typeof answer === "string" && answer.startsWith("📍|")) {
    storedAnswer = session.customerLocationName || "موقع مشترك";
  }
  answers[fields[idx].id] = storedAnswer;
  // sync للحقول القديمة (سيتم تجاوزها لو resolveSharedLocation سبقت)
  if (fields[idx].type === "location" && storedAnswer && !session.customerLocationMapsUrl) {
    sessionManager.update(from, { customerLocation: storedAnswer });
  }
  sessionManager.update(from, {
    customAnswers: answers,
    questionIdx: idx + 1,
  });
  return _askDynamicQuestion(from, fields, idx + 1);
}

async function _finishDynamicQuestions(from) {
  // كل الأسئلة تمت → اذهب لـ summary
  sessionManager.update(from, { step: "CONFIRM_ORDER", questionIdx: undefined });
  return showOrderSummary(from, sessionManager.get(from));
}

async function handleCollectName(from, msg, session) {
  // 🚫 خطوة الاسم محذوفة بالكامل — أي رسالة وصلت هنا = العميل يحاول إدخال العنوان/الموقع
  // ننتقل مباشرة لـ COLLECT_LOCATION أو SCHEDULE_ORDER (حسب نوع البيزنس) ونعالج النص كموقع
  const { store } = storeCtx.getStore() || {};
  const btype  = getBusinessType(store);
  const labels = businessLabels(btype);

  sessionManager.update(from, { customerName: "عميل", customerLocation: null });

  // pickup/walkin: تخطّ الموقع → SCHEDULE_ORDER
  if (!labels.needsLocation) {
    sessionManager.update(from, { step: "SCHEDULE_ORDER" });
    return sendScheduleAsk(from, "");
  }

  // delivery: عالج الرسالة الحالية كموقع مباشرة (لو هي bypass = LOC_*) أو طلب موقع جديد
  sessionManager.update(from, { step: "COLLECT_LOCATION" });
  // لو الرسالة تبدو موقعاً صالحاً، عالجها فوراً
  if (msg && msg.length >= 3 && !["BACK_CART","BACK_MAIN"].includes(msg)) {
    return handleCollectLocation(from, msg, sessionManager.get(from));
  }
  return sendText(from,
    `📍 *${labels.locationPrompt}*\n\n` +
    `🗺️ *الطريقة الأسرع:* أرسل موقعك من واتساب\n` +
    `   اضغط 📎 (أو ➕) ← *الموقع* ← *موقعي الحالي*\n\n` +
    `أو اكتب اسم الحي / العنوان كنص 👇\n\n` +
    `_اكتب *"تعديل"* للعودة للسلة_`
  );
}

// isValidLocation → moved to ./utils/server-helpers.js (Phase 1 refactor)

async function handleCollectLocation(from, msg, session) {
  let location = msg.trim().slice(0, 500);

  // إذا العميل أرسل ملاحظات بعد ما طلبناها — تُلحَق بالاسم لا تستبدله
  if (session.awaitingLocationNote && location && !location.startsWith("📍|") && msg !== "LOC_SKIP_NOTE") {
    const baseName = session.customerLocationName || "";
    const lat = session.customerLocationLat;
    const lng = session.customerLocationLng;
    const mapsUrl = (lat && lng) ? `https://maps.google.com/?q=${lat},${lng}` : "";
    const combinedName = baseName ? `${baseName} — ${location}` : location;
    const finalLoc = mapsUrl ? `${combinedName} (📍 ${mapsUrl})` : combinedName;
    sessionManager.update(from, {
      step: "SCHEDULE_ORDER",
      customerLocation: finalLoc,
      customerLocationName: combinedName,
      customerLocationNote: location,
      awaitingLocationNote: false,
    });
    await sendText(from, `✅ تم تسجيل الملاحظة:\n_${location}_`);
    return sendScheduleAsk(from);
  }

  // ✅ زر "تأكيد بدون ملاحظة"
  if (msg === "LOC_CONFIRM" || msg === "LOC_SKIP_NOTE") {
    sessionManager.update(from, { step: "SCHEDULE_ORDER", awaitingLocationNote: false });
    return sendScheduleAsk(from);
  }

  // 📍 رسالة موقع مشاركة من واتساب — نحوّل الإحداثيات لاسم مفهوم
  if (location.startsWith("📍|")) {
    const resolved = await resolveSharedLocation(location);
    if (resolved) {
      const mapsUrl = `https://maps.google.com/?q=${resolved.lat},${resolved.lng}`;
      const finalLoc = `${resolved.name} (📍 ${mapsUrl})`;
      const { store: _storeLoc } = storeCtx.getStore() || {};
      const sharedLocationUpdate = {
        customerLocation: finalLoc,
        customerLocationLat: resolved.lat,
        customerLocationLng: resolved.lng,
        customerLocationName: resolved.name,
        customerLocationMapsUrl: mapsUrl,
        awaitingLocationNote: false,
      };
      // للمتاجر الفورية: تخطّي سؤال الوقت + ETA من avgDeliveryMin
      if (!shouldAskDeliveryTime(_storeLoc)) {
        sessionManager.update(from, {
          step: "CONFIRM_ORDER",
          ...sharedLocationUpdate,
          scheduledTime: computeETAText(_storeLoc),
        });
        return showOrderSummary(from, sessionManager.get(from));
      }
      sessionManager.update(from, { step: "SCHEDULE_ORDER", ...sharedLocationUpdate });
      return sendScheduleAsk(from);
    }
  }

  // 📝 زر "إضافة ملاحظة" — يطلب من العميل كتابتها
  if (msg === "LOC_NOTE") {
    sessionManager.update(from, { awaitingLocationNote: true });
    return sendText(from, `📝 *اكتب ملاحظات الموقع:*\n\nأمثلة:\n• "أمام محل العثيم"\n• "بجانب جامع الفهد، الباب الأخضر"\n• "الفيلا البيضاء عند الإشارة"\n• "الدور الثاني، شقة 5"`);
  }

  // "تعديل" / "رجوع" → عودة للسلة
  if (isEditIntent(location)) {
    return showCart(from, sessionManager.get(from));
  }
  // رفض: gibberish أو أسئلة شخصية
  if (isOffTopicQuery(location)) {
    return sendText(from,
      "🤖 *لاحظت أن هذا سؤال!*\n\nأنا بوت لاستقبال الطلبات فقط. من فضلك *أرسل موقعك* (📎 → الموقع) أو اكتب اسم الحي 📍\n\n" +
      `_أو اكتب *"تعديل"* للعودة للسلة_`
    );
  }
  if (isGibberish(location)) {
    return sendText(from,
      "🤔 *العنوان غير واضح!*\n\n🗺️ *الأسهل:* أرسل موقعك (📎 → الموقع → موقعي الحالي)\nأو اكتب اسم الحي بشكل واضح 📍\n\n" +
      `_أو اكتب *"تعديل"* للعودة للسلة_`
    );
  }
  // Reject invalid locations (button IDs أو طول غير معقول)
  if (!isValidLocation(location) || /^[A-Z][A-Z0-9_]*$/.test(location)) {
    return sendText(from,
      "📍 *العنوان مطلوب*\n\n🗺️ *الأسهل:* أرسل موقعك من واتساب (📎 → الموقع)\nأو اكتب اسم الحي 📌\n\n" +
      `_أو اكتب *"تعديل"* للعودة للسلة_`
    );
  }

  // 🚀 للمتاجر التي لها ساعات عمل ثابتة (food/cafe/restaurant/delivery/pickup):
  // لا نسأل عن الوقت — نحسب ETA الفعلي من avgDeliveryMin
  // 📍 نص يدوي → نحفظه كما كتبه العميل + نمسح أي إحداثيات GPS قديمة (يفرّق المسارين)
  const { store: _store } = storeCtx.getStore() || {};
  const textLocationUpdate = {
    customerLocation: location,
    customerLocationName: location, // النص الذي كتبه العميل
    customerLocationLat: null,       // مسح أي GPS سابق
    customerLocationLng: null,
    customerLocationMapsUrl: null,
  };
  if (!shouldAskDeliveryTime(_store)) {
    sessionManager.update(from, {
      step: "CONFIRM_ORDER",
      ...textLocationUpdate,
      scheduledTime: computeETAText(_store),
    });
    return showOrderSummary(from, sessionManager.get(from));
  }
  sessionManager.update(from, { step: "SCHEDULE_ORDER", ...textLocationUpdate });
  return sendScheduleAsk(from);
}

// نص موحد لطلب الوقت — دائماً كتابة حرة بدون buttons
// 🚀 للمتاجر الفورية (food/cafe/delivery/pickup): تخطّي السؤال + ETA من avgDeliveryMin
async function sendScheduleAsk(from, prefix = "") {
  const { store } = storeCtx.getStore() || {};
  if (!shouldAskDeliveryTime(store)) {
    // متجر فوري — نحسب ETA الفعلي + ننتقل لملخص الطلب
    sessionManager.update(from, { step: "CONFIRM_ORDER", scheduledTime: computeETAText(store) });
    return showOrderSummary(from, sessionManager.get(from));
  }
  const { timeLabel } = businessLabels(getBusinessType(store));
  return sendText(from,
    (prefix ? prefix + "\n\n" : "") +
    `🕐 *متى تريد ${timeLabel}؟*\n\n` +
    `اكتب الوقت المطلوب — أمثلة:\n` +
    `• *الآن* (للاستلام الفوري)\n` +
    `• *بعد 30 دقيقة*\n` +
    `• *بعد ساعة*\n` +
    `• *7:30 مساء*\n` +
    `• *9 صباحاً*\n\n` +
    `_أو اكتب *"تعديل"* للعودة وتعديل السلة_`
  );
}

async function handleScheduleOrder(from, msg, session) {
  const trimmed = String(msg || "").trim();

  // أي صياغة تشير لـ "تعديل/تغيير/رجوع" → عودة للسلة
  if (isEditIntent(trimmed)) {
    return showCart(from, sessionManager.get(from));
  }

  // "الآن" / "now" → استلام فوري
  if (/^(الآن|الان|الأن|now|⚡|فور(اً|ا))$/i.test(trimmed)) {
    sessionManager.update(from, { scheduledTime: null });
    return showOrderSummary(from, sessionManager.get(from));
  }

  // رفض: gibberish أو أسئلة شخصية
  if (isOffTopicQuery(trimmed)) {
    return sendScheduleAsk(from, "🤖 لاحظت أن هذا سؤال — أحتاج فقط وقت الاستلام.");
  }
  if (isGibberish(trimmed)) {
    return sendScheduleAsk(from, "🤔 لم أفهم الوقت — حاول مرة أخرى.");
  }

  // محاولة 1: rule-based parser (سريع)
  let parsed = orderScheduler.parseArabicTime(trimmed);

  // محاولة 2: AI fallback لو فشل rule-based (للعامية المعقدة)
  if (!parsed) {
    try { parsed = await aiParser.aiParseTime(trimmed); }
    catch (e) { console.warn("[ai-parse-time] failed:", e.message); }
  }

  if (parsed) {
    sessionManager.update(from, { scheduledTime: trimmed });
    return showOrderSummary(from, sessionManager.get(from));
  }

  // لم يُفهم حتى مع AI → نعيد طلب الوقت
  return sendScheduleAsk(from, "❌ لم أفهم الوقت.");
}

async function handleCollectTime(from, msg, session) {
  // Quick time presets
  const timePresets = { TIME_30: 30, TIME_60: 60, TIME_90: 90, TIME_120: 120 };
  if (timePresets[msg] !== undefined) {
    const now   = new Date();
    now.setMinutes(now.getMinutes() + timePresets[msg]);
    const h    = now.getHours();
    const m    = String(now.getMinutes()).padStart(2, "0");
    const period = h >= 12 ? "مساء" : "صباحاً";
    const h12  = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    const timeStr = `${h12}:${m} ${period}`;
    sessionManager.update(from, { scheduledTime: timeStr });
    return showOrderSummary(from, sessionManager.get(from));
  }

  const parsed = orderScheduler.parseArabicTime(msg);
  if (!parsed) {
    const { store: storeInner } = storeCtx.getStore() || {};
    const { timeLabel: tl } = businessLabels(getBusinessType(storeInner));
    return sendList(from, {
      body:       `❌ لم أفهم الوقت.\n\nاختر وقتاً سريعاً أو اكتب مثل: *7:30 مساء*`,
      buttonText: "اختر الوقت",
      sections: [{
        title: `أوقات ${tl}`,
        rows: [
          { id: "TIME_30",    title: "⏱️ بعد 30 دقيقة",  description: "" },
          { id: "TIME_60",    title: "⏱️ بعد ساعة",       description: "" },
          { id: "TIME_90",    title: "⏱️ بعد ساعة ونصف", description: "" },
          { id: "TIME_120",   title: "⏱️ بعد ساعتين",     description: "" },
          { id: "BACK_SCHED", title: "🔙 رجوع",            description: "" },
        ],
      }],
      footer: "أو اكتب الوقت مثل: 7:30 مساء",
    });
  }
  sessionManager.update(from, { scheduledTime: msg.trim() });
  return showOrderSummary(from, sessionManager.get(from));
}

async function showOrderSummary(from, session) {
  sessionManager.update(from, { step: "CONFIRM_ORDER" });

  const { store } = storeCtx.getStore() || {};
  const currency   = store?.currency || CURRENCY;
  const btype      = getBusinessType(store);
  const labels     = businessLabels(btype);

  // 🚚 حساب رسوم التوصيل حسب موقع العميل (deliveryZones)
  //     لو المتجر عرّف مناطق → مطابقة تلقائية من الموقع/العنوان
  //     لو ما فيه مناطق → deliveryFee الموحّد
  let fee = 0;
  let matchedZoneName = null;
  if (labels.feeLabel) {
    const { resolveDeliveryZone } = require("./delivery-zones");
    const zoneResult = resolveDeliveryZone(store, session);
    fee = Number(zoneResult.fee) || 0;
    matchedZoneName = zoneResult.zoneName;
    // احفظ في session للـ handleConfirmOrder + الفاتورة
    sessionManager.update(from, {
      resolvedDeliveryZone: matchedZoneName,
      resolvedDeliveryFee: fee,
    });
    console.log(`[zone] ${from} → zone="${matchedZoneName || "—"}" fee=${fee} matched=${zoneResult.matched}`);
  }

  const cart        = session.cart || [];
  const hasNegotiable = cart.some(i => i.priceOnRequest);
  const rawSubtotal = cart.reduce((s, i) => s + (i.priceOnRequest ? 0 : i.price * i.qty), 0);
  const discount    = session.appliedDiscount || 0;
  const grandTotal  = hasNegotiable && rawSubtotal === 0 ? null : Math.max(0, rawSubtotal - discount) + fee;

  // 📦 عناصر الطلب — سطر بسيط (بلا سعر تفصيلي، السعر في التوتال)
  const itemLines  = cart.map(i => `• ${i.name} ×${i.qty}`).join("\n");

  // 🗺️ رابط Google Maps (من الإحداثيات لو متوفرة)
  const mapsUrl = (session.customerLocationLat && session.customerLocationLng)
    ? `https://maps.google.com/?q=${session.customerLocationLat},${session.customerLocationLng}`
    : "";

  // 🤖 كل إجابات الأسئلة الديناميكية بترتيب المتجر — كل سؤال في سطر منفصل
  //    نُدمج معها العنوان (لو معدَّل ولم يُسأل) والوقت التلقائي — بدون أي تكرار
  const customAnswers = session.customAnswers || {};
  const customFields  = require("./store-router")._getActiveStoreQuestions(store, store?.businessType || "delivery");
  const answeredFieldIds = new Set();
  const questionLines = [];
  const ICON = { location: "📍", schedule: "⏰", phone: "📞", number: "🔢", date: "📅", choice: "☑️", text: "📝" };
  if (customFields.length) {
    for (const f of customFields) {
      const v = customAnswers[f.id];
      if (!v) continue;
      answeredFieldIds.add(f.id);
      // 🚫 وقت الاستلام محذوف من رسالة الملخص (يظهر بعد قبول المتجر فقط)
      if (f.type === "schedule" || f.id === "schedule") continue;
      const ico = ICON[f.type] || "📝";
      questionLines.push(`${ico} *${f.label}:* ${v}`);
    }
  }
  // Fallback للـ location لو ما اتحفظ في customAnswers لكن موجود في session
  const locationName = (session.customerLocationName || session.customerLocation || "")
    .replace(/\s*\(📍\s*https?:\/\/[^)]+\)/g, "").trim();
  if (locationName && !customFields.some(f => f.type === "location" || f.id === "location")) {
    questionLines.push(`📍 *العنوان:* ${locationName}`);
  }
  // 🚫 وقت الاستلام محذوف نهائياً من رسالة الملخص
  const questionsBlock = questionLines.length ? questionLines.join("\n") : "";

  // 📝 ملاحظات العميل — دائماً في الملخص + دائماً في الفاتورة (إن وُجدت)
  const notesText = (session.orderNotes || "").trim();

  // 💳 طريقة الدفع — سطر واحد فقط (أول طريقة نشطة)
  let paymentMethod = "💵 الدفع عند الاستلام";
  if (store?.payBank === true || store?.payBank === "true" || store?.payBank === 1) {
    paymentMethod = "🏦 تحويل بنكي أو الدفع عند الاستلام";
  } else if (store?.payStc === true || store?.payStc === "true" || store?.payStc === 1) {
    paymentMethod = "📱 STC Pay أو الدفع عند الاستلام";
  } else if (store?.payCash === false) {
    paymentMethod = "💳 راجع طرق الدفع مع المتجر";
  }

  // 💰 (محذوف من رسالة الملخص) — رسوم التوصيل والإجمالي وطريقة الدفع تظهر بعد قبول المتجر فقط
  //     السبب: البوت يحسب رسوم من الموقع، لكن المتجر قد يعدّلها عند القبول → لا نظهرها للعميل مبكراً

  // 🎯 orderId مُولَّد هنا مرة واحدة — يُحفَظ في session ويُستخدم في handleConfirmOrder + رسائل الاستلام
  //     (يمنع اختلاف رقم الطلب بين رسالة الملخص ورسالة "قيد المراجعة")
  const orderId = `ORD-${Date.now().toString().slice(-7)}`;
  sessionManager.update(from, { pendingOrderId: orderId });

  // 📝 تصميم منظّم بلا تكرار — بلا رسوم وبلا إجمالي وبلا دفع (تظهر بعد قبول المتجر)
  //    ترتيب: الرأس → الأسئلة والإجابات → الأصناف → رابط الموقع (نصي) → الملاحظات
  const SEP = "━━━━━━━━━━━━━━";
  const parts = [];
  // 🔖 رأس
  parts.push(`🧾 *ملخص طلبك* — ${orderId}`);
  parts.push(SEP);
  // 🤖 أسئلة وأجوبة (كل واحد سطر منفصل)
  if (questionsBlock) {
    parts.push(questionsBlock);
    parts.push(SEP);
  }
  // 🛍️ الأصناف
  parts.push(`🛍️ *الأصناف:*\n${itemLines}`);
  // 🗺️ رابط الموقع (نصي فقط — بلا bold وبلا زخرفة)
  if (mapsUrl) {
    parts.push(SEP);
    parts.push(mapsUrl);
  }
  // 📝 الملاحظات (إن وُجدت — في الملخص + الفاتورة)
  if (notesText) {
    parts.push(SEP);
    parts.push(`📝 *ملاحظات:* ${notesText}`);
  }

  const invoice = parts.join("\n");

  sessionManager.update(from, { pendingInvoice: invoice, grandTotal });

  // 🎯 الملخص يُرسل فقط (صورة + caption) ثم نُنفّذ التأكيد تلقائياً.
  // caption = الملخص فقط (بلا سطر مساعدة زائد — الرسالة قصيرة وواضحة)
  const caption  = invoice;

  try {
    const summaryImg = await generateSummaryImage({
      sessionId:      from.slice(-6),
      storeName:      store?.storeName || STORE_NAME,
      invoiceColor:   store?.invoiceColor || null,
      invoiceLogoUrl: store?.invoiceLogoUrl || null,
      items: cart, deliveryFee: fee, total: grandTotal, currency,
    });
    const imgPath = summaryImg.filePath || path.join(DATA_DIR,"invoices",summaryImg.fileName);
    await sendImage(from, imgPath, caption);
  } catch (err) {
    console.error("Summary image error:", err.message);
    // Fallback: نص فقط (لو الصورة فشلت)
    try { await sendText(from, caption); } catch {}
  }

  // 🚀 إرسال الطلب فوراً للمتجر — بدون خطوة تأكيد
  // نقرأ session مُحدّث (يحوي pendingInvoice + grandTotal اللذين حُفظا للتو)
  return handleConfirmOrder(from, "CONFIRM_YES", sessionManager.get(from) || session);
}

async function handleConfirmOrder(from, msg, session) {
  // 🎯 تقبل: الأرقام (1/2/3) + كل لهجات العربية والإنجليزية
  // بعد normalizeAr: ؤ→و، أإآ→ا، ى→ي، ة→ه + إزالة التشكيل
  const trimmed = String(msg || "").trim();
  const norm    = aiParser.normalizeAr(trimmed);

  // 1️⃣ تأكيد — الأرقام والكلمات الإيجابية بكل اللهجات
  const RX_YES = /^(1|١|تاكيد|اكد|اكدلي|تاكيدي|نعم|ايوه|ايوة|ايوا|اي|ها|هاي|تمام|تم|تمم|اوكي|اوك|اوك?ي?|خلاص|خلص|يلا|طيب|زين|كويس|كويسه|ممتاز|ماشي|متفق|اتفقنا|موافق|موافقه|قبلت|اقبل|ابعتها|ابعتلي|ارسلها|ارسل|سرها|سيرها|sure|confirm|done|ok|okay|yes|yep|yeah|y|👍|✅|✔)$/i;
  // 2️⃣ تعديل — أرقام وكلمات تعني العودة للسلة
  const RX_EDIT = /^(2|٢|تعديل|عدل|عدلي|عدلوا|غير|غيره|غيرها|تغيير|عدل\s*ع?لي|عدل\s*في|رجوع|ارجع|راجع|اقدر\s*اعدل|عاوز\s*اعدل|بدي\s*اعدل|edit|back|change|modify)$/i;
  // 3️⃣ إلغاء — أرقام و"لا" بكل اللهجات
  const RX_NO = /^(3|٣|الغاء|الغ|الغي|الغيها|بطل|بطلها|انسي|انسى|لا|لاء|لاه|لاع|لاه|كنسل|cancel|stop|no|nope|n|مش\s*عاوز|مش\s*عايز|ما\s*ابي|ما\s*ابغى|ما\s*اريد|❌|🚫)$/i;

  if (RX_YES.test(norm))      msg = "CONFIRM_YES";
  else if (RX_EDIT.test(norm)) msg = "BACK_CART";
  else if (RX_NO.test(norm))   msg = "CONFIRM_NO";

  if (msg === "CONFIRM_YES") {
    // 🛡️ Idempotency guard — يحمي من double-tap أو re-deliver أو race
    if (session.step === "DONE" && session.orderId) {
      console.log(`[confirm-dedup] [${from}] session.orderId=${session.orderId} موجود — تجاهل confirm مكرر`);
      return;
    }
    // 📊 diagnostic snapshot لو شي فشل في الـ flow
    console.log(`[confirm] [${from}] start: cartLen=${(session.cart||[]).length} grandTotal=${session.grandTotal} scheduledTime="${session.scheduledTime}" loc="${(session.customerLocation||"").slice(0,30)}"`);

    const { store, storeId } = storeCtx.getStore() || {};
    const currency  = store?.currency || CURRENCY;
    const btype     = getBusinessType(store);
    const labels    = businessLabels(btype);
    // 🚚 استخدم fee المحسوب من showOrderSummary (deliveryZones) — يضمن نفس السعر
    const fee       = labels.feeLabel
      ? (session.resolvedDeliveryFee != null ? Number(session.resolvedDeliveryFee) : (Number(store?.deliveryFee) || Number(deliveryFee) || 0))
      : 0;
    const rawSubtotal = (session.cart || []).reduce((s, i) => s + i.price * i.qty, 0);
    const discount  = session.appliedDiscount || 0;
    const subtotal  = Math.max(0, rawSubtotal - discount);
    // 🎯 استخدم orderId المولّد في showOrderSummary لضمان تطابق الأرقام
    const orderId   = session.pendingOrderId || `ORD-${Date.now().toString().slice(-7)}`;

    // خصم المخزون تلقائياً (يتجاهل المنتجات ذات stock=null)
    decrementStock(storeId, session.cart || []);

    sessionManager.update(from, { step: "DONE", orderId });

    // إذا العميل شارك موقعه، نُولّد رابط Google Maps الجاهز لصفحة الأدمن
    const mapsUrl = (session.customerLocationLat && session.customerLocationLng)
      ? `https://maps.google.com/?q=${session.customerLocationLat},${session.customerLocationLng}`
      : null;

    logOrder({
      orderId,
      storeId:          storeId || "unknown",
      storeName:        store?.storeName || STORE_NAME,
      invoiceColor:     store?.invoiceColor || null,
      invoiceLogoUrl:   store?.invoiceLogoUrl || null,
      customerName:     session.customerName,
      customerLocation: session.customerLocation,
      // الحقول الجغرافية الإضافية لصفحة الأدمن (تسهّل التوصيل)
      customerLocationName: session.customerLocationName || null,
      customerLocationLat:  session.customerLocationLat || null,
      customerLocationLng:  session.customerLocationLng || null,
      customerLocationMapsUrl: mapsUrl,
      customerPhone:    phoneNum(from),
      items:            session.cart,
      subtotal, deliveryFee: fee, total: session.grandTotal, currency,
      // 🚚 اسم منطقة التوصيل (لعرضها في الفاتورة + صفحة الأدمن)
      deliveryZone:     session.resolvedDeliveryZone || null,
      coupon:           session.appliedCoupon || null,
      discount,
      scheduledTime:    session.scheduledTime || null,
      // 🤖 إجابات الأسئلة المخصصة (لو وُجدت) — تظهر في صفحة الطلبات بالأدمن
      customAnswers:    session.customAnswers && Object.keys(session.customAnswers).length ? session.customAnswers : null,
      notes:            session.orderNotes || null,
      date:   new Date().toISOString().slice(0, 10),
      status: "pending_confirmation",
    });

    // Mark coupon as used
    if (session.appliedCoupon) {
      try { useCoupon(session.appliedCoupon, from); }
      catch (e) { console.warn("[coupon-use] failed:", e.message); }
    }

    // ملاحظة: upsertCustomer + addPoints تأجلت لمرحلة "confirm" (بعد قبول المالك)
    // لتجنب: (1) منح نقاط لطلب قد يُرفض  (2) عدّ طلبات مرفوضة في إحصائيات العميل
    const storeName = store?.storeName || STORE_NAME;

    // معاينة النقاط التي سيكسبها عند قبول الطلب (لتحفيز فقط، بدون حفظ)
    const { calcPoints } = require("./loyalty");
    const previewPoints = calcPoints(session.grandTotal, store);

    // ⏱ ETA ذكي: حسب settings أو متوسط timing من الطلبات السابقة
    let etaText = "";
    try {
      if (store?.avgDeliveryMin) {
        etaText = `⏱ المدة المتوقعة: *${store.avgDeliveryMin} دقيقة*\n`;
      } else {
        const btype = getBusinessType(store);
        const baseEta = btype === "pickup" ? 20 : btype === "homeService" ? 60 : 35;
        // اقرأ متوسط ووقت معالجة آخر 20 طلب مكتمل
        const ordersFile = storeId === "nakheel_001"
          ? path.join(DATA_DIR, "orders.jsonl")
          : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
        if (fs.existsSync(ordersFile)) {
          const recent = fs.readFileSync(ordersFile, "utf8").split("\n").filter(Boolean)
            .slice(-200).map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(o => o && (o.status === "completed" || o.status === "delivered") && o.timestamp && o.deliveredAt);
          if (recent.length >= 3) {
            const avg = recent.slice(-10).reduce((s, o) =>
              s + (new Date(o.deliveredAt) - new Date(o.timestamp)) / 60_000, 0) / Math.min(recent.length, 10);
            if (avg >= 5 && avg <= 180) {
              const low = Math.max(10, Math.round(avg * 0.8 / 5) * 5);
              const high = Math.round(avg * 1.2 / 5) * 5;
              etaText = `⏱ المدة المتوقعة: *${low}-${high} دقيقة*\n`;
            }
          }
        }
        if (!etaText) etaText = `⏱ المدة المتوقعة: *${baseEta-10}-${baseEta+10} دقيقة*\n`;
      }
    } catch {}

    // 🚀 تسريع: رسالة العميل + رسالة المالك بالتوازي (Promise.all)
    // — رسائل مختلفة لمستلمين مختلفين، لا حاجة للترتيب
    const _customerAck = sendText(from,
      `رقم الطلب: ${orderId}\n` +
      `📋 الحالة: قيد المراجعة ⌛\n\n` +
      `💚 شكرًا لاختيارك ${storeName}.`
    ).catch(e => console.warn("[customer-ack] failed:", e.message));

    // Owner WhatsApp notification — يتضمن رابط Google Maps مباشر للتوصيل
    const ownerPhone = store?.ownerPhone;
    if (ownerPhone && storeId) {
      const orderLines = (session.cart || []).map(i => `• ${i.name} ×${i.qty}`).join("\n");
      // ننظف اسم العنوان من أي رابط legacy
      const locationName = (session.customerLocationName || session.customerLocation || "")
        .replace(/\s*\(📍\s*https?:\/\/[^)]+\)/g, "").trim();
      // رابط Maps من الإحداثيات لو متوفر
      const ownerMapsUrl = (session.customerLocationLat && session.customerLocationLng)
        ? `https://maps.google.com/?q=${session.customerLocationLat},${session.customerLocationLng}`
        : null;
      const locationBlock = locationName
        ? (ownerMapsUrl
            ? `📍 العنوان: *${locationName}*\n🗺️ خرائط: ${ownerMapsUrl}\n`
            : `📍 العنوان: ${locationName}\n`)
        : "";
      // 🚚 المنطقة + رسوم التوصيل (لو المتجر عرّف deliveryZones)
      const zoneBlock = session.resolvedDeliveryZone
        ? `🚚 المنطقة: *${session.resolvedDeliveryZone}* — رسوم: ${fee.toFixed(2)} ${currency}\n`
        : "";

      // 🚨 Fraud check للعميل
      const fraudInfo = _detectFraud(storeId, phoneNum(from));
      const fraudWarning = fraudInfo.suspicious
        ? `\n⚠️ *تنبيه:* هذا العميل ألغى/رُفض له ${fraudInfo.cancellations}/${fraudInfo.total} طلب آخر 30 يوم — راجع بحذر\n`
        : "";

      const ownerMsg =
        `🔔 *طلب جديد — ${storeName}*\n\n` +
        `رقم الطلب: *${orderId}*\n` +
        `_للقبول السريع: اكتب_ *قبول*\n` +
        `_للرفض: اكتب_ *رفض ${orderId.replace("ORD-", "")} السبب*\n` +
        fraudWarning +
        `العميل: *${session.customerName}*\n` +
        `الهاتف: ${phoneNum(from)}\n` +
        locationBlock +
        zoneBlock +
        (session.scheduledTime ? `⏰ ${labels.timeLabel}: *${session.scheduledTime}*\n` : "") +
        `\n${orderLines}\n\n` +
        `──────────\n` +
        `💰 الإجمالي: *${session.grandTotal?.toFixed(2)} ${currency}*` +
        (discount > 0 ? ` (خصم ${discount.toFixed(2)})` : "");

      // Register in order scheduler if timed
      if (session.scheduledTime && store?.ownerPhone) {
        addScheduledOrder({
          orderId,
          storeId,
          ownerPhone:    store.ownerPhone,
          scheduledStr:  session.scheduledTime,
          customerName:  session.customerName,
          total:         session.grandTotal,
          currency,
        });
      }
      const ownerJid = ownerPhone.replace(/\D/g, "") + "@s.whatsapp.net";
      // ✅ يُرسل بالتوازي مع رسالة العميل (لا await هنا — تنتظر معاً في النهاية)
      // allowCold=true لأن إشعار طلب جديد للمالك حتمي (لا يخضع لـ cold messaging)
      waMgr.sendMessage(storeId, ownerJid, ownerMsg, { allowCold: true, reason: "order_notification" })
        .catch(e => console.warn("[owner-notify] failed:", e.message));
    }
    // انتظر رسالة العميل تنتهي (المالك تكمل في الخلفية)
    await _customerAck;

    // 📌 الفاتورة لا تُرسَل هنا — تُرسَل عند قبول المالك (store-router) كـ caption لصورة الفاتورة
    require("./orders").updateOrderStatus(storeId, orderId, "pending_confirmation").catch(e => console.warn("[update-status]", e.message));

    // 🚫 لا nجدول طلب تقييم هنا — التقييم يُرسَل **مرة واحدة فقط** عند التسليم (owner-cmd)
    // نظّف أي timer قديم لهذا المتجر فقط (isolation)
    const _prNewOrder = _prget(storeId, from);
    if (_prNewOrder) {
      const prevRating = _prNewOrder.value;
      if (prevRating?.timer) clearTimeout(prevRating.timer);
      if (prevRating?.reminderTimer) clearTimeout(prevRating.reminderTimer);
      if (prevRating?.commentTimer) clearTimeout(prevRating.commentTimer);
      pendingRatings.delete(_prNewOrder.key);
    }
    // الصمت بعد الطلب — حتى التسليم/الرفض من الأدمن
    return;
  }

  if (msg === "CONFIRM_NO") {
    sessionManager.set(from, { step: "POST_ORDER", cart: [] });
    const _s = storeCtx.getStore()?.store || null;
    return sendText(from, botMsg.msg(_s, "order.canceled"));
  }

  // AI/Numeric: نص حر للتذكير
  if (session.path === "ai" || session.path === "numeric") {
    return sendText(from,
      (session.pendingInvoice || "🧾 طلبك بانتظار التأكيد") +
      `\n\n━━━━━━━━━━\n` +
      `اكتب *"تأكيد"* لإتمام الطلب ✅\n` +
      `أو *"تعديل"* لتعديل الطلب ✏️\n` +
      `أو *"إلغاء"* لإلغاء الطلب ❌`
    );
  }
  return sendButtons(from, {
    body:    session.pendingInvoice || "🧾 طلبك بانتظار التأكيد",
    buttons: [
      { id: "CONFIRM_YES", title: "✅ تأكيد الطلب" },
      { id: "BACK_CART",   title: "✏️ تعديل الطلب" },
      { id: "CONFIRM_NO",  title: "❌ إلغاء نهائي" },
    ],
  });
}

async function handlePostOrder(from) {
  // 🤫 Phase 6: البوت يصمت بعد استلام الطلب حتى التسليم + التقييم
  // التاجر يكلم العميل في واتساب مباشرة. أوامر الادمن تكمل الـ flow.
  sessionManager.update(from, { step: "DONE", _doneAt: Date.now() });
  return; // صمت تام — لا ترحيب، لا رد على رسائل العميل
}

// ─── Phase 5: AI Free-text Order ─────────────────────────────────────────
// كشف "يبدو كطلب": أي نص طويل > 6 أحرف يحوي حرف عربي/لاتيني وليس greeting بحت
const _GREETING_RX = /^(مرحبا|السلام|اهلا|أهلا|hi|hello|hey|صباح|مساء|^\?+$)$/i;
function _looksLikeOrder(text, products) {
  const norm = aiParser.normalizeAr(String(text || "")).trim();
  if (norm.length < 6 || norm.length > 500) return false;
  if (_GREETING_RX.test(norm)) return false;
  // كلمات تدل على طلب
  const orderHints = /(ابغي|ابغى|اريد|اطلب|عاوز|عايز|بدي|محتاج|ودي|اعطني|ابي|please|order|دلوقتي|اعمل|ممكن)/i;
  // اسم منتج موجود؟
  const productNames = (products || []).slice(0, 50).map(p => aiParser.normalizeAr(p.name || "")).filter(n => n.length >= 3);
  const hasProduct = productNames.some(n => norm.includes(n));
  if (hasProduct) return true;
  // كلمة طلبية + رقم/سؤال طويل → ربما طلب → جرّب الـ AI
  if (orderHints.test(norm) && norm.length > 10) return true;
  return false;
}

// يحاول تحليل الطلب وبناء session جاهز للـ checkout
async function _tryFreeTextOrder(from, text, session, store) {
  const { parseFreeTextOrder } = require("./ai-order-parser");
  const result = await parseFreeTextOrder(text, store);

  if (!result.items?.length) {
    // 🍽️ لو لم يجد منتجاً مطابقاً → اعتذار + صورة المنيو الكاملة
    const reasonsLine = result.unclear?.length
      ? result.unclear.slice(0, 3).map(u => `«${u.item}»`).join("، ")
      : "ما طلبت";
    const apology =
      `🙏 *عذراً، ${reasonsLine} غير متوفر في منيونا حالياً.*\n\n` +
      `هذه قائمتنا الكاملة 👇\n_اكتب اسم المنتج كما يظهر، أو افتح رابط الطلب التفاعلي._`;
    // أرسل صورة المنيو إن أمكن
    try {
      const sid = store.storeId || store.id;
      const PUBLIC_URL = process.env.PUBLIC_URL || "";
      const menuImgUrl = PUBLIC_URL ? `${PUBLIC_URL.replace(/\/$/, "")}/menu-image/${sid}` : null;
      if (menuImgUrl) {
        await waMgr.sendImage(sid, from, menuImgUrl, apology);
      } else {
        const productList = store.products.slice(0, 30)
          .map(p => `• ${p.name}${p.price > 0 ? ` — ${p.price} ر.س` : ""}`)
          .join("\n");
        await sendText(from, apology + "\n\n" + productList);
      }
    } catch (e) {
      console.warn("[free-text] menu image failed:", e.message);
      const productList = store.products.slice(0, 30).map(p => `• ${p.name}${p.price > 0 ? ` — ${p.price} ر.س` : ""}`).join("\n");
      await sendText(from, apology + "\n\n" + productList);
    }
    return true; // handled
  }

  // 🛒 بناء cart من الـ items
  const cart = [];
  for (const it of result.items) {
    const prod = store.products.find(p => String(p.id) === String(it.productId));
    if (!prod) continue;
    const isNeg = !!prod.priceOnRequest;
    let unitPrice = Number(prod.price || 0);
    const modsArr = Array.isArray(prod.modifiers) ? prod.modifiers : (Array.isArray(prod.options) ? prod.options : []);
    // sizes
    let nameExtra = "";
    if (Array.isArray(prod.sizes) && prod.sizes[it.sizeIdx]) {
      if (prod.sizes[it.sizeIdx].price > 0) unitPrice = Number(prod.sizes[it.sizeIdx].price);
      nameExtra = " — " + prod.sizes[it.sizeIdx].name;
    }
    // options (add to price)
    let extrasSum = 0;
    const extraNames = [];
    for (const oi of (it.options || [])) {
      const m = modsArr[oi]; if (!m) continue;
      extrasSum += Number(m.price || 0);
      extraNames.push(m.name || m.label);
    }
    const exclTxt = (it.excluded?.length) ? ` (بدون ${it.excluded.join("، ")})` : "";
    cart.push({
      id:    prod.id,
      name:  prod.name + nameExtra + (extraNames.length ? " + " + extraNames.join("، ") : "") + exclTxt,
      price: isNeg ? 0 : (unitPrice + extrasSum),
      qty:   it.qty,
      imageUrl: prod.imageUrl || null,
      priceOnRequest: isNeg,
      excluded: it.excluded?.length ? it.excluded : undefined,
    });
  }

  if (!cart.length) return false;

  // أرسل ملخصاً للعميل
  const subtotal = cart.reduce((s, i) => s + (i.priceOnRequest ? 0 : i.price * i.qty), 0);
  const linesArr = cart.map(i => `• ${i.name} × ${i.qty}` + (i.priceOnRequest ? "" : ` — ${(i.price * i.qty).toFixed(2)} ر.س`));
  const unclearTxt = result.unclear?.length
    ? `\n\n⚠️ لم أفهم: ${result.unclear.map(u => u.item).slice(0,3).join("، ")}`
    : "";
  // 📝 ملاحظات AI (مثل "زيادة جبنة، شيلي طماطم" غير متوفرة في الإعدادات)
  // تُحفظ كـ orderNotes — تظهر في الفاتورة وإشعار الأدمن
  if (result.notes) {
    const existingNotes = (session.orderNotes || "").trim();
    const combinedNotes = existingNotes
      ? `${existingNotes}\n📝 ${result.notes}`
      : `📝 ${result.notes}`;
    sessionManager.update(from, { orderNotes: combinedNotes, aiNotes: result.notes });
  }

  // احفظ في session — يدخل في flow الـ checkout العادي
  const storeData = getStoreById(store.storeId || store.id);
  const isBookingMode = storeData?.adminConfig?.orderMode === "booking";
  const labels = businessLabels(getBusinessType(storeData));

  sessionManager.set(from, {
    cart,
    path: "free_text",
    customerName: "عميل",
    grandTotal: subtotal + (Number(store.deliveryFee) || 0),
    step: labels.needsLocation ? "COLLECT_LOCATION" : (shouldAskDeliveryTime(storeData) ? "SCHEDULE_ORDER" : "CONFIRM_ORDER"),
  });

  const notesTxt = result.notes ? `\n\n📝 *ملاحظات:* ${result.notes}` : "";
  let nextMsg = `✅ *فهمت طلبك:*\n\n${linesArr.join("\n")}\n\n💰 الإجمالي: *${subtotal.toFixed(2)} ر.س*${notesTxt}${unclearTxt}`;
  if (labels.needsLocation) {
    nextMsg += `\n\n📍 *أرسل موقعك* (أو اكتب العنوان)`;
  } else if (shouldAskDeliveryTime(storeData)) {
    nextMsg += `\n\n🕐 *متى تريد ${labels.timeLabel}؟*`;
  } else {
    nextMsg += `\n\nاكتب *تأكيد* لإتمام الطلب أو *تعديل* للتغيير.`;
  }
  await sendText(from, nextMsg);
  return true;
}

// ─── Rating Submit (مع نقاط ولاء + service recovery + 5★ follow-up) ─────────
// storeId (optional) — يمرّر من intercept ليضمن العزل بين متاجر
async function handleRatingSubmit(from, ratingText, storeIdCtx) {
  // 🎯 isolation: نبحث بمفتاح مركّب لو معنا storeIdCtx (يمنع تسرّب لمتجر آخر)
  const _hit = storeIdCtx ? _prget(storeIdCtx, from) : _prfind(from);
  if (!_hit) return;
  const { key: prKey, value: pending } = _hit;
  clearTimeout(pending.timer);
  if (pending.reminderTimer) clearTimeout(pending.reminderTimer);
  const rating = parseInt(ratingText);

  pending.rating = rating;
  pending.awaitingComment = true;
  pendingRatings.set(prKey, pending);

  const stars = ["","⭐","⭐⭐","⭐⭐⭐","⭐⭐⭐⭐","⭐⭐⭐⭐⭐"][rating] || "⭐⭐⭐";
  try {
    await waMgr.sendMessage(pending.storeId, from,
      `${stars} *شكراً على تقييمك!*\n\n` +
      `💬 لو حابب تشاركنا تعليقاً (سيء/إيجابي)، اكتبه الآن.\n` +
      `أو اكتب *تخطي* لإنهاء التقييم.`
    );
  } catch (e) { console.error(`[rating-ask-comment] failed:`, e.message); }

  // 🛡️ closure-safe: احفظ storeId في متغير محلي (لا تشير لـ pending الذي قد يتحدث)
  const savedStoreId = pending.storeId;
  pending.commentTimer = setTimeout(() => {
    const p = pendingRatings.get(prKey);
    if (p && p.awaitingComment) _finalizeRating(from, "", savedStoreId);
  }, 3 * 60 * 1000);
  pending.commentTimer.unref?.();
  pendingRatings.set(prKey, pending);
}

// يلتقط تعليق ما بعد التقييم
async function _finalizeRating(from, comment, storeIdCtx) {
  const _hit = storeIdCtx ? _prget(storeIdCtx, from) : _prfind(from);
  if (!_hit) return;
  const { key: prKey, value: pending } = _hit;
  if (pending.commentTimer) clearTimeout(pending.commentTimer);
  pendingRatings.delete(prKey);

  const rating = pending.rating;
  const ratingsMod = require("./ratings");
  try {
    ratingsMod.saveRating({ storeId: pending.storeId, phone: from, orderId: pending.orderId, rating, comment, source: "bot", lang: "ar" });
  } catch (e) { console.warn("[save-rating] failed:", e.message); }

  // 🎁 مكافأة 5 نقاط ولاء على المشاركة في التقييم
  let loyaltyBonus = 0;
  try {
    const { addPoints } = require("./loyalty");
    const store = pending.store || null;
    const result = addPoints(pending.storeId, from, 0, pending.orderId + "-rating", store, 5);
    if (result && result.newPoints > 0) loyaltyBonus = result.newPoints;
  } catch (e) { console.warn("[rating-bonus] failed:", e.message); }

  const stars = ["","⭐","⭐⭐","⭐⭐⭐","⭐⭐⭐⭐","⭐⭐⭐⭐⭐"][rating] || "⭐⭐⭐";
  const bonusLine = loyaltyBonus > 0 ? `\n\n🎁 +${loyaltyBonus} نقاط ولاء كمكافأة!` : "";
  const commentLine = comment ? `\n📝 تعليقك: _"${comment.slice(0,200)}"_\n` : "";

  try {
    await waMgr.sendMessage(pending.storeId, from,
      `${stars} *تم تسجيل تقييمك* 🌸\n${commentLine}\nنسعد دائماً بخدمتك في *${pending.storeName}* 💚${bonusLine}`
    );
  } catch (e) { console.error(`[rating-reply] failed:`, e.message); }

  // أبلغ المالك بالتعليق (إن وُجد) لإعطائه فرصة الرد
  if (comment) {
    try {
      const store = pending.store;
      if (store?.ownerPhone) {
        await waMgr.sendMessage(pending.storeId, String(store.ownerPhone).replace(/[^\d]/g, "") + "@s.whatsapp.net",
          `💬 *تعليق عميل على طلب*\n\n` +
          `الطلب: *${pending.orderId}*\n` +
          `التقييم: ${stars} (${rating}/5)\n` +
          `العميل: ${from.split("@")[0]}\n\n` +
          `التعليق:\n_"${comment.slice(0,400)}"_`,
          { allowCold: true, reason: "order_notification" });
      }
    } catch (e) { console.warn("[notify-owner-comment] failed:", e.message); }
  }

  // 🔴 Service recovery للسلبي (1-2 نجمة)
  if (rating <= 2) {
    try {
      const coupons = require("./coupons");
      const couponCode = "RECOVERY-" + Math.random().toString(36).slice(2, 7).toUpperCase();
      try {
        coupons.createCoupon({
          code: couponCode,
          storeId: pending.storeId,
          discountType: "percent",
          discountValue: 20,
          maxUses: 1,
          expiresAt: new Date(Date.now() + 14 * 86400_000).toISOString(),
          phoneRestriction: from.replace(/[^\d]/g, ""),
        });
      } catch (ce) { console.warn("[recovery-coupon] save failed:", ce.message); }
      await new Promise(r => setTimeout(r, 1500));
      // 💔 رسالة الاعتذار — مخصصة من المتجر لو معرّفة، وإلا الافتراضية
      const customApology = String(pending.store?.apologyMessage || "").trim();
      const apologyMsg = customApology
        ? customApology
            .replace(/\{\{store_name\}\}/g, pending.storeName)
            .replace(/\{\{coupon\}\}/g, couponCode)
            .replace(/\{\{stars\}\}/g, stars)
        : ratingsMod.serviceRecoveryMessage(pending.storeName, couponCode);
      await waMgr.sendMessage(pending.storeId, from, apologyMsg);
      // أبلغ المالك بتقييم سلبي
      const store = pending.store;
      if (store?.ownerPhone) {
        try {
          await waMgr.sendMessage(pending.storeId, store.ownerPhone.replace(/[^\d]/g,"") + "@s.whatsapp.net",
            `⚠️ *تقييم سلبي عاجل!*\n\nالطلب: *${pending.orderId}*\nالعميل: ${from.split("@")[0]}\nالتقييم: ${rating}/5\n\nتم إرسال كوبون اعتذار تلقائي (${couponCode}). تواصل مع العميل لاستعادة ثقته.`,
            { allowCold: true, reason: "order_notification" });
        } catch {}
      }
    } catch (e) { console.warn("[service-recovery] failed:", e.message); }
  }
  // 🌟 Thank-you message للتقييم المرتفع (4-5 نجوم) — قابل للتخصيص من الأدمن
  else if (rating >= 4) {
    try {
      await new Promise(r => setTimeout(r, 2000));
      const store = pending.store;
      const custom = String(store?.thankYouMessage || "").trim();
      const message = custom
        ? custom.replace(/\{\{store_name\}\}/g, pending.storeName).replace(/\{\{stars\}\}/g, stars)
        : ratingsMod.fiveStarFollowUp(pending.storeName);
      await waMgr.sendMessage(pending.storeId, from, message);
    } catch (e) { console.warn("[thank-you] failed:", e.message); }
  }
}

// ─── Helper: هل الطلب لا يزال في حالة "مكتمل"؟ (للحماية من تقييم طلب ملغي) ──
function _isOrderCompleted(storeId, orderId) {
  if (!storeId || !orderId) return false;
  try {
    const ordersFile = storeId === "nakheel_001"
      ? path.join(DATA_DIR, "orders.jsonl")
      : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
    if (!fs.existsSync(ordersFile)) return false;
    const lines = fs.readFileSync(ordersFile, "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        if (o.orderId === orderId) return o.status === "completed";
      } catch {}
    }
  } catch {}
  return false;
}

// ─── Rating Reminder (24h لاحقاً لو لم يقيم) ───────────────────────────────
function scheduleRatingReminder(from, storeId, storeName, orderId) {
  // نخزن في pendingRatings مع flag reminder للتمييز
  const reminderKey = _prkey(storeId, from);
  const reminderTimer = setTimeout(async () => {
    if (!pendingRatings.has(reminderKey)) return; // قَيّم بالفعل
    // ⚠️ defense: لا تذكير لطلب ملغي/مرفوض
    if (!_isOrderCompleted(storeId, orderId)) {
      console.log(`[rating-reminder] skipped — order ${orderId} not completed`);
      pendingRatings.delete(reminderKey);
      return;
    }
    try {
      const ratingsMod = require("./ratings");
      await waMgr.sendMessage(storeId, from, ratingsMod.reminderMessage(storeName));
    } catch (e) { console.warn("[rating-reminder] failed:", e.message); }
  }, 24 * 60 * 60 * 1000);
  reminderTimer.unref?.();
  return reminderTimer;
}

// ─── Edit Location for an active order ────────────────────────────────────────
// العميل يكتب "تعديل الموقع" → ندخله في حالة EDIT_LOCATION، نسأله موقع جديد،
// عند الاستلام نحدّث الـ order ونرسل تأكيد للمالك والعميل.
const ACTIVE_STATUSES_FOR_EDIT = ["pending_confirmation", "confirmed", "preparing", "ready_pickup"];

async function handleEditLocationRequest(from, explicitOrderId) {
  const { store, storeId } = storeCtx.getStore() || {};
  const orders = readOrders(storeId, 200);
  const phone = phoneNum(from);
  // اعثر على الطلب: إما برقم معطى أو آخر طلب نشط
  let order = null;
  if (explicitOrderId) {
    const suffix = String(explicitOrderId).replace(/\D/g, "");
    order = orders.find(o => o.orderId && o.orderId.endsWith(suffix) && phoneNum(o.customerPhone) === phone);
  } else {
    const mine = orders
      .filter(o => phoneNum(o.customerPhone) === phone && ACTIVE_STATUSES_FOR_EDIT.includes(o.status) && !o._test)
      .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
    order = mine[0] || null;
  }
  if (!order) {
    return sendText(from, botMsg.msg(store, "location.no_active"));
  }
  sessionManager.update(from, { step: "EDIT_LOCATION", editingLocationOrderId: order.orderId });
  return sendText(from,
    `📍 *تعديل موقع الطلب ${order.orderId}*\n\n` +
    `أرسل الآن:\n` +
    `🗺️ موقعك من زر المرفقات في واتساب (الأدق)\n` +
    `أو اكتب عنواناً نصياً واضحاً.\n\n` +
    `للإلغاء اكتب *الغاء*`
  );
}

async function handleEditLocationResponse(from, msg, session) {
  const { store, storeId } = storeCtx.getStore() || {};
  const text = String(msg || "").trim();
  if (/^(الغاء|إلغاء|cancel|رجوع|back)$/i.test(text)) {
    sessionManager.update(from, { step: undefined, editingLocationOrderId: undefined });
    return sendText(from, botMsg.msg(store, "location.edit_canceled"));
  }
  const orderId = session.editingLocationOrderId;
  if (!orderId) {
    sessionManager.update(from, { step: undefined });
    return; // فقد السياق
  }
  // استقبل موقع مشترك أو نص
  let newLocName = "", newMapsUrl = "", newLat = null, newLng = null;
  if (text.startsWith("📍|")) {
    const resolved = await resolveSharedLocation(text);
    if (!resolved) return sendText(from, botMsg.msg(store, "location.invalid"));
    newLocName = resolved.name;
    newMapsUrl = `https://maps.google.com/?q=${resolved.lat},${resolved.lng}`;
    newLat = resolved.lat; newLng = resolved.lng;
  } else if (text.length >= 5) {
    newLocName = text.slice(0, 200);
  } else {
    return sendText(from, botMsg.msg(store, "location.required"));
  }
  // حدّث الـ order في الـ JSONL — atomic
  const ordersFile = storeId === "nakheel_001" ? path.join(DATA_DIR, "orders.jsonl") : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
  await require("./atomic-fs").updateJsonlLocked(ordersFile, (lines) => {
    const updated = lines.map(l => {
      try {
        const o = JSON.parse(l);
        if (o.orderId === orderId) {
          o.customerLocation         = newMapsUrl ? `${newLocName} (📍 ${newMapsUrl})` : newLocName;
          o.customerLocationName     = newLocName;
          o.customerLocationMapsUrl  = newMapsUrl || null;
          o.customerLocationLat      = newLat;
          o.customerLocationLng      = newLng;
          o.locationEditedAt         = new Date().toISOString();
        }
        return JSON.stringify(o);
      } catch { return l; }
    });
    return { lines: updated };
  });
  // أبلغ المالك
  try {
    const ownerJid = String(store?.ownerPhone || "").replace(/\D/g, "") + "@s.whatsapp.net";
    if (store?.ownerPhone) {
      await waMgr.sendMessage(storeId, ownerJid,
        `📍 *تحديث موقع طلب ${orderId}*\n\n` +
        `العميل ${session.customerName || ""} عدّل موقع التوصيل:\n\n` +
        `${newLocName}\n${newMapsUrl ? newMapsUrl : ""}`,
        { allowCold: true, reason: "order_notification" });
    }
  } catch {}
  sessionManager.update(from, { step: undefined, editingLocationOrderId: undefined });
  return sendText(from,
    `✅ *تم تحديث موقع الطلب ${orderId}*\n\n` +
    `📍 ${newLocName}\n${newMapsUrl ? `🗺️ ${newMapsUrl}\n` : ""}\n` +
    `أُبلغ المتجر بالتعديل ✨`
  );
}

// ─── Order Tracking ───────────────────────────────────────────────────────────
async function handleOrderTracking(from, orderId) {
  const { storeId } = storeCtx.getStore() || {};
  const orders = readOrders(storeId, 200);
  const phone = phoneNum(from);
  // 🧠 إذا لم يُرسل orderId، احصل على آخر طلب نشط لهذا العميل تلقائياً
  let order;
  if (orderId) {
    order = orders.find(o => o.orderId === orderId && phoneNum(o.customerPhone) === phone);
  } else {
    const customerOrders = orders
      .filter(o => phoneNum(o.customerPhone) === phone && !o._test)
      .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
    if (!customerOrders.length) {
      return sendText(from,
        `📦 *تتبع الطلب*\n\nلا توجد طلبات سابقة لرقمك حالياً.\nاكتب *قائمة* لتصفّح المنيو وعمل طلب جديد 🌸`
      );
    }
    // الطلبات النشطة أولاً، وإلا آخر طلب
    const active = ["pending_confirmation", "confirmed", "preparing", "out_for_delivery", "ready_pickup", "in_progress", "awaiting_review"];
    order = customerOrders.find(o => active.includes(o.status)) || customerOrders[0];
  }
  if (!order) {
    return sendText(from,
      `❌ لم يُعثر على هذا الطلب\n\nاكتب فقط: *تتبع*\nسأعرض لك آخر طلب لك تلقائياً.`
    );
  }
  const statusMap = {
    pending_confirmation: "⏳ بانتظار التأكيد",
    confirmed:            "✅ تم التأكيد — جاري التحضير",
    preparing:            "🔄 قيد التنفيذ",
    ready_pickup:         "📦 جاهز للاستلام",
    out_for_delivery:     "🚴 في الطريق إليك",
    in_progress:          "⚙️ قيد العمل",
    awaiting_review:      "📋 للمراجعة",
    delivered:            "🎉 تم التوصيل",
    completed:            "✅ مكتمل",
    cancelled:            "❌ ملغي",
    rejected:             "❌ مرفوض",
  };
  const statusLabel = statusMap[order.status] || order.status;
  const lines = (order.items || []).map(i => `• ${i.name} ×${i.qty}`).join("\n");
  const etaLine = order.estimatedMinutes
    ? `⏱️ الوقت المتوقع: *${order.estimatedMinutes} دقيقة* تقريباً\n`
    : "";
  return sendText(from,
    `📦 *تفاصيل طلبك*\n\n` +
    `رقم الطلب: *${order.orderId}*\n` +
    `الحالة: *${statusLabel}*\n` +
    etaLine +
    `التاريخ: ${order.date || ""}\n\n` +
    `المنتجات:\n${lines}\n\n` +
    `💰 الإجمالي: *${(order.total || 0).toFixed(2)} ${order.currency || "ر.س"}*`
  );
}

// ─── Utilities (truncate/phoneNum moved to ./utils/server-helpers.js) ───────

// قائمة رموز دول حقيقية (E.164) — تكفي لأسواقنا المستهدفة
const _COUNTRY_CODES = ["966","971","973","974","965","968","962","964","963","961","970","20","212","213","216","218","249","252","253","967"];

function _stripCountryCode(digits) {
  for (const cc of _COUNTRY_CODES) {
    if (digits.startsWith(cc) && digits.length - cc.length >= 7) return digits.slice(cc.length);
  }
  return digits;
}

// Compare phone numbers strictly: نطابق إما كاملاً أو بعد نزع رمز دولة معروف من أحد الطرفين.
// لا نطابق "آخر 9 خانات" بشكل أعمى — هذا يسبب false positives بين دول مختلفة.
function isSamePhone(phone1, phone2) {
  if (!phone1 || !phone2) return false;
  const p1 = String(phone1).replace(/\D/g, "");
  const p2 = String(phone2).replace(/\D/g, "");
  if (!p1 || !p2) return false;
  if (p1 === p2) return true;
  const n1 = _stripCountryCode(p1);
  const n2 = _stripCountryCode(p2);
  // طابق فقط بعد نزع رمز دولة معروف من الطرفين (يمنع 555-XXX سعودي = 555-XXX مصري)
  return n1 === n2 && n1.length >= 7;
}

// ─── Cross-bot Owner Command Routing ──────────────────────────────────────────
// عندما يكون bot المتجر متصلاً بنفس رقم المالك، Baileys يرمي الرسائل بـ fromMe=true.
// الحل: المالك يرسل "قبول/رفض/تم ORD-xxxxxxx" لأي بوت آخر (platform/lead/owner_try).
// نتعرف على رقم المرسل كمالك متجر، ونوجّه الأمر للمتجر الصحيح حسب orderId.
const OWNER_CMD_RE = /^(قبول|اكد|أكد|confirm|رفض|reject|بدأ|بدا|preparing|جاهز|ready|خرج|delivery|تم|completed|تسليم|إلغاء|الغاء|cancel|طلبات|orders|الطلبات|مساعدة|أوامر|اوامر|help|منتظرين|handoffs|استئناف|استانف|resume)\b/i;

async function tryCrossBotOwnerCommand(from, text) {
  if (!text || !OWNER_CMD_RE.test(String(text).trim())) return false;
  const senderPhone = phoneNum(from);
  if (!senderPhone) return false;
  const ownerStores = getAllStores().filter(s => s.ownerPhone && isSamePhone(senderPhone, s.ownerPhone));
  if (!ownerStores.length) return false;

  // إذا فيها orderId → استنتج المتجر منه؛ وإلا لو المالك يملك متجراً واحداً، استخدمه
  const idMatch = String(text).match(/ORD-?(\d{4,})/i);
  let targetStore = null;
  if (idMatch) {
    const orderSuffix = idMatch[1];
    for (const s of ownerStores) {
      const f = s.id === "nakheel_001"
        ? path.join(DATA_DIR, "orders.jsonl")
        : path.join(DATA_DIR, `orders_${s.id}.jsonl`);
      if (!fs.existsSync(f)) continue;
      const found = fs.readFileSync(f, "utf8").split("\n").some(l => {
        try { const o = JSON.parse(l); return o.orderId && o.orderId.endsWith(orderSuffix); }
        catch { return false; }
      });
      if (found) { targetStore = s; break; }
    }
  }
  if (!targetStore) {
    if (ownerStores.length === 1) {
      targetStore = ownerStores[0];
    } else {
      // متعدد المتاجر وبدون orderId واضح → اطلب توضيحاً
      await waMgr.sendMessage("platform", from,
        `🏪 *عندك ${ownerStores.length} متاجر*\n\nاكتب الأمر مع رقم الطلب: مثل *قبول ORD-1234567*\n\nمتاجرك:\n` +
        ownerStores.map((s, i) => `${i+1}. ${s.storeName}`).join("\n")
      );
      return true;
    }
  }

  // نفّذ الأمر في سياق المتجر الصحيح. الرد يعود عبر بوت platform (لأن المالك راسلنا عليه)
  const ownerJid = String(targetStore.ownerPhone).replace(/\D/g, "") + "@s.whatsapp.net";
  await storeCtx.run({ storeId: targetStore.id, store: targetStore, replyVia: { storeId: "platform", to: from } }, async () => {
    const handled = await handleOwnerCommand(ownerJid, String(text).trim(), targetStore, targetStore.id);
    if (!handled) {
      await waMgr.sendMessage("platform", from, `⚠️ لم أفهم الأمر. اكتب *مساعدة* لقائمة الأوامر`);
    }
  });
  return true;
}

// ─── Baileys Message Router ───────────────────────────────────────────────────
waMgr.setMessageHandler(async (storeId, from, text, rawMsg) => {
  if (isDuplicate(rawMsg?.key?.id)) return;

  // Platform bot — صامت: لا ترحيب ولا رد تلقائي، فقط:
  //   1) تنفيذ أوامر مالكي المتاجر (cross-bot owner commands)
  //   2) إعادة توجيه الرسائل لأبو حاتم ليرد يدوياً
  if (storeId === "platform") {
    if (await tryCrossBotOwnerCommand(from, text)) return;
    // forward لأبو حاتم — لا رد على المرسل
    try {
      if (PLATFORM_OWNER_PHONE && from !== PLATFORM_OWNER_PHONE && text && text.trim()) {
        const cleanFrom = String(from).replace(/@.*$/, "");
        await waMgr.sendMessage("platform", PLATFORM_OWNER_PHONE,
          `💬 *رسالة جديدة على بوت المنصة*\n\n📱 من: +${cleanFrom}\n✉️ ${String(text).slice(0, 500)}\n\n_رد عليه مباشرة من واتساب — البوت لن يتدخل._`
        );
      }
    } catch (e) { console.warn("[platform/forward]", e.message); }
    return;
  }
  // Lead bot — صامت بنفس الطريقة (forward فقط)
  if (storeId === "lead") {
    try {
      if (LEAD_OWNER_PHONE && from !== LEAD_OWNER_PHONE && text && text.trim()) {
        const cleanFrom = String(from).replace(/@.*$/, "");
        await waMgr.sendMessage("lead", LEAD_OWNER_PHONE,
          `💬 *رسالة جديدة على رقم الـ Lead*\n\n📱 من: +${cleanFrom}\n✉️ ${String(text).slice(0, 500)}\n\n_رد عليه مباشرة — البوت صامت._`
        );
      }
    } catch (e) { console.warn("[lead/forward]", e.message); }
    return;
  }
  // Try slots (try_1..try_5) + legacy owner_try
  //   - لو slot مربوط بقطاع → استخدم demo_<sector> store DATA
  //   - storeId يبقى try_X (للـ Baileys session) — وإلا sendMessage يفشل
  //   - الطلبات تُحفظ بـ try_X (نقرأها من /try/orders بنفس الـ slot)
  //   ⚠️ لو الـ slot غير مربوط بقطاع — لا fallback لمتجر حقيقي! نرسل
  //   رسالة "ابدأ ديمو جديد" ثم نفصل الجلسة لمنع تسرب البوت لرقم الزائر.
  if (storeId === "owner_try" || /^try_\d+$/.test(storeId)) {
    let demoStore = demoStores.getDemoStoreBySlot(storeId);
    if (!demoStore) {
      console.warn(`⚠️  [${storeId}] try slot غير مربوط بقطاع — إرسال رسالة انتهاء وفصل الجلسة`);
      try {
        await waMgr.sendMessage(storeId, from,
          `⏰ *انتهت جلسة التجربة*\n\nلتجربة جديدة، افتح:\nhttps://61465.github.io/thawanidemo/demo/`
        );
      } catch (e) { console.warn(`[${storeId}] send-end failed:`, e.message); }
      // افصل + امسح الـ creds — يمنع الاستخدام المستمر للرقم
      try { await waMgr.disconnectSession(storeId, { keepCreds: false }); }
      catch (e) { console.warn(`[${storeId}] disconnect failed:`, e.message); }
      return;
    }
    // ⚠️ override id محلياً ليبقى الـ ctx متسقاً (لا نغيّر storeId الفعلي للـ session)
    demoStore = { ...demoStore, id: storeId };
    await storeCtx.run({ storeId, store: demoStore }, async () => {
      await handleMessage(from, text);
    });
    return;
  }
  // Store bot
  const store = getStoreById(storeId);
  if (!store) {
    console.warn(`⚠️  No store config for session [${storeId}]`);
    return;
  }
  // 🔗 Share-link order detection: marker بسيط #طلب_من_المنيو
  //    البوت يستلم الطلب كأنه من webview → يتخطى الترحيب ويسأل العنوان
  if (text && /#طلب_من_المنيو/.test(text)) {
    await storeCtx.run({ storeId, store }, async () => {
      await _handleShareLinkOrder(from, text, store);
    });
    return;
  }
  await storeCtx.run({ storeId, store }, async () => {
    await handleMessage(from, text);
  });
});

// ─── Groq AI Poll Fallback ────────────────────────────────────────────────────
// عندما يفشل فك تشفير التصويت، Groq يحدد الخيار الأكثر احتمالاً بناءً على السياق
waMgr.setPollFallback(async (storeId, from, pollData) => {
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return null;

  const session   = sessionManager.get(from);
  const options   = pollData.options.map(o => o.optionName).filter(Boolean);
  const valueToId = pollData.valueToId;

  const cartSummary = session?.cart?.length
    ? session.cart.map(i => `${i.name}×${i.qty}`).join("، ")
    : "فارغة";
  const optionsList = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  const hasAddMore  = options.some(o => /إضافة|متابعة|صنف آخر/u.test(o));
  const prompt = [
    `أنت مساعد بوت طلبات واتساب. العميل صوّت في استطلاع ولم نتمكن من فك تشفيره.`,
    ``,
    `السياق:`,
    `- الخطوة: ${session?.step || "MAIN_MENU"}`,
    `- السلة: ${cartSummary}`,
    ``,
    `خيارات الاستطلاع:`,
    optionsList,
    ``,
    `قاعدة مهمة: إذا كانت الخيارات تتضمن "إضافة" أو "صنف آخر"${hasAddMore ? " (وهو موجود هنا)" : ""}، فلا تخمّن خيار "إتمام الطلب" ما لم يكن الخيار الوحيد المنطقي.`,
    `أجب بنص الخيار بالضبط كما هو مكتوب أعلاه فقط، لا تضف شيئاً.`,
  ].join("\n");

  try {
    const res  = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model:    "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 30,
      temperature: 0,
    }, { headers: { Authorization: `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" } });

    const answer = res.data.choices?.[0]?.message?.content?.trim();
    console.log(`🤖 [poll-ai] storeId=${storeId} from=${from} guess="${answer}"`);

    // طابق إجابة Groq مع الخيارات الموجودة (مرن)
    const matched = options.find(o => o === answer)
      || options.find(o => answer?.includes(o))
      || options.find(o => o.includes(answer || ""));
    if (matched) return valueToId[matched] || null;
  } catch (e) {
    console.warn(`[poll-ai] failed: ${e.message}`);
  }
  return null;
});

// ─── Pairing API (used by master panel) ──────────────────────────────────────
// Note: actual endpoints in master-router.js call waMgr directly

// ─── Native List Order Menu ────────────────────────────────────────────────────
async function sendTextOrderMenu(from) {
  const demo = demoCtx.getStore();
  const { store, storeId } = storeCtx.getStore() || {};
  if (!store) return;

  const products = (store.products || []).filter(isProductInStock);
  if (!products.length) return sendText(from, "❌ لا توجد منتجات متاحة حالياً.");

  const cats     = (store.categories || []).filter(cat => products.some(p => p.category === cat.id));
  const currency = store.currency || CURRENCY;
  const prodMap  = {};

  // بناء sections للـ native list
  const sections = [];
  if (cats.length > 0) {
    for (const cat of cats) {
      const catProds = products.filter(p => p.category === cat.id);
      if (!catProds.length) continue;
      sections.push({
        title: `${cat.emoji || "◆"} ${cat.name}`,
        rows:  catProds.map(p => {
          prodMap[String(p.id)] = p;
          return {
            id:          `PROD_${p.id}`,
            title:       p.name,
            description: `${_priceLabel(p, currency, { short: true })}${p.description ? " • " + p.description : ""}`,
          };
        }),
      });
    }
  } else {
    sections.push({
      title: `🛍️ ${store.storeName || "المنتجات"}`,
      rows:  products.map(p => {
        prodMap[String(p.id)] = p;
        return {
          id:          `PROD_${p.id}`,
          title:       p.name,
          description: `${_priceLabel(p, currency, { short: true })}${p.description ? " • " + p.description : ""}`,
        };
      }),
    });
  }

  if (demo) {
    const opts = sections.flatMap(s => s.rows).map(r => `• ${r.title} — ${r.description}`).join("\n");
    demo.buffer.push({ type: "text", body: `🛍️ قائمة ${store.storeName || "متجرنا"}:\n\n${opts}` });
    return;
  }

  sessionManager.update(from, { step: "ORDER_BROWSE", cart: [], orderProdMap: prodMap });

  // ── CTA: زر يفتح صفحة الطلب الكاملة داخل واتساب ──
  const orderToken = waMgr.createWebOrderToken(storeId, from);
  const orderUrl   = `${process.env.PUBLIC_URL}/${orderToken}`;
  const storeName  = store.storeName || "متجرنا";

  const logoUrl  = store.logoUrl
    ? (store.logoUrl.startsWith("http") ? store.logoUrl : `${(process.env.PUBLIC_URL||"").replace(/\/$/,"")}${store.logoUrl}`)
    : "";

  const ctaSent = await waMgr.sendCtaButton(storeId, from, {
    body:         `🛍️ *${storeName}*\n\nاضغط الزر لفتح قائمة المنتجات واختيار طلبك 👇`,
    buttonText:   "🛒 اطلب الآن",
    url:          orderUrl,
    footer:       `${storeName} • ${products.length} منتج متاح`,
    thumbnailUrl: logoUrl,
  });

  if (!ctaSent) {
    // fallback: نص بسيط مع الرابط
    await waMgr.sendMessage(storeId, from,
      `🛍️ *${storeName}*\n\n` +
      `اضغط لفتح قائمة الطلب:\n${orderUrl}\n\n` +
      `_⏰ الرابط صالح 15 دقيقة_`
    );
  }
}

async function handleOrderBrowse(from, msg, session) {
  const { store } = storeCtx.getStore() || {};
  const currency  = store?.currency || CURRENCY;
  const prodMap   = session.orderProdMap || {};
  const cart      = session.cart || [];
  const maxIdx    = Object.keys(prodMap).length;

  // تأكيد الطلب
  if (/^(تأكيد|confirm|تم|اكمل|أكمل|تمام|موافق|نعم|yes|ok)$/i.test(msg.trim())) {
    if (!cart.length) {
      return sendText(from, `❌ سلتك فارغة!\n\nأرسل رقم المنتج (1–${maxIdx}) لإضافته.`);
    }
    const total   = cart.reduce((s, i) => s + i.price * i.qty, 0);
    const summary = `✅ *تأكيد طلبك:*\n\n` +
      cart.map(i => `• ${i.name} × ${i.qty} — ${(i.price * i.qty).toFixed(2)} ${currency}`).join("\n") +
      `\n\n💰 *المجموع: ${total.toFixed(2)} ${currency}*`;
    sessionManager.update(from, { orderProdMap: undefined });
    await sendText(from, summary);
    return _moveToNextAfterCart();
  }

  // تعديل السلة / حذف عنصر
  if (msg.trim() === "CLEAR_CART") {
    sessionManager.update(from, { cart: [] });
    return sendTextOrderMenu(from);
  }

  // استجابة native list: PROD_<id>
  let selectedProds = [];
  if (msg.startsWith("PROD_")) {
    const prodId = msg.replace("PROD_", "");
    const prod   = prodMap[prodId];
    if (prod) selectedProds = [prod];
  }

  // fallback: أرقام نصية
  if (!selectedProds.length) {
    const tokens = msg.trim().split(/[\s,،]+/);
    const nums   = tokens.map(t => parseInt(t)).filter(n => !isNaN(n) && n >= 1 && n <= maxIdx);
    selectedProds = nums.map(n => prodMap[n]).filter(Boolean);
  }

  if (!selectedProds.length) {
    return sendButtons(from, {
      body:    `❌ لم أفهم اختيارك\n\nأو اضغط زر التأكيد إذا انتهيت:`,
      buttons: [
        { id: "ORDER_CONFIRM", title: "✅ تأكيد الطلب" },
        { id: "ORDER_MENU",    title: "📋 القائمة مجدداً" },
      ],
    });
  }

  // أضف للسلة
  const newCart = [...cart];
  for (const prod of selectedProds) {
    const existing = newCart.find(i => String(i.id) === String(prod.id));
    if (existing) {
      existing.qty++;
    } else {
      newCart.push({ id: prod.id, name: prod.name, price: Number(prod.price) || 0, qty: 1, imageUrl: prod.imageUrl || null, priceOnRequest: !!prod.priceOnRequest });
    }
  }

  sessionManager.update(from, { cart: newCart });

  const total    = newCart.reduce((s, i) => s + i.price * i.qty, 0);
  const cartLine = newCart.map(i => `• ${i.name} × ${i.qty} — ${(i.price * i.qty).toFixed(2)} ${currency}`).join("\n");

  await sendButtons(from, {
    body:    `✅ *تمت الإضافة!*\n\n🛒 *سلتك:*\n${cartLine}\n\n💰 *المجموع: ${total.toFixed(2)} ${currency}*`,
    buttons: [
      { id: "ORDER_CONFIRM", title: "✅ تأكيد الطلب" },
      { id: "ORDER_MENU",    title: "➕ إضافة منتج" },
    ],
    footer: `${newCart.length} منتج في السلة`,
  });
}

// ─── Web Order System (legacy — kept for reference) ───────────────────────────
async function sendWebOrderLink(from) {
  const demo = demoCtx.getStore();
  if (demo) {
    demo.buffer.push({ type: "text", body: "🛍️ اضغط لفتح قائمة الطلب:\n[رابط الطلب الإلكتروني — متاح عند التشغيل الفعلي]" });
    return;
  }
  const { store, storeId } = storeCtx.getStore() || {};
  if (!storeId) return;
  const token = waMgr.createWebOrderToken(storeId, from);
  const url   = `${process.env.PUBLIC_URL}/${token}`;
  await sendText(from,
    `🛍️ *اختر من قائمة ${store?.storeName || "متجرنا"}!*\n\n` +
    `👆 اضغط لفتح القائمة وإضافة ما تريد:\n${url}\n\n` +
    `_⏰ الرابط صالح لمدة 15 دقيقة_`
  );
}

// ─── Web Button System ────────────────────────────────────────────────────────
function _esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// JSON آمن للحقن في <script> tags — يحوّل < إلى < ويمنع كسر </script>
// وحماية من injection داخل HTML comment أيضاً.
function _safeJSON(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\u003c")
    .replace(/>/g, "\u003e")
    .replace(/&/g, "\u0026")
    .replace(/\u2028/g, "\u2028")
    .replace(/\u2029/g, "\u2029");
}

// تحقق آمن من قيمة CSS color (يقبل #hex / rgb / rgba / hsl / var(...) / كلمات محددة)
function _safeCssColor(val, fallback) {
  if (!val || typeof val !== "string") return fallback;
  const s = val.trim();
  if (s.length > 60) return fallback;
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
  if (/^rgba?\(\s*\d{1,3}(\s*,\s*\d{1,3}){2}(\s*,\s*[\d.]+)?\s*\)$/i.test(s)) return s;
  if (/^hsla?\(\s*\d{1,3}(\s*,\s*\d{1,3}%){2}(\s*,\s*[\d.]+)?\s*\)$/i.test(s)) return s;
  if (/^var\(--[a-z0-9-]+\)$/i.test(s)) return s;
  if (/^(transparent|currentColor|inherit|initial|unset)$/i.test(s)) return s;
  if (/^[a-z]{3,20}$/i.test(s)) return s; // named colors (red, blue, …)
  return fallback;
}

app.get("/c/:token", (req, res) => {
  const sess = waMgr.getButtonSession(req.params.token);
  if (!sess) {
    return res.status(410).send(`<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>انتهت الجلسة</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f2f5;color:#333}</style></head><body><div style="text-align:center"><div style="font-size:56px">⏰</div><h2>انتهت صلاحية الرابط</h2><p style="color:#666">عد للمحادثة وأرسل أي رسالة للبوت</p></div></body></html>`);
  }

  const color   = _esc(sess.color || "#25d366");
  const items   = sess.options.map(opt => {
    const id    = _esc(opt.id);
    const title = _esc(opt.title);
    const desc  = opt.description ? `<span class="desc">${_esc(opt.description)}</span>` : "";
    return `<button class="btn" data-id="${id}" data-title="${title}">${title}${desc}</button>`;
  }).join("");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <meta name="theme-color" content="${color}">
  <title>اختر</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    body{font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#f0f2f5;min-height:100vh;display:flex;flex-direction:column;align-items:center}
    .header{background:${color};width:100%;padding:18px 20px;text-align:center;color:#fff;font-size:17px;font-weight:700;letter-spacing:.3px}
    .card{width:100%;max-width:480px;padding:14px 16px 24px;display:flex;flex-direction:column;gap:10px}
    .btn{display:flex;flex-direction:column;align-items:flex-start;width:100%;padding:15px 18px;background:#fff;border:2px solid ${color};border-radius:14px;color:#222;font-size:16px;font-weight:600;cursor:pointer;text-align:right;transition:background .15s,color .15s,transform .1s;box-shadow:0 1px 6px rgba(0,0,0,.07)}
    .btn:active,.btn.sel{background:${color};color:#fff;transform:scale(.97)}
    .desc{display:block;font-size:13px;font-weight:400;margin-top:3px;opacity:.75}
    #done{display:none;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;text-align:center;flex:1}
    #done .icon{font-size:72px;margin-bottom:20px}
    #done h2{font-size:22px;font-weight:700;color:${color};margin-bottom:8px}
    #done p{font-size:14px;color:#888}
  </style>
</head>
<body>
  <div class="header">اختر من القائمة</div>
  <div class="card" id="card">${items}</div>
  <div id="done">
    <div class="icon">✅</div>
    <h2>تم الاختيار!</h2>
    <p>جارٍ العودة للواتساب…</p>
  </div>
  <script>
    const TOKEN = "${_esc(req.params.token)}";
    document.querySelectorAll('.btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (btn.classList.contains('sel')) return;
        btn.classList.add('sel');
        document.querySelectorAll('.btn').forEach(b => { if (b !== btn) { b.disabled = true; b.style.opacity = '.35'; } });
        try {
          await fetch('/api/c/' + TOKEN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: btn.dataset.id })
          });
        } catch(e) {}
        document.getElementById('card').style.display = 'none';
        document.getElementById('done').style.display = 'flex';
        setTimeout(() => {
          try { window.history.back(); } catch(e) {}
          setTimeout(() => { try { window.close(); } catch(e) {} }, 600);
        }, 1200);
      });
    });
  </script>
</body>
</html>`);
});

app.post("/api/c/:token", express.json(), async (req, res) => {
  const sess = waMgr.getButtonSession(req.params.token);
  if (!sess) return res.status(410).json({ ok: false, error: "expired" });

  waMgr.clearButtonSession(req.params.token);

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: "missing id" });

  try {
    const store = resolveStore(sess.storeId);
    if (!store) return res.status(404).json({ ok: false });

    res.json({ ok: true }); // respond immediately before processing

    await storeCtx.run({ storeId: sess.storeId, store }, () =>
      handleMessage(sess.userFrom, id)
    );
  } catch (e) {
    console.error("[web-btn]", e.message);
  }
});

// ─── Dine-in QR redirect: /t/:storeId/:tableNum → /o/<slug> ───────────────────
// public scan endpoint — generates a 90-day token with dine_in:true + table:N
// ─── 🔗 Share link: /m/:slug → wa.me/<botPhone>?text=... ────────────────────
// rate-limit بسيط per-IP (50 ضغطة/دقيقة)
const _shareLinkHits = new Map(); // ip → { count, resetAt }
function _shareLinkRateOk(ip) {
  const now = Date.now();
  const e = _shareLinkHits.get(ip);
  if (!e || e.resetAt < now) {
    _shareLinkHits.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (e.count >= 50) return false;
  e.count++;
  return true;
}
// smart welcome text based on businessType
function _shareLinkWelcomeText(store) {
  if (store.shareWelcomeText) return store.shareWelcomeText;
  const bt = String(store.businessType || "").toLowerCase();
  const name = store.storeName || "متجركم";
  if (/مطعم|كافيه|كافي|كوفي|قهوة|مخبز|حلويات|cafe|coffee|restaurant|bakery/i.test(bt + " " + name)) {
    return `السلام عليكم 👋\nأبي أطلب من ${name} 🍽️`;
  }
  if (/شاليه|تأجير|مزرعة|استراحة|فندق|rental|hotel/i.test(bt + " " + name)) {
    return `السلام عليكم 👋\nأبغى أحجز في ${name} 🏖️`;
  }
  if (/صالون|سبا|عيادة|salon|spa|clinic|barber/i.test(bt + " " + name)) {
    return `السلام عليكم 👋\nأبغى أحجز موعد في ${name} ✂️`;
  }
  return `السلام عليكم 👋\nأبي أطلب من ${name} 🛍️`;
}
function _shareLinkLogClick(storeId, ip, ua) {
  try {
    const fs = require("fs"), path = require("path");
    const file = path.join(DATA_DIR, `share-clicks_${storeId}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(),
      ip: String(ip || "").slice(0, 45),
      ua: String(ua || "").slice(0, 200),
    }) + "\n", "utf8");
  } catch (e) { console.warn("[share-link/log]", e.message); }
}
// /m/:slug — يفتح المنيو مباشرة (Web view)
// العميل يطلب → الـ webview تنشئ session في bot → البوت يكمل بطبيعته (يسأل العنوان...)
// لا ترحيب، لا واتساب وسيط
app.get("/m/:slug", (req, res) => {
  const slug = String(req.params.slug || "").toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9-]{2,18}[a-z0-9]$/.test(slug)) {
    return res.status(404).type("html").send(_shareLinkErrorPage("رابط غير صحيح", "تأكد من الرابط الذي تلقّيته"));
  }
  // rate-limit
  const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "";
  if (!_shareLinkRateOk(ip)) {
    return res.status(429).type("html").send(_shareLinkErrorPage("محاولات كثيرة", "حاول بعد دقيقة"));
  }
  // ابحث في كل المتاجر
  const stores = getAllStores();
  const store = stores.find(s => s.shareSlug === slug);
  if (!store) {
    return res.status(404).type("html").send(_shareLinkErrorPage("الرابط غير موجود", "المتجر قد يكون قد غيّر رابطه"));
  }
  // فحص حالة المتجر
  if (store.active === false || store.subscriptionStatus === "expired") {
    return res.status(403).type("html").send(_shareLinkErrorPage(`${store.storeName} غير متوفر حالياً`, "نعتذر، المتجر متوقف مؤقتاً"));
  }
  // log click (async)
  _shareLinkLogClick(store.id, ip, req.headers["user-agent"]);

  // 🔑 ولّد short token للـ webview — العميل لا يحتاج رقم
  //    عند الإرسال: webview يفتح wa.me/<botPhone>?text=<order> → العميل يضغط إرسال
  try {
    const slug2 = waMgr.createWebOrderToken(store.id, "share_anon_" + Date.now(), {
      source: "share_link",
    });
    return res.redirect(302, "/o/" + slug2);
  } catch (e) {
    console.warn("[m/slug] token create failed:", e.message);
    return res.status(500).type("html").send(_shareLinkErrorPage("خطأ مؤقت", "حاول مرة أخرى بعد قليل"));
  }
});
// 📖 صفحة عرض المنيو الجاهز (PDF/صور) — تصميم كتاب بأنيميشن تقليب صفحات
app.get("/menu-book/:slug", (req, res) => {
  const slug = String(req.params.slug || "").toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9-]{2,18}[a-z0-9]$/.test(slug)) {
    return res.status(404).type("html").send(_shareLinkErrorPage("رابط غير صحيح", ""));
  }
  const stores = getAllStores();
  const store  = stores.find(s => s.shareSlug === slug);
  if (!store) return res.status(404).type("html").send(_shareLinkErrorPage("المتجر غير موجود", ""));
  if (store.active === false) return res.status(403).type("html").send(_shareLinkErrorPage("المتجر متوقف", ""));

  // اجمع صفحات المنيو: menuFiles (الأحدث) أو menuImageUrl (backward compat)
  let pages = Array.isArray(store.menuFiles) && store.menuFiles.length
    ? store.menuFiles.slice()
    : (store.menuImageUrl ? [store.menuImageUrl] : []);
  if (!pages.length) {
    return res.status(404).type("html").send(_shareLinkErrorPage("لا توجد صفحات منيو", "المتجر لم يرفع منيو جاهز بعد"));
  }
  // فصل الـ PDFs عن الصور
  const pdfPages = pages.filter(u => /\.pdf(\?|$)/i.test(u));
  const imgPages = pages.filter(u => !/\.pdf(\?|$)/i.test(u));

  const accent = String(store.themeAccent || "#c9a24a").slice(0, 20);
  const name   = String(store.storeName || "المنيو").slice(0, 60);
  const orderLink = store.shareSlug ? `/m/${store.shareSlug}` : "";

  res.type("html").send(`<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=6,user-scalable=yes">
<title>📖 منيو ${_esc(name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;600;800;900&display=swap" rel="stylesheet">
<style>
  :root { --accent: ${accent}; }
  *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{height:100%;overflow:hidden;background:#0a0a0a;font-family:'Tajawal',system-ui,sans-serif;color:#fff}
  body{
    background:
      radial-gradient(1200px 800px at 50% -10%, rgba(201,162,74,.15), transparent 60%),
      radial-gradient(900px 700px at 50% 120%, rgba(201,162,74,.10), transparent 60%),
      #0a0a0a;
    display:flex;flex-direction:column;
  }
  .topbar{
    display:flex;align-items:center;gap:12px;padding:14px 18px;
    background:linear-gradient(180deg,rgba(0,0,0,.6),rgba(0,0,0,0));
    position:relative;z-index:5;
  }
  .brand{font-weight:900;font-size:16px;color:#fff;letter-spacing:.3px;flex:1;text-align:center}
  .brand small{display:block;font-weight:600;font-size:11px;opacity:.7;letter-spacing:2px}
  .back-btn{
    background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);
    color:#fff;padding:8px 14px;border-radius:20px;font-family:inherit;font-size:12px;font-weight:700;
    cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px;
  }
  .back-btn:hover{background:rgba(255,255,255,.15)}
  .stage{
    flex:1;display:flex;align-items:center;justify-content:center;position:relative;
    padding:14px 8px 88px;overflow:hidden;
  }
  .book{
    position:relative;width:100%;max-width:640px;height:100%;
    user-select:none;
  }
  .page{
    position:absolute;inset:0;background:#111;border-radius:12px;overflow:hidden;
    box-shadow:0 20px 60px rgba(0,0,0,.55),0 0 0 1px rgba(201,162,74,.28);
    transition:transform .55s cubic-bezier(.22,.61,.36,1),opacity .35s;
    will-change:transform,opacity;display:none;
  }
  .page.current{display:block;z-index:2;transform:translateX(0);opacity:1}
  .page.leaving-left  {display:block;z-index:1;transform:translateX(-105%);opacity:0}
  .page.leaving-right {display:block;z-index:1;transform:translateX(105%);opacity:0}
  .page.entering-left {display:block;z-index:2;transform:translateX(-105%);opacity:0}
  .page.entering-right{display:block;z-index:2;transform:translateX(105%);opacity:0}
  /* الحاوية القابلة للـ pan+zoom */
  .page .zoom-wrap{
    width:100%;height:100%;overflow:auto;-webkit-overflow-scrolling:touch;
    display:flex;align-items:center;justify-content:center;background:#fff;
    touch-action:pinch-zoom pan-x pan-y;
  }
  .page img,.page canvas{
    max-width:100%;max-height:100%;width:auto;height:auto;
    object-fit:contain;background:#fff;display:block;
    transform-origin:center center;transition:transform .2s ease-out;
    cursor:zoom-in;
  }
  .page img.zoomed,.page canvas.zoomed{cursor:zoom-out;max-width:none;max-height:none}
  .page-num{
    position:absolute;bottom:8px;left:50%;transform:translateX(-50%);
    background:rgba(0,0,0,.55);color:#fff;font-size:11px;font-weight:800;
    padding:4px 10px;border-radius:12px;letter-spacing:1px;pointer-events:none;z-index:3;
  }
  .nav{
    position:absolute;top:50%;transform:translateY(-50%);
    width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,.2);
    background:rgba(0,0,0,.55);color:#fff;font-size:22px;font-weight:800;
    display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:4;
    backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);font-family:inherit;
  }
  .nav:disabled{opacity:.3;cursor:not-allowed}
  .nav:hover:not(:disabled){background:var(--accent);color:#000;border-color:var(--accent)}
  .nav.prev{right:6px}
  .nav.next{left:6px}
  .dots{
    position:absolute;bottom:14px;left:50%;transform:translateX(-50%);
    display:flex;gap:6px;z-index:3;
  }
  .dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.3);cursor:pointer;transition:all .25s}
  .dot.active{background:var(--accent);width:20px;border-radius:3px}
  .footer{
    position:fixed;bottom:0;left:0;right:0;
    background:linear-gradient(0deg,rgba(0,0,0,.85),rgba(0,0,0,0));
    padding:12px 18px 16px;text-align:center;z-index:6;
  }
  .order-btn{
    display:inline-flex;align-items:center;gap:8px;
    background:linear-gradient(135deg,var(--accent),#e6c56c);
    color:#000;font-weight:900;font-family:inherit;font-size:14px;
    padding:12px 24px;border-radius:26px;text-decoration:none;
    box-shadow:0 8px 24px rgba(201,162,74,.4);
    transition:transform .2s;
  }
  .order-btn:active{transform:scale(.96)}
  .loading{
    position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    color:var(--accent);font-weight:800;font-size:14px;
  }
  .spinner{
    width:36px;height:36px;border:3px solid rgba(255,255,255,.15);
    border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;
    margin:0 auto 10px;
  }
  @keyframes spin{to{transform:rotate(360deg)}}
  @media (max-width:400px){ .book{width:94vw} }
</style>
</head>
<body>
  <div class="topbar">
    <a class="back-btn" href="${_esc(orderLink || '#')}">🛍️ للطلب</a>
    <div class="brand">📖 المنيو<small>${_esc(name)}</small></div>
    <div style="width:78px"></div>
  </div>

  <div class="stage">
    <button class="nav prev" id="btnPrev" aria-label="السابق">‹</button>
    <div class="book" id="book">
      <div class="loading" id="loading"><div><div class="spinner"></div>جارٍ تحميل المنيو…</div></div>
    </div>
    <button class="nav next" id="btnNext" aria-label="التالي">›</button>
    <div class="dots" id="dots"></div>
  </div>

  ${orderLink ? `<div class="footer"><a class="order-btn" href="${_esc(orderLink)}">🛒 ابدأ الطلب من المنيو التفاعلي</a></div>` : ""}

  ${pdfPages.length ? `<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>` : ""}
  <script>
    const IMG_PAGES = ${JSON.stringify(imgPages)};
    const PDF_URLS  = ${JSON.stringify(pdfPages)};
    let pages = []; // {type:'img'|'pdf', url|pdf/pageNum}
    let current = 0;
    let animating = false;
    let zoomState = { scale: 1, tx: 0, ty: 0, el: null };

    async function renderPdfs() {
      if (!PDF_URLS.length || typeof pdfjsLib === 'undefined') return;
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      for (const url of PDF_URLS) {
        try {
          const pdf = await pdfjsLib.getDocument(url).promise;
          for (let i = 1; i <= pdf.numPages; i++) pages.push({ type:'pdf', pdf, pageNum:i });
        } catch(e) { console.warn('PDF error:', e); }
      }
    }

    async function renderPageContent(p, idx) {
      if (p.type === 'img') {
        return '<div class="zoom-wrap"><img src="' + p.url + '" alt="صفحة ' + (idx+1) + '" loading="eager" draggable="false"></div>';
      }
      if (p.type === 'pdf') {
        try {
          const page = await p.pdf.getPage(p.pageNum);
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const viewport = page.getViewport({ scale: 2 * dpr });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width; canvas.height = viewport.height;
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
          const wrap = document.createElement('div');
          wrap.className = 'zoom-wrap';
          wrap.appendChild(canvas);
          return wrap.outerHTML;
        } catch(e) { return ''; }
      }
      return '';
    }

    async function buildPage(idx, cssClass) {
      const p = pages[idx];
      if (!p) return null;
      const div = document.createElement('div');
      div.className = 'page ' + cssClass;
      div.dataset.index = idx;
      div.innerHTML = await renderPageContent(p, idx) +
        '<div class="page-num">' + (idx+1) + ' / ' + pages.length + '</div>';
      return div;
    }

    async function draw() {
      const book = document.getElementById('book');
      book.innerHTML = '';
      const el = await buildPage(current, 'current');
      if (el) { book.appendChild(el); attachZoom(el); }
      renderDots();
      updateNav();
      prefetchNeighbors();
    }

    async function prefetchNeighbors() {
      // Preload صور مجاورة (لا نُضيفها للـ DOM — فقط cache المتصفح)
      [current-1, current+1].forEach(i=>{
        if (pages[i]?.type === 'img') { const im = new Image(); im.src = pages[i].url; }
      });
    }

    function renderDots() {
      const dots = document.getElementById('dots');
      dots.innerHTML = pages.map((_,i)=>'<div class="dot ' + (i===current?'active':'') + '" data-i="' + i + '"></div>').join('');
      dots.querySelectorAll('.dot').forEach(d=>d.addEventListener('click',()=>{ if(!animating){ goTo(+d.dataset.i); }}));
    }

    function updateNav(){
      document.querySelectorAll('.dot').forEach((d,i)=>d.classList.toggle('active', i===current));
      document.getElementById('btnPrev').disabled = current === 0;
      document.getElementById('btnNext').disabled = current === pages.length - 1;
    }

    async function goTo(target) {
      if (animating || target === current || target < 0 || target >= pages.length) return;
      animating = true;
      resetZoom();
      const book = document.getElementById('book');
      const dir = target > current ? 'right' : 'left'; // RTL: التالي يدخل من اليسار
      const enterFrom  = dir === 'right' ? 'entering-left'  : 'entering-right';
      const currentOut = dir === 'right' ? 'leaving-right'  : 'leaving-left';

      const oldEl = book.querySelector('.page.current');
      const newEl = await buildPage(target, enterFrom);
      book.appendChild(newEl);
      // force reflow ثم فعّل الحركة
      // eslint-disable-next-line no-unused-expressions
      newEl.offsetHeight;
      requestAnimationFrame(()=>{
        newEl.classList.remove(enterFrom);
        newEl.classList.add('current');
        if (oldEl) { oldEl.classList.remove('current'); oldEl.classList.add(currentOut); }
      });
      setTimeout(()=>{
        if (oldEl) oldEl.remove();
        attachZoom(newEl);
        current = target;
        updateNav();
        prefetchNeighbors();
        animating = false;
      }, 560);
    }

    // ═══ Zoom (pinch + double-tap) على الصفحة الحالية ═══
    function resetZoom() {
      const media = document.querySelectorAll('.page.current img, .page.current canvas');
      media.forEach(m=>{ m.style.transform = ''; m.classList.remove('zoomed'); });
      zoomState = { scale: 1, tx: 0, ty: 0, el: null };
      const wrap = document.querySelector('.page.current .zoom-wrap');
      if (wrap) { wrap.scrollLeft = 0; wrap.scrollTop = 0; }
    }

    function attachZoom(pageEl) {
      const media = pageEl.querySelector('img, canvas');
      if (!media) return;
      let lastTap = 0;
      let pinchStart = 0;
      let baseScale = 1;
      let sx=0, sy=0, moved=false, startedZoomed=false;

      // Double-tap للـ zoom
      media.addEventListener('click', (e)=>{
        const now = Date.now();
        if (now - lastTap < 320) {
          toggleZoom(media, e);
          e.preventDefault();
        }
        lastTap = now;
      });

      // Pinch (touch)
      media.addEventListener('touchstart', (e)=>{
        if (e.touches.length === 2) {
          pinchStart = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
          baseScale = zoomState.scale;
        } else if (e.touches.length === 1) {
          sx = e.touches[0].clientX; sy = e.touches[0].clientY;
          moved = false; startedZoomed = zoomState.scale > 1;
        }
      }, { passive: true });
      media.addEventListener('touchmove', (e)=>{
        if (e.touches.length === 2 && pinchStart) {
          const d = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
          const scale = Math.min(5, Math.max(1, baseScale * (d / pinchStart)));
          zoomState.scale = scale;
          media.style.transform = 'scale(' + scale + ')';
          media.classList.toggle('zoomed', scale > 1.02);
          e.preventDefault();
        }
      }, { passive: false });

      // Swipe للانتقال — فقط لو ليست مكبَّرة
      pageEl.addEventListener('touchend', (e)=>{
        if (animating) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - sx;
        const dy = t.clientY - sy;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && zoomState.scale <= 1.02) {
          // RTL: swipe يمين → صفحة سابقة، يسار → صفحة تالية
          if (dx > 0) goTo(current - 1);
          else        goTo(current + 1);
        }
      }, { passive: true });
    }

    function toggleZoom(media, evt) {
      if (zoomState.scale > 1.02) {
        media.style.transform = '';
        media.classList.remove('zoomed');
        zoomState.scale = 1;
      } else {
        zoomState.scale = 2.4;
        media.style.transform = 'scale(2.4)';
        media.classList.add('zoomed');
      }
    }

    // Navigation buttons
    document.getElementById('btnPrev').addEventListener('click',()=>goTo(current-1));
    document.getElementById('btnNext').addEventListener('click',()=>goTo(current+1));
    document.addEventListener('keydown',e=>{
      if (e.key==='ArrowLeft')  goTo(current+1);
      if (e.key==='ArrowRight') goTo(current-1);
      if (e.key==='Escape')     resetZoom();
    });

    (async ()=>{
      for (const url of IMG_PAGES) pages.push({ type:'img', url });
      await renderPdfs();
      if (!pages.length){
        document.getElementById('book').innerHTML = '<div class="loading">لا توجد صفحات لعرضها</div>';
        return;
      }
      draw();
    })();
  </script>
</body>
</html>`);
});

function _shareLinkErrorPage(title, sub) {
  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${_esc(title)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,"Segoe UI",Tahoma,Arial,sans-serif;background:linear-gradient(135deg,#0f172a,#1e293b);color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;direction:rtl}
.box{background:rgba(15,23,42,.7);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:40px 30px;max-width:380px;width:100%;text-align:center}
.icon{font-size:64px;margin-bottom:16px;opacity:.7}
h1{font-size:20px;margin-bottom:8px;font-weight:800}
p{font-size:13px;color:#94a3b8;line-height:1.7}
</style></head><body>
<div class="box">
<div class="icon">⚠️</div>
<h1>${_esc(title)}</h1>
<p>${_esc(sub)}</p>
</div></body></html>`;
}

app.get("/t/:storeId/:tableNum", (req, res) => {
  const storeId  = String(req.params.storeId || "").trim();
  const tableNum = parseInt(req.params.tableNum, 10);
  // 🛡️ تحقق صارم من شكل storeId (يمنع رموز خاصة قد تُربك الـ resolve)
  if (!storeId || !/^[a-zA-Z0-9_-]+$/.test(storeId) || !Number.isFinite(tableNum) || tableNum < 1 || tableNum > 999) {
    return res.status(400).send(`<!DOCTYPE html><html dir="rtl" lang="ar"><meta charset="UTF-8"><body style="font-family:sans-serif;text-align:center;padding:40px"><div style="font-size:48px">⚠️</div><h2>رابط غير صحيح</h2><p>تأكد من مسح كود QR الصحيح</p></body></html>`);
  }
  const store = resolveStore(storeId);
  if (!store) return res.status(404).send("المتجر غير موجود");
  try {
    // ابحث عن تعريف الطاولة في store.diningTables (لو موجود)
    const tableDef = (store.diningTables || []).find(t => Number(t.num) === tableNum);
    let extra = { dine_in: true, table: tableNum };
    if (tableDef) {
      const labelParts = [];
      if (tableDef.section) labelParts.push(tableDef.section);
      labelParts.push(`طاولة ${tableNum}`);
      if (tableDef.area) labelParts.push(tableDef.area);
      extra.tableLabel = labelParts.join(" · ");
      extra.section    = tableDef.section || "";
      extra.area       = tableDef.area    || "";
      extra.tableNote  = tableDef.note    || "";
    }
    const slug = waMgr.createWebOrderToken(storeId, `dine_in_t${tableNum}`, extra);
    return res.redirect(302, `/o/${slug}`);
  } catch (e) {
    console.error("[dine-in]", e.message);
    return res.status(500).send("خطأ مؤقت — حاول مرة أخرى");
  }
});

// ─── Dine-in QR-cards PDF (printable A6 cards for tables) ─────────────────────
// GET /store/dine-in/qr-pdf?count=6
// 🏗️ يبني ملف PDF لطاولة واحدة → Buffer
async function _buildSingleTableQrPdf({ store, storeId, tbl, base, arabicFontPath }) {
  const QRCode      = require("qrcode");
  const PDFDocument = require("pdfkit");
  return new Promise(async (resolve, reject) => {
    try {
      const chunks = [];
      const doc = new PDFDocument({ size: "A6", margin: 18 });
      doc.on("data", c => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const storeName = store.storeName || "متجرنا";
      const accent    = "#d4af37";
      const dark      = "#1b1b1b";
      const arOpts    = { features: ["rtla", "calt", "liga", "ccmp"] };

      const tableNum = tbl.num;
      const W = doc.page.width;
      const H = doc.page.height;

      doc.save().rect(0, 0, W, H * 0.13).fill(dark).restore();
      if (arabicFontPath) doc.font(arabicFontPath);
      doc.fillColor(accent).fontSize(17)
         .text(storeName, 0, H * 0.045, { width: W, align: "center", ...arOpts });

      const url = `${base}/t/${storeId}/${tableNum}`;
      const qrBuf = await QRCode.toBuffer(url, { errorCorrectionLevel: "M", margin: 1, width: 480 });
      const qrSize = Math.min(W - 40, H * 0.46);
      const qrX = (W - qrSize) / 2;
      const qrY = H * 0.16;
      doc.save().rect(qrX - 6, qrY - 6, qrSize + 12, qrSize + 12).fill("#ffffff").restore();
      doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });

      if (arabicFontPath) doc.font(arabicFontPath);
      doc.fillColor("#000000").fontSize(26)
         .text(`طاولة ${tableNum}`, 0, qrY + qrSize + 10, { width: W, align: "center", ...arOpts });

      const subParts = [];
      if (tbl.section) subParts.push(tbl.section);
      if (tbl.area)    subParts.push(tbl.area);
      if (subParts.length > 0) {
        doc.fillColor("#7a6e3e").fontSize(13)
           .text(subParts.join(" · "), 0, qrY + qrSize + 42, { width: W, align: "center", ...arOpts });
      }
      if (tbl.note) {
        doc.fillColor("#999999").fontSize(10)
           .text(tbl.note, 0, qrY + qrSize + 62, { width: W, align: "center", ...arOpts });
      }

      doc.fillColor("#666666").fontSize(10)
         .text("امسح الكود واطلب من جوالك", 0, H - 42, { width: W, align: "center", ...arOpts });

      doc.fillColor("#aaaaaa").fontSize(7);
      if (arabicFontPath) doc.font(arabicFontPath);
      doc.text("Powered by Thawani · ثواني", 0, H - 22, { width: W, align: "center", ...arOpts });

      doc.end();
    } catch (e) { reject(e); }
  });
}

// 🗂️ ZIP يحوي ملف PDF لكل طاولة (طلب: زر تحميل المجمّع يطبع كل طاولة في ملف منفصل داخل ZIP واحد)
app.get("/store/dine-in/qr-zip", require("./store-router").auth, async (req, res) => {
  try {
    const JSZip = require("jszip");
    const fs    = require("fs");
    const path  = require("path");

    const storeId = req.storeId;
    const store   = resolveStore(storeId);
    if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

    const customTables = Array.isArray(store.diningTables) ? store.diningTables : [];
    if (!customTables.length) {
      return res.status(400).json({ error: "لا توجد طاولات معرّفة — أضف طاولات أولاً" });
    }

    const base = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
    const arabicFontCandidates = [
      path.join(__dirname, "..", "data", "fonts", "Cairo-Bold.ttf"),
      path.join(__dirname, "..", "data", "fonts", "Tajawal-Bold.ttf"),
      path.join(__dirname, "..", "public", "fonts", "Cairo-Bold.ttf"),
    ];
    const arabicFontPath = arabicFontCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });

    const zip = new JSZip();
    const tables = customTables.slice(0, 100).map(t => ({
      num: parseInt(t.num, 10),
      section: t.section || "",
      area: t.area || "",
      note: t.note || "",
    }));

    // ابني كل PDF (بالتوازي مع limit)
    const results = await Promise.all(tables.map(async tbl => {
      const buf = await _buildSingleTableQrPdf({ store, storeId, tbl, base, arabicFontPath });
      return { tbl, buf };
    }));

    for (const { tbl, buf } of results) {
      const parts = [`table-${String(tbl.num).padStart(3, "0")}`];
      if (tbl.section) parts.push(tbl.section.replace(/[\/\\:?*"<>|\x00-\x1f]/g, ""));
      if (tbl.area)    parts.push(tbl.area.replace(/[\/\\:?*"<>|\x00-\x1f]/g, ""));
      const fname = parts.join("-") + ".pdf";
      zip.file(fname, buf);
    }

    const zipBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });

    // ⚠️ Content-Disposition لا يقبل أحرف غير-ASCII مباشرة → نستخدم RFC 5987 (filename* UTF-8)
    const rawName = `qr-tables-${store.storeName || storeId}.zip`;
    const asciiFallback = `qr-tables-${String(storeId).replace(/[^\w\-]/g, "_")}.zip`;
    const utf8Encoded = encodeURIComponent(rawName);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition",
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`);
    res.send(zipBuf);
  } catch (e) {
    console.error("[dine-in-zip]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "فشل توليد ZIP" });
  }
});

app.get("/store/dine-in/qr-pdf", require("./store-router").auth, async (req, res) => {
  try {
    const QRCode      = require("qrcode");
    const PDFDocument = require("pdfkit");
    const fs          = require("fs");
    const path        = require("path");

    const storeId = req.storeId;
    const store   = resolveStore(storeId);
    if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

    const customTables = Array.isArray(store.diningTables) ? store.diningTables : [];
    let tablesList;
    // 🎯 طلب طباعة طاولة واحدة فقط: ?only=N
    const onlyNum = parseInt(req.query.only, 10);
    if (Number.isFinite(onlyNum) && onlyNum >= 1 && onlyNum <= 999) {
      const tbl = customTables.find(t => parseInt(t.num, 10) === onlyNum);
      tablesList = [tbl
        ? { num: onlyNum, section: tbl.section || "", area: tbl.area || "", note: tbl.note || "" }
        : { num: onlyNum, section: "", area: "", note: "" }
      ];
    } else if (customTables.length > 0) {
      // استخدم تعريفات الطاولات المخصصة (لكل طاولة قسم/منطقة/ملاحظة)
      tablesList = customTables.slice(0, 100).map(t => ({
        num: parseInt(t.num, 10),
        section: t.section || "",
        area:    t.area    || "",
        note:    t.note    || "",
      }));
    } else {
      // fallback: 1..count
      const count = Math.max(1, Math.min(50, parseInt(req.query.count, 10) || 6));
      const startFrom = Math.max(1, parseInt(req.query.from, 10) || 1);
      tablesList = Array.from({ length: count }, (_, i) => ({ num: startFrom + i, section: "", area: "", note: "" }));
    }
    const base = (process.env.PUBLIC_URL || "").replace(/\/$/, "");

    const arabicFontCandidates = [
      path.join(__dirname, "..", "data", "fonts", "Cairo-Bold.ttf"),
      path.join(__dirname, "..", "data", "fonts", "Tajawal-Bold.ttf"),
      path.join(__dirname, "..", "public", "fonts", "Cairo-Bold.ttf"),
    ];
    const arabicFontPath = arabicFontCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="dine-in-qr-${storeId}.pdf"`);

    const doc = new PDFDocument({ size: "A6", margin: 18 });
    doc.pipe(res);

    const storeName = store.storeName || "متجرنا";
    const accent    = "#d4af37";
    const dark      = "#1b1b1b";

    // ⭐ Arabic text features (RTL + ligatures) — fontkit handles shaping
    const arOpts = { features: ["rtla", "calt", "liga", "ccmp"] };

    for (let i = 0; i < tablesList.length; i++) {
      const tbl = tablesList[i];
      const tableNum = tbl.num;
      if (i > 0) doc.addPage({ size: "A6", margin: 18 });

      const W = doc.page.width;
      const H = doc.page.height;

      // Header band
      doc.save().rect(0, 0, W, H * 0.13).fill(dark).restore();
      if (arabicFontPath) doc.font(arabicFontPath);
      // emoji + اسم المتجر — pdfkit لا يدعم الـ emoji في الـ TTF، فنفصلها
      doc.fillColor(accent).fontSize(17)
         .text(storeName, 0, H * 0.045, { width: W, align: "center", ...arOpts });

      // QR code
      const url      = `${base}/t/${storeId}/${tableNum}`;
      const qrBuf    = await QRCode.toBuffer(url, { errorCorrectionLevel: "M", margin: 1, width: 480 });
      const qrSize   = Math.min(W - 40, H * 0.46);
      const qrX      = (W - qrSize) / 2;
      const qrY      = H * 0.16;
      doc.save().rect(qrX - 6, qrY - 6, qrSize + 12, qrSize + 12).fill("#ffffff").restore();
      doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });

      // Table number (كبير)
      if (arabicFontPath) doc.font(arabicFontPath);
      doc.fillColor("#000000").fontSize(26)
         .text(`طاولة ${tableNum}`, 0, qrY + qrSize + 10, { width: W, align: "center", ...arOpts });

      // Section + area (لو موجود)
      const subParts = [];
      if (tbl.section) subParts.push(tbl.section);
      if (tbl.area)    subParts.push(tbl.area);
      if (subParts.length > 0) {
        doc.fillColor("#7a6e3e").fontSize(13)
           .text(subParts.join(" · "), 0, qrY + qrSize + 42, { width: W, align: "center", ...arOpts });
      }
      // ملاحظة (لو موجودة)
      if (tbl.note) {
        doc.fillColor("#999999").fontSize(10)
           .text(tbl.note, 0, qrY + qrSize + 62, { width: W, align: "center", ...arOpts });
      }

      // Instructions (في الأسفل)
      doc.fillColor("#666666").fontSize(10)
         .text("امسح الكود واطلب من جوالك", 0, H - 42, { width: W, align: "center", ...arOpts });

      // Footer (إنجليزي — لا حاجة لـ shaping)
      doc.fillColor("#aaaaaa").fontSize(7);
      if (arabicFontPath) doc.font(arabicFontPath);
      doc.text("Powered by Thawani · ثواني", 0, H - 22, { width: W, align: "center", ...arOpts });
    }

    doc.end();
  } catch (e) {
    console.error("[dine-in-pdf]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "فشل توليد ملف PDF" });
  }
});

// ─── Interactive Card Order Page (يستجيب لـ /:slug و /o/:token و /order/:token) ──
// الـ /:slug للأقصر — pattern 5-12 chars من base62 فقط
// 🎨 Menu Pro v2 — تصميم احترافي اختياري per-store (store.menuTheme = "pro")
// يقبل نفس الـ token. يحوّل تلقائياً لو المتجر مُفعّل لها.
app.get(["/o/v2/:token", "/order/v2/:token"], (req, res) => {
  return _renderMenu(req, res, { force: "pro" });
});

// 🍽️ تحديد ما إذا كان النشاط مطعم/كافيه (يحصل Pro تلقائياً)
//    يفحص businessType + storeName (لو الـ AI سجّل النوع غلط، الاسم ينقذ)
const _RESTAURANT_RX = /مطعم|كافيه|كافي|كوفي|قهوة|مخبز|حلويات|بيتزا|برجر|شاورما|مشاوي|سندويتش|cafe|coffee|restaurant|bakery|sweets|food|kitchen|fastfood|grill|burger|pizza|shawarma|sandwich|dine[\-_ ]?in/i;
function _isRestaurantLikeBiz(store) {
  if (!store) return false;
  const bt = String(store.businessType || "").trim();
  const nm = String(store.storeName  || "").trim();
  return _RESTAURANT_RX.test(bt) || _RESTAURANT_RX.test(nm);
}

app.get(["/order/:token", "/o/:token", "/:token([a-zA-Z0-9]{4,12})"], (req, res) => {
  // الـ routing logic — menu-pro للمطاعم/الكافيهات فقط (حتى لو التاجر اختار pro خطأً):
  //   - menuTheme = "classic"              → دائماً Classic
  //   - menuTheme = "pro" + بيزنس مطعم    → Pro
  //   - menuTheme = "pro" + بيزنس آخر      → Classic (يحمي من إعداد خاطئ سابق)
  //   - بدون menuTheme: مطعم/كافيه → Pro auto، الباقي → Classic
  const sess0 = waMgr.getWebOrderSession(req.params.token);
  if (sess0) {
    const st = resolveStore(sess0.storeId);
    if (st) {
      const explicit = st.menuTheme;
      const isResto  = _isRestaurantLikeBiz(st);
      if (explicit === "classic") return _renderMenuClassic(req, res);
      if (explicit === "pro" && isResto) return _renderMenuPro(req, res, sess0, st);
      if (isResto) return _renderMenuPro(req, res, sess0, st);
    }
  }
  return _renderMenuClassic(req, res);
});
function _renderMenu(req, res, opts) {
  const sess = waMgr.getWebOrderSession(req.params.token);
  if (!sess) return _renderMenuClassic(req, res);
  const st = resolveStore(sess.storeId);
  if (!st) return res.status(404).send("المتجر غير موجود");
  if (opts?.force === "pro") return _renderMenuPro(req, res, sess, st);
  return _renderMenuClassic(req, res);
}
function _renderMenuClassic(req, res) {
  // 🚫 لا cache — HTML يحوي بيانات ديناميكية (currency, products, sizes)
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  const sess = waMgr.getWebOrderSession(req.params.token);
  if (!sess) {
    return res.status(410).send(`<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta name="theme-color" content="var(--bg)"><title>انتهت الجلسة</title><style>*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}html,body{height:100%;display:flex;align-items:center;justify-content:center;background:var(--bg);font-family:'Segoe UI',Tahoma,Arial,sans-serif;overflow:hidden}.box{text-align:center;padding:40px 24px;max-width:340px}.ico{font-size:72px;margin-bottom:18px;filter:drop-shadow(0 0 12px rgba(212,175,55,.3))}.h{font-size:20px;font-weight:800;color:var(--accent);margin-bottom:10px;letter-spacing:.3px}.p{font-size:14px;color:#888;line-height:1.7}.back{display:inline-block;margin-top:22px;background:var(--accent);color:#000;padding:12px 28px;border-radius:24px;font-size:14px;font-weight:800;text-decoration:none;cursor:pointer}.back:active{opacity:.8}</style></head><body><div class="box"><div class="ico">⏰</div><div class="h">انتهت صلاحية الرابط</div><div class="p">الرابط صالح لـ 24 ساعة<br>عد للمحادثة وأرسل أي رسالة للبوت</div><a class="back" href="#" onclick="try{window.history.back();}catch(e){}try{window.close();}catch(e){}">💬 العودة للمحادثة</a></div></body></html>`);
  }

  const store    = resolveStore(sess.storeId);
  if (!store) return res.status(404).send("المتجر غير موجود");

  const botPhone   = sess.botPhone || "";
  // validation صارمة لقيم CSS لمنع injection عبر إعدادات المتجر
  const rawColor   = _safeCssColor(store.invoiceColor, "#1b5e20");
  const rawAccent  = _safeCssColor(store.themeAccent,  "var(--accent)");
  const menuMode   = store.menuMode === "light" ? "light" : "dark";
  const color      = _esc(rawColor);
  const accentColor = _esc(rawAccent);
  const name       = _esc(store.storeName || "متجرنا");
  const currency   = store.currency || CURRENCY;

  // ── Theme palette: dark | light ──
  const basePalette = menuMode === "light" ? {
    bg:        "#ffffff",
    bgAlt:     "#f9fafb",
    bgHeader:  "#ffffff",
    text:      "#1f2937",
    textMute:  "#6b7280",
    textDim:   "#9ca3af",
    cardBg:    "#ffffff",
    cardBgAlt: "#f3f4f6",
    border:    "#e5e7eb",
    borderDim: "#f3f4f6",
    shadowOverlay: "rgba(0,0,0,.5)",
  } : {
    bg:        "#050505",
    bgAlt:     "#080808",
    bgHeader:  "#0e0e0e",
    text:      "#f5f5f5",
    textMute:  "#9a9a9a",
    textDim:   "#666666",
    cardBg:    "#121212",
    cardBgAlt: "#161616",
    border:    "#1f1f1f",
    borderDim: "#262626",
    shadowOverlay: "rgba(0,0,0,.85)",
  };
  // تخصيص ألوان النصوص من إعدادات المتجر (إن وُجدت)
  const palette = {
    ...basePalette,
    text:     store.themeText     || basePalette.text,
    textMute: store.themeTextMute || basePalette.textMute,
  };
  const products = (store.products || []).filter(isProductInStock);
  const cats     = (store.categories || []).filter(cat => products.some(p => p.category === cat.id));

  const _absUrl = (u) => {
    if (!u) return null;
    return u.startsWith("http") ? u : `${(process.env.PUBLIC_URL||"").replace(/\/$/,"")}${u}`;
  };
  // YouTube/Vimeo → embed URL لـ <iframe>
  const _videoEmbed = (url) => {
    if (!url) return null;
    // YouTube watch / youtu.be / shorts
    const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_\-]{11})/);
    if (yt) return { kind: "iframe", src: `https://www.youtube.com/embed/${yt[1]}?rel=0&playsinline=1`, original: url };
    // Vimeo
    const vm = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (vm) return { kind: "iframe", src: `https://player.vimeo.com/video/${vm[1]}`, original: url };
    // Google Drive (preview)
    const gd = url.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_\-]+)/);
    if (gd) return { kind: "iframe", src: `https://drive.google.com/file/d/${gd[1]}/preview`, original: url };
    // direct mp4/webm/mov OR uploaded internal /store-videos/...
    if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(url) || url.startsWith("/store-videos/")) {
      return { kind: "native", src: _absUrl(url), original: url };
    }
    // fallback: just open in new tab
    return { kind: "link", src: url, original: url };
  };

  // ─── Order counts (per-product, last 30 days) — للـ "الأكثر طلباً" + popularity ranking
  const productOrderCount = new Map();
  try {
    const ordersFile = storeId === "nakheel_001"
      ? path.join(__dirname, "..", "data", "orders.jsonl")
      : path.join(__dirname, "..", "data", `orders_${storeId}.jsonl`);
    if (fs.existsSync(ordersFile)) {
      const cutoff = Date.now() - 30 * 86400_000;
      for (const l of fs.readFileSync(ordersFile, "utf8").split("\n")) {
        if (!l) continue;
        try {
          const o = JSON.parse(l);
          const ts = new Date(o.timestamp || o.createdAt || 0).getTime();
          if (ts < cutoff) continue;
          for (const item of (o.items || o.cart || [])) {
            const pid = item.id || item.productId;
            if (!pid) continue;
            productOrderCount.set(pid, (productOrderCount.get(pid) || 0) + (Number(item.qty || item.quantity) || 1));
          }
        } catch {}
      }
    }
  } catch {}
  // Top 5 الأكثر طلباً
  const topIds = new Set([...productOrderCount.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]));

  const productData = {};
  const NEW_DAYS = 7;
  products.forEach(p => {
    const created = new Date(p.createdAt || p.id?.replace(/^p_/,"") || Date.now()).getTime();
    const isNew = (Date.now() - created) < NEW_DAYS * 86400_000;
    const isTop = topIds.has(p.id);
    const stockNum = typeof p.stock === "number" ? p.stock : null;
    const lowStock = stockNum !== null && stockNum > 0 && stockNum < 5;
    const originalPrice = Number(p.originalPrice || 0);
    const hasDiscount = originalPrice > 0 && originalPrice > p.price;
    const discountPct = hasDiscount ? Math.round((1 - p.price / originalPrice) * 100) : 0;

    // max 2 badges per product (تجنب الفوضى) — أولوية: خصم > الأكثر طلباً > متبقي قليل > جديد
    const badges = [];
    if (hasDiscount) badges.push({ kind: "discount", label: `خصم ${discountPct}%`, emoji: "💰" });
    if (isTop && badges.length < 2) badges.push({ kind: "top", label: "الأكثر طلباً", emoji: "🔥" });
    if (lowStock && badges.length < 2) badges.push({ kind: "low", label: `متبقي ${stockNum}`, emoji: "⚠️" });
    if (isNew && badges.length < 2) badges.push({ kind: "new", label: "جديد", emoji: "🆕" });

    // ⭐ معالجة الصور المتعددة — نُرجع array كاملة
    const productImages = Array.isArray(p.images) && p.images.length
      ? p.images.map(_absUrl).filter(Boolean)
      : (p.imageUrl ? [_absUrl(p.imageUrl)].filter(Boolean) : []);

    // 🏠 لو وحدة عقارية → أضف accommodation + حالة التوفر
    let acmInfo = null;
    let acmAvailability = null;
    if (p.accommodation) {
      acmInfo = p.accommodation;
      try {
        const bookings = require("./bookings");
        acmAvailability = bookings.getUnitAvailability(storeId, p.id);
      } catch {}
    }

    productData[String(p.id)] = {
      name:           p.name,
      description:    p.description || "",
      price:          Number(p.price) || 0,
      originalPrice:  originalPrice > p.price ? originalPrice : null,
      imageUrl:       productImages[0] || null,  // backward compat
      images:         productImages,             // ⭐ array كامل
      // 🎬 فيديو المنتج انتقل لصفحة "استعرض المنتجات" (/browse/:storeId)
      categoryId:     String(p.category || ""),
      subCategoryId:  String(p.subCategoryId || ""),
      sizes:          Array.isArray(p.sizes) && p.sizes.length
        ? p.sizes.map(s => ({ label: String(s.label || ""), price: Number(s.price) || 0 })).filter(s => s.label && s.price > 0)
        : null,
      badges,
      popularity:     productOrderCount.get(p.id) || 0,
      stock:          stockNum,
      // 🏠 معلومات الوحدة العقارية + حالة التوفر
      accommodation:  acmInfo,
      availability:   acmAvailability,
    };
  });

  // نقبل logoUrl أو invoiceLogoUrl (يُحفظ من tab الإعدادات في store-admin)
  const rawLogo = store.logoUrl || store.invoiceLogoUrl || "";
  const logoUrl = rawLogo
    ? (rawLogo.startsWith("http") ? rawLogo : `${(process.env.PUBLIC_URL||"").replace(/\/$/,"")}${rawLogo}`)
    : "";

  // ⭐ نُحدّد المنتجات غير المصنّفة (category فاضي أو لا يطابق أي قسم) — تروح لـ "غير مصنّف"
  const catIds = new Set(cats.map(c => String(c.id)));
  const uncategorized = products.filter(p => !p.category || !catIds.has(String(p.category)));
  // 🔢 رتّب categories حسب sortOrder (يتحكم به التاجر من الادمن)
  const sortedCats = cats.slice().sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));
  const categoriesData = sortedCats.length > 0
    ? [
        ...sortedCats.map(c => ({
          id:    String(c.id),
          name:  c.name,
          emoji: c.emoji || "◆",
          icon:  c.icon || null,  // 🖼️ أيقونة الصنف (تُعرض بدل emoji لو موجودة)
          items: products.filter(p => String(p.category) === String(c.id)).map(p => String(p.id)),
          subCategories: Array.isArray(c.subCategories)
            ? c.subCategories
                .filter(s => s && s.id && s.active !== false)
                .map(s => ({ id: String(s.id), name: String(s.name||""), emoji: String(s.emoji||"") }))
            : [],
        })),
        // قسم احتياطي للمنتجات غير المصنفة (يظهر فقط لو فيه منتجات بدون قسم)
        ...(uncategorized.length > 0 ? [{
          id: "__uncategorized__",
          name: "أخرى",
          emoji: "📋",
          items: uncategorized.map(p => String(p.id)),
          subCategories: [],
        }] : []),
      ].filter(c => c.items.length > 0)  // نُخفي الأقسام الفارغة من قائمة العميل
    : [{ id: "__all__", name: "المنتجات", emoji: "🛍️", items: products.map(p => String(p.id)), subCategories: [] }];
  // إن انتهينا بقائمة فارغة (مثلاً كل المنتجات منتهية أو ما في منتجات) — أضف قسم فارغ افتراضي
  const finalCategoriesData = categoriesData.length > 0
    ? categoriesData
    : [{ id: "__all__", name: "المنتجات", emoji: "🛍️", items: products.map(p => String(p.id)), subCategories: [] }];

  // ─── Header extras: حالة المتجر + التقييم + وقت التوصيل ──────────────────────
  const hStart = _toHourFloat(store.workingHoursStart, 0);
  const hEnd   = _toHourFloat(store.workingHoursEnd,   24);
  const nowH   = new Date().getHours() + new Date().getMinutes() / 60;
  const isOpen = (hStart === 0 && hEnd >= 23.98) ? true : (hStart <= hEnd ? (nowH >= hStart && nowH < hEnd) : (nowH >= hStart || nowH < hEnd));
  // التقييم: نقرأ من ratings الموجود (إن وُجد) — مجمع per store
  let storeRating = null;
  try {
    const ratingsMod = require("./ratings");
    if (typeof ratingsMod.getStoreSummary === "function") {
      storeRating = ratingsMod.getStoreSummary(storeId);
    }
  } catch {}
  // وقت التوصيل المتوقع: avg من completed orders آخر 30 يوم (لو فيه delivery time tracked)
  let avgDeliveryMin = store?.avgDeliveryMin || null;
  if (!avgDeliveryMin) {
    try {
      const ordersFile = storeId === "nakheel_001"
        ? path.join(__dirname, "..", "data", "orders.jsonl")
        : path.join(__dirname, "..", "data", `orders_${storeId}.jsonl`);
      if (fs.existsSync(ordersFile)) {
        const cutoff = Date.now() - 30 * 86400_000;
        const times = [];
        for (const l of fs.readFileSync(ordersFile, "utf8").split("\n")) {
          if (!l) continue;
          try {
            const o = JSON.parse(l);
            const ts = new Date(o.timestamp || o.createdAt || 0).getTime();
            if (ts < cutoff) continue;
            if (o.deliveredAt && o.timestamp) {
              const min = (new Date(o.deliveredAt) - new Date(o.timestamp)) / 60000;
              if (min > 0 && min < 240) times.push(min);
            }
          } catch {}
        }
        if (times.length >= 3) {
          avgDeliveryMin = Math.round(times.reduce((s,x)=>s+x,0) / times.length);
        }
      }
    } catch {}
  }

  // عدد طلبات اليوم (trust signal)
  let ordersTodayCount = 0;
  try {
    const ordersFile = storeId === "nakheel_001"
      ? path.join(__dirname, "..", "data", "orders.jsonl")
      : path.join(__dirname, "..", "data", `orders_${storeId}.jsonl`);
    if (fs.existsSync(ordersFile)) {
      const today = new Date().toISOString().slice(0, 10);
      for (const l of fs.readFileSync(ordersFile, "utf8").split("\n")) {
        if (!l) continue;
        try {
          const o = JSON.parse(l);
          if ((o.timestamp || o.createdAt || "").slice(0, 10) === today) ordersTodayCount++;
        } catch {}
      }
    }
  } catch {}

  const headerExtras = {
    isOpen,
    hStart, hEnd,
    rating: storeRating?.average ? Number(storeRating.average.toFixed(1)) : null,
    ratingCount: storeRating?.count || 0,
    avgDeliveryMin,
    ordersToday: ordersTodayCount,
  };

  const token    = _safeJSON(req.params.token);
  // 💱 ر.س → الرمز الجديد ﷼ في المنيو
  const _displayCurrencyFront = (c) => {
    const s = String(c || "").trim();
    if (!s) return "﷼";
    if (/^(ر\.?س|SAR|ريال|ر$)/i.test(s)) return "﷼";
    return s;
  };
  const curr     = _safeJSON(_displayCurrencyFront(currency));
  const pdata    = _safeJSON(productData);
  const cdata    = _safeJSON(finalCategoriesData);
  const logoJ    = _safeJSON(logoUrl);
  const nameJ    = _safeJSON(store.storeName || "متجرنا");
  const colorJ   = _safeJSON(rawColor);
  const phoneJ   = _safeJSON(botPhone);
  const extrasJ  = _safeJSON(headerExtras);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="${color}">
<meta property="og:title" content="${name} — قائمة الطلب">
<meta property="og:description" content="اضغط لاختيار طلبك الآن 🛒">
<meta property="og:type" content="website">
${logoUrl ? `<meta property="og:image" content="${_esc(logoUrl)}">` : ""}
<title>${name} — قائمة الطلب</title>
<style>
:root{
  --primary:${rawColor};
  --accent:${rawAccent};
  --bg:${palette.bg};
  --bg-alt:${palette.bgAlt};
  --bg-header:${palette.bgHeader};
  --text:${palette.text};
  --text-mute:${palette.textMute};
  --text-dim:${palette.textDim};
  --card-bg:${palette.cardBg};
  --card-bg-alt:${palette.cardBgAlt};
  --border:${palette.border};
  --border-dim:${palette.borderDim};
  --overlay:${palette.shadowOverlay};
}
</style>
<link rel="stylesheet" href="/menu-classic.css?v=1">
<style>
</style>
</head>
<body>
<div class="sticky-stack">
  <div class="hdr" id="hdr"></div>
  <div class="search-bar">
    <div class="search-wrap">
      <span class="search-icon">🔍</span>
      <input type="text" id="search" class="search-input" placeholder="ابحث عن منتج...">
    </div>
  </div>
  <div class="tabs" id="tabs"></div>
  <div class="sub-chips" id="subChips" style="display:none"></div>
</div>
<!-- Phase 5B — Last Order banner (إن وُجد) + Hero featured -->
<div id="lastOrderBanner" class="last-order-banner" style="display:none">
  <div class="lo-icon">🔄</div>
  <div class="lo-info">
    <div class="lo-title">آخر طلب أحببته</div>
    <div class="lo-sub" id="loSub"></div>
  </div>
  <button class="lo-btn" type="button" onclick="reorderLast()">اطلب نفسه</button>
</div>
<div id="heroBanner" class="hero-banner" style="display:none">
  <div id="heroImgWrap"></div>
  <div class="hero-info">
    <span class="hero-tag">🔥 الأكثر طلباً</span>
    <div class="hero-name" id="heroName"></div>
    <div class="hero-meta" id="heroMeta"></div>
  </div>
  <button class="hero-cta" type="button" id="heroCta">اطلبه الآن</button>
</div>

<div id="skeleton" class="skeleton-grid"></div>
<div id="scroll" style="display:none"></div>

<!-- Phase 5B — Cart Drawer (slide-up) -->
<div id="cartDrawerBg" class="cd-bg" onclick="closeCartDrawer()"></div>
<div id="cartDrawer" class="cart-drawer">
  <div class="cd-handle"></div>
  <div class="cd-header">
    <div class="cd-title">🛒 سلتك</div>
    <button class="cd-close" type="button" onclick="closeCartDrawer()">✕</button>
  </div>
  <div class="cd-items" id="cdItems"></div>
  <div class="cd-footer">
    <div class="cd-total-row">
      <div class="cd-total-label">الإجمالي</div>
      <div class="cd-total-val" id="cdTotal">0 ر.س</div>
    </div>
    <button class="cd-confirm" type="button" onclick="closeCartDrawer(); openSummary()">تأكيد الطلب ✓</button>
  </div>
</div>

<!-- Phase 5 — Product Detail Modal (Bottom Sheet) -->
<div id="pdBg" class="pd-bg" onclick="if(event.target===this)closeProductDetail()">
  <div class="pd-sheet" id="pdSheet">
    <div class="pd-handle" id="pdHandle"></div>
    <button class="pd-close" type="button" aria-label="إغلاق" onclick="closeProductDetail()">✕</button>
    <div class="pd-scroll">
      <div class="pd-hero" id="pdHero"></div>
      <div class="pd-body">
        <div class="pd-title-row">
          <div class="pd-name" id="pdName"></div>
          <div class="pd-price-block">
            <div class="pd-price" id="pdPrice"></div>
            <div class="pd-orig" id="pdOrig" style="display:none"></div>
          </div>
        </div>
        <div class="pd-desc" id="pdDesc"></div>
        <div id="pdSizesSection" style="display:none">
          <div class="pd-section-label">⚖️ اختر الحجم</div>
          <div class="pd-sizes" id="pdSizes"></div>
        </div>
        <div>
          <div class="pd-section-label">📝 ملاحظات (اختياري)</div>
          <textarea id="pdNotes" class="pd-notes" placeholder="مثال: بدون سكر، مع ثلج إضافي..." maxlength="240"></textarea>
        </div>
      </div>
    </div>
    <div class="pd-footer">
      <div class="pd-qty">
        <button class="pd-qty-btn minus" id="pdMinus" type="button" onclick="pdChangeQty(-1)">−</button>
        <span class="pd-qty-num" id="pdQty">1</span>
        <button class="pd-qty-btn plus" id="pdPlus" type="button" onclick="pdChangeQty(1)">+</button>
      </div>
      <button class="pd-cta" id="pdCta" type="button" onclick="pdAddToCart()">
        <span id="pdCtaIcon">🛒</span> <span id="pdCtaText">أضف للسلة</span>
      </button>
    </div>
  </div>
</div>

<div id="cartbar">
  <div class="cm">
    <div class="cart-icon">🛒<span class="cart-badge" id="cbadge">0</span></div>
    <div class="cm-text"><div id="cc"></div><div id="ct"></div></div>
  </div>
  <button id="ok">تأكيد الطلب ✓</button>
</div>

<!-- Summary Modal — يظهر قبل التأكيد النهائي -->
<div id="summaryModal" onclick="if(event.target===this)closeSummary()">
  <div class="sm-sheet">
    <div class="sm-handle"><div class="sm-handle-bar"></div></div>
    <div class="sm-hdr">
      <div class="sm-title">🛒 ملخص الطلب</div>
      <button class="sm-close" onclick="closeSummary()">✕</button>
    </div>
    <div class="sm-body" id="smBody"></div>
    <div class="sm-total">
      <div class="sm-total-label">الإجمالي</div>
      <div class="sm-total-value" id="smTotal">0</div>
    </div>
    <!-- ⭐ Booking fields — تظهر فقط للـ orderMode=booking -->
    <div id="smBooking" style="display:none;padding:0 18px 8px;border-top:1px dashed var(--border-dim);margin-top:6px;padding-top:14px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:4px">
        <div>
          <div style="font-size:12.5px;color:var(--text-mute);font-weight:700;margin-bottom:6px">📅 التاريخ</div>
          <input type="date" id="smBookDate" style="width:100%;padding:10px;border-radius:10px;background:var(--card-bg-alt);color:var(--text);border:1px solid var(--border);font-family:inherit;font-size:14px" />
        </div>
        <div>
          <div style="font-size:12.5px;color:var(--text-mute);font-weight:700;margin-bottom:6px">⏰ الوقت</div>
          <input type="time" id="smBookTime" style="width:100%;padding:10px;border-radius:10px;background:var(--card-bg-alt);color:var(--text);border:1px solid var(--border);font-family:inherit;font-size:14px" />
        </div>
      </div>
      <div id="smBookHint" style="font-size:11.5px;color:var(--text-mute);margin-top:6px">سيتأكد المتجر من توفر هذا الوقت بعد إرسال الطلب</div>
    </div>
    <div class="sm-notes-wrap">
      <div class="sm-notes-label">📝 ملاحظات على الطلب (اختياري)</div>
      <textarea id="smNotes" class="sm-notes" placeholder="مثال: بدون سكر، مع ثلج إضافي..."></textarea>
    </div>
    <div class="sm-actions">
      <button class="sm-btn ghost" onclick="closeSummary()">إلغاء</button>
      <button class="sm-btn primary" id="confirmFinal">تأكيد الطلب ✅</button>
    </div>
  </div>
</div>

<div id="done">
  <div class="dico">✅</div>
  <h2>تم استلام طلبك! 🎉</h2>
  <p>سيتواصل معك البوت الآن<br>لإتمام بيانات التوصيل 💬</p>
  <a id="wa-back" href="#" onclick="try{window.history.back();}catch(e){}try{window.close();}catch(e){}" style="display:none;margin-top:18px;background:var(--accent);color:#000;padding:12px 28px;border-radius:24px;font-size:15px;font-weight:800;text-decoration:none">💬 العودة للمحادثة</a>
</div>

<!-- 🍽️ Dine-in dashboard (للعميل في الطاولة بعد الطلب) -->
<div id="dineInDash" style="display:none;position:fixed;inset:0;background:var(--bg);overflow-y:auto;z-index:200;padding:14px;direction:rtl">
  <div style="max-width:520px;margin:0 auto">
    <div style="background:linear-gradient(135deg,#d4af37,#b8941f);color:#1b1b1b;padding:14px 18px;border-radius:14px;margin-bottom:14px;text-align:center;font-weight:800;font-size:17px;box-shadow:0 4px 16px rgba(212,175,55,.3)">
      🍽️ <span id="dineHdrLabel">طاولة</span>
    </div>
    <div id="dineOrdersList" style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
      <button onclick="dineAddMore()" style="background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;border:none;border-radius:12px;padding:14px;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit">➕ أضف لطلبي</button>
      <button onclick="dineContact()" style="background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;border:none;border-radius:12px;padding:14px;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit">💬 اتصل بالمطعم</button>
    </div>
    <div style="text-align:center;padding:8px 10px;border-top:1px dashed var(--border);margin-top:8px">
      <button onclick="dineSessionReset()" style="background:none;color:var(--text-mute);border:1px solid var(--border);border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:inherit">🆕 ضيف جديد على الطاولة</button>
      <div style="font-size:10px;color:var(--text-mute);margin-top:6px;opacity:.6">🔄 يتحدث كل 5 ثوان</div>
    </div>
  </div>
</div>

<!-- 💬 شاشة محادثة (full chat thread) -->
<div id="dineChatScreen" style="display:none;position:fixed;inset:0;background:var(--bg);z-index:250;flex-direction:column;direction:rtl">
  <!-- Header -->
  <div style="background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:12px;box-shadow:0 2px 8px rgba(0,0,0,.2)">
    <button onclick="dineChatClose()" style="background:none;border:none;color:#fff;font-size:22px;cursor:pointer;padding:0 4px">←</button>
    <div style="flex:1">
      <div style="font-weight:800;font-size:15px">💬 محادثة مع المطعم</div>
      <div id="dineChatHdrSub" style="font-size:11px;opacity:.85"></div>
    </div>
    <div id="dineChatTyping" style="font-size:11px;opacity:.85;display:none">يكتب...</div>
  </div>
  <!-- Messages -->
  <div id="dineChatMessages" style="flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px"></div>
  <!-- Preset chips -->
  <div style="padding:6px 12px;display:flex;gap:6px;overflow-x:auto;background:var(--bg-alt);border-top:1px solid var(--border)">
    <button onclick="dineChatPreset('وين طلبي؟')" style="background:rgba(212,175,55,.15);color:var(--accent);border:1px solid rgba(212,175,55,.3);border-radius:14px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap">وين طلبي؟</button>
    <button onclick="dineChatPreset('ممكن ماء؟')" style="background:rgba(212,175,55,.15);color:var(--accent);border:1px solid rgba(212,175,55,.3);border-radius:14px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap">ممكن ماء؟</button>
    <button onclick="dineChatPreset('الحساب لو سمحت')" style="background:rgba(212,175,55,.15);color:var(--accent);border:1px solid rgba(212,175,55,.3);border-radius:14px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap">الحساب لو سمحت</button>
    <button onclick="dineChatPreset('ممكن نقل الطلب لطاولة أخرى؟')" style="background:rgba(212,175,55,.15);color:var(--accent);border:1px solid rgba(212,175,55,.3);border-radius:14px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap">نقل لطاولة أخرى</button>
  </div>
  <!-- Composer -->
  <div style="padding:10px 12px;display:flex;gap:8px;align-items:flex-end;background:var(--card-bg);border-top:1px solid var(--border)">
    <textarea id="dineChatInput" placeholder="اكتب رسالتك..." maxlength="300" rows="1" style="flex:1;padding:10px 12px;font-size:14px;font-family:inherit;border-radius:18px;border:1px solid var(--border);background:var(--bg);color:var(--text);resize:none;max-height:80px;direction:rtl" oninput="this.style.height='auto';this.style.height=Math.min(80,this.scrollHeight)+'px'" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();dineChatSend();}"></textarea>
    <button onclick="dineChatSend()" id="dineChatSendBtn" style="background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;border:none;border-radius:50%;width:42px;height:42px;cursor:pointer;font-size:18px;flex-shrink:0">📤</button>
  </div>
</div>
<script>
var TOKEN = ${token};
var CUR   = ${curr};
var PRODS = ${pdata};
var CATS  = ${cdata};
var LOGO  = ${logoJ};
var NAME  = ${nameJ};
var COLOR = ${colorJ};
var BOT_PHONE = ${phoneJ};
// ⭐ Dine-in mode (QR code on table) — يفعّل badge الطاولة + يخفي حقل العنوان
var DINE_IN     = ${JSON.stringify(!!sess.dine_in)};
var TABLE       = ${JSON.stringify(sess.table || null)};
var TABLE_LABEL = ${JSON.stringify(sess.tableLabel || (sess.table ? "طاولة " + sess.table : ""))};
var ORDER_MODE   = ${JSON.stringify(store.adminConfig?.orderMode || "cart")};
var PRIMARY_BTN  = ${JSON.stringify(store.adminConfig?.menuLayout?.primaryButtonText || "اطلب الآن")};
// ⭐ AI-driven UI: terms + layout + tagline + welcome (يعكسون نوع النشاط)
var TERMS        = ${JSON.stringify(store.adminConfig?.terms || {})};
var MENU_LAYOUT  = ${JSON.stringify(store.adminConfig?.menuLayout || {})};
var TAGLINE      = ${JSON.stringify(store.adminConfig?.tagline || "")};
var WELCOME_MSG  = ${JSON.stringify(
  String(store.adminConfig?.settings?.welcomeMessage || "")
    .replace(/\{\{\s*store_name\s*\}\}/gi, store.storeName || "متجرنا")
    .replace(/\{\{\s*biz_emoji\s*\}\}/gi, store.adminConfig?.emoji || "")
    .replace(/\{\{\s*tagline\s*\}\}/gi, store.adminConfig?.tagline || "")
)};
var BIZ_EMOJI    = ${JSON.stringify(store.adminConfig?.emoji || "🛍️")};
var BIZ_LABEL    = ${JSON.stringify(store.adminConfig?.label || "")};
// ⭐ Effective terms with defaults (للوصول الآمن من JS)
var T = {
  item:        TERMS.item        || 'منتج',
  items:       TERMS.items       || 'المنتجات',
  itemAdd:     TERMS.itemAdd     || 'أضف للسلة',
  catalog:     TERMS.catalog     || '🛒 المنتجات',
  order:       TERMS.order       || 'طلب',
  orders:      TERMS.orders      || 'الطلبات',
  customer:    TERMS.customer    || 'عميل',
  cart:        TERMS.cart        || '🛒 السلة',
  delivery:    TERMS.delivery    || 'تسليم'
};
// ⭐ Layout flags
var SHOW_QTY        = MENU_LAYOUT.showQuantityButtons !== false; // default true
var SHOW_CART_ICON  = MENU_LAYOUT.showCartIcon        !== false; // default true
var ASK_DELIVERY    = MENU_LAYOUT.askForDeliveryFee   !== false; // default true
var EXTRAS       = ${extrasJ};

// ⭐ Apply AI-driven terms + layout على الـ DOM
(function applyAiUx(){
  try {
    document.body.setAttribute('data-order-mode', ORDER_MODE);
    if (!SHOW_QTY) document.body.classList.add('hide-qty');
    if (!SHOW_CART_ICON) document.body.classList.add('no-cart');

    var orderWord = T.order || 'الطلب';
    var confirmTxt = (ORDER_MODE === 'booking') ? 'تأكيد الحجز'
                   : (ORDER_MODE === 'single')  ? 'تأكيد'
                   : ('تأكيد ' + orderWord);

    // عناوين السلة/الملخص
    var smTitle = document.querySelector('.sm-title');
    if (smTitle) smTitle.textContent = (T.cart || '🛒 السلة');
    // CTA — Product Detail
    var pdCta = document.getElementById('pdCtaText');
    if (pdCta) pdCta.textContent = (PRIMARY_BTN || T.itemAdd || 'أضف للسلة');
    // أخفِ الأيقونة 🛒 لو الـ orderMode ليس cart
    var pdIcon = document.getElementById('pdCtaIcon');
    if (pdIcon && ORDER_MODE !== 'cart') pdIcon.style.display = 'none';
    // sticky cartbar — زر OK
    var okBtn = document.getElementById('ok');
    if (okBtn) okBtn.textContent = confirmTxt + ' ✓';
    // confirmFinal في الـ summary modal
    var cfBtn = document.getElementById('confirmFinal');
    if (cfBtn) cfBtn.textContent = confirmTxt + ' ✅';
    // أزرار الـ drawer
    document.querySelectorAll('.cd-confirm').forEach(function(b){
      b.textContent = confirmTxt + ' ✓';
    });

    // tagline تحت اسم المتجر
    if (TAGLINE) {
      setTimeout(function(){
        var hdrText = document.querySelector('.hdr-text');
        if (hdrText && !hdrText.querySelector('.biz-tagline')) {
          var tag = document.createElement('div');
          tag.className = 'biz-tagline';
          tag.textContent = TAGLINE;
          var sub = hdrText.querySelector('.hdr-sub');
          if (sub) sub.after(tag); else hdrText.appendChild(tag);
        }
      }, 0);
    }

    // welcome banner (مرة واحدة لكل token)
    if (WELCOME_MSG && !sessionStorage.getItem('wb_' + TOKEN)) {
      setTimeout(function(){
        var sticky = document.querySelector('.sticky-stack');
        if (!sticky) return;
        var wb = document.createElement('div');
        wb.className = 'welcome-banner';
        wb.innerHTML = '<button class="welcome-banner-close" type="button" aria-label="إخفاء">✕</button>' +
                       (BIZ_EMOJI ? (BIZ_EMOJI + ' ') : '') +
                       String(WELCOME_MSG).replace(/[<>]/g, '');
        wb.querySelector('.welcome-banner-close').onclick = function(){
          wb.remove();
          try { sessionStorage.setItem('wb_' + TOKEN, '1'); } catch(_) {}
        };
        sticky.after(wb);
      }, 100);
    }
  } catch (e) { /* silent — لا نكسر الصفحة لو فشل */ }
})();
// 🛒 Cart persistence — يحفظ السلة في localStorage لتجنب فقدها لو WhatsApp app
// عمل reload للصفحة بعد inactivity. TTL = 24h (نفس مدة الـ token).
// 🔄 يعمل تلقائياً عبر Proxy → كل cart[id]=N أو delete cart[id] يحفظ
var _CART_KEY = 'twani_cart_' + TOKEN;
var _CART_TTL = 24 * 60 * 60 * 1000;
var _cartRestored = false;
var _cartInitial = (function(){
  try {
    var raw = localStorage.getItem(_CART_KEY);
    if (!raw) return {};
    var data = JSON.parse(raw);
    if (!data || !data.savedAt) return {};
    if (Date.now() - data.savedAt > _CART_TTL) { localStorage.removeItem(_CART_KEY); return {}; }
    _cartRestored = Object.keys(data.items || {}).filter(function(k){ return data.items[k] > 0; }).length > 0;
    return data.items || {};
  } catch (_) { return {}; }
})();
function _persistCart(obj) {
  try {
    var hasItems = Object.keys(obj).some(function(k){ return obj[k] > 0; });
    if (hasItems) localStorage.setItem(_CART_KEY, JSON.stringify({ items: obj, savedAt: Date.now() }));
    else localStorage.removeItem(_CART_KEY);
  } catch (_) {}
}
function _clearCartLS() { try { localStorage.removeItem(_CART_KEY); } catch(_){} }
// 🪝 Proxy: كل set/delete يحفظ تلقائياً
var cart = new Proxy(_cartInitial, {
  set: function(t, p, v) { t[p] = v; _persistCart(t); return true; },
  deleteProperty: function(t, p) { delete t[p]; _persistCart(t); return true; },
});
// تبديل المرجع كاملاً (مثل cart = {}) لا يمر عبر Proxy، فنُضيف helper
window._cartReplace = function(newObj) {
  Object.keys(cart).forEach(function(k){ delete cart[k]; });
  Object.keys(newObj || {}).forEach(function(k){ cart[k] = newObj[k]; });
};
// أعلِم العميل لو تم استرجاع سلة سابقة + حدّث UI ليعكسها
setTimeout(function(){
  if (_cartRestored) {
    try { if (typeof sync === 'function') sync(); } catch(_) {}
    try { if (typeof updateCartCount === 'function') updateCartCount(); } catch(_) {}
    // حدّث counters على بطاقات المنتجات (لو موجودة)
    try {
      Object.keys(cart).forEach(function(pid){
        var qEl = document.getElementById('q' + pid);
        if (qEl) { qEl.textContent = cart[pid]; qEl.className = 'cq' + (cart[pid] > 0 ? ' nz' : ''); }
        var card = document.querySelector('[data-id="' + pid + '"]');
        if (card) card.classList.toggle('has-qty', cart[pid] > 0);
      });
    } catch(_) {}
    var n = Object.keys(cart).filter(function(k){ return cart[k] > 0; }).length;
    if (n > 0 && typeof showToast === 'function') {
      showToast('♻️ تم استعادة سلتك السابقة (' + n + ' صنف)', 'success');
    }
  }
}, 1200);
var cartbar  = document.getElementById('cartbar');
var scrollEl = document.getElementById('scroll');
var tabsEl   = document.getElementById('tabs');

// ── Header (logo/icon + name + back button) ──
(function() {
  var hdr = document.getElementById('hdr');
  hdr.innerHTML = '';

  // الـ main section: logo + name
  var main = document.createElement('div');
  main.className = 'hdr-main';
  if (LOGO) {
    var img = document.createElement('img');
    img.className = 'hdr-logo';
    img.src = LOGO;
    img.onerror = function() {
      var ic = document.createElement('div');
      ic.className = 'hdr-icon';
      ic.textContent = '🛍️';
      img.replaceWith(ic);
    };
    main.appendChild(img);
  } else {
    var ic = document.createElement('div');
    ic.className = 'hdr-icon';
    ic.textContent = '🛍️';
    main.appendChild(ic);
  }
  var txtDiv = document.createElement('div');
  txtDiv.className = 'hdr-text';
  var subText = EXTRAS.isOpen
    ? ('⏰ مفتوح حتى ' + EXTRAS.hEnd + ':00')
    : ('⏰ مغلق — يفتح ' + EXTRAS.hStart + ':00');
  txtDiv.innerHTML = '<div class="hdr-name">' + NAME + '</div>' +
                     '<div class="hdr-sub">' + subText + '</div>';

  // Phase 5 — chips: status + rating + delivery + busy
  var chipsRow = document.createElement('div');
  chipsRow.className = 'hdr-chips';
  // 🍽️ dine-in chip (طاولة) — أولوية أولى — يعرض الـ label الكامل (محلي · طاولة 5 · عوائل)
  if (typeof DINE_IN !== 'undefined' && DINE_IN === true && TABLE) {
    var tableChip = document.createElement('span');
    tableChip.className = 'h-chip';
    tableChip.style.cssText = 'background:linear-gradient(135deg,#d4af37,#b8941f);color:#1b1b1b;font-weight:800;font-size:13px;padding:4px 10px';
    tableChip.textContent = '🍽️ ' + (TABLE_LABEL || ('طاولة ' + TABLE));
    chipsRow.appendChild(tableChip);
  }
  // status chip
  var statusChip = document.createElement('span');
  statusChip.className = 'h-chip ' + (EXTRAS.isOpen ? 'open' : 'closed');
  statusChip.textContent = (EXTRAS.isOpen ? '🟢 مفتوح الآن' : '🔴 مغلق حالياً');
  chipsRow.appendChild(statusChip);
  // rating chip
  if (EXTRAS.rating && EXTRAS.ratingCount > 0) {
    var rateChip = document.createElement('span');
    rateChip.className = 'h-chip rating';
    rateChip.textContent = '⭐ ' + EXTRAS.rating + ' (' + EXTRAS.ratingCount + ')';
    chipsRow.appendChild(rateChip);
  }
  // delivery chip
  if (EXTRAS.avgDeliveryMin) {
    var delChip = document.createElement('span');
    delChip.className = 'h-chip delivery';
    delChip.textContent = '🚴 ~' + EXTRAS.avgDeliveryMin + ' دقيقة';
    chipsRow.appendChild(delChip);
  }
  // busy chip (orders today)
  if (EXTRAS.ordersToday >= 20) {
    var busyChip = document.createElement('span');
    busyChip.className = 'h-chip busy';
    busyChip.textContent = '🔥 ' + EXTRAS.ordersToday + ' طلب اليوم';
    chipsRow.appendChild(busyChip);
  }
  txtDiv.appendChild(chipsRow);

  main.appendChild(txtDiv);
  hdr.appendChild(main);

  // زر العودة للواتساب (مخفي في وضع dine-in — العميل في المطعم لا في محادثة)
  if (!(typeof DINE_IN !== 'undefined' && DINE_IN === true)) {
    var back = document.createElement('button');
    back.className = 'hdr-back';
    back.title = 'العودة للمحادثة';
    back.textContent = '🔙';
    back.addEventListener('click', function() {
      if (!confirm('هل تريد العودة للمحادثة؟ (سيتم إلغاء السلة الحالية)')) return;
      try { window.history.back(); } catch(e) {}
      if (BOT_PHONE) {
        try { window.location.href = 'whatsapp://send?phone=' + BOT_PHONE; } catch(e) {}
      }
      setTimeout(function(){ try { window.close(); } catch(e) {} }, 600);
    });
    hdr.appendChild(back);
  }
})();

// ── Build card sections ──
function esc(s) {
  var d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
}

// 🏠 ═══════════════ Accommodation Card + Booking Flow ═══════════════
var AMENITY_LABELS_INLINE = {
  wifi:"📶", pool:"🏊", bbq:"🔥", parking:"🚗", kitchen:"🍳", ac:"❄️", heater:"🔆",
  tv:"📺", washer:"🧺", balcony:"🌅", garden:"🌳", seaview:"🌊", jacuzzi:"🛁", gym:"🏋️"
};

function buildAccommodationCard(pid, p) {
  var acm = p.accommodation || {};
  var av  = p.availability || { available: true };
  var card = document.createElement('div');
  card.className = 'card acm-card';
  card.dataset.pid = pid;
  card.style.cssText = 'background:#0e1a14;border:1px solid rgba(8,145,178,0.4);border-radius:16px;overflow:visible;position:relative;display:flex;flex-direction:column;grid-column:span 2;box-shadow:0 4px 14px rgba(0,0,0,0.2)';

  // Badge حالة
  var badgeColor = '#16a34a', badgeText = '🟢 متاح';
  if (av.available === false && av.currentBooking) {
    var endD = new Date(av.currentBooking.endAt);
    badgeColor = '#dc2626';
    badgeText = '🔴 محجوز حتى ' + endD.toLocaleDateString('ar-EG',{month:'short',day:'numeric'});
  } else if (av.nextBooking) {
    var nextD = new Date(av.nextBooking.startAt);
    badgeColor = '#f59e0b';
    badgeText = '🟡 متاح حتى ' + nextD.toLocaleDateString('ar-EG',{month:'short',day:'numeric'});
  }
  var badge = document.createElement('span');
  badge.style.cssText = 'position:absolute;top:12px;left:12px;background:'+badgeColor+';color:#fff;padding:6px 12px;border-radius:10px;font-size:12px;font-weight:800;box-shadow:0 4px 12px rgba(0,0,0,.3);z-index:5';
  badge.textContent = badgeText;
  card.appendChild(badge);

  // Image
  var imgDiv = document.createElement('div');
  imgDiv.style.cssText = 'width:100%;aspect-ratio:16/10;background:#1a1a1a;display:flex;align-items:center;justify-content:center;font-size:64px;overflow:hidden;border-radius:16px 16px 0 0';
  if (p.imageUrl) {
    var im = document.createElement('img');
    im.src = p.imageUrl;
    im.alt = p.name;
    im.loading = 'lazy';
    im.style.cssText = 'width:100%;height:100%;object-fit:cover';
    imgDiv.appendChild(im);
  } else {
    imgDiv.textContent = '🏠';
  }
  card.appendChild(imgDiv);

  // Body
  var body = document.createElement('div');
  body.style.cssText = 'padding:16px 18px;display:flex;flex-direction:column;gap:10px';

  var name = document.createElement('div');
  name.style.cssText = 'font-size:18px;font-weight:900;color:#f1f5f4;line-height:1.3';
  name.textContent = p.name;
  body.appendChild(name);

  if (acm.location) {
    var loc = document.createElement('div');
    loc.style.cssText = 'font-size:13px;color:#9ca3af';
    loc.textContent = '📍 ' + acm.location;
    body.appendChild(loc);
  }

  // Chips
  var chips = [];
  if (acm.bedrooms)  chips.push('🛏 ' + acm.bedrooms + ' غرف');
  if (acm.bathrooms) chips.push('🚿 ' + acm.bathrooms + ' حمام');
  if (acm.maxGuests) chips.push('👥 ' + acm.maxGuests + ' ضيف');
  if (acm.sizeM2)    chips.push('📐 ' + acm.sizeM2 + 'م²');
  if (chips.length) {
    var chipsDiv = document.createElement('div');
    chipsDiv.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;font-size:13px;color:#e0b85f;font-weight:700';
    chipsDiv.textContent = chips.join(' · ');
    body.appendChild(chipsDiv);
  }

  // Amenities
  if (Array.isArray(acm.amenities) && acm.amenities.length) {
    var amenDiv = document.createElement('div');
    amenDiv.style.cssText = 'font-size:22px;letter-spacing:6px';
    amenDiv.textContent = acm.amenities.slice(0,8).map(function(a){return AMENITY_LABELS_INLINE[a]||'';}).filter(Boolean).join(' ');
    body.appendChild(amenDiv);
  }

  // Times + minNights
  if (acm.checkInTime || acm.checkOutTime) {
    var timesDiv = document.createElement('div');
    timesDiv.style.cssText = 'font-size:12px;color:#9ca3af';
    timesDiv.textContent = '🔑 الوصول: ' + (acm.checkInTime||'15:00') + ' · 👋 المغادرة: ' + (acm.checkOutTime||'12:00');
    body.appendChild(timesDiv);
  }
  if (acm.minNights && acm.minNights > 1) {
    var minDiv = document.createElement('div');
    minDiv.style.cssText = 'font-size:12px;color:#f59e0b';
    minDiv.textContent = '⚠️ الحد الأدنى ' + acm.minNights + ' ليالي';
    body.appendChild(minDiv);
  }

  // Description
  if (p.description) {
    var desc = document.createElement('div');
    desc.style.cssText = 'font-size:13px;color:#cfd8d4;line-height:1.6;opacity:.85';
    desc.textContent = p.description;
    body.appendChild(desc);
  }

  // Bottom: price + button
  var bottom = document.createElement('div');
  bottom.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:6px;padding-top:12px;border-top:1px dashed rgba(255,255,255,0.1)';

  var price = document.createElement('div');
  price.style.cssText = 'font-size:22px;font-weight:900;color:#0891b2';
  price.innerHTML = p.price + ' <small style="font-size:12px;color:#9ca3af;font-weight:600">' + CUR + '/ليلة</small>';
  bottom.appendChild(price);

  var btn = document.createElement('button');
  btn.style.cssText = 'background:linear-gradient(135deg,#0891b2,#0e7490);color:#fff;border:none;padding:12px 22px;border-radius:10px;font-family:inherit;font-weight:800;font-size:14px;cursor:pointer;box-shadow:0 4px 14px rgba(8,145,178,0.4)';
  btn.textContent = '📅 احجز الآن';
  btn.onclick = function(e){ e.stopPropagation(); openAcmBooking(pid); };
  bottom.appendChild(btn);
  body.appendChild(bottom);

  card.appendChild(body);
  return card;
}

// 🏠 Booking modal للوحدة العقارية
var _ACM_PID = null;
var _ACM_BOOKED_DAYS = {};
var _ACM_CHECKIN = null;
var _ACM_CHECKOUT = null;
var _ACM_CAL_MONTH = new Date();

async function openAcmBooking(pid) {
  _ACM_PID = pid;
  _ACM_CHECKIN = null;
  _ACM_CHECKOUT = null;
  _ACM_CAL_MONTH = new Date();
  var p = PRODS[pid];
  var modal = document.getElementById('acmBookingModal');
  if (!modal) modal = createAcmModal();
  document.getElementById('acmUnitName').textContent = p.name;
  document.getElementById('acmUnitPrice').textContent = p.price + ' ' + CUR + '/ليلة';
  document.getElementById('acmGuests').max = (p.accommodation && p.accommodation.maxGuests) || 99;
  document.getElementById('acmGuests').value = 2;
  document.getElementById('acmName').value = '';
  document.getElementById('acmPhone').value = '';
  document.getElementById('acmNotes').value = '';
  document.getElementById('acmAvailMsg').style.display = 'none';
  // 🏖️ Build extras checkboxes
  _ACM_EXTRAS = {};
  var extrasBox = document.getElementById('acmExtrasBox');
  var acmCfg = p.accommodation || {};
  var extras = Array.isArray(acmCfg.extras) ? acmCfg.extras : [];
  if (extras.length && extrasBox) {
    extrasBox.style.display = '';
    var ehtml = '<label style="font-size:12px;color:#cfd8d4;display:block;margin-bottom:6px;margin-top:8px">✨ إضافات اختيارية</label>';
    extras.forEach(function(e){
      var safeKey = String(e.key).replace(/[^a-zA-Z0-9_-]/g,'');
      ehtml += '<label style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(0,0,0,0.25);border:1px solid rgba(201,162,75,0.2);border-radius:7px;margin-bottom:6px;cursor:pointer">' +
        '<input type="checkbox" data-acmextra="'+safeKey+'" style="cursor:pointer">' +
        '<span style="flex:1;font-size:13px;color:#f1f5f4">'+esc(e.label)+'</span>' +
        '<span style="color:#e0b85f;font-weight:700;font-size:13px">+'+e.price+' '+CUR+'</span>' +
        '</label>';
    });
    extrasBox.innerHTML = ehtml;
    extrasBox.querySelectorAll('[data-acmextra]').forEach(function(cb){
      cb.addEventListener('change', function(){
        _ACM_EXTRAS[cb.getAttribute('data-acmextra')] = cb.checked;
        recalcAcmTotal();
      });
    });
  } else if (extrasBox) {
    extrasBox.style.display = 'none';
    extrasBox.innerHTML = '';
  }
  modal.style.display = 'flex';
  // اجلب الفترات المحجوزة
  try {
    var r = await fetch('/api/menu-token/' + TOKEN + '/unit-bookings/' + encodeURIComponent(pid));
    if (r.ok) {
      var d = await r.json();
      _ACM_BOOKED_DAYS = {};
      (d.periods||[]).forEach(function(per){
        var s = new Date(per.startAt).getTime();
        var e = new Date(per.endAt).getTime();
        for (var t = s; t < e; t += 86400000) {
          _ACM_BOOKED_DAYS[new Date(t).toISOString().slice(0,10)] = true;
        }
      });
    }
  } catch {}
  renderAcmCalendar();
  recalcAcmTotal();
}

function createAcmModal() {
  var m = document.createElement('div');
  m.id = 'acmBookingModal';
  m.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;align-items:center;justify-content:center;padding:16px';
  m.onclick = function(e){ if(e.target===m) m.style.display='none'; };
  m.innerHTML =
    '<div style="background:#0e1a14;border:1px solid rgba(201,162,75,0.35);border-radius:14px;max-width:480px;width:100%;max-height:92vh;overflow-y:auto">' +
    '<div style="padding:18px 22px;border-bottom:1px solid rgba(201,162,75,0.2);background:linear-gradient(135deg,rgba(8,145,178,0.12),transparent);display:flex;justify-content:space-between;align-items:center;gap:10px">' +
    '<div><div style="font-weight:800;font-size:17px;color:#f1f5f4">📅 احجز <span id="acmUnitName" style="color:#0891b2"></span></div>' +
    '<div style="font-size:12px;color:#9ca3af;margin-top:3px"><b id="acmUnitPrice" style="color:#e0b85f"></b></div></div>' +
    '<button onclick="document.getElementById(\\'acmBookingModal\\').style.display=\\'none\\'" style="background:none;border:none;color:#9ca3af;font-size:24px;cursor:pointer">×</button></div>' +
    '<div style="padding:18px 22px;display:flex;flex-direction:column;gap:14px">' +
    '<div style="padding:14px;background:rgba(0,0,0,0.3);border:1px solid rgba(201,162,75,0.2);border-radius:10px"><div id="acmCal"></div></div>' +
    '<div><label style="font-size:12px;color:#cfd8d4;display:block;margin-bottom:4px">👥 عدد الأشخاص</label>' +
    '<input type="number" id="acmGuests" min="1" value="2" style="width:100%;padding:10px;background:rgba(0,0,0,0.4);border:1px solid rgba(201,162,75,0.3);border-radius:8px;color:#f1f5f4;font-size:13px;box-sizing:border-box"></div>' +
    '<div id="acmExtrasBox" style="display:none"></div>' +
    '<div id="acmAvailMsg" style="display:none;padding:10px;background:rgba(220,38,38,0.15);border:1px solid rgba(220,38,38,0.4);border-radius:8px;color:#fca5a5;font-size:13px;text-align:center"></div>' +
    '<div id="acmTotalBox" style="padding:14px;background:rgba(8,145,178,0.1);border:1px solid rgba(8,145,178,0.3);border-radius:10px;text-align:center"></div>' +
    '<div style="border-top:1px dashed rgba(201,162,75,0.2);padding-top:14px">' +
    '<label style="font-size:12px;color:#cfd8d4;display:block;margin-bottom:4px">👤 اسمك</label>' +
    '<input id="acmName" maxlength="80" placeholder="الاسم الكامل" style="width:100%;padding:10px;background:rgba(0,0,0,0.4);border:1px solid rgba(201,162,75,0.3);border-radius:8px;color:#f1f5f4;font-size:13px;box-sizing:border-box;margin-bottom:10px">' +
    '<label style="font-size:12px;color:#cfd8d4;display:block;margin-bottom:4px">📱 رقم الجوال</label>' +
    '<input id="acmPhone" type="tel" dir="ltr" placeholder="966500000000" style="width:100%;padding:10px;background:rgba(0,0,0,0.4);border:1px solid rgba(201,162,75,0.3);border-radius:8px;color:#f1f5f4;font-size:13px;box-sizing:border-box;margin-bottom:10px">' +
    '<label style="font-size:12px;color:#cfd8d4;display:block;margin-bottom:4px">📝 ملاحظات</label>' +
    '<textarea id="acmNotes" rows="2" maxlength="300" style="width:100%;padding:10px;background:rgba(0,0,0,0.4);border:1px solid rgba(201,162,75,0.3);border-radius:8px;color:#f1f5f4;font-size:13px;box-sizing:border-box;resize:vertical"></textarea></div></div>' +
    '<div style="padding:14px 22px;border-top:1px solid rgba(201,162,75,0.15);display:flex;gap:10px;justify-content:flex-end">' +
    '<button onclick="document.getElementById(\\'acmBookingModal\\').style.display=\\'none\\'" style="background:transparent;border:1px solid rgba(201,162,75,0.3);color:#cfd8d4;padding:10px 18px;border-radius:8px;cursor:pointer;font-size:13px">إلغاء</button>' +
    '<button id="acmSubmitBtn" onclick="submitAcmBooking()" style="background:linear-gradient(135deg,#0891b2,#0e7490);color:#fff;border:none;padding:10px 24px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:800">✅ أكّد الحجز</button></div></div>';
  document.body.appendChild(m);
  return m;
}

function _acmRangeHasBooked(from, to) {
  var f = new Date(from).getTime();
  var t = new Date(to).getTime();
  for (var x = f; x < t; x += 86400000) {
    if (_ACM_BOOKED_DAYS[new Date(x).toISOString().slice(0,10)]) return true;
  }
  return false;
}

function renderAcmCalendar() {
  var box = document.getElementById('acmCal');
  if (!box) return;
  var today = new Date(); today.setHours(0,0,0,0);
  var todayKey = today.toISOString().slice(0,10);
  var y = _ACM_CAL_MONTH.getFullYear();
  var m = _ACM_CAL_MONTH.getMonth();
  var firstDay = new Date(y, m, 1).getDay();
  var days = new Date(y, m+1, 0).getDate();
  var label = _ACM_CAL_MONTH.toLocaleDateString('ar-EG',{year:'numeric',month:'long'});
  var ci = _ACM_CHECKIN, co = _ACM_CHECKOUT;
  var WD = ['أحد','اثن','ثلا','أرب','خمي','جمع','سبت'];
  var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
    '<button onclick="_acmNav(-1)" style="background:rgba(201,162,75,0.15);border:1px solid rgba(201,162,75,0.3);color:#e0b85f;padding:6px 12px;border-radius:7px;cursor:pointer;font-size:13px">← السابق</button>' +
    '<span style="font-weight:800;color:#e0b85f;font-size:14px">' + label + '</span>' +
    '<button onclick="_acmNav(1)" style="background:rgba(201,162,75,0.15);border:1px solid rgba(201,162,75,0.3);color:#e0b85f;padding:6px 12px;border-radius:7px;cursor:pointer;font-size:13px">التالي →</button></div>' +
    '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;direction:rtl">';
  for (var i = 0; i < 7; i++) html += '<div style="text-align:center;font-weight:700;font-size:11px;color:#9ca3af;padding:4px 0">'+WD[i]+'</div>';
  for (var i = 0; i < firstDay; i++) html += '<div></div>';
  for (var d = 1; d <= days; d++) {
    var dObj = new Date(y, m, d);
    var key = dObj.toISOString().slice(0,10);
    var isPast = dObj.getTime() < today.getTime();
    var isBooked = !!_ACM_BOOKED_DAYS[key];
    var isToday = key === todayKey;
    var isCi = ci === key, isCo = co === key;
    var isRange = ci && co && key > ci && key < co;
    var bg = 'rgba(0,0,0,0.3)', col = '#cfd8d4', bd = '1px solid transparent', cur = 'pointer', tip = '';
    if (isBooked) { bg = 'rgba(220,38,38,0.25)'; col = '#fca5a5'; cur = 'not-allowed'; tip = 'محجوز'; }
    else if (isPast) { bg = 'rgba(0,0,0,0.15)'; col = '#6b7280'; cur = 'not-allowed'; }
    if (isCi || isCo) { bg = 'linear-gradient(135deg,#0891b2,#0e7490)'; col = '#fff'; bd = '1px solid #0e7490'; tip = isCi?'🔑 الوصول':'👋 المغادرة'; }
    else if (isRange) { bg = 'rgba(8,145,178,0.3)'; col = '#a5f3fc'; }
    if (isToday && !isCi && !isCo) bd = '1px solid #e0b85f';
    var click = (isPast || isBooked) ? '' : ' onclick="_acmPick(\\'' + key + '\\')"';
    html += '<div title="'+tip+'"'+click+' style="background:'+bg+';color:'+col+';border:'+bd+';border-radius:6px;padding:7px 2px;text-align:center;font-size:12px;font-weight:600;cursor:'+cur+';min-height:34px;display:flex;align-items:center;justify-content:center">'+d+'</div>';
  }
  html += '</div>' +
    '<div style="display:flex;justify-content:center;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:11px;color:#9ca3af">' +
    '<span><span style="display:inline-block;width:12px;height:12px;background:rgba(220,38,38,0.25);border-radius:3px;vertical-align:middle"></span> محجوز</span>' +
    '<span><span style="display:inline-block;width:12px;height:12px;background:rgba(8,145,178,0.3);border-radius:3px;vertical-align:middle"></span> فترتك</span></div>' +
    '<div style="text-align:center;margin-top:8px;font-size:12px;color:'+(ci&&co?'#86efac':'#fcd34d')+'">' +
    (ci&&co?('✅ '+ci+' → '+co):(ci?'🔑 الوصول: '+ci+' — الآن اختر تاريخ المغادرة':'👇 اضغط على يوم لاختيار تاريخ الوصول'))+'</div>';
  box.innerHTML = html;
}
function _acmNav(delta) { _ACM_CAL_MONTH.setMonth(_ACM_CAL_MONTH.getMonth()+delta); renderAcmCalendar(); }
function _acmPick(key) {
  if (!_ACM_CHECKIN || (_ACM_CHECKIN && _ACM_CHECKOUT)) {
    _ACM_CHECKIN = key; _ACM_CHECKOUT = null;
  } else {
    if (key <= _ACM_CHECKIN) { _ACM_CHECKIN = key; _ACM_CHECKOUT = null; }
    else if (_acmRangeHasBooked(_ACM_CHECKIN, key)) {
      document.getElementById('acmAvailMsg').innerHTML = '❌ الفترة المختارة تتداخل مع حجز موجود';
      document.getElementById('acmAvailMsg').style.display = '';
      return;
    } else {
      _ACM_CHECKOUT = key;
      document.getElementById('acmAvailMsg').style.display = 'none';
    }
  }
  renderAcmCalendar();
  recalcAcmTotal();
}
// 🏖️ Saudi pricing: weekday/weekend/holidays + extras
var _ACM_EXTRAS = {}; // key → selected boolean
function _acmIsWeekendKey(key) {
  // key = "YYYY-MM-DD"
  var d = new Date(key + 'T12:00:00');
  var day = d.getDay();
  return day === 5 || day === 6; // Friday + Saturday
}
function _acmIsHolidayKey(key, holidays) {
  return Array.isArray(holidays) && holidays.indexOf(key) >= 0;
}
function recalcAcmTotal() {
  var box = document.getElementById('acmTotalBox');
  var btn = document.getElementById('acmSubmitBtn');
  if (!_ACM_CHECKIN || !_ACM_CHECKOUT) {
    box.innerHTML = '<span style="color:#9ca3af;font-size:13px">اختر تاريخي الوصول والمغادرة</span>';
    btn.disabled = true; return;
  }
  var nights = Math.ceil((new Date(_ACM_CHECKOUT) - new Date(_ACM_CHECKIN)) / 86400000);
  var p = PRODS[_ACM_PID];
  var acm = p.accommodation || {};
  if (acm.minNights && nights < acm.minNights) {
    box.innerHTML = '<span style="color:#f59e0b">⚠️ الحد الأدنى ' + acm.minNights + ' ليالي</span>';
    btn.disabled = true; return;
  }
  // حساب per-night حسب نوع اليوم (weekday/weekend/holiday)
  var pw  = Number(acm.priceWeekday) || Number(p.price) || 0;
  var pwk = Number(acm.priceWeekend) || pw;
  var ph  = Number(acm.priceHoliday) || pwk;
  var holidays = acm.holidays || [];
  var total = 0;
  var lines = [];
  var weekdayCount = 0, weekendCount = 0, holidayCount = 0;
  var cur = new Date(_ACM_CHECKIN);
  for (var i = 0; i < nights; i++) {
    var key = cur.toISOString().slice(0,10);
    var price, label;
    if (_acmIsHolidayKey(key, holidays))   { label = '🎉 إجازة'; price = ph; holidayCount++; }
    else if (_acmIsWeekendKey(key))         { label = '🌙 ويكند'; price = pwk; weekendCount++; }
    else                                    { label = '📅 يوم'; price = pw; weekdayCount++; }
    lines.push({ key: key, label: label, price: price });
    total += price;
    cur.setDate(cur.getDate() + 1);
  }
  // إضافات
  var extrasLines = [];
  var extras = Array.isArray(acm.extras) ? acm.extras : [];
  extras.forEach(function(e){
    if (_ACM_EXTRAS[e.key]) {
      total += Number(e.price);
      extrasLines.push({ label: '✨ ' + e.label, price: e.price });
    }
  });
  // breakdown summary
  var summaryParts = [];
  if (weekdayCount)  summaryParts.push(weekdayCount + ' × ' + pw + ' (عادي)');
  if (weekendCount)  summaryParts.push(weekendCount + ' × ' + pwk + ' (ويكند)');
  if (holidayCount)  summaryParts.push(holidayCount + ' × ' + ph + ' (إجازة)');
  var summary = summaryParts.join(' + ');
  var extrasHTML = extrasLines.map(function(e){ return '<div style="font-size:12px;color:#86efac">'+e.label+': +'+e.price+' '+CUR+'</div>'; }).join('');
  box.innerHTML =
    '<div style="font-size:13px;color:#9ca3af">'+nights+' ليلة: '+summary+'</div>' +
    extrasHTML +
    '<div style="font-size:26px;font-weight:900;color:#e0b85f;margin-top:6px">'+total+' '+CUR+'</div>';
  btn.disabled = false;
}
// 📱 تحقق محلي من رقم الجوال (يمنع الإرسال للسيرفر إذا كان خاطئ)
// ⚠️ هذا الكود مُولَّد داخل template literal — لذا \\n و \\D ضرورية
function _validatePhoneClient(rawPhone) {
  var phone = String(rawPhone || '').trim().replace(/\\D/g,'').replace(/^00/, '');
  if (!phone || phone.length < 10 || phone.length > 15) {
    return { ok: false, msg: '⚠️ رقم الجوال غير صحيح\\n\\nاكتب الرقم بصيغة:\\n✓ 966512345678 (سعودية)\\n✓ 201012345678 (مصر)\\n\\nبدون 0 في البداية، بدون + أو مسافات.' };
  }
  if (phone[0] === '0') {
    return { ok: false, msg: '⚠️ ابدأ برمز الدولة (لا تضع 0 في البداية)\\n\\nأمثلة:\\n✓ سعودية: 966 ثم 5XXXXXXXX\\n✓ مصر: 20 ثم 1XXXXXXXXX\\n✓ إمارات: 971 ثم 5XXXXXXX' };
  }
  var KNOWN_CC = ['966','971','973','974','965','968','962','964','963','961','970','20','212','213','216','218','249','252','253','967','90','60','62','91','92'];
  var hasCC = KNOWN_CC.some(function(cc){ return phone.indexOf(cc) === 0; });
  if (!hasCC) {
    return { ok: false, msg: '⚠️ رمز الدولة في بداية الرقم غير معروف\\n\\nتأكد من البداية:\\n✓ سعودية: 966\\n✓ مصر: 20\\n✓ إمارات: 971\\n✓ كويت: 965' };
  }
  return { ok: true, phone: phone };
}

async function submitAcmBooking() {
  if (!_ACM_CHECKIN || !_ACM_CHECKOUT) return;
  var name = document.getElementById('acmName').value.trim();
  var phoneRaw = document.getElementById('acmPhone').value;
  if (!name) { alert('⚠️ الاسم مطلوب'); return; }
  // ⛔ تحقق صلب من الرقم — نوقف العملية إذا كان خاطئ
  var v = _validatePhoneClient(phoneRaw);
  if (!v.ok) {
    alert(v.msg);
    var inp = document.getElementById('acmPhone');
    if (inp) { inp.style.border = '2px solid #dc2626'; inp.focus(); inp.scrollIntoView({behavior:'smooth',block:'center'}); }
    return;
  }
  var phone = v.phone;
  var p = PRODS[_ACM_PID];
  // 🏖️ اجمع الـ extras المُختارة
  var selectedExtras = Object.keys(_ACM_EXTRAS).filter(function(k){ return _ACM_EXTRAS[k]; });
  var payload = {
    unitId: _ACM_PID, unitName: p.name,
    startAt: _ACM_CHECKIN + 'T15:00:00', endAt: _ACM_CHECKOUT + 'T12:00:00',
    pricePerNight: p.price,
    guests: parseInt(document.getElementById('acmGuests').value) || 1,
    customerName: name, customerPhone: phone,
    notes: document.getElementById('acmNotes').value.trim().slice(0,300),
    extras: selectedExtras,
  };
  var btn = document.getElementById('acmSubmitBtn');
  btn.disabled = true; btn.textContent = '⏳ جاري الحجز...';
  try {
    var r = await fetch('/api/menu-token/'+TOKEN+'/book-unit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    var d = await r.json();
    if (!r.ok) {
      // عرض رسالة السيرفر لو فيها message (لتفصيل أكثر)
      alert(d.message || d.error || 'فشل الحجز');
      btn.disabled = false; btn.textContent = '✅ أكّد الحجز';
      if (d.error === 'MISSING_COUNTRY_CODE' || d.error === 'INVALID_COUNTRY_CODE') {
        var inp2 = document.getElementById('acmPhone');
        if (inp2) { inp2.style.border = '2px solid #dc2626'; inp2.focus(); }
      }
      return;
    }
    document.getElementById('acmBookingModal').style.display = 'none';
    var done = document.getElementById('done');
    if (done) { done.style.display = 'flex'; }
    alert('✅ تم استلام طلب الحجز — سيتواصل معك المتجر للتأكيد');
  } catch (e) { alert('خطأ: ' + e.message); btn.disabled = false; btn.textContent = '✅ أكّد الحجز'; }
}

var multiCat = CATS.length > 1;

// Phase 5 — Skeleton: render 6 placeholders ثم clear بعد render الـ products
(function renderSkeleton(){
  var sk = document.getElementById('skeleton');
  if (!sk) return;
  for (var i = 0; i < 6; i++) {
    sk.innerHTML += '<div class="skel-card"><div class="skel-img"></div><div class="skel-body"><div class="skel-line w-70"></div><div class="skel-line w-90"></div><div class="skel-line w-90"></div><div class="skel-line w-40"></div></div></div>';
  }
})();

CATS.forEach(function(cat, ci) {
  var sec = document.createElement('div');
  sec.className = 'cat-section' + (ci === 0 ? ' visible' : '');
  sec.id = 'cat-' + cat.id;

  if (multiCat) {
    var lbl = document.createElement('div');
    lbl.className = 'cat-label';
    lbl.innerHTML = '<span>' + esc(cat.emoji) + '</span><span>' + esc(cat.name) + '</span>';
    sec.appendChild(lbl);
  }

  var grid = document.createElement('div');
  grid.className = 'grid';

  cat.items.forEach(function(pid) {
    var p = PRODS[pid];
    if (!p) return;

    // 🏠 لو وحدة عقارية → render accommodation card مخصص
    if (p.accommodation) {
      var acmCard = buildAccommodationCard(pid, p);
      grid.appendChild(acmCard);
      return;
    }

    var card = document.createElement('div');
    card.className = 'card';
    card.dataset.pid = pid;
    card.dataset.cat = String(p.categoryId || cat.id || '');
    card.dataset.sub = String(p.subCategoryId || '');

    // Image wrapper
    var imgDiv = document.createElement('div');
    imgDiv.className = 'c-img';
    // ⭐ Badge "+N صور" لو في صور إضافية
    var imgCount = Array.isArray(p.images) ? p.images.length : 0;
    if (imgCount > 1) {
      var multiBadge = document.createElement('div');
      multiBadge.style.cssText = 'position:absolute;inset-block-start:8px;inset-inline-end:8px;background:rgba(0,0,0,0.65);color:#fff;padding:3px 8px;border-radius:12px;font-size:10.5px;font-weight:700;z-index:3;backdrop-filter:blur(6px);display:flex;align-items:center;gap:3px';
      multiBadge.innerHTML = '📷 ' + imgCount;
      imgDiv.appendChild(multiBadge);
    }
    if (p.imageUrl) {
      var img = document.createElement('img');
      img.src = p.imageUrl;
      img.alt = p.name;
      img.loading = 'lazy';
      img.onerror = function() { imgDiv.innerHTML = '<div class="no-img">🍽️</div>'; };
      imgDiv.appendChild(img);
    } else {
      imgDiv.innerHTML = '<div class="no-img">🍽️</div>';
    }
    // 🎬 Video badge — يفتح modal للمشاهدة (sub: stop propagation حتى لا يفتح Detail)
    if (p.video && p.video.src) {
      var vidBadge = document.createElement('button');
      vidBadge.className = 'c-vid-badge';
      vidBadge.type = 'button';
      vidBadge.innerHTML = '▶ فيديو';
      vidBadge.title = 'شاهد الفيديو';
      vidBadge.addEventListener('click', function(ev){
        ev.stopPropagation();
        openVideoModal(p.video, p.name, p.videoCaption || '');
      });
      imgDiv.appendChild(vidBadge);
    }
    // 🏷️ Marketing badges (top-right corner)
    if (Array.isArray(p.badges) && p.badges.length) {
      var badgesWrap = document.createElement('div');
      badgesWrap.className = 'c-badges';
      p.badges.forEach(function(b){
        var bEl = document.createElement('span');
        bEl.className = 'c-badge ' + b.kind;
        bEl.textContent = b.emoji + ' ' + b.label;
        badgesWrap.appendChild(bEl);
      });
      imgDiv.appendChild(badgesWrap);
    }
    // 👆 Click card → فتح Product Detail Modal (إلا إن ضغط أزرار +/- أو الفيديو)
    card.style.cursor = 'pointer';
    card.addEventListener('click', function(ev){
      if (ev.target.closest('.c-ctrl, .cb-single, .c-vid-badge, .sz-btn')) return;
      openProductDetail(pid);
    });

    // Body
    var body = document.createElement('div');
    body.className = 'c-body';

    var nameEl = document.createElement('div');
    nameEl.className = 'c-name';
    nameEl.textContent = p.name;
    body.appendChild(nameEl);

    if (p.description) {
      var descEl = document.createElement('div');
      descEl.className = 'c-desc';
      descEl.textContent = p.description;
      body.appendChild(descEl);
    }

    // أحجام (sizes) — لو المنتج له variants
    if (p.sizes && p.sizes.length) {
      var szWrap = document.createElement('div');
      szWrap.className = 'c-sizes';
      p.sizes.forEach(function(sz, si) {
        var szBtn = document.createElement('button');
        szBtn.className = 'sz-btn' + (si === 0 ? ' active' : '');
        szBtn.textContent = sz.label + ' (' + sz.price + ')';
        szBtn.dataset.price = sz.price;
        szBtn.dataset.label = sz.label;
        szBtn.addEventListener('click', function() {
          szWrap.querySelectorAll('.sz-btn').forEach(function(b){ b.classList.remove('active'); });
          szBtn.classList.add('active');
          // تحديث السعر الظاهر
          var pe = card.querySelector('.c-price');
          if (pe) pe.textContent = sz.price + ' ' + CUR;
          // تحديث السعر الفعلي للمنتج في PRODS
          PRODS[pid].selectedSize = sz.label;
          PRODS[pid].price = Number(sz.price);
          sync();
        });
        szWrap.appendChild(szBtn);
      });
      // الحجم الافتراضي = الأول
      if (p.sizes[0]) {
        PRODS[pid].selectedSize = p.sizes[0].label;
        PRODS[pid].price = Number(p.sizes[0].price);
      }
      body.appendChild(szWrap);
    }

    var foot = document.createElement('div');
    foot.className = 'c-foot';

    var priceEl = document.createElement('div');
    priceEl.className = 'c-price';
    var priceTxt = PRODS[pid].priceOnRequest ? '💬 السعر بالتفاوض' : ((PRODS[pid].price || p.price) + ' ' + CUR);
    if (p.originalPrice && p.originalPrice > p.price) {
      var origSpan = document.createElement('span');
      origSpan.className = 'c-orig-price';
      origSpan.textContent = p.originalPrice + ' ' + CUR;
      priceEl.appendChild(origSpan);
      var curSpan = document.createElement('span');
      curSpan.textContent = priceTxt;
      priceEl.appendChild(curSpan);
    } else {
      priceEl.textContent = priceTxt;
    }
    foot.appendChild(priceEl);

    var ctrl = document.createElement('div');
    ctrl.className = 'c-ctrl';
    // ⭐ single + booking → زر واحد ("اطلب"/"احجز"). cart → quantity buttons
    var singleLike = (ORDER_MODE === 'single' || ORDER_MODE === 'booking');
    var singleLabel = (ORDER_MODE === 'booking')
      ? (PRIMARY_BTN || T.itemAdd || 'احجز هذا')
      : (PRIMARY_BTN || T.itemAdd || 'اطلب الآن');
    ctrl.innerHTML =
      (singleLike
        ? '<button class="cb-single" data-id="' + esc(pid) + '">' + esc(singleLabel) + '</button>'
        : '<button class="cb minus zero" data-id="' + esc(pid) + '">−</button>' +
          '<span class="cq" id="q' + esc(pid) + '">0</span>' +
          '<button class="cb plus" data-id="' + esc(pid) + '">+</button>');
    foot.appendChild(ctrl);

    body.appendChild(foot);
    card.appendChild(imgDiv);
    card.appendChild(body);
    grid.appendChild(card);
  });

  if (!grid.children.length) {
    grid.innerHTML = '<div class="empty">لا توجد منتجات</div>';
  }
  sec.appendChild(grid);
  scrollEl.appendChild(sec);
});

// Phase 5 — Hide skeleton, show real catalog
(function revealCatalog(){
  var sk = document.getElementById('skeleton');
  if (sk) sk.style.display = 'none';
  if (scrollEl) scrollEl.style.display = '';
})();

// ═══════════════ Phase 5B — Hero featured (Top product) ═══════════════
(function renderHero(){
  // اختار المنتج الأكثر شعبية (popularity > 0) لعرضه
  var topPid = null, topPop = 0;
  Object.keys(PRODS).forEach(function(pid){
    var p = PRODS[pid];
    if ((p.popularity || 0) > topPop) { topPop = p.popularity; topPid = pid; }
  });
  if (!topPid || topPop < 3) return; // لا نعرض Hero بدون بيانات كافية
  var p = PRODS[topPid];
  var banner = document.getElementById('heroBanner');
  var imgWrap = document.getElementById('heroImgWrap');
  if (p.imageUrl) {
    var im = document.createElement('img');
    im.className = 'hero-img'; im.src = p.imageUrl; im.alt = p.name;
    imgWrap.innerHTML = ''; imgWrap.appendChild(im);
  } else {
    imgWrap.innerHTML = '<div class="hero-noimg">🌟</div>';
  }
  document.getElementById('heroName').textContent = p.name;
  document.getElementById('heroMeta').innerHTML = '<span>' + (p.priceOnRequest ? '💬 السعر بالتفاوض' : ('💰 ' + p.price + ' ' + CUR)) + '</span><span>•</span><span>طُلب ' + p.popularity + 'x آخر شهر</span>';
  document.getElementById('heroCta').addEventListener('click', function(){ openProductDetail(topPid); });
  banner.style.display = '';
  banner.addEventListener('click', function(e){ if (e.target.closest('.hero-cta')) return; openProductDetail(topPid); });
})();

// ═══════════════ Phase 5C — Last Order memory ═══════════════
var LO_KEY = 'thawani_last_order_' + (typeof BOT_PHONE !== 'undefined' ? BOT_PHONE : 'x');
var LO_TTL_DAYS = 30;

function saveLastOrder() {
  try {
    var items = [];
    Object.keys(cart).forEach(function(pid){
      var q = cart[pid]; if (!q || q <= 0) return;
      var p = PRODS[pid]; if (!p) return;
      items.push({ id: pid, name: p.name, price: p.price, qty: q, size: p.selectedSize || null, notes: p.notes || null, priceOnRequest: !!p.priceOnRequest });
    });
    if (items.length === 0) return;
    localStorage.setItem(LO_KEY, JSON.stringify({ items: items, savedAt: Date.now(), total: items.reduce(function(s,i){return s+i.price*i.qty;},0) }));
  } catch (_) {}
}
function getLastOrder() {
  try {
    var raw = localStorage.getItem(LO_KEY); if (!raw) return null;
    var data = JSON.parse(raw);
    var ageDays = (Date.now() - (data.savedAt||0)) / 86400000;
    if (ageDays > LO_TTL_DAYS) { localStorage.removeItem(LO_KEY); return null; }
    return data;
  } catch (_) { return null; }
}
function renderLastOrderBanner() {
  var lo = getLastOrder(); if (!lo || !lo.items?.length) return;
  // Skip if all items unavailable
  var available = lo.items.filter(function(it){ return PRODS[it.id]; });
  if (!available.length) return;
  var banner = document.getElementById('lastOrderBanner');
  document.getElementById('loSub').textContent = available.length + ' عناصر — إجمالي ' + (lo.total||0).toFixed(0) + ' ' + CUR;
  banner.style.display = '';
}
function reorderLast() {
  var lo = getLastOrder(); if (!lo) return;
  _hapticTap(20);
  lo.items.forEach(function(it){
    if (!PRODS[it.id]) return;
    cart[it.id] = it.qty;
    if (it.size) PRODS[it.id].selectedSize = it.size;
    if (it.notes) PRODS[it.id].notes = it.notes;
  });
  sync();
  document.getElementById('lastOrderBanner').style.display = 'none';
  showToast('✓ تم إضافة آخر طلب للسلة');
}
function showToast(msg) {
  var t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;top:20%;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.9);color:#fff;padding:12px 22px;border-radius:24px;z-index:9999;font-size:14px;font-weight:700;box-shadow:0 6px 24px rgba(0,0,0,.5);animation:fadeIn .2s';
  document.body.appendChild(t);
  setTimeout(function(){ t.style.transition='opacity .3s'; t.style.opacity='0'; setTimeout(function(){t.remove();}, 300); }, 1800);
}
renderLastOrderBanner();

// ═══════════════ Phase 5B — Cart Drawer ═══════════════
function openCartDrawer() {
  renderCartDrawer();
  document.getElementById('cartDrawer').classList.add('show');
  document.getElementById('cartDrawerBg').classList.add('show');
  document.body.style.overflow = 'hidden';
  _hapticTap(12);
}
function closeCartDrawer() {
  document.getElementById('cartDrawer').classList.remove('show');
  document.getElementById('cartDrawerBg').classList.remove('show');
  document.body.style.overflow = '';
}
function renderCartDrawer() {
  var wrap = document.getElementById('cdItems');
  var total = 0;
  var ids = Object.keys(cart).filter(function(pid){ return cart[pid] > 0 && PRODS[pid]; });
  if (!ids.length) {
    wrap.innerHTML = '<div class="cd-empty">السلة فارغة. اضف منتجات من القائمة 🛍️</div>';
    document.getElementById('cdTotal').textContent = '0 ' + CUR;
    return;
  }
  wrap.innerHTML = '';
  ids.forEach(function(pid){
    var p = PRODS[pid]; var q = cart[pid]; total += p.price * q;
    var row = document.createElement('div'); row.className = 'cd-item';
    var imgHtml = p.imageUrl
      ? '<img class="cd-item-img" src="' + p.imageUrl + '" alt="">'
      : '<div class="cd-item-noimg">🍽️</div>';
    var meta = (p.selectedSize ? p.selectedSize + ' • ' : '') + p.price + ' ' + CUR;
    row.innerHTML = imgHtml
      + '<div class="cd-item-info"><div class="cd-item-name">' + escHtml(p.name) + '</div><div class="cd-item-meta">' + escHtml(meta) + '</div></div>'
      + '<div class="cd-item-qty"><button class="cd-qbtn minus" data-pid="' + pid + '" data-d="-1">−</button><span class="cd-qnum">' + q + '</span><button class="cd-qbtn plus" data-pid="' + pid + '" data-d="1">+</button></div>';
    wrap.appendChild(row);
  });
  // event delegation
  wrap.querySelectorAll('.cd-qbtn').forEach(function(b){
    b.addEventListener('click', function(){
      var pid = b.getAttribute('data-pid');
      var d = parseInt(b.getAttribute('data-d'), 10);
      cart[pid] = Math.max(0, (cart[pid]||0) + d);
      if (cart[pid] === 0) delete cart[pid];
      sync();
      renderCartDrawer();
      _hapticTap(10);
    });
  });
  document.getElementById('cdTotal').textContent = total + ' ' + CUR;
}
function escHtml(s){ var d=document.createElement('div'); d.textContent=String(s||''); return d.innerHTML; }
// Wire cartbar (sub: ok button confirms, but rest opens drawer)
(function wireCartbar(){
  var bar = document.getElementById('cartbar');
  if (!bar) return;
  bar.classList.add('cb-click');
  bar.addEventListener('click', function(ev){
    if (ev.target.closest('#ok')) return;
    if (Object.keys(cart).filter(function(p){ return cart[p]>0; }).length === 0) return;
    openCartDrawer();
  });
})();

// ── نظام التبويب الموحّد: tabs = categories، chips = subCategories ──
try { (function() {
  var subChipsEl = document.getElementById('subChips');
  if (!subChipsEl || !tabsEl) return;
  var activeCat  = CATS[0] ? CATS[0].id : '__all__';
  var activeSub  = '__all__';

  if (!multiCat) { tabsEl.style.display = 'none'; }

  function applyFilter() {
    document.querySelectorAll('.card').forEach(function(c) {
      var cc = c.dataset.cat || '';
      var cs = c.dataset.sub || '';
      var okSub = (activeSub === '__all__') || (cs === activeSub);
      c.classList.toggle('hidden-by-filter', !okSub);
    });
  }

  function renderSubChips() {
    subChipsEl.innerHTML = '';
    var cat = CATS.find(function(c){ return c.id === activeCat; });
    var subs = (cat && Array.isArray(cat.subCategories)) ? cat.subCategories : [];
    if (!subs.length) { subChipsEl.style.display = 'none'; activeSub = '__all__'; return; }
    subChipsEl.style.display = 'flex';

    var allChip = document.createElement('button');
    allChip.className = 'chip active';
    allChip.textContent = '✦ الكل';
    allChip.addEventListener('click', function() {
      subChipsEl.querySelectorAll('.chip').forEach(function(c){ c.classList.remove('active'); });
      allChip.classList.add('active');
      activeSub = '__all__';
      applyFilter();
    });
    subChipsEl.appendChild(allChip);

    subs.forEach(function(s) {
      var chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = (s.emoji ? s.emoji + ' ' : '') + s.name;
      chip.addEventListener('click', function() {
        subChipsEl.querySelectorAll('.chip').forEach(function(c){ c.classList.remove('active'); });
        chip.classList.add('active');
        activeSub = s.id;
        applyFilter();
      });
      subChipsEl.appendChild(chip);
    });
  }

  CATS.forEach(function(cat, ci) {
    var btn = document.createElement('button');
    btn.className = 'tab' + (ci === 0 ? ' active' : '');
    btn.textContent = cat.emoji + ' ' + cat.name;
    btn.addEventListener('click', function() {
      tabsEl.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
      btn.classList.add('active');
      document.querySelectorAll('.cat-section').forEach(function(s){ s.classList.remove('visible'); });
      var sec = document.getElementById('cat-' + cat.id);
      if (sec) sec.classList.add('visible');
      activeCat = cat.id; activeSub = '__all__';
      renderSubChips(); applyFilter();
      scrollEl.scrollTop = 0;
    });
    tabsEl.appendChild(btn);
  });

  renderSubChips();
  applyFilter();
})(); } catch(_tabsErr) { console.error('tabs init error:', _tabsErr); }

// ═══════════════ Phase 5 — Product Detail Modal ═══════════════
var _pdState = { pid: null, qty: 1, sizeIdx: 0 };

function _hapticTap(ms) {
  try { if (navigator.vibrate) navigator.vibrate(ms || 12); } catch(_) {}
}

function openProductDetail(pid) {
  var p = PRODS[pid]; if (!p) return;
  _pdState.pid = pid;
  _pdState.qty = Math.max(1, cart[pid] || 1);
  _pdState.sizeIdx = 0;
  _hapticTap(15);

  // Hero (image carousel + video toggle)
  var hero = document.getElementById('pdHero');
  hero.innerHTML = '';
  var heroBadges = null;

  // ⭐ Carousel للصور المتعددة
  var imageList = Array.isArray(p.images) && p.images.length
    ? p.images
    : (p.imageUrl ? [p.imageUrl] : []);

  if (imageList.length > 0) {
    var carousel = document.createElement('div');
    carousel.className = 'pd-carousel';
    carousel.style.cssText = 'position:relative;inline-size:100%;block-size:100%;overflow:hidden;border-radius:inherit';

    var track = document.createElement('div');
    track.className = 'pd-carousel-track';
    track.style.cssText = 'display:flex;inline-size:100%;block-size:100%;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;';

    imageList.forEach(function(url, idx) {
      var slide = document.createElement('div');
      slide.style.cssText = 'flex:0 0 100%;scroll-snap-align:start;display:flex;align-items:center;justify-content:center;background:#000;position:relative';
      var im = document.createElement('img');
      im.src = url; im.alt = p.name + ' - ' + (idx + 1);
      im.loading = idx === 0 ? 'eager' : 'lazy';
      im.style.cssText = 'inline-size:100%;block-size:100%;object-fit:cover';
      im.onerror = function(){ slide.innerHTML = '<div class="pd-hero-noimg">🍽️</div>'; };
      slide.appendChild(im);
      track.appendChild(slide);
    });

    // hide scrollbar in webkit
    var styleTag = document.getElementById('pd-carousel-style');
    if (!styleTag) {
      styleTag = document.createElement('style');
      styleTag.id = 'pd-carousel-style';
      styleTag.textContent = '.pd-carousel-track::-webkit-scrollbar{display:none}';
      document.head.appendChild(styleTag);
    }

    carousel.appendChild(track);

    // dots indicator (لو > 1 صورة)
    if (imageList.length > 1) {
      var dots = document.createElement('div');
      dots.className = 'pd-carousel-dots';
      dots.style.cssText = 'position:absolute;inset-block-end:12px;inset-inline:0;display:flex;justify-content:center;gap:6px;z-index:5;pointer-events:none';
      imageList.forEach(function(_, idx) {
        var dot = document.createElement('span');
        dot.style.cssText = 'inline-size:7px;block-size:7px;border-radius:50%;background:rgba(255,255,255,' + (idx === 0 ? '1' : '0.45') + ');box-shadow:0 1px 4px rgba(0,0,0,0.4);transition:background .15s';
        dots.appendChild(dot);
      });
      carousel.appendChild(dots);
      // sync dot with scroll
      track.addEventListener('scroll', function() {
        var w = track.clientWidth;
        if (w === 0) return;
        var current = Math.round(track.scrollLeft / w);
        Array.from(dots.children).forEach(function(d, i) {
          d.style.background = 'rgba(255,255,255,' + (i === current ? '1' : '0.45') + ')';
        });
      }, { passive: true });

      // image counter (top-left)
      var counter = document.createElement('div');
      counter.className = 'pd-carousel-counter';
      counter.style.cssText = 'position:absolute;inset-block-start:12px;inset-inline-start:12px;background:rgba(0,0,0,0.55);color:#fff;padding:4px 10px;border-radius:14px;font-size:11.5px;font-weight:700;z-index:5;backdrop-filter:blur(6px);';
      counter.textContent = '1 / ' + imageList.length;
      carousel.appendChild(counter);
      track.addEventListener('scroll', function() {
        var w = track.clientWidth;
        if (w === 0) return;
        var current = Math.round(track.scrollLeft / w) + 1;
        counter.textContent = current + ' / ' + imageList.length;
      }, { passive: true });
    }

    hero.appendChild(carousel);
  } else {
    hero.innerHTML = '<div class="pd-hero-noimg">🍽️</div>';
  }
  // Video inline toggle
  if (p.video && p.video.src) {
    var vt = document.createElement('button');
    vt.className = 'pd-hero-vid-toggle';
    vt.type = 'button';
    vt.innerHTML = '▶ شاهد الفيديو';
    vt.addEventListener('click', function(ev){
      ev.stopPropagation();
      hero.innerHTML = '';
      if (p.video.kind === 'iframe') {
        var f = document.createElement('iframe');
        f.src = p.video.src;
        f.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
        f.setAttribute('allowfullscreen', '');
        hero.appendChild(f);
      } else if (p.video.kind === 'native') {
        var v = document.createElement('video');
        v.src = p.video.src; v.controls = true; v.autoplay = true; v.playsInline = true;
        hero.appendChild(v);
      } else {
        window.open(p.video.original || p.video.src, '_blank', 'noopener');
      }
    });
    hero.appendChild(vt);
  }
  // Badges row (top-right)
  if (Array.isArray(p.badges) && p.badges.length) {
    var brow = document.createElement('div');
    brow.className = 'pd-badges-row';
    p.badges.forEach(function(b){
      var be = document.createElement('span');
      be.className = 'c-badge ' + b.kind;
      be.textContent = b.emoji + ' ' + b.label;
      brow.appendChild(be);
    });
    hero.appendChild(brow);
  }

  // Name + Price + Original
  document.getElementById('pdName').textContent = p.name;
  document.getElementById('pdPrice').textContent = p.priceOnRequest ? '💬 السعر بالتفاوض' : (p.price + ' ' + CUR);
  var orig = document.getElementById('pdOrig');
  if (p.originalPrice) {
    orig.textContent = p.originalPrice + ' ' + CUR;
    orig.style.display = '';
  } else {
    orig.style.display = 'none';
  }

  // Description
  var descEl = document.getElementById('pdDesc');
  descEl.textContent = p.description || '';
  descEl.style.display = p.description ? '' : 'none';

  // Sizes
  var sizesSec = document.getElementById('pdSizesSection');
  var sizesWrap = document.getElementById('pdSizes');
  sizesWrap.innerHTML = '';
  if (p.sizes && p.sizes.length) {
    sizesSec.style.display = '';
    p.sizes.forEach(function(sz, idx){
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pd-size-btn' + (idx === 0 ? ' active' : '');
      b.innerHTML = '<span>' + sz.label + '</span><span class="pd-size-price">(' + sz.price + ' ' + CUR + ')</span>';
      b.addEventListener('click', function(){
        _pdState.sizeIdx = idx;
        sizesWrap.querySelectorAll('.pd-size-btn').forEach(function(x){ x.classList.remove('active'); });
        b.classList.add('active');
        document.getElementById('pdPrice').textContent = sz.price + ' ' + CUR;
        _hapticTap(8);
      });
      sizesWrap.appendChild(b);
    });
  } else {
    sizesSec.style.display = 'none';
  }

  // Notes
  document.getElementById('pdNotes').value = '';

  // Qty
  _pdRenderQty();

  // CTA state
  var cta = document.getElementById('pdCta');
  cta.classList.remove('added');
  // ⭐ نص الزر يحترم orderMode + terms
  var pdLabel;
  if (cart[pid] && cart[pid] > 0) {
    pdLabel = (ORDER_MODE === 'cart') ? 'تحديث ' + (T.cart || 'السلة').replace(/^[^\\u0600-\\u06ff]+/, '').trim() : '✓ مختار';
  } else {
    pdLabel = PRIMARY_BTN || T.itemAdd || (ORDER_MODE === 'booking' ? 'احجز هذا' : 'أضف للسلة');
  }
  document.getElementById('pdCtaText').textContent = pdLabel;

  // Open
  var bg = document.getElementById('pdBg');
  bg.classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeProductDetail() {
  var bg = document.getElementById('pdBg');
  bg.classList.remove('show');
  document.body.style.overflow = '';
  // Stop playing video if any
  var hero = document.getElementById('pdHero');
  var iframe = hero.querySelector('iframe');
  if (iframe) iframe.src = '';
  var vid = hero.querySelector('video');
  if (vid) { vid.pause(); vid.src = ''; }
}

function pdChangeQty(delta) {
  _pdState.qty = Math.max(1, _pdState.qty + delta);
  _pdRenderQty();
  _hapticTap(8);
}

function _pdRenderQty() {
  document.getElementById('pdQty').textContent = _pdState.qty;
  var minus = document.getElementById('pdMinus');
  minus.classList.toggle('zero', _pdState.qty <= 1);
}

function pdAddToCart() {
  var pid = _pdState.pid; if (!pid) return;
  var p = PRODS[pid];
  // If sized, update price first
  if (p.sizes && p.sizes[_pdState.sizeIdx]) {
    var sz = p.sizes[_pdState.sizeIdx];
    PRODS[pid].selectedSize = sz.label;
    PRODS[pid].price = Number(sz.price);
  }
  var notes = document.getElementById('pdNotes').value.trim();
  if (notes) PRODS[pid].notes = notes;
  cart[pid] = _pdState.qty;
  sync();
  // Visual feedback then close
  var cta = document.getElementById('pdCta');
  cta.classList.add('added');
  document.getElementById('pdCtaText').textContent = '✓ تم الإضافة';
  document.getElementById('pdCtaIcon').textContent = '';
  _hapticTap(30);
  setTimeout(closeProductDetail, 600);
}

// ESC + swipe down support
document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeProductDetail(); });
(function setupSwipeDownDismiss(){
  var sheet = document.getElementById('pdSheet');
  var handle = document.getElementById('pdHandle');
  if (!sheet || !handle) return;
  var startY = 0, curY = 0, dragging = false;
  function onStart(y){ startY = y; curY = y; dragging = true; sheet.style.transition = 'none'; }
  function onMove(y){
    if (!dragging) return;
    curY = y;
    var dy = Math.max(0, curY - startY);
    sheet.style.transform = 'translateY(' + dy + 'px)';
  }
  function onEnd(){
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = '';
    var dy = curY - startY;
    if (dy > 100) closeProductDetail();
    sheet.style.transform = '';
  }
  handle.addEventListener('touchstart', function(e){ onStart(e.touches[0].clientY); }, { passive: true });
  handle.addEventListener('touchmove',  function(e){ onMove(e.touches[0].clientY); },  { passive: true });
  handle.addEventListener('touchend',   onEnd);
  handle.addEventListener('touchcancel', onEnd);
})();

// ── 🎬 Video modal ──
function openVideoModal(video, productName, caption) {
  var bg = document.getElementById('videoModalBg');
  if (!bg) {
    bg = document.createElement('div');
    bg.id = 'videoModalBg';
    bg.className = 'video-modal-bg';
    bg.innerHTML = '<div class="video-modal"><button class="video-modal-close" type="button" aria-label="إغلاق">✕</button><div class="video-modal-body" id="videoModalBody"></div><div class="video-modal-caption" id="videoModalCaption"></div></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', function(e){ if (e.target === bg) closeVideoModal(); });
    bg.querySelector('.video-modal-close').addEventListener('click', closeVideoModal);
  }
  var body = document.getElementById('videoModalBody');
  var capEl = document.getElementById('videoModalCaption');
  body.innerHTML = '';
  if (video.kind === 'iframe') {
    var iframe = document.createElement('iframe');
    iframe.src = video.src;
    iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('loading', 'lazy');
    body.appendChild(iframe);
  } else if (video.kind === 'native') {
    var vid = document.createElement('video');
    vid.src = video.src;
    vid.controls = true;
    vid.autoplay = true;
    vid.playsInline = true;
    body.appendChild(vid);
  } else {
    // link fallback — open in new tab
    window.open(video.original || video.src, '_blank', 'noopener');
    return;
  }
  var capText = (productName ? productName : '') + (caption ? ' — ' + caption : '');
  capEl.textContent = capText.trim();
  capEl.style.display = capText.trim() ? '' : 'none';
  bg.classList.add('show');
  document.body.style.overflow = 'hidden';
}
function closeVideoModal() {
  var bg = document.getElementById('videoModalBg');
  if (!bg) return;
  bg.classList.remove('show');
  var body = document.getElementById('videoModalBody');
  if (body) body.innerHTML = ''; // stop playback
  document.body.style.overflow = '';
}
document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeVideoModal(); });

// ── Sync cart bar ──
function sync() {
  var n = 0, t = 0;
  Object.keys(cart).forEach(function(id) {
    var q = cart[id];
    if (q > 0 && PRODS[id]) { n += q; t += q * PRODS[id].price; }
  });
  // تحديث "has-qty" للكروت — البطاقات التي بها كميات تأخذ border ذهبي
  document.querySelectorAll('.card').forEach(function(c) {
    var pid = c.dataset.pid;
    if (cart[pid] > 0) c.classList.add('has-qty'); else c.classList.remove('has-qty');
  });
  if (n > 0) {
    cartbar.classList.add('on');
    document.getElementById('cc').textContent = n + ' منتج في السلة';
    document.getElementById('ct').textContent = 'الإجمالي: ' + t.toFixed(2) + ' ' + CUR;
    document.getElementById('cbadge').textContent = n;
  } else {
    cartbar.classList.remove('on');
  }
}

// ── Delegated click for +/- (cart mode) ──
document.addEventListener('click', function(e) {
  var btn = e.target.closest('.cb');
  if (!btn) return;
  var id = btn.dataset.id;
  if (!id) return;
  var delta = btn.classList.contains('plus') ? 1 : -1;
  cart[id] = Math.max(0, (cart[id] || 0) + delta);
  var qEl = document.getElementById('q' + id);
  var mb  = btn.closest('.c-ctrl').querySelector('.minus');
  qEl.textContent = cart[id];
  qEl.className = 'cq' + (cart[id] > 0 ? ' nz' : '');
  if (cart[id] > 0) { mb.classList.remove('zero'); } else { mb.classList.add('zero'); }
  sync();
});

// ── Single-order mode: زر واحد لكل خدمة/مشروع، يفتح ملخص فوراً ──
document.addEventListener('click', function(e) {
  var btn = e.target.closest('.cb-single');
  if (!btn) return;
  var id = btn.dataset.id;
  if (!id || !PRODS[id]) return;
  // اختيار حصري: نُلغي السلة ونضع هذا فقط بكمية 1
  window._cartReplace({});
  cart[id] = 1;
  // تحديث visual: حذف "taken" من غيره
  var defLabel = (ORDER_MODE === 'booking')
    ? (PRIMARY_BTN || T.itemAdd || 'احجز هذا')
    : (PRIMARY_BTN || T.itemAdd || 'اطلب الآن');
  document.querySelectorAll('.cb-single.taken').forEach(function(b){
    b.classList.remove('taken');
    b.textContent = defLabel;
  });
  btn.classList.add('taken');
  btn.textContent = '✓ مختار';
  sync();
  // افتح ملخص الطلب مباشرة (تجربة العميل أسرع)
  setTimeout(function(){ openSummary(); }, 200);
});

// ── Search filter — يفلتر البطاقات حسب اسم/وصف المنتج ──
document.getElementById('search').addEventListener('input', function(e) {
  var q = String(e.target.value || '').trim().toLowerCase();
  document.querySelectorAll('.card').forEach(function(card) {
    var pid  = card.dataset.pid;
    var prod = PRODS[pid];
    if (!prod) return;
    var hay = (prod.name + ' ' + (prod.description || '')).toLowerCase();
    card.style.display = (!q || hay.indexOf(q) !== -1) ? '' : 'none';
  });
  // إخفاء tabs عند البحث
  document.getElementById('tabs').style.display = q ? 'none' : '';
  if (q) {
    document.querySelectorAll('.cat-section').forEach(function(s) { s.classList.add('visible'); });
  }
});

// ── Summary modal helpers ──
function openSummary() {
  var items = [];
  Object.keys(cart).forEach(function(id) {
    var q = cart[id];
    if (q > 0 && PRODS[id]) items.push({ id: id, name: PRODS[id].name, price: PRODS[id].price, qty: q, priceOnRequest: !!PRODS[id].priceOnRequest });
  });
  if (!items.length) return;

  var body = document.getElementById('smBody');
  body.innerHTML = '';
  var total = 0;
  var hasNeg = false;
  items.forEach(function(it) {
    var sub = it.priceOnRequest ? 0 : it.price * it.qty;
    if (it.priceOnRequest) hasNeg = true;
    total += sub;
    var row = document.createElement('div');
    row.className = 'sm-item';
    var priceLine = it.priceOnRequest
      ? '<div class="sm-item-sub" style="color:#7c3aed;font-weight:700">💬 السعر بالتفاوض</div>'
      : '<div class="sm-item-sub">' + it.qty + ' × ' + it.price + ' ' + CUR + '</div>';
    var priceCell = it.priceOnRequest
      ? '<div class="sm-item-price" style="color:#7c3aed;font-weight:700">💬 تفاوض</div>'
      : '<div class="sm-item-price">' + sub.toFixed(2) + ' ' + CUR + '</div>';
    row.innerHTML =
      '<div><div class="sm-item-name">' + esc(it.name) + '</div>' + priceLine + '</div>' + priceCell;
    body.appendChild(row);
  });
  var totalEl = document.getElementById('smTotal');
  if (hasNeg && total === 0) totalEl.innerHTML = '<span style="color:#7c3aed">💬 يحدّد بالتفاوض</span>';
  else if (hasNeg) totalEl.innerHTML = total.toFixed(2) + ' ' + CUR + ' <span style="font-size:11px;color:#7c3aed">+ تفاوض</span>';
  else totalEl.textContent = total.toFixed(2) + ' ' + CUR;

  // ⭐ Booking date/time — يظهر فقط للـ orderMode=booking
  var smBookingEl = document.getElementById('smBooking');
  if (smBookingEl) {
    if (ORDER_MODE === 'booking') {
      smBookingEl.style.display = '';
      var d = document.getElementById('smBookDate');
      var t = document.getElementById('smBookTime');
      if (d && !d.value) {
        var today = new Date();
        d.min = today.toISOString().slice(0, 10);
        // default = الغد لتسهيل التجربة
        var tomorrow = new Date(today.getTime() + 86400000);
        d.value = tomorrow.toISOString().slice(0, 10);
      }
      if (t && !t.value) t.value = '12:00';
    } else {
      smBookingEl.style.display = 'none';
    }
  }
  document.getElementById('summaryModal').style.display = 'flex';
}
function closeSummary() {
  document.getElementById('summaryModal').style.display = 'none';
}

// ── Submit (يفتح modal الملخص أولاً، ثم يرسل بعد التأكيد) ──
document.getElementById('ok').addEventListener('click', function() {
  openSummary();
});

document.getElementById('confirmFinal').addEventListener('click', async function() {
  var items = [];
  Object.keys(cart).forEach(function(id) {
    var q = cart[id];
    if (q > 0 && PRODS[id]) items.push({ id: id, name: PRODS[id].name, price: PRODS[id].price, qty: q, priceOnRequest: !!PRODS[id].priceOnRequest });
  });
  if (!items.length) return;

  var notes  = String(document.getElementById('smNotes').value || '').trim().slice(0, 500);
  // ⭐ Booking: أضف التاريخ/الوقت في بداية الملاحظات
  if (ORDER_MODE === 'booking') {
    var bd = document.getElementById('smBookDate');
    var bt = document.getElementById('smBookTime');
    var dateVal = bd ? String(bd.value || '').trim() : '';
    var timeVal = bt ? String(bt.value || '').trim() : '';
    if (!dateVal || !timeVal) {
      var hint = document.getElementById('smBookHint');
      if (hint) { hint.textContent = '⚠️ من فضلك اختر التاريخ والوقت'; hint.style.color = '#ef4444'; }
      return;
    }
    var bookingLine = '📅 الموعد المطلوب: ' + dateVal + ' ' + timeVal;
    notes = notes ? (bookingLine + '\\n' + notes).slice(0, 500) : bookingLine;
  }
  var btn    = document.getElementById('confirmFinal');
  btn.disabled = true;
  btn.textContent = '⏳ إرسال…';
  var ok = false;
  try {
    var r = await fetch('/api/order/' + TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items, notes: notes })
    });
    ok = r.ok;
  } catch(e) {}
  if (!ok) {
    btn.disabled = false;
    btn.textContent = '⚠️ خطأ — أعد المحاولة';
    return;
  }
  // Phase 5C — حفظ آخر طلب ناجح + haptic
  try { saveLastOrder(); } catch(_) {}
  _hapticTap(60);
  closeSummary();
  // 🍽️ Dine-in: لا تعرض done — افتح dashboard مباشرة + امسح السلة + start polling
  if (typeof DINE_IN !== 'undefined' && DINE_IN === true) {
    try { window._cartReplace({}); _clearCartLS(); updateCartCount && updateCartCount(); } catch(_) {}
    setTimeout(function() { dineOpen(); }, 200);
    return;
  }
  document.getElementById('done').style.display = 'flex';
  setTimeout(function() {
    try { window.history.back(); } catch(e) {}
    setTimeout(function() {
      if (BOT_PHONE) {
        try { window.location.href = 'whatsapp://send?phone=' + BOT_PHONE; } catch(e) {}
      }
      setTimeout(function() {
        var waBtn = document.getElementById('wa-back');
        if (waBtn) waBtn.style.display = 'inline-block';
        try { window.close(); } catch(e) {}
      }, 800);
    }, 600);
  }, 1800);
});

// ════════════════ 🍽️ Dine-in Dashboard ════════════════
var _dinePollTimer = null;
// 🆕 Session مرتبطة بالـ TOKEN (الـ slug) — كل QR scan = slug جديد = جلسة جديدة
//    Refresh لنفس الـ URL = نفس الـ slug = الجلسة محفوظة (الطلبات + الرسائل تبقى)
function _dineSessionKey() { return 'dineSession_' + TOKEN; }
function _dineChatOpenKey() { return 'dineChatOpen_' + TOKEN; }
function _dineSessionStart() {
  var k = _dineSessionKey();
  var v = parseInt(localStorage.getItem(k), 10);
  if (!v) {
    v = Date.now();
    localStorage.setItem(k, String(v));
  }
  return v;
}
function _dineSessionTouch() {
  // لا حاجة لـ touch مع نظام الـ slug — الـ session ثابتة طوال عمر الـ slug
}
function dineSessionReset() {
  if (!confirm('بدء جلسة جديدة؟ (ستختفي الطلبات والرسائل الحالية من شاشتك — لن تُحذف من المطعم)')) return;
  localStorage.setItem(_dineSessionKey(), String(Date.now()));
  localStorage.removeItem(_dineChatOpenKey());
  _dineChatLastSeenTs = 0;
  _dineChatLastAdminTs = 0;
  _dineChatUnread = 0;
  _updateChatBtnBadge();
  dinePoll();
}
function dineOpen() {
  var d = document.getElementById('dineInDash');
  if (!d) return;
  var lbl = document.getElementById('dineHdrLabel');
  if (lbl) lbl.textContent = TABLE_LABEL || ('طاولة ' + TABLE);
  d.style.display = 'block';
  _dineSessionTouch();
  dinePoll();
  if (_dinePollTimer) clearInterval(_dinePollTimer);
  _dinePollTimer = setInterval(dinePoll, 5000);
}
async function dinePoll() {
  try {
    var r = await fetch('/api/dine-in/' + TOKEN + '/orders', { cache: 'no-store' });
    if (!r.ok) return;
    var data = await r.json();
    if (!data.ok) return;
    // 🧹 صفِّ على الجلسة الحالية فقط
    var sessStart = _dineSessionStart();
    var filtered = (data.orders || []).filter(function(o) {
      return new Date(o.timestamp).getTime() >= sessStart;
    });
    dineRender(filtered);
  } catch(e) {}
}
function dineStatusMeta(s) {
  var m = {
    'pending':              { bg:'#fef3c7', fg:'#92400e', txt:'⏳ بانتظار التأكيد', icon:'⏳' },
    'pending_confirmation': { bg:'#fef3c7', fg:'#92400e', txt:'⏳ بانتظار التأكيد', icon:'⏳' },
    'confirmed':            { bg:'#dbeafe', fg:'#1e40af', txt:'✅ تم التأكيد', icon:'✅' },
    'preparing':            { bg:'#fed7aa', fg:'#9a3412', txt:'👨‍🍳 قيد التحضير', icon:'👨‍🍳' },
    'ready_pickup':         { bg:'#d1fae5', fg:'#065f46', txt:'🍽️ جاهز - في الطريق إليك', icon:'🍽️' },
    'completed':            { bg:'#d1fae5', fg:'#065f46', txt:'🏁 تم التسليم', icon:'🏁' },
    'delivered':            { bg:'#d1fae5', fg:'#065f46', txt:'🏁 تم التسليم', icon:'🏁' },
    'rejected':             { bg:'#fee2e2', fg:'#991b1b', txt:'❌ مرفوض', icon:'❌' },
    'cancelled':            { bg:'#f3e8ff', fg:'#6b21a8', txt:'🚫 ملغي', icon:'🚫' },
  };
  return m[s] || { bg:'#f3f4f6', fg:'#6b7280', txt:s||'—', icon:'•' };
}
function dineRender(orders) {
  var box = document.getElementById('dineOrdersList');
  if (!box) return;
  if (!orders.length) {
    box.innerHTML = '<div style="background:var(--card-bg);padding:30px;border-radius:14px;text-align:center;color:var(--text-mute)"><div style="font-size:42px;margin-bottom:8px">🍽️</div>لا توجد طلبات بعد على هذه الطاولة</div>';
    return;
  }
  box.innerHTML = orders.map(function(o, i) {
    var meta = dineStatusMeta(o.status);
    var time = new Date(o.timestamp).toLocaleTimeString('ar-EG', {hour:'2-digit',minute:'2-digit',hour12:true});
    var itemsHtml = (o.items || []).map(function(it) {
      return '<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0;border-bottom:1px dashed var(--border)"><span>• ' + (it.name || '') + ' × ' + (it.qty || 1) + '</span><span style="color:var(--accent);font-weight:700">' + ((it.price||0)*(it.qty||1)).toFixed(2) + '</span></div>';
    }).join('');
    return (
      '<div style="background:var(--card-bg);border-radius:14px;padding:14px;border:1px solid var(--border);box-shadow:0 2px 8px rgba(0,0,0,.1)">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
          '<div style="font-weight:800;font-size:13px;color:var(--text-mute)">طلب #' + (i+1) + ' · ' + time + '</div>' +
          '<span style="background:' + meta.bg + ';color:' + meta.fg + ';padding:4px 12px;border-radius:999px;font-size:12px;font-weight:800">' + meta.txt + '</span>' +
        '</div>' +
        itemsHtml +
        '<div style="display:flex;justify-content:space-between;margin-top:10px;padding-top:8px;border-top:1px solid var(--border);font-weight:800"><span>الإجمالي</span><span style="color:var(--accent);font-size:16px">' + (o.total||0).toFixed(2) + ' ' + CUR + '</span></div>' +
        (o.notes ? '<div style="margin-top:8px;padding:8px;background:var(--card-bg-alt);border-radius:8px;font-size:12px;color:var(--text-mute)">📝 ' + o.notes + '</div>' : '') +
      '</div>'
    );
  }).join('');
}
function dineAddMore() {
  var d = document.getElementById('dineInDash');
  if (d) d.style.display = 'none';
  if (_dinePollTimer) { clearInterval(_dinePollTimer); _dinePollTimer = null; }
  window.scrollTo(0, 0);
}
// 💬 Chat thread (full screen) + background polling
var _dineChatPollTimer = null;
var _dineChatBgPollTimer = null;
var _dineChatLastSeenTs = 0;
var _dineChatLastAdminTs = 0; // آخر رسالة مدير شفناها
var _dineChatUnread = 0;
function dineContact() {
  var s = document.getElementById('dineChatScreen');
  if (!s) return;
  s.style.display = 'flex';
  localStorage.setItem(_dineChatOpenKey(), '1');
  var sub = document.getElementById('dineChatHdrSub');
  if (sub) sub.textContent = TABLE_LABEL || ('طاولة ' + TABLE);
  // امسح الـ unread badge — العميل يقرأ الآن
  _dineChatUnread = 0;
  _updateChatBtnBadge();
  dineChatLoad();
  if (_dineChatPollTimer) clearInterval(_dineChatPollTimer);
  _dineChatPollTimer = setInterval(dineChatLoad, 3500);
}
function dineChatClose() {
  var s = document.getElementById('dineChatScreen');
  if (s) s.style.display = 'none';
  localStorage.removeItem(_dineChatOpenKey());
  if (_dineChatPollTimer) { clearInterval(_dineChatPollTimer); _dineChatPollTimer = null; }
}
async function dineChatLoad() {
  try {
    var r = await fetch('/api/dine-in/' + TOKEN + '/messages?limit=80', { cache: 'no-store' });
    if (!r.ok) return;
    var data = await r.json();
    if (!data.ok) return;
    var sessStart = _dineSessionStart();
    var mine = (data.messages || []).filter(function(m){ return m.ts >= sessStart; });
    dineChatRender(mine);
    // تتبع آخر رسالة مدير
    var lastAdmin = mine.filter(function(m){ return m.from === 'admin'; }).pop();
    if (lastAdmin) _dineChatLastAdminTs = Math.max(_dineChatLastAdminTs, lastAdmin.ts);
  } catch(e) {}
}
// 🔄 Background polling خفيف — يتفقد رسائل المدير حتى لو شاشة المحادثة مقفلة
async function _dineChatCheckNew() {
  try {
    var r = await fetch('/api/dine-in/' + TOKEN + '/messages?limit=20', { cache: 'no-store' });
    if (!r.ok) return;
    var data = await r.json();
    if (!data.ok) return;
    var sessStart = _dineSessionStart();
    var adminMsgs = (data.messages || []).filter(function(m){ return m.from === 'admin' && m.ts >= sessStart; });
    if (!adminMsgs.length) return;
    var newest = adminMsgs[adminMsgs.length-1];
    var chatScreenOpen = document.getElementById('dineChatScreen')?.style.display === 'flex';
    if (newest.ts > _dineChatLastAdminTs) {
      // رسالة جديدة من المدير
      _dineChatLastAdminTs = newest.ts;
      if (!chatScreenOpen) {
        _dineChatUnread++;
        _updateChatBtnBadge();
        // تنبيه: صوت قصير + اهتزاز
        _dineNotifyNew(newest.text);
      }
    }
  } catch(e) {}
}
function _updateChatBtnBadge() {
  var btn = document.querySelector('button[onclick="dineContact()"]');
  if (!btn) return;
  var badge = document.getElementById('dineChatBtnBadge');
  if (_dineChatUnread > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'dineChatBtnBadge';
      badge.style.cssText = 'background:#dc2626;color:#fff;border-radius:999px;padding:2px 8px;font-size:11px;font-weight:900;margin-right:6px;animation:pulse 1s infinite';
      btn.insertBefore(badge, btn.firstChild);
    }
    badge.textContent = _dineChatUnread;
    badge.style.display = '';
  } else if (badge) {
    badge.style.display = 'none';
  }
}
function _dineNotifyNew(text) {
  // اهتزاز قصير على الجوال
  try { if (navigator.vibrate) navigator.vibrate([200, 80, 200]); } catch(e) {}
  // صوت قصير
  try {
    var ctx = window._dineAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    window._dineAudioCtx = ctx;
    if (ctx.state === 'suspended') ctx.resume();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1000, ctx.currentTime);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.35);
  } catch(e) {}
}
function dineChatRender(messages) {
  var box = document.getElementById('dineChatMessages');
  if (!box) return;
  var wasAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
  if (!messages.length) {
    box.innerHTML = '<div style="text-align:center;color:var(--text-mute);padding:40px 20px;font-size:13px"><div style="font-size:42px;margin-bottom:10px">💬</div>لا توجد رسائل بعد<br><span style="font-size:11px;opacity:.7">اكتب رسالتك للمطعم في الأسفل</span></div>';
    return;
  }
  box.innerHTML = messages.map(function(m) {
    var isCustomer = m.from === 'customer';
    var time = new Date(m.ts).toLocaleTimeString('ar-EG', {hour:'2-digit',minute:'2-digit',hour12:true});
    var safeText = String(m.text||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\n/g,'<br>');
    if (isCustomer) {
      return (
        '<div style="display:flex;justify-content:flex-end">' +
          '<div style="max-width:78%;background:linear-gradient(135deg,#d4af37,#b8941f);color:#1b1b1b;padding:10px 14px;border-radius:16px 16px 4px 16px;font-size:14px;line-height:1.5;box-shadow:0 1px 4px rgba(0,0,0,.15)">' +
            safeText +
            '<div style="font-size:10px;opacity:.7;margin-top:4px;text-align:left">' + time + '</div>' +
          '</div>' +
        '</div>'
      );
    } else {
      return (
        '<div style="display:flex;justify-content:flex-start;gap:6px;align-items:flex-end">' +
          '<div style="background:#16a34a;color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">🍽️</div>' +
          '<div style="max-width:75%;background:var(--card-bg-alt);color:var(--text);padding:10px 14px;border-radius:16px 16px 16px 4px;font-size:14px;line-height:1.5;border:1px solid var(--border)">' +
            safeText +
            '<div style="font-size:10px;color:var(--text-mute);margin-top:4px">' + time + '</div>' +
          '</div>' +
        '</div>'
      );
    }
  }).join('');
  if (wasAtBottom) box.scrollTop = box.scrollHeight;
  _dineChatLastSeenTs = messages[messages.length-1]?.ts || 0;
}
function dineChatPreset(text) {
  var t = document.getElementById('dineChatInput');
  if (t) { t.value = text; t.focus(); }
}
async function dineChatSend() {
  var t = document.getElementById('dineChatInput');
  var btn = document.getElementById('dineChatSendBtn');
  var text = (t.value || '').trim();
  if (!text) { t.focus(); return; }
  btn.disabled = true; var oldHtml = btn.innerHTML; btn.innerHTML = '⏳';
  try {
    var r = await fetch('/api/dine-in/' + TOKEN + '/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text })
    });
    var data = await r.json();
    if (data.ok) {
      t.value = '';
      t.style.height = 'auto';
      dineChatLoad();
    }
  } catch(e) {}
  btn.disabled = false; btn.innerHTML = oldHtml;
}
// 🎬 على تحميل الصفحة في وضع dine-in:
//    1) لو شاشة المحادثة كانت مفتوحة قبل الـ refresh → افتحها مباشرة (chat-first)
//    2) لو فيه طلبات في الجلسة → افتح dashboard
//    3) ابدأ background polling خفيف للرسائل (يشتغل دائماً)
if (typeof DINE_IN !== 'undefined' && DINE_IN === true && TABLE) {
  // background polling خفيف كل 5 ثوان (لرسائل المدير حتى وأنت في المنيو)
  if (_dineChatBgPollTimer) clearInterval(_dineChatBgPollTimer);
  _dineChatBgPollTimer = setInterval(_dineChatCheckNew, 5000);
  setTimeout(_dineChatCheckNew, 500); // فحص فوري عند التحميل

  setTimeout(function(){
    // (1) استعادة المحادثة لو كانت مفتوحة
    if (localStorage.getItem(_dineChatOpenKey()) === '1') {
      dineContact();
      return; // أولوية للمحادثة على الـ dashboard
    }
    // (2) فتح dashboard لو فيه طلبات سابقة
    var sessStart = _dineSessionStart();
    fetch('/api/dine-in/' + TOKEN + '/orders', { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!d.ok) return;
        var mine = (d.orders||[]).filter(function(o){ return new Date(o.timestamp).getTime() >= sessStart; });
        if (mine.length > 0) dineOpen();
      })
      .catch(function(){});
  }, 600);
}
</script>
</body>
</html>`);
} // end _renderMenuClassic

// 🎨 Menu Pro v2 renderer — يستخدم CSS+JS منفصلين من /menu-pro/
function _renderMenuPro(req, res, sess, store) {
  // 🚫 لا cache — HTML ديناميكي
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  const storeId = sess.storeId;
  const products = (store.products || []).filter(p => p.available !== false);
  if (!products.length) return _renderMenuClassic(req, res);

  // ابني نفس بنية CATS/PRODS التي يستخدمها الـ classic webview
  const cats = (store.categories || []).filter(c => c.active !== false);
  const productData = {};
  for (const p of products) {
    // images: array كامل (مع backward compat)
    const allImages = Array.isArray(p.images) && p.images.length
      ? p.images.filter(u => typeof u === "string" && u)
      : (p.imageUrl ? [p.imageUrl] : []);

    // originalPrice: السعر قبل الخصم (لو الـ admin حفظ خصماً)
    const origPrice = Number(p.originalPrice || p.compareAtPrice || 0);
    const hasDiscount = origPrice > 0 && origPrice > (Number(p.price) || 0);

    // accommodation (للـ rental) — معلومات الشاليه + الـ availability
    let accommodation = null;
    let availability  = null;
    if (p.accommodation && typeof p.accommodation === "object") {
      accommodation = p.accommodation;
      try {
        const bookings = require("./bookings");
        availability = bookings.getUnitAvailability(storeId, p.id);
      } catch {}
    }

    productData[String(p.id)] = {
      id: String(p.id),
      name: p.name || "",
      description: p.description || "",
      price: Number(p.price || 0),
      originalPrice: hasDiscount ? origPrice : null,
      priceOnRequest: !!p.priceOnRequest,
      imageUrl: allImages[0] || null,
      images: allImages,
      // 🎨 isShowcaseOnly — منتج للعرض فقط (بلا سعر، بلا زر)
      isShowcaseOnly: !!p.isShowcaseOnly,
      // 🎬 videoUrl للعرض في portfolio cards (بلا فيديو لكل المنتجات — فقط showcase)
      videoUrl: p.isShowcaseOnly ? (p.videoUrl || null) : null,
      description: p.description || p.desc || "",
      categoryId: String(p.category || ""),
      subCategoryId: String(p.subCategoryId || ""),
      stock: (p.stock === null || p.stock === undefined) ? null : Number(p.stock),
      calories: p.calories || p.cal || null,
      prepTimeMin: p.prepTimeMin || p.prepTime || null,
      popular: (p.popularity || 0) >= 50 || !!p.popular,
      spicy: !!p.spicy,
      isNew: !!p.isNew,
      size: p.size || null,
      // 🚫 Phase 1 + Global: دمج مكونات المنتج + الـ global removable التي تطبق عليه
      removableIngredients: (function(){
        const productRem = Array.isArray(p.removableIngredients)
          ? p.removableIngredients.filter(s => typeof s === "string")
          : [];
        const globalRem = Array.isArray(store.globalRemovableIngredients) ? store.globalRemovableIngredients : [];
        const seen = new Set(productRem);
        const merged = [...productRem];
        for (const g of globalRem) {
          if (!g || !g.name || seen.has(g.name)) continue;
          const ids = Array.isArray(g.productIds) ? g.productIds : [];
          if (ids.length === 0 || ids.includes(String(p.id))) {
            merged.push(g.name);
            seen.add(g.name);
          }
        }
        return merged.length ? merged.slice(0, 20) : null;
      })(),
      // Modifiers: sizes array [{name, price}]
      // ⚠️ Admin يحفظ label لكن menu-pro يتوقع name — نقبل كلاهما
      sizes: Array.isArray(p.sizes)
        ? p.sizes
            .filter(s => s && (s.name || s.label))
            .map(s => ({ name: String(s.name || s.label), price: Number(s.price || 0) }))
            .slice(0, 8)
        : null,
      // 🔄 admin يحفظ modifiers — menu-pro يتوقع options
      // 🌐 يدمج product.modifiers مع store.globalModifiers (productIds: فارغة=كل المنتجات، محددة=هؤلاء فقط)
      options: (function(){
        const productMods = Array.isArray(p.options) ? p.options
                          : Array.isArray(p.modifiers) ? p.modifiers : [];
        const globalMods  = Array.isArray(store.globalModifiers) ? store.globalModifiers : [];
        const seen = new Set();
        const merged = [];
        for (const o of productMods) {
          if (!o || (!o.label && !o.name)) continue;
          const label = String(o.label || o.name);
          merged.push({ label, price: Number(o.price || 0) });
          seen.add(label);
        }
        for (const g of globalMods) {
          if (!g || !g.name) continue;
          if (seen.has(g.name)) continue;
          // 🎯 طبّق فقط إذا productIds فارغة (= كل المنتجات) أو تحتوي هذا المنتج
          const ids = Array.isArray(g.productIds) ? g.productIds : [];
          const applies = ids.length === 0 || ids.includes(String(p.id));
          if (!applies) continue;
          merged.push({ label: String(g.name), price: Number(g.price || 0) });
        }
        return merged.length ? merged.slice(0, 12) : null;
      })(),
      ingredients: typeof p.ingredients === "string" ? p.ingredients : null,
      // 🏠 accommodation (للـ rental)
      accommodation,
      availability,
      // customFields الذكية (يحفظها الـ AI admin config)
      customFields: (p.customFields && typeof p.customFields === "object") ? p.customFields : {},
    };
  }
  const catIds = new Set(cats.map(c => String(c.id)));
  const uncategorized = products.filter(p => !p.category || !catIds.has(String(p.category)));
  // 🔢 رتّب categories حسب sortOrder قبل العرض
  const sortedCats = cats.slice().sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));
  const categoriesData = sortedCats.length > 0
    ? [
        ...sortedCats.map(c => ({
          id: String(c.id),
          name: c.name,
          emoji: c.emoji || "🍽️",
          icon: c.icon || null,  // 🖼️ أيقونة الصنف
          items: products.filter(p => String(p.category) === String(c.id)).map(p => String(p.id)),
        })),
        ...(uncategorized.length > 0 ? [{ id: "__other__", name: "أخرى", emoji: "📋", items: uncategorized.map(p => String(p.id)) }] : []),
      ].filter(c => c.items.length > 0)
    : [{ id: "__all__", name: "المنتجات", emoji: "🛍️", items: products.map(p => String(p.id)) }];

  // اختيار الثيم: الـ explicit أولاً، ثم default للنشاط (مطعم/كافيه = achay)
  const theme = store.menuThemeName || (_isRestaurantLikeBiz(store) ? "achay" : "maroon");
  const tableLabel = sess.dine_in ? (sess.tableLabel || `طاولة ${sess.table}`) : "";
  const safeJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

  // 🎨 Achay-style layout (hero + circular logo + socials + large category circles)
  //    يُفعّل دائماً لكل menu pro — اللون فقط يتغير حسب menuThemeName
  const isAchayStyle = true;
  // ⚠️ hero لا يقع fallback على logo (يمنع تكرار نفس الصورة في هيرو + لوغو دائري)
  const heroImage = store.heroImageUrl || "";
  const logoUrl = store.invoiceLogoUrl || store.logoUrl || "";
  // 💡 tagline: يفضّل store.tagline (يديره صاحب المتجر) وإلا يفعّل adminConfig.tagline (AI)
  const tagline = (store.tagline || "").trim() || store.adminConfig?.tagline || "";
  // 📊 معلومات المتجر السريعة (تظهر كـ chips تحت الشعار)
  const _cur = store.currency || "ر.س";
  // 💰 رمز الريال السعودي الرسمي 2025+ (SVG)
  const _SAR_SVG = '<svg viewBox="0 0 1124.14 1256.39" aria-hidden="true"><path d="M699.62,1113.02h0c-20.06,44.48-33.32,92.75-38.4,143.37l424.51-90.24c20.06-44.47,33.31-92.75,38.4-143.37l-424.51,90.24Z"/><path d="M1085.73,895.8c20.06-44.47,33.32-92.75,38.4-143.37l-330.68,70.33v-135.2l292.27-62.11c20.06-44.47,33.33-92.75,38.42-143.37l-330.68,70.27V66.13c-50.67,28.45-95.67,66.32-132.25,110.99v403.35l-132.25,28.11V0c-50.67,28.44-95.67,66.32-132.25,110.99v525.69l-295.91,62.88c-20.06,44.47-33.33,92.75-38.42,143.37l334.33-71.05v170.26l-358.3,76.14c-20.06,44.47-33.32,92.75-38.4,143.37l375.04-79.7c30.53-6.35,56.77-22.67,75.94-45.41,18.66-22.55,29.84-51.77,29.84-83.84v-218.27l132.25-28.11v270.6l424.51-90.24Z"/></svg>';
  const _isSAR = /^(ر\.?س|SAR|ريال|SR)$/i.test(String(_cur).trim());
  // amount → HTML (uses SVG for SAR; falls back to text for other currencies)
  const _amountHtml = (n, decimals = 2) => {
    const num = Number(n).toFixed(decimals);
    return _isSAR
      ? `${num} <span class="mp-sar-sym">${_SAR_SVG}</span>`
      : `${num} ${_esc(_cur)}`;
  };
  // 📍 مناطق التوصيل: لو معرّفة، نعرض نطاق الأسعار (من X إلى Y)
  const _zones = Array.isArray(store.deliveryZones) ? store.deliveryZones.filter(z => z && z.name) : [];
  const _hasZones = _zones.length > 0;
  const _hasDelivery = Number(store.deliveryFee) > 0 || _hasZones;
  const _hasEta      = Number(store.avgDeliveryMin) > 0;
  const _hasMinOrder = Number(store.minOrder) > 0;
  // 🎨 Pill Bar style (design #2): icon فوق، رقم كبير وسط، label نصي تحت
  // 🕐 وقت التنفيذ — يدعم دقائق/ساعات/أيام
  const _timeUnit = String(store.deliveryTimeUnit || "minute").toLowerCase();
  const _etaValue = _hasEta ? computeETAChipText(store) : "";
  // 📍 قيمة التوصيل: لو مناطق متعددة → نطاق (min–max)، وإلا رقم واحد
  let _deliveryValueHtml = "";
  let _deliveryLabel = "توصيل";
  if (_hasZones) {
    const fees = _zones.map(z => Number(z.fee) || 0);
    const minFee = Math.min(...fees);
    const maxFee = Math.max(...fees);
    if (minFee === maxFee) {
      _deliveryValueHtml = _amountHtml(minFee, 0);
    } else {
      _deliveryValueHtml = `${minFee}–${maxFee}${_isSAR ? ` <span class="mp-sar-sym">${_SAR_SVG}</span>` : ` ${_esc(_cur)}`}`;
    }
    _deliveryLabel = `${_zones.length} مناطق`;
  } else if (Number(store.deliveryFee) > 0) {
    _deliveryValueHtml = _amountHtml(store.deliveryFee, 2);
  }
  const _infoChips = [];
  if (_hasEta)      _infoChips.push({ icon: "🕒", label: _timeUnit === "day" ? "المدة" : (_timeUnit === "hour" ? "المدة" : "دقيقة"), valueHtml: _esc(_etaValue) });
  if (_hasDelivery) _infoChips.push({ icon: "🛵", label: _deliveryLabel, valueHtml: _deliveryValueHtml });
  if (_hasMinOrder) _infoChips.push({ icon: "💰", label: "حد أدنى",   valueHtml: _amountHtml(store.minOrder, 0) });
  // Socials: pull from store fields if defined
  // 🚫 حُذف 📞 (ownerPhone) و 💬 (botPhone) — مكرران مع زر 👤 في الهيرو
  const socials = [];
  if (store.googleMapsUrl || store.locationMapUrl) socials.push({ icon: "📍", url: store.googleMapsUrl || store.locationMapUrl, label: "خرائط" });
  if (store.instagramUrl) socials.push({ icon: "📷", url: store.instagramUrl, label: "Instagram" });
  if (store.twitterUrl) socials.push({ icon: "𝕏", url: store.twitterUrl, label: "X" });
  if (store.tiktokUrl) socials.push({ icon: "🎵", url: store.tiktokUrl, label: "TikTok" });
  if (store.snapchatUrl) socials.push({ icon: "👻", url: store.snapchatUrl, label: "Snapchat" });

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html><html dir="rtl" lang="ar"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="${isAchayStyle ? "#EBD9B9" : "#FAFAF7"}">
<title>${_esc(store.storeName || "منيو")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="/menu-pro/menu-pro.css?v=62">
</head>
<body class="mp-theme-${_esc(theme)}">
<div class="mp-app">
  ${tableLabel ? `<div class="mp-table-badge">🍽️ ${_esc(tableLabel)}</div>` : ""}
  ${isAchayStyle ? `
    <!-- Achay-style hero -->
    <div class="mp-hero${heroImage ? "" : " mp-hero-empty"}">
      ${heroImage ? `<img src="${_esc(heroImage)}" alt="hero">` : ""}
      <button class="mp-hero-user" id="mpHeaderMenu" aria-label="القائمة">👤</button>
      <div class="mp-hero-logo">
        ${logoUrl ? `<img src="${_esc(logoUrl)}" alt="logo">` : `<span>${_esc((store.storeName || "م").trim().charAt(0))}</span>`}
      </div>
    </div>
    <div class="mp-brand">
      <button class="mp-brand-lang" data-action="lang">▼ Arabic 🌐</button>
      <h1 class="mp-brand-name">${_esc(store.storeName || "متجرنا")}</h1>
      ${tagline ? `<p class="mp-brand-tagline">${_esc(tagline)}</p>` : ""}
    </div>
    ${_infoChips.length ? `
      <div class="mp-info-chips">
        ${_infoChips.map(c => `
          <div class="mp-info-chip">
            <div class="mp-info-chip-icon">${c.icon}</div>
            <div class="mp-info-chip-value">${c.valueHtml}</div>
            <div class="mp-info-chip-label">${_esc(c.label)}</div>
          </div>
        `).join("")}
      </div>
    ` : ""}
    ${socials.length ? `
      <div class="mp-socials">
        ${socials.map(s => `<a class="mp-social" href="${_esc(s.url)}" target="_blank" rel="noopener" title="${_esc(s.label)}">${s.icon}</a>`).join("")}
      </div>
    ` : ""}
    ${(store.showcaseEnabled !== false) ? `
    <a href="/browse/${_esc(store.id || "")}" rel="noopener" class="mp-showcase-banner" style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:12px 14px 6px;padding:13px 16px;border-radius:14px;background:linear-gradient(135deg,rgba(201,162,75,0.20),rgba(201,162,75,0.08));border:1.5px solid rgba(201,162,75,0.45);color:inherit;text-decoration:none;box-shadow:0 4px 12px rgba(201,162,75,0.15);cursor:pointer">
      <div style="display:flex;align-items:center;gap:12px;min-width:0">
        <div style="width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,#c9a24b,#a07f2e);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;color:#fff;box-shadow:0 2px 6px rgba(201,162,75,0.4)">✨</div>
        <div style="min-width:0">
          <div style="font-size:14px;font-weight:800;color:#3a2e14">استعرض المنيو</div>
          <div style="font-size:11.5px;font-weight:600;color:#7a6534">شاهد الأصناف والمكونات بأناقة</div>
        </div>
      </div>
      <div style="font-size:22px;opacity:.8;flex-shrink:0;color:#a07f2e">›</div>
    </a>
    ` : ""}
    ${((Array.isArray(store.menuFiles) && store.menuFiles.length) || store.menuImageUrl) && store.shareSlug ? `
    <a href="/menu-book/${_esc(store.shareSlug)}" rel="noopener" class="mp-menubook-banner" style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:6px 14px 6px;padding:13px 16px;border-radius:14px;background:linear-gradient(135deg,rgba(120,53,15,0.18),rgba(120,53,15,0.06));border:1.5px solid rgba(120,53,15,0.45);color:inherit;text-decoration:none;box-shadow:0 4px 12px rgba(120,53,15,0.15);cursor:pointer">
      <div style="display:flex;align-items:center;gap:12px;min-width:0">
        <div style="width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,#78350f,#451a03);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;color:#fff;box-shadow:0 2px 6px rgba(120,53,15,0.4)">📖</div>
        <div style="min-width:0">
          <div style="font-size:14px;font-weight:800;color:#3a2e14">المنيو الرسمي (صور/PDF)</div>
          <div style="font-size:11.5px;font-weight:600;color:#7a6534">تصفّح المنيو بتقليب الصفحات</div>
        </div>
      </div>
      <div style="font-size:22px;opacity:.8;flex-shrink:0;color:#78350f">›</div>
    </a>
    ` : ""}
    <nav class="mp-cats-circles" id="mpTabs"></nav>
    <div class="mp-tabs-sep"></div>
    <div class="mp-view-toggle" id="mpViewToggle">
      <button class="active" data-view="list" title="قائمة">☰</button>
      <button data-view="grid" title="شبكة">▦</button>
    </div>
  ` : `
    <header class="mp-header">
      <button class="mp-header-menu" id="mpHeaderMenu" aria-label="القائمة">☰</button>
      <div class="mp-header-brand">
        ${logoUrl ? `<img class="mp-header-logo" src="${_esc(logoUrl)}" alt="logo">` : `<div class="mp-header-logo" style="display:flex;align-items:center;justify-content:center;font-size:20px">🍽️</div>`}
        <div class="mp-header-info">
          <div class="mp-header-name">${_esc(store.storeName || "متجرنا")}</div>
          <div class="mp-header-sub">${tableLabel || tagline || "اطلب أفضل ما لدينا"}</div>
        </div>
      </div>
      <button class="mp-header-lang" data-action="lang">EN</button>
    </header>
    <nav class="mp-tabs" id="mpTabs"></nav>
  `}
  <main id="mpSections"></main>
  <div class="mp-compliance">
    <a href="https://wa.me/${_esc(String(process.env.MASTER_PHONE || "966508572902").replace(/\D/g, ""))}?text=${encodeURIComponent("مرحباً 👋 احتاج دعم بخصوص منصة ثواني")}" target="_blank" rel="noopener" class="mp-footer-brand" title="تواصل مع دعم منصة ثواني">
      <img src="/logo-transparent-40.png" alt="ثواني" loading="lazy">
      <span>جميع الحقوق محفوظة لـ <b>منصة ثواني</b> © ${new Date().getFullYear()}</span>
    </a>
  </div>
</div>
<button class="mp-cart-fab" id="mpCartFab" type="button">
  <span class="mp-cart-fab-count" id="mpCartCount">0</span>
  <span class="mp-cart-fab-label">إرسال الطلب</span>
  <span class="mp-cart-fab-total" id="mpCartTotal">0${_isSAR ? ` <span class="mp-sar-sym">${_SAR_SVG}</span>` : ` ${_esc(_cur)}`}</span>
</button>

<!-- Bottom sheet -->
<div class="mp-sheet-backdrop" id="mpSheetBackdrop" onclick="_mpSheetClose()"></div>
<div class="mp-sheet" id="mpSheet">
  <div class="mp-sheet-handle"></div>
  <div class="mp-sheet-body">
    <div class="mp-sheet-hero" id="mpSheetHero">
      <button class="mp-sheet-close" onclick="_mpSheetClose()">✕</button>
    </div>
    <div class="mp-sheet-content">
      <h2 class="mp-sheet-name" id="mpSheetName"></h2>
      <p class="mp-sheet-desc" id="mpSheetDesc"></p>
      <div class="mp-sheet-meta" id="mpSheetMeta"></div>
    </div>
  </div>
  <div class="mp-sheet-foot">
    <div class="mp-stepper">
      <button onclick="_mpSheetStep(-1)">−</button>
      <span class="mp-stepper-val" id="mpSheetQty">1</span>
      <button onclick="_mpSheetStep(1)">+</button>
    </div>
    <button class="mp-sheet-cta" id="mpSheetCta" onclick="_mpSheetAdd()">أضف للسلة</button>
  </div>
</div>

<!-- Side drawer -->
<div class="mp-drawer-backdrop" id="mpDrawerBackdrop"></div>
<aside class="mp-drawer" id="mpDrawer">
  <div class="mp-drawer-head">
    <div class="mp-drawer-title">${_esc(store.storeName || "متجرنا")}</div>
    <div class="mp-drawer-sub">${tableLabel || (store.address || "")}</div>
  </div>
  <div class="mp-drawer-body">
    ${(store.showcaseEnabled !== false) ? `
    <div class="mp-drawer-item" data-action="showcase" style="background:linear-gradient(135deg,rgba(201,162,75,0.15),rgba(201,162,75,0.05));border:1px solid rgba(201,162,75,0.35);border-radius:12px;margin-bottom:6px">
      <div class="mp-drawer-item-icon">✨</div><div style="font-weight:800">استعرض المنيو</div><div class="mp-drawer-item-chev">›</div>
    </div>
    ` : ""}
    <div class="mp-drawer-item" data-action="rate">
      <div class="mp-drawer-item-icon">⭐</div><div>قيّم تجربتك</div><div class="mp-drawer-item-chev">›</div>
    </div>
    <div class="mp-drawer-item" data-action="lang">
      <div class="mp-drawer-item-icon">🌐</div><div>اللغة / Language</div><div class="mp-drawer-item-chev">›</div>
    </div>
    <div class="mp-drawer-item" data-action="close">
      <div class="mp-drawer-item-icon">↩️</div><div>إغلاق</div>
    </div>
  </div>
</aside>

<script>
var TOKEN = ${safeJson(req.params.token)};
var PRODS = ${safeJson(productData)};
var CATS  = ${safeJson(categoriesData)};
var CUR   = ${safeJson((function(c){const s=String(c||"").trim(); return (!s || /^(ر\.?س|SAR|ريال|ر$)/i.test(s)) ? "﷼" : s;})(store.currency || "ر.س"))};
var IS_SAR = ${safeJson(_isSAR)};
var MP_STYLE = ${safeJson(isAchayStyle ? "achay" : "default")};
var IS_SHARE_LINK = ${safeJson(typeof sess.from === "string" && sess.from.startsWith("share_anon_"))};
var NAME  = ${safeJson(store.storeName || "متجرنا")};
var LOGO  = ${safeJson(store.invoiceLogoUrl || store.logoUrl || "")};
var DINE_IN = ${safeJson(!!sess.dine_in)};
var TABLE = ${safeJson(sess.table || null)};
var TABLE_LABEL = ${safeJson(sess.tableLabel || "")};
var BOT_PHONE = ${safeJson(sess.botPhone || "")};
var STORE_ID  = ${safeJson(store.id || "")};
var SHOWCASE_ENABLED = ${safeJson(store.showcaseEnabled !== false)};
</script>
<script src="/menu-pro/menu-pro.js?v=69" defer></script>
</body></html>`);
}

// 🏠 GET فترات وحدة معينة (للكالندر)
// 🎨 صفحة استعراض المنتجات (3D showcase) — عرض فقط بلا سلة
app.get("/browse/:storeId", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "showcase.html"));
});
app.get("/browse", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "showcase.html"));
});
// API لجلب بيانات المتجر لصفحة العرض (public — بلا auth، فقط منتجات + صور + عنوان)
// 🎬 helper: تحويل URL فيديو إلى embed format (YouTube/Vimeo/Drive/mp4 مباشر)
function _showcaseVideoEmbed(url) {
  if (!url) return null;
  const s = String(url).trim();
  const yt = s.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_\-]{11})/);
  if (yt) return { kind: "youtube", embed: `https://www.youtube.com/embed/${yt[1]}?rel=0&playsinline=1`, original: s };
  const vm = s.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vm) return { kind: "vimeo", embed: `https://player.vimeo.com/video/${vm[1]}`, original: s };
  const gd = s.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_\-]+)/);
  if (gd) return { kind: "drive", embed: `https://drive.google.com/file/d/${gd[1]}/preview`, original: s };
  if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(s) || s.startsWith("/store-videos/")) {
    return { kind: "native", embed: s, original: s };
  }
  return { kind: "link", embed: s, original: s };
}

app.get("/api/showcase/:storeId", (req, res) => {
  const store = getStoreById(req.params.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  // فلترة: فقط منتجات متاحة + غير مؤرشفة
  const products = (store.products || [])
    .filter(p => p.available !== false && (p.stock == null || Number(p.stock) > 0))
    .map(p => ({
      id: p.id, name: p.name, description: p.description || p.desc || "",
      imageUrl: p.imageUrl || null,
      price: p.priceOnRequest ? null : Number(p.price || 0),
      priceOnRequest: !!p.priceOnRequest,
      category: p.category,
      calories: p.calories || p.cal,
      prepTimeMin: p.prepTimeMin,
      size: p.size,
      sizes: Array.isArray(p.sizes) ? p.sizes.slice(0, 8).map(s => ({ name: s.name, price: s.price })) : [],
      options: Array.isArray(p.options) ? p.options.slice(0, 12).map(o => ({ name: o.name, price: o.price })) : [],
      removableIngredients: Array.isArray(p.removableIngredients) ? p.removableIngredients : [],
      popular: !!p.popular, spicy: !!p.spicy, isNew: !!p.isNew,
      // 🎬 فيديو المنتج
      video: _showcaseVideoEmbed(p.videoUrl),
      videoUrl: p.videoUrl || "", // للأدمن (raw)
      videoCaption: p.videoCaption || "",
      // 🧪 مقادير سحرية (showcase-only) — array of { name, emoji, note? }
      ingredients: Array.isArray(p.showcaseIngredients)
        ? p.showcaseIngredients.slice(0, 20).map(i => ({
            name:  String(i.name || "").slice(0, 60),
            emoji: String(i.emoji || "✨").slice(0, 8),
            note:  String(i.note || "").slice(0, 100),
          })).filter(i => i.name)
        : [],
    }));
  // 🔗 رابط الطلب (share-slug إن وجد)
  let orderLink = "";
  if (store.shareSlug) {
    const base = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
    orderLink = `${base}/m/${store.shareSlug}`;
  }
  res.setHeader("Cache-Control", "public, max-age=60"); // 1 دقيقة cache للسرعة
  res.json({
    storeId: store.id,
    storeName: store.storeName || "متجرنا",
    tagline: (store.tagline || "").trim() || (store.adminConfig?.tagline || ""),
    logoUrl: store.invoiceLogoUrl || store.logoUrl || null,
    heroImage: store.heroImageUrl || null,
    categories: store.categories || [],
    products,
    currency: store.currency || "ر.س",
    orderLink,
    // 🎨 showcase config
    theme:            (store.showcaseTheme || "royal").toLowerCase(),
    showcaseTitle:    store.showcaseTitle || "",
    showcaseSubtitle: store.showcaseSubtitle || "",
    enabled:          store.showcaseEnabled !== false,
  });
});

app.get("/api/menu-token/:token/unit-bookings/:unitId", (req, res) => {
  const sess = waMgr.getWebOrderSession(req.params.token);
  if (!sess) return res.status(410).json({ error: "expired" });
  try {
    const bookings = require("./bookings");
    // ⚠️ includeExpired=true ضروري — لمنع double-booking على فترات endAt المستقبلية
    const all = bookings.listBookings(sess.storeId, { includeExpired: true });
    const now = Date.now();
    const periods = all
      .filter(b => b.unitId === req.params.unitId && b.endAt && !["cancelled","rejected","no_show"].includes(b.status))
      .filter(b => new Date(b.endAt).getTime() > now) // فقط الـ periods المستقبلية أو الحالية
      .map(b => ({ startAt: b.startAt, endAt: b.endAt, status: b.status }));
    res.json({ unitId: req.params.unitId, periods });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 🏠 POST حجز وحدة عقارية من webview البوت
app.post("/api/menu-token/:token/book-unit", express.json({ limit: "5kb" }), async (req, res) => {
  const sess = waMgr.getWebOrderSession(req.params.token);
  if (!sess) return res.status(410).json({ error: "expired" });
  const b = req.body || {};
  if (!b.unitId || !b.startAt || !b.endAt) return res.status(400).json({ error: "unitId+startAt+endAt مطلوبة" });
  if (!b.customerName || !b.customerPhone) return res.status(400).json({ error: "اسم + جوال مطلوبان" });

  // 📅 تحقق من صحة التواريخ — يمنع الحجز في الماضي أو نطاق معكوس
  const _startMs = Date.parse(b.startAt);
  const _endMs   = Date.parse(b.endAt);
  if (!_startMs || !_endMs) {
    return res.status(400).json({ error: "INVALID_DATE", message: "صيغة التاريخ غير صحيحة" });
  }
  if (_startMs < Date.now() - 60_000) {
    return res.status(400).json({ error: "PAST_DATE", message: "⚠️ لا يمكن الحجز في تاريخ سابق. اختر تاريخاً مستقبلياً." });
  }
  if (_endMs <= _startMs) {
    return res.status(400).json({ error: "INVALID_RANGE", message: "⚠️ تاريخ المغادرة يجب أن يكون بعد تاريخ الوصول." });
  }

  // 📱 تحقق من رقم العميل — لازم يبدأ برمز الدولة (لا 0 ولا فراغ)
  const phoneDigits = String(b.customerPhone).replace(/\D/g, "").replace(/^00/, "");
  if (phoneDigits.startsWith("0") || phoneDigits.length < 10 || phoneDigits.length > 15) {
    return res.status(400).json({
      error: "MISSING_COUNTRY_CODE",
      message: "⚠️ رقم الجوال يحتاج رمز الدولة في البداية\n\nأمثلة صحيحة:\n✓ 966512345678 (سعودية)\n✓ 201012345678 (مصر)\n✓ 971501234567 (إمارات)\n\nلا تضع 0 في البداية، ولا تكتب + أو مسافات.",
    });
  }
  // تحقق من رمز دولة معروف (لتفادي أرقام عشوائية)
  const KNOWN_CC = ["966","971","973","974","965","968","962","964","963","961","970","20","212","213","216","218","249","252","253","967","90","60","62","91","92"];
  if (!KNOWN_CC.some(cc => phoneDigits.startsWith(cc))) {
    return res.status(400).json({
      error: "INVALID_COUNTRY_CODE",
      message: "⚠️ رقم الجوال لا يبدأ برمز دولة معروف\n\nتأكد من البداية:\n✓ سعودية: 966\n✓ مصر: 20\n✓ إمارات: 971\n✓ كويت: 965\n\nمثال: 966512345678",
    });
  }
  b.customerPhone = phoneDigits;

  const store = resolveStore(sess.storeId);
  if (!store) return res.status(404).json({ error: "store_not_found" });
  const unit = (store.products || []).find(p => p.id === b.unitId && p.accommodation);
  if (!unit) return res.status(404).json({ error: "unit_not_found" });

  try {
    // 🏖️ Saudi pricing: حساب الإجمالي بـ weekday/weekend/holiday + extras
    const pricing = require("./accommodation-pricing");
    const selectedExtras = Array.isArray(b.extras) ? b.extras.filter(k => typeof k === "string" && k.length < 50) : [];
    let priceCalc;
    try {
      priceCalc = pricing.calculatePrice({
        unit,
        checkIn: b.startAt,
        checkOut: b.endAt,
        extras: selectedExtras,
      });
    } catch (e) {
      // fallback لو بيانات السعر ناقصة
      priceCalc = { total: 0, nights: 0, breakdown: [] };
    }
    const bookings = require("./bookings");
    const r = await bookings.createBooking(sess.storeId, {
      customerName:  String(b.customerName).slice(0, 80),
      customerPhone: String(b.customerPhone).replace(/\D/g, "").slice(0, 15),
      serviceName:   unit.name,
      startAt:       b.startAt,
      endAt:         b.endAt,
      unitId:        b.unitId,
      unitName:      unit.name,
      pricePerNight: Number(unit.accommodation?.priceWeekday || unit.price) || 0,
      guests:        b.guests || null,
      notes:         String(b.notes || "").slice(0, 300),
      extras:        selectedExtras,
      breakdown:     priceCalc.breakdown,
      totalPrice:    priceCalc.total || null,
    });
    if (!r.ok) return res.status(r.code === "UNIT_UNAVAILABLE" ? 409 : 400).json({ error: r.error });
    // إشعار المالك واتس — يشمل breakdown
    try {
      const ownerPhone = String(store.ownerPhone || "").replace(/\D/g,"");
      if (ownerPhone) {
        const ownerJid = ownerPhone + "@s.whatsapp.net";
        const inDate  = new Date(b.startAt).toLocaleDateString("ar-EG",{month:"short",day:"numeric"});
        const outDate = new Date(b.endAt).toLocaleDateString("ar-EG",{month:"short",day:"numeric"});
        const guestsTxt = b.guests ? ` · 👥 ${b.guests}` : "";
        const finalTotal = priceCalc.total || r.booking.totalPrice;
        const breakdownText = priceCalc.breakdown && priceCalc.breakdown.length
          ? "\n📊 *التفاصيل:*\n" + pricing.formatBreakdown(priceCalc.breakdown, "ر.س")
          : "";
        const msg = `🏠 *حجز جديد عبر البوت — "${unit.name}"*\n\n` +
          `👤 ${b.customerName}\n📱 +${String(b.customerPhone).replace(/\D/g,"")}\n` +
          `🔑 ${inDate} → 👋 ${outDate}${guestsTxt}\n` +
          `💰 الإجمالي: *${finalTotal} ر.س* (${priceCalc.nights || r.booking.nights} ليلة)` +
          breakdownText + "\n" +
          (b.notes ? `📝 ${b.notes}\n` : "") +
          `\n📋 افتح لوحة التاجر لتأكيد الحجز`;
        waMgr.sendMessage(sess.storeId, ownerJid, msg, { allowCold: true, reason: "order_notification" }).catch(e => console.warn("[booking-notify] failed:", e.message));
      }
    } catch {}

    // 📩 رسالة تأكيد للعميل (يستلمها في واتساب فوراً)
    try {
      const customerJid = String(b.customerPhone).replace(/\D/g, "") + "@s.whatsapp.net";
      const inDate  = new Date(b.startAt).toLocaleDateString("ar-EG",{weekday:"long",month:"long",day:"numeric"});
      const outDate = new Date(b.endAt).toLocaleDateString("ar-EG",{weekday:"long",month:"long",day:"numeric"});
      const finalTotal = priceCalc.total || r.booking.totalPrice;
      // قالب قابل للتخصيص من إعدادات المتجر
      const tpl = store.bookingAckTemplate || `✅ *تم استلام طلب حجزك*

أهلاً {{customerName}} 👋

شكراً لاختيارك *{{storeName}}*

🏠 الوحدة: *{{unitName}}*
🔑 الوصول: {{checkIn}}
👋 المغادرة: {{checkOut}}
💰 الإجمالي: *{{total}} ر.س* ({{nights}} ليلة)

📞 سيتواصل معك المسؤول خلال دقائق للاتفاق على الدفع وإتمام الحجز.

⏳ البوت في وضع الانتظار حتى يتم تأكيد حجزك.`;
      const ackMsg = tpl
        .replace(/\{\{customerName\}\}/g, b.customerName)
        .replace(/\{\{storeName\}\}/g, store.storeName || "متجرنا")
        .replace(/\{\{unitName\}\}/g, unit.name)
        .replace(/\{\{checkIn\}\}/g, inDate)
        .replace(/\{\{checkOut\}\}/g, outDate)
        .replace(/\{\{total\}\}/g, String(finalTotal))
        .replace(/\{\{nights\}\}/g, String(priceCalc.nights || r.booking.nights))
        .replace(/\{\{bookingId\}\}/g, r.booking.id);
      waMgr.sendMessage(sess.storeId, customerJid, ackMsg, { allowCold: true, reason: "booking_intent_reply" })
        .catch(e => console.warn("[booking-customer-ack] failed:", e.message));

      // 🤫 Auto-handoff للحجوزات: البوت يصمت حتى يضغط الادمن "تأكيد"
      // التاجر سيكلم العميل في واتساب مباشرة للاتفاق على الدفع، ثم يضغط Confirm
      try {
        const fs = require("fs");
        const path = require("path");
        const atomicFs = require("./atomic-fs");
        const handoffFile = path.join(__dirname, "..", "data", "handoffs.json");
        let handoffs = {};
        try { handoffs = JSON.parse(fs.readFileSync(handoffFile, "utf8")); } catch {}
        handoffs[sess.storeId + "|" + customerJid] = {
          storeId:   sess.storeId,
          phone:     customerJid,
          startedAt: new Date().toISOString(),
          lastMsg:   `auto: booking ${r.booking.id} pending confirmation`,
          reason:    "booking_pending",
          bookingId: r.booking.id,
          autoStarted: true,
        };
        atomicFs.writeJsonSync(handoffFile, handoffs);
        console.log(`[booking-handoff] auto-set for ${customerJid} @ ${sess.storeId} (booking=${r.booking.id})`);
      } catch (e) { console.warn("[booking-handoff] failed:", e.message); }
    } catch (e) { console.warn("[booking-customer-ack] error:", e.message); }

    // 📡 SSE: إشعار فوري للوحة الادمن (لتحديث القائمة بدون refresh)
    try { global.sseSend?.(sess.storeId, "new_booking", r.booking); } catch {}

    // 👤 سجّل العميل في قاعدة العملاء (مع counter للحجوزات)
    try {
      const { upsertCustomer } = require("./customers");
      upsertCustomer({
        phone:    String(b.customerPhone).replace(/\D/g, ""),
        name:     b.customerName,
        location: unit.accommodation?.location || "",
        total:    priceCalc.total || 0,
        storeId:  sess.storeId,
        kind:     "booking",
      });
    } catch (e) { console.warn("[booking-customer] upsert failed:", e.message); }

    // امسح session menu token (تم الحجز)
    waMgr.clearWebOrderSession(req.params.token);

    // 🧹 نظّف session البوت — أخرجها من mid-flow حتى inactivity-watcher لا يبعت "تم الإلغاء"
    // sessionManager scope بـ storeCtx — لذا نلفّها في storeCtx.run
    try {
      const customerJid = String(b.customerPhone).replace(/\D/g, "") + "@s.whatsapp.net";
      storeCtx.run({ storeId: sess.storeId, store }, () => {
        sessionManager.set(customerJid, { step: "POST_ORDER", cart: [], _storeId: sess.storeId, _inactivityCancelled: true });
      });
    } catch (e) { console.warn("[booking-session-cleanup] failed:", e.message); }

    res.json({ ok: true, booking: r.booking });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 🍽️ Dine-in: list table's orders (للـ dashboard في المنيو) ───
// GET /api/dine-in/:token/orders → آخر طلبات الطاولة (آخر 3 ساعات)
app.get("/api/dine-in/:token/orders", (req, res) => {
  const sess = waMgr.getWebOrderSession(req.params.token);
  if (!sess) return res.status(410).json({ ok: false, error: "expired" });
  if (!sess.dine_in || !sess.table) return res.status(403).json({ ok: false, error: "not_dine_in" });
  try {
    const orders = require("./orders");
    const all = orders.readOrders(sess.storeId, 100);
    const cutoff = Date.now() - 3 * 60 * 60 * 1000; // آخر 3 ساعات
    const tableOrders = all.filter(o =>
      (o.source === "dine_in" || o.dine_in === true) &&
      Number(o.table) === Number(sess.table) &&
      new Date(o.timestamp).getTime() >= cutoff
    ).map(o => ({
      orderId:   o.orderId,
      timestamp: o.timestamp,
      status:    o.status,
      items:     o.items || [],
      total:     o.total || 0,
      notes:     o.notes || "",
      tableLabel: o.tableLabel || `طاولة ${sess.table}`,
    }));
    res.json({ ok: true, table: sess.table, tableLabel: sess.tableLabel || `طاولة ${sess.table}`, orders: tableOrders });
  } catch (e) {
    console.warn("[dine-in/list]", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/dine-in/:token/message → رسالة من العميل للمطعم (محفوظة + SSE + WhatsApp)
app.post("/api/dine-in/:token/message", express.json({ limit: "2kb" }), async (req, res) => {
  const sess = waMgr.getWebOrderSession(req.params.token);
  if (!sess) return res.status(410).json({ ok: false, error: "expired" });
  if (!sess.dine_in || !sess.table) return res.status(403).json({ ok: false, error: "not_dine_in" });
  const text = String(req.body?.text || "").trim().slice(0, 300);
  if (!text) return res.status(400).json({ ok: false, error: "empty" });
  const store = resolveStore(sess.storeId);
  if (!store) return res.status(404).json({ ok: false, error: "no_store" });
  try {
    const tableChat = require("./table-chat");
    const msg = tableChat.appendMessage(sess.storeId, sess.table, "customer", text);
    // SSE للوحة الادمن
    try { global.sseSend?.(sess.storeId, "table_message", { table: sess.table, from: "customer", text, ts: msg.ts, id: msg.id }); } catch {}
    // واتساب للمالك (إضافي — تنبيه فوري)
    try {
      const ownerPhone = String(store.ownerPhone || "").replace(/\D/g, "");
      if (ownerPhone) {
        const ownerJid = ownerPhone + "@s.whatsapp.net";
        const tableLabel = sess.tableLabel || `طاولة ${sess.table}`;
        const waMsg = `💬 *رسالة من الطاولة*\n\n🍽️ ${tableLabel}\n\n📩 ${text}\n\n_رد من لوحة التحكم → 💬 رسائل الطاولات_`;
        waMgr.sendMessage(sess.storeId, ownerJid, waMsg, { allowCold: true, reason: "table_message" })
          .catch(e => console.warn("[dine-in/msg/wa]", e.message));
      }
    } catch {}
    console.log(`[dine-in/msg] table=${sess.table} storeId=${sess.storeId} text=${text.slice(0,50)}`);
    res.json({ ok: true, message: msg });
  } catch (e) {
    console.warn("[dine-in/msg]", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/dine-in/:token/messages → سجل المحادثة للعميل
app.get("/api/dine-in/:token/messages", (req, res) => {
  const sess = waMgr.getWebOrderSession(req.params.token);
  if (!sess) return res.status(410).json({ ok: false, error: "expired" });
  if (!sess.dine_in || !sess.table) return res.status(403).json({ ok: false, error: "not_dine_in" });
  try {
    const tableChat = require("./table-chat");
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const messages = tableChat.getMessages(sess.storeId, sess.table, limit);
    res.json({ ok: true, table: sess.table, messages });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post(["/api/order/:token", "/api/o/:token"], async (req, res) => {
  const sess = waMgr.getWebOrderSession(req.params.token);
  if (!sess) return res.status(410).json({ ok: false, error: "expired" });

  const { storeId, from, dine_in, table } = sess;
  // 🚫 Share-link tokens يجب ألا تصل هنا — العميل من /m/ يستخدم wa.me لا API call
  if (typeof from === "string" && from.startsWith("share_anon_")) {
    return res.status(400).json({ ok: false, error: "use_wa_link", message: "هذا الرابط يفتح واتساب — لا API submit" });
  }
  // Dine-in: لا تحذف الـ token (مشترك بين كل العملاء على الطاولة، صالح 90 يوم)
  if (!dine_in) waMgr.clearWebOrderSession(req.params.token);

  const { items, notes } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ ok: false, error: "empty cart" });
  }
  const cleanNotes = String(notes || "").trim().slice(0, 500);

  const store = resolveStore(storeId);
  if (!store) return res.status(404).json({ ok: false, error: "store not found" });

  // ⭐ التفاف في storeCtx ليتطابق session key (storeId|phone) مع باقي الـ flow
  return storeCtx.run({ storeId, store }, async () => {
    return _handleWebOrderSubmit(req, res, { storeId, from, store, items, cleanNotes, dine_in, table });
  });
});

async function _handleWebOrderSubmit(req, res, { storeId, from, store, items, cleanNotes, dine_in, table }) {

  // Build cart with imageUrl + priceOnRequest from store products (source of truth)
  // ⚠️ السعر يُؤخذ من المنتج لا من الـ client (لمنع التزوير)
  // 📦 منتجات خارج المخزون أو غير متاحة تُرفض مع رسالة واضحة
  const outOfStockItems = [];
  const cartItems = items
    .map(item => {
      const prod = (store.products || []).find(p => String(p.id) === String(item.id));
      if (!prod) return null;
      // 🚫 منتج غير متاح أو نفد مخزونه
      const isUnavailable = prod.available === false
        || (prod.stock !== null && prod.stock !== undefined && Number(prod.stock) <= 0);
      if (isUnavailable) {
        outOfStockItems.push(prod.name || item.name);
        return null;
      }
      const isNegotiable = !!prod.priceOnRequest;
      // 🚫 Phase 1: قبول excluded ingredients إن أرسلها العميل من الـ webview
      // وتحقق أنها فعلاً في قائمة removableIngredients (يمنع التزوير)
      const allowedRemovable = new Set(
        Array.isArray(prod.removableIngredients) ? prod.removableIngredients : []
      );
      const excluded = Array.isArray(item.excluded)
        ? item.excluded
            .filter(s => typeof s === "string" && allowedRemovable.has(s))
            .slice(0, 20)
        : [];
      return {
        id:       item.id,
        name:     String(item.name || prod.name || ""),
        price:    isNegotiable ? 0 : Number(prod.price ?? item.price ?? 0),
        qty:      Math.max(1, Number(item.qty) || 1),
        imageUrl: prod.imageUrl || null,
        priceOnRequest: isNegotiable,
        excluded: excluded.length ? excluded : undefined,
      };
    })
    .filter(i => i && i.qty > 0 && i.name);

  if (outOfStockItems.length) {
    return res.status(409).json({
      ok: false,
      error: "OUT_OF_STOCK",
      items: outOfStockItems,
      message: `⚠️ المنتجات التالية غير متوفرة حالياً:\n${outOfStockItems.map(n => "• " + n).join("\n")}\n\nأزلها من السلة وحاول مرة أخرى.`,
    });
  }
  if (!cartItems.length) return res.status(400).json({ ok: false, error: "invalid items" });

  // ─── 🍽️ Dine-in branch: طلب مباشر من طاولة (لا واتساب للعميل، إخطار صالة للمالك) ──
  if (dine_in && table) {
    const orders = require("./orders");
    const sessAll = waMgr.getWebOrderSession(req.params.token) || {};
    const tableLabel = sessAll.tableLabel || `طاولة ${table}`;
    const section    = sessAll.section    || "";
    const area       = sessAll.area       || "";
    const tableNote  = sessAll.tableNote  || "";

    const subtotal = cartItems.reduce((s, i) => s + (i.priceOnRequest ? 0 : i.price * i.qty), 0);
    const orderId  = "DIN-" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random()*1000).toString(36).toUpperCase();
    const order = {
      orderId,
      storeId,
      customerPhone: `table_${table}`,
      customerName:  tableLabel,
      items:    cartItems,
      subtotal,
      deliveryFee: 0,
      total:    subtotal,
      notes:    cleanNotes,
      status:   "pending",
      source:   "dine_in",
      dine_in:  true,
      table,
      tableLabel,
      section,
      area,
      tableNote,
    };
    try { orders.logOrder(order); } catch (e) { console.warn("[dine-in/log]", e.message); }

    // إخطار المالك
    try {
      const ownerPhone = String(store.ownerPhone || "").replace(/\D/g, "");
      if (ownerPhone) {
        const ownerJid = ownerPhone + "@s.whatsapp.net";
        const lines = cartItems.map(i => {
          const exclTxt = (i.excluded && i.excluded.length) ? `\n   🚫 بدون: ${i.excluded.join("، ")}` : "";
          return `• ${i.name} × ${i.qty}` + (i.priceOnRequest ? "" : ` — ${(i.price * i.qty).toFixed(2)}`) + exclTxt;
        });
        const msg =
          `🍽️ *طلب جديد — ${tableLabel}*\n` +
          (tableNote ? `📍 ${tableNote}\n` : "") +
          `\n` +
          lines.join("\n") +
          (subtotal > 0 ? `\n\n💰 الإجمالي: *${subtotal.toFixed(2)} ${store.currency || "ر.س"}*` : "") +
          (cleanNotes ? `\n\n📝 ملاحظات: ${cleanNotes}` : "") +
          `\n\n🆔 ${orderId}`;
        waMgr.sendMessage(storeId, ownerJid, msg, { allowCold: true, reason: "order_notification" })
          .catch(e => console.warn("[dine-in/notify]", e.message));
      }
    } catch {}

    console.log(`[dine-in] new order: ${orderId} table=${table} (${tableLabel}) storeId=${storeId} items=${cartItems.length} total=${subtotal}`);
    return res.json({ ok: true, dine_in: true, table, tableLabel, orderId });
  }

  // ❌ خطوة الاسم محذوفة — استخدم botQuestions الديناميكية إن وجدت
  const storeData = getStoreById(storeId);

  // 💰 تحقق من الحد الأدنى للطلب — يمنع الطلبات الأقل من الحد
  const _minOrder = Number(storeData?.minOrder) || 0;
  if (_minOrder > 0) {
    const _subCheck = cartItems.reduce((s, i) => s + (i.priceOnRequest ? 0 : i.price * i.qty), 0);
    if (_subCheck < _minOrder) {
      const _cur = storeData?.currency || "ر.س";
      return res.status(400).json({
        ok: false,
        error: "MIN_ORDER_NOT_MET",
        message: `⚠️ الحد الأدنى للطلب ${_minOrder.toFixed(0)} ${_cur}. مجموع سلتك الحالي ${_subCheck.toFixed(2)} ${_cur} — يرجى إضافة المزيد.`,
        minOrder: _minOrder, currentSubtotal: _subCheck,
      });
    }
  }

  // 🤝 وضع "المالك يتحكم بالتفاصيل" (botSilentAfterOrder)
  // البوت يستلم الطلب فقط → يرسل ملخص للعميل → يبلّغ المالك → يصمت تماماً
  // المالك يتواصل مع العميل مباشرة (العنوان، الوقت، إلخ)
  // البوت يعود للكلام فقط عند: أوامر الأدمن من لوحة الطلبات (قبول/تحضير/توصيل/تسليم)
  if (storeData?.botSilentAfterOrder === true) {
    const ordersMod = require("./orders");
    const subtotal = cartItems.reduce((s, i) => s + (i.priceOnRequest ? 0 : i.price * i.qty), 0);
    const orderId = `ORD-${Date.now().toString().slice(-7)}`;
    try {
      ordersMod.logOrder({
        orderId,
        storeId,
        storeName:    storeData?.storeName || "",
        invoiceColor: storeData?.invoiceColor || null,
        invoiceLogoUrl: storeData?.invoiceLogoUrl || null,
        customerName: "عميل",
        customerPhone: phoneNum(from),
        items:      cartItems,
        subtotal,
        deliveryFee: 0,
        total:       subtotal,
        currency:    storeData?.currency || "ر.س",
        notes:       cleanNotes || null,
        date:        new Date().toISOString().slice(0, 10),
        status:      "pending_confirmation",
        source:      "menu_silent",
      });
    } catch (e) { console.warn("[silent-mode/log-order]", e.message); }

    // 📡 SSE إشعار فوري للوحة الأدمن
    try { global.sseSend?.(storeId, "new_order", { orderId, customerPhone: phoneNum(from), items: cartItems, subtotal, source: "menu_silent" }); } catch {}

    // خصم المخزون
    try { decrementStock(storeId, cartItems); } catch {}

    // 📩 إشعار المالك (رسالة تفصيلية)
    try {
      const ownerPhone = String(storeData?.ownerPhone || "").replace(/\D/g, "");
      if (ownerPhone) {
        const ownerJid = ownerPhone + "@s.whatsapp.net";
        const lines = cartItems.map(i => {
          const exclTxt = (i.excluded && i.excluded.length) ? `\n   🚫 بدون: ${i.excluded.join("، ")}` : "";
          return `• ${i.name} × ${i.qty}` + (i.priceOnRequest ? "" : ` — ${(i.price * i.qty).toFixed(2)}`) + exclTxt;
        });
        const customerPhoneDigits = String(from).replace(/\D/g, "");
        const msg =
          `🆕 *طلب جديد (وضع صامت)*\n\n` +
          lines.join("\n") +
          (subtotal > 0 ? `\n\n💰 الإجمالي: *${subtotal.toFixed(2)} ${storeData?.currency || "ر.س"}*` : "") +
          (cleanNotes ? `\n\n📝 ملاحظات: ${cleanNotes}` : "") +
          `\n\n📱 العميل: +${customerPhoneDigits}` +
          `\n🆔 ${orderId}` +
          `\n\n💬 *كلّم العميل الآن* لأخذ العنوان والوقت.`;
        waMgr.sendMessage(storeId, ownerJid, msg, { allowCold: true, reason: "order_notification" })
          .catch(e => console.warn("[silent-mode/notify-owner]", e.message));
      }
    } catch {}

    // ✅ رسالة استلام للعميل (قابلة للتخصيص) — ثم يصمت البوت
    try {
      const itemsText = cartItems.map(i => `• ${i.name} × ${i.qty}`).join("\n");
      const notesText = cleanNotes ? `\n\n📝 *ملاحظات:* ${cleanNotes}` : "";
      const ackMsg = botMsg.msg(storeData, "order.received_silent", {
        items: itemsText,
        notes: notesText,
        storeName: storeData?.storeName || "",
        orderId,
      });
      await waMgr.sendMessage(storeId, from, ackMsg, { fastReply: true });
    } catch (e) { console.warn("[silent-mode/ack-customer]", e.message); }

    // 🔇 اجعل الـ session في DONE — البوت يتجاهل رسائل العميل حتى يقرر المالك من لوحة الأدمن
    sessionManager.set(from, {
      step: "DONE",
      orderId,
      cart: cartItems,
      path: "silent",
      orderNotes: cleanNotes,
    });

    console.log(`[silent-mode] order ${orderId} logged & bot silenced for ${from} @ ${storeId}`);
    return res.json({ ok: true, silentMode: true, orderId });
  }

  // ⭐ Booking mode: إن كان المتجر orderMode=booking والـ notes فيها "الموعد المطلوب" → أنشئ booking record
  // (للصالون/العيادة/الفعاليات وغيرها — حجوزات بدون unitId)
  const isBookingMode = storeData?.adminConfig?.orderMode === "booking";
  const bookingMatch = isBookingMode ? cleanNotes.match(/📅\s*الموعد المطلوب:\s*([\d-]+)\s+(\d{1,2}:\d{2})/) : null;
  if (bookingMatch && !cartItems[0]?.id?.includes("salla_")) {
    try {
      const bookings = require("./bookings");
      const dateStr = bookingMatch[1];
      const timeStr = bookingMatch[2];
      const startAt = new Date(`${dateStr}T${timeStr}:00`);
      if (!isNaN(startAt.getTime())) {
        const firstItem = cartItems[0];
        const customerPhone = String(from).replace(/\D/g, "").slice(0, 15);
        // إنشاء booking record (بدون unitId — للحجوزات العامة)
        const r = await bookings.createBooking(storeId, {
          customerName:  "عميل",
          customerPhone,
          serviceName:   firstItem.name,
          startAt:       startAt.toISOString(),
          notes:         cleanNotes.replace(/📅[^\n]*\n?/, "").slice(0, 300),
        });
        if (r.ok) {
          console.log(`[web-order/booking] created booking ${r.booking.id} for ${storeId} (${firstItem.name} @ ${dateStr} ${timeStr})`);
          // 📡 SSE: إشعار فوري للوحة الادمن
          try { global.sseSend?.(storeId, "new_booking", r.booking); } catch {}
          // 👤 سجّل العميل
          try {
            require("./customers").upsertCustomer({
              phone:   customerPhone,
              name:    "عميل",
              total:   0,
              storeId,
              kind:    "booking",
            });
          } catch {}

          // 📩 رسالة استلام الحجز للعميل (نفس template الـ rental — قابل للتخصيص)
          try {
            const dt = new Date(startAt);
            const dateHuman = dt.toLocaleDateString("ar-EG",{weekday:"long",month:"long",day:"numeric"});
            const timeHuman = dt.toLocaleTimeString("ar-EG",{hour:"2-digit",minute:"2-digit",hour12:true});
            const tpl = storeData.bookingAckTemplate || `✅ *تم استلام طلب حجزك*

أهلاً 👋

شكراً لاختيارك *{{storeName}}*
سيتم مراجعة حجزك وتأكيده من إدارتنا قريباً.

✂️ الخدمة: *{{serviceName}}*
📅 التاريخ: {{date}}
🕐 الوقت: {{time}}

📞 سنتواصل معك خلال دقائق
🌹 نتطلع لاستضافتك`;
            const ackMsg = tpl
              .replace(/\{\{customerName\}\}/g, "")
              .replace(/\{\{storeName\}\}/g, storeData.storeName || "متجرنا")
              .replace(/\{\{unitName\}\}/g, firstItem.name)
              .replace(/\{\{serviceName\}\}/g, firstItem.name)
              .replace(/\{\{date\}\}/g, dateHuman)
              .replace(/\{\{time\}\}/g, timeHuman)
              .replace(/\{\{checkIn\}\}/g, dateHuman + " " + timeHuman)
              .replace(/\{\{checkOut\}\}/g, "")
              .replace(/\{\{total\}\}/g, "")
              .replace(/\{\{nights\}\}/g, "")
              .replace(/\{\{bookingId\}\}/g, r.booking.id);
            waMgr.sendMessage(storeId, from, ackMsg, { allowCold: true, reason: "booking_intent_reply" })
              .catch(e => console.warn("[booking-ack-generic] failed:", e.message));
          } catch (e) { console.warn("[booking-ack-generic] error:", e.message); }

          // 📩 إشعار المالك بالحجز الجديد
          try {
            const ownerPhone = String(storeData.ownerPhone || "").replace(/\D/g,"");
            if (ownerPhone) {
              const ownerJid = ownerPhone + "@s.whatsapp.net";
              const dt = new Date(startAt);
              const dateHuman = dt.toLocaleDateString("ar-EG",{month:"short",day:"numeric"});
              const timeHuman = dt.toLocaleTimeString("ar-EG",{hour:"2-digit",minute:"2-digit",hour12:true});
              const customerPhoneDigits = String(from).replace(/\D/g,"");
              const ownerMsg = `📅 *حجز جديد عبر البوت*\n\n` +
                `✂️ الخدمة: *${firstItem.name}*\n` +
                `📅 ${dateHuman} · 🕐 ${timeHuman}\n` +
                `📱 العميل: +${customerPhoneDigits}\n` +
                `\n📋 افتح لوحة التاجر لتأكيد الحجز`;
              waMgr.sendMessage(storeId, ownerJid, ownerMsg, { allowCold: true, reason: "order_notification" })
                .catch(e => console.warn("[booking-notify-generic] failed:", e.message));
            }
          } catch {}
        }
      }
    } catch (e) {
      console.warn("[web-order/booking] create failed:", e.message);
    }
  }

  // 🤖 auto-filter: يخفي order_type/table/payment لو الإعدادات لا تطلبهم
  const allFields = require("./store-router")._getActiveStoreQuestions(storeData, storeData?.businessType || "delivery");
  const couponsActive = storeData?.enableCoupons !== false;
  let nextStep, firstPrompt;
  // 🎟️ لو الكوبونات مفعّلة، اعرضها أولاً قبل الأسئلة
  if (couponsActive) {
    nextStep = "COUPON";
    firstPrompt = `🎟️ *كود خصم؟*\nاكتب الكود إن كان لديك، أو اكتب *تخطي* للمتابعة.`;
  } else if (allFields.length) {
    nextStep = "DYNAMIC_Q";
    const f0 = allFields[0];
    // 🎯 تحكم 100%: نص المتجر بالضبط. للـ choice نضيف الخيارات فقط.
    if (f0.type === "choice" && Array.isArray(f0.options) && f0.options.length) {
      firstPrompt = `${f0.prompt}\n${f0.options.map((o,i)=>`${i+1}️⃣ ${o}`).join("\n")}`;
    } else {
      firstPrompt = f0.prompt;
    }
  } else {
    // legacy
    const btype  = getBusinessType(storeData);
    const labels = businessLabels(btype);
    nextStep = labels.needsLocation ? "COLLECT_LOCATION" : "SCHEDULE_ORDER";
    firstPrompt = labels.needsLocation
      ? `\n\n📍 *${labels.locationPrompt}*`
      : `\n\n📅 *حدد وقت الطلب*`;
  }
  sessionManager.set(from, {
    step: nextStep,
    cart: cartItems,
    path: "webview",
    orderNotes: cleanNotes,
    customerName: "عميل",
    customAnswers: {},
    couponWaiting: couponsActive,
    questionIdx: allFields.length && !couponsActive ? 0 : undefined,
  });

  console.log(`[web-order] sending reply → storeId=${storeId} from=${from} notes=${cleanNotes.length} nextStep=${nextStep} customQ=${allFields.length}`);
  try {
    // 🎯 ترتيب مقصود (طلب العميل):
    //   1️⃣ رسالة استلام الطلب (مع أصناف السلة) — أولاً
    //   2️⃣ ثم رسالة السؤال الأول (الموقع/التاريخ/إلخ) — منفصلة بعدها بلحظة
    const itemsText = cartItems.map(i => `• ${i.name} × ${i.qty}`).join("\n");
    const notesText = cleanNotes ? `\n\n📝 *ملاحظات:* ${cleanNotes}` : "";
    const ackHeader = botMsg.msg(storeData, "order.received_ack", {
      items: itemsText,
      notes: notesText,
    });
    await waMgr.sendMessage(storeId, from, ackHeader, { fastReply: true });
    // ⏱️ فاصل صغير + السؤال منفصل
    if (firstPrompt && String(firstPrompt).trim()) {
      await new Promise(r => setTimeout(r, 800));
      await waMgr.sendMessage(storeId, from, firstPrompt, { fastReply: true });
    }
    console.log(`[web-order] ✅ ack + prompt sent → ${from}`);
  } catch (e) {
    console.error(`[web-order] ❌ sendMessage failed → ${from}: ${e.message}`);
  }

  res.json({ ok: true });
}

// ─── Test send (master only) ──────────────────────────────────────────────────
app.post("/master/test-send", async (req, res) => {
  const tok = req.headers["x-master-token"];
  if (tok !== process.env.MASTER_PASSWORD) return res.status(403).json({ ok: false });
  const { storeId, to, text } = req.body || {};
  if (!storeId || !to || !text) return res.status(400).json({ ok: false, error: "storeId, to, text required" });
  try {
    await waMgr.sendMessage(storeId, to, text);
    res.json({ ok: true, sent: `${storeId} → ${to}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Boot & Start ─────────────────────────────────────────────────────────────
module.exports = { app, handleMessage };

if (require.main === module) {
  // 🛡️ تثبيت Error Monitor قبل أي شيء (يلتقط uncaught/unhandled مبكراً)
  try { require("./error-monitor").install(waMgr); } catch (e) { console.warn("error-monitor install:", e.message); }

  const stores = getAllStores();
  // Migrate existing stores to Firestore (skips already-migrated docs)
  firestoreAuth.migrateStores(stores).catch(e => console.warn("Migration error:", e.message));
  waMgr.bootAllSessions(stores).then(() => {
    app.listen(PORT, () => {
      console.log(`\n🤖 WhatsApp SaaS Platform`);
      console.log(`📡 HTTP API on port ${PORT}`);
      console.log(`✅ Baileys multi-session active — ${stores.length} stores`);
      console.log(`⏰ Timezone: ${process.env.TZ || "system default"}\n`);

      // Start background services
      sessionWatchdog.start();
      dailyReport.start();
      orderScheduler.start();
      require("./monthly-archive").startMonthlyCron();
      // 🛡️ Maintenance alerts (developer-only — writes to data/alerts/)
      const maint = require("./maintenance-alerts");
      maint.installGlobalHandlers();
      maint.startHealthMonitor();
      require("./daily-archive").startScheduler();
      require("./accounting").startMonthlyAccountingCron();
      require("./health-monitor").startPeriodicChecks();
      require("./subscription-enforcer").start();
      require("./bot-outage-monitor").start();    // 🚨 ينبه المالك عند انقطاع بوته
      require("./inactivity-watcher").start();
      require("./cart-abandonment").start();   // v3: استرداد السلات المتروكة
      require("./backup-rotator").start();      // v3: backup يومي + rotation 14d/12w
      require("./booking-reminder").start();    // Sprint B: تذكير الحجوزات قبل 24h
      // resume broadcasts التي توقفت لو السيرفر crashed
      setTimeout(() => {
        require("./broadcast-queue").resumeAll()
          .catch(e => console.warn("[broadcast-queue] resume failed:", e.message));
      }, 30_000); // انتظر 30s للـ Baileys sessions تستقر أولاً
    });
  });
}
