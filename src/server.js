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

const { sessionManager }                           = require("./session");
const { buildInvoice }                             = require("./invoice");
const { generateInvoiceImage, generateSummaryImage } = require("./invoice-image");
const { generateMenuImage } = require("./menu-image");
const { logOrder, readOrders, updateOrderStatus }  = require("./orders");
const { upsertCustomer }                           = require("./customers");
const { hasFeature }                               = require("./plans");
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
  windowMs: 15 * 60 * 1000, max: 10, // 10 attempts per 15 min
  standardHeaders: true, legacyHeaders: false,
  message: { error: "محاولات كثيرة، انتظر 15 دقيقة" },
});
app.use("/store/",        apiLimiter);
app.use("/api/",          apiLimiter);
app.use("/master/login",  loginLimiter);

app.use(express.json({ limit: "60mb" })); // raised for video uploads (videos enforce 50MB inside endpoint)
app.use(express.raw({ type: "video/*", limit: "60mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));
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

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  const masterToken = req.headers["x-master-token"] || req.query.masterToken;
  const isAdmin = masterToken && masterToken === process.env.MASTER_TOKEN;
  if (isAdmin) {
    return res.json({ ok: true, sessions: waMgr.listSessions(), time: new Date().toISOString() });
  }
  res.json({ ok: true });
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

// ─── Orders Feed ──────────────────────────────────────────────────────────────
app.get("/orders", (req, res) => {
  const token = req.query.token || req.headers["x-master-token"];
  const expected = process.env.MASTER_PASSWORD || process.env.MASTER_TOKEN;
  if (!token || token !== expected) {
    return res.status(403).json({ error: "forbidden" });
  }
  res.json({ orders: readOrders(parseInt(req.query.limit) || 50) });
});

// ─── Public Try Slot endpoints (for /try.html visitors, no auth) ────────────
const TRY_SLOTS = ["try_1", "try_2", "try_3", "try_4", "try_5"];
const tryInitTimes = new Map(); // ip → [timestamps]

app.post("/try/init", async (req, res) => {
  const ip  = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "unknown";
  const now = Date.now();
  const times = (tryInitTimes.get(ip) || []).filter(t => now - t < 3600_000);
  if (times.length >= 20) {
    return res.status(429).json({ error: "تجاوزت الحد المسموح، حاول لاحقاً" });
  }
  times.push(now);
  tryInitTimes.set(ip, times);

  for (const slotId of TRY_SLOTS) {
    const { status } = waMgr.getStatus(slotId);
    if (status === "open") continue; // مستخدم حالياً
    try {
      await waMgr.resetSession(slotId);
      return res.json({ ok: true, slotId });
    } catch (e) {
      console.warn(`/try/init [${slotId}] failed:`, e.message);
    }
  }
  return res.status(503).json({ error: "جميع فتحات التجربة مشغولة، حاول بعد دقيقة" });
});

app.get("/try/status/:slotId", (req, res) => {
  const { slotId } = req.params;
  if (!TRY_SLOTS.includes(slotId)) return res.status(400).json({ error: "invalid slot" });
  res.json(waMgr.getStatus(slotId));
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
    const store    = getAllStores()[0] || {};
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
      invoiceColor: store.invoiceColor || "#1b5e20",
      invoiceLogoUrl: store.invoiceLogoUrl || null,
      customerName: "أحمد محمد العميل",
      customerLocation: "حي النخيل — شارع الملك فهد",
      items, subtotal, deliveryFee: fee, total: subtotal+fee,
      currency: store.currency || CURRENCY,
      date: new Date().toISOString().slice(0,10),
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

// ─── Store helpers ────────────────────────────────────────────────────────────
function getAllStores() {
  try {
    const { stores } = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "stores.json"), "utf8"));
    return stores || [];
  } catch { return []; }
}

function getStoreById(storeId) {
  return getAllStores().find(s => s.id === storeId) || null;
}

// try_1..5 / owner_try = demo slots — resolve to first active store with products
function resolveStore(storeId) {
  if (/^try_\d+$/.test(storeId) || storeId === "owner_try") {
    const active = getAllStores().filter(s => s.active && s.subscriptionStatus === "active");
    return active.find(s => (s.products || []).length > 0) || active[0] || null;
  }
  return getStoreById(storeId);
}

// ─── Working Hours ────────────────────────────────────────────────────────────
function isStoreOpen(store) {
  const hStart = store?.workingHoursStart ?? hourStart;
  const hEnd   = store?.workingHoursEnd   ?? hourEnd;
  if (hStart === 0 && hEnd === 24) return true;
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  return hStart <= hEnd ? h >= hStart && h < hEnd : h >= hStart || h < hEnd;
}

function formatHour(h) {
  const period = h < 12 ? "صباحاً" : "مساءً";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12} ${period}`;
}

// ─── Business Type Helpers ────────────────────────────────────────────────────
function getBusinessType(store) {
  return store?.businessType || "delivery";
}

// Returns labels based on businessType
// needsLocation: whether to ask customer for address
// feeLabel: null = hide fee entirely
// timeLabel: Arabic word for "when do you want ____?"
function businessLabels(btype) {
  switch (btype) {
    case "pickup":      return { needsLocation: false, feeLabel: null,            timeLabel: "الاستلام",  locationPrompt: null };
    case "homeService": return { needsLocation: true,  feeLabel: "رسوم الخدمة",   timeLabel: "الخدمة",    locationPrompt: "أرسل موقعك للخدمة" };
    case "walkin":      return { needsLocation: false, feeLabel: null,            timeLabel: "الموعد",    locationPrompt: null };
    default:            return { needsLocation: true,  feeLabel: "رسوم التوصيل",  timeLabel: "التوصيل",   locationPrompt: "أرسل موقعك للتوصيل" };
  }
}

// ─── Pending Rating Requests ──────────────────────────────────────────────────
// phone → { storeId, orderId, storeName, timer }
const pendingRatings = new Map();

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

// ─── Input Validation: كشف الرسائل العشوائية والأسئلة الخارجية ────────────────

// كشف الكلام العشوائي/spam (gibberish)
function isGibberish(text) {
  const s = String(text || "").trim();
  if (s.length < 2) return false;
  // 1. تكرار حرف واحد ≥ 5 مرات متتالية (مثلاً "kkkkk")
  if (/(.)\1{4,}/.test(s)) return true;
  // 2. نسبة الحروف الفريدة قليلة جداً للنص الطويل (≥9 chars + ≤30% unique)
  if (s.length >= 9) {
    const unique = new Set(s.toLowerCase().replace(/\s/g, "")).size;
    if (unique / s.replace(/\s/g, "").length < 0.3) return true;
  }
  // 3. لا حروف عربية ولا لاتينية إطلاقاً
  const hasLetters = /[؀-ۿa-zA-Z]/.test(s);
  if (!hasLetters && s.length >= 4) return true;
  return false;
}

// كشف الأسئلة الشخصية أو الخارجة عن السياق
// ملاحظة: \b لا يعمل مع الحروف العربية، فنستخدم anchors نصية أو غياب word-boundary
function isOffTopicQuery(text) {
  const s = String(text || "").trim().toLowerCase();
  if (s.length < 3) return false;
  const patterns = [
    /(ما|ايش|إيش|شو|وش)\s*اسمك/i,
    /كم\s*عمرك/i,
    /من\s*انت/i,
    /(انت|أنت)\s*(بوت|روبوت|انسان|إنسان|آلة)/i,
    /تحكي\s*عربي/i,
    /(الطقس|الجو|weather)/i,
    /كيف\s*حالك/i,
    /كيف\s*الحال/i,
    /(صباح|مساء)\s*(الخير|الفل|النور)/i,
    /^(haha|hehe|lol|🤣|😂|hi|hello|مرحبا)$/i,
    /(تحب|بتحب)\s*(ال|أ|إ)/i,
  ];
  return patterns.some(p => p.test(s));
}

// التحقق من اسم سليم (للـ COLLECT_NAME)
// يقبل: حروف عربية/لاتينية + مسافة + بعض الرموز الشائعة
// يرفض: gibberish، أسئلة، أرقام فقط
function isValidName(text) {
  const s = String(text || "").trim();
  if (s.length < 2 || s.length > 80) return false;
  if (isGibberish(s) || isOffTopicQuery(s)) return false;
  // يجب أن يحوي حروف لاتينية أو عربية (لا يكفي رموز/أرقام)
  // ملاحظة: \W في JS regex بدون u-flag يعتبر العربية non-word، فلا نستخدمه
  if (!/[؀-ۿa-zA-Z]/.test(s)) return false;
  // يرفض إذا كان أرقام فقط (مع/بدون مسافات)
  if (/^[\d\s]+$/.test(s)) return false;
  return true;
}

// كشف نية "العودة للسلة لتعديل الطلب" — يقبل صياغات متعددة
function isEditIntent(text) {
  const s = String(text || "").trim().toLowerCase();
  if (!s || s.length > 50) return false;
  // أي رسالة قصيرة تحتوي على كلمة تشير إلى التعديل/العودة
  return /(تعديل|تعدل|عدل|تغيير|غير|رجوع|ارجع|إرجع|عودة|عود|back|edit|change|modify|cancel)/i.test(s);
}

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
// المنتج "متوفر" إذا: available !== false AND (stock === null OR stock > 0)
function isProductInStock(p) {
  if (!p || p.available === false) return false;
  return p.stock === null || p.stock === undefined || p.stock > 0;
}

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
  const { storeId } = storeCtx.getStore() || {};
  if (!storeId) return;
  try { await waMgr.sendMessage(storeId, to, body); } catch(e) {
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

  const nums = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
  const opts = rows.map((r, i) => `${nums[i] || (i+1)+"."} ${r.title}`).join("\n");

  if (demo) {
    demo.buffer.push({ type: "text", body: body + "\n\n" + opts + (footer ? "\n\n" + footer : "") });
    return;
  }
  if (!storeId) return;

  // text plain في AI/Numeric/Webview أو أثناء checkout
  const sess = sessionManager.get(to);
  const checkoutSteps = ["COLLECT_NAME","COLLECT_LOCATION","SCHEDULE_ORDER","COLLECT_TIME","CONFIRM_ORDER"];
  const textOnly = sess?.path === "ai"
                || sess?.path === "numeric"
                || sess?.path === "webview"
                || checkoutSteps.includes(sess?.step);

  if (!textOnly) {
    const sent = await waMgr.sendNativeList(storeId, to, {
      body,
      sections,
      footer:     footer || "",
      buttonText: buttonText || "📋 عرض الخيارات",
    });
    if (sent) return;
  }

  // text fallback (أو الافتراضي في AI/Numeric mode)
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
async function handleMessage(from, incoming) {
  const { store, storeId } = storeCtx.getStore() || {};
  const session   = sessionManager.get(from);

  // normalize Arabic/Persian digits → English قبل أي معالجة
  incoming = normalizeDigits(incoming);

  // ── Human Handoff: العميل يطلب مسؤول ──────────────────────
  const HANDOFF_TRIGGERS = /^(احتاج مسؤول|اريد مسؤول|مسؤول|اريد التحدث مع مسؤول|بشري|انسان|human)$/i;
  if (HANDOFF_TRIGGERS.test(String(incoming).trim())) {
    const fs = require("fs");
    const path = require("path");
    const handoffFile = path.join(__dirname, "..", "data", "handoffs.json");
    let handoffs = {};
    try { handoffs = JSON.parse(fs.readFileSync(handoffFile, "utf8")); } catch {}
    handoffs[from] = {
      storeId,
      phone:     from,
      startedAt: new Date().toISOString(),
      lastMsg:   String(incoming).slice(0, 200),
    };
    fs.writeFileSync(handoffFile, JSON.stringify(handoffs, null, 2));
    // أبلغ الستور owner عبر MASTER_PHONE
    try {
      const ownerJid = (store?.ownerPhone || "").replace(/[^\d]/g,"") + "@s.whatsapp.net";
      if (ownerJid && ownerJid !== "@s.whatsapp.net") {
        await waMgr.sendMessage(storeId, ownerJid,
          `🆘 *عميل يحتاج مساعدة*\n\nرقم: \`${phoneNum(from)}\`\nالمتجر: ${store?.storeName || "—"}\n\nالعميل ينتظرك. افتح واتساب وتحدث معه مباشرة.\nالبوت متوقف لهذا العميل حتى تستأنفه من لوحة الإدارة.`);
      }
    } catch {}
    return sendText(from,
      `🙋 *تم تنبيه المسؤول*\n\nسيتواصل معك مسؤول قريباً جداً.\n\n_البوت متوقف الآن لهذه المحادثة — اكتب لنا مباشرة._`);
  }

  // إذا العميل في handoff state، البوت يسكت تماماً
  try {
    const fs = require("fs");
    const path = require("path");
    const handoffFile = path.join(__dirname, "..", "data", "handoffs.json");
    if (fs.existsSync(handoffFile)) {
      const handoffs = JSON.parse(fs.readFileSync(handoffFile, "utf8"));
      if (handoffs[from] && handoffs[from].storeId === storeId) {
        console.log(`[handoff] silent for ${from} (paused for ${storeId})`);
        return;
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
  if (pendingRatings.has(from) && isRatingInput(incoming)) {
    return handleRatingSubmit(from, incoming);
  }

  // ── Order tracking command ───────────────────────────────────────────────────
  const trackMatch = /^(تتبع|track)\s*(ORD-\d+)?/i.exec(msg?.trim() || "");
  if (trackMatch) {
    const orderId = trackMatch[2];
    return handleOrderTracking(from, orderId);
  }

  // ── Loyalty points command ───────────────────────────────────────────────────
  if (/^(نقاطي|رصيد نقاطي|loyalty|points)$/i.test(msg?.trim() || "")) {
    return sendText(from, pointsMessage(storeId, from, store));
  }

  // Block outside working hours (except mid-flow)
  if (!isStoreOpen(store)) {
    const midFlow = ["COLLECT_NAME","COLLECT_LOCATION","CONFIRM_ORDER","QUANTITY","CART_ACTION","POST_ORDER","COUPON","RATING","ORDER_BROWSE"]
      .includes(session.step);
    if (!midFlow) {
      sessionManager.reset(from);
      const hStart = store?.workingHoursStart ?? hourStart;
      const hEnd   = store?.workingHoursEnd   ?? hourEnd;
      return sendText(from,
        `عزيزي العميل،\n\n` +
        `🕐 *${store?.storeName || STORE_NAME}* مغلق حالياً.\n\n` +
        `أوقات العمل:\n` +
        `من الساعة *${formatHour(hStart)}* حتى *${formatHour(hEnd)}*\n\n` +
        `يسعدنا خدمتك خلال أوقات العمل 😊`
      );
    }
  }

  // أوامر الـ reset الصريحة (تعمل دائماً)
  const isHardReset = msg === "MAIN_MENU" || /^(start|ابدأ|البدايه|البداية|الرئيسية)$/i.test(msg);
  // التحيات (تعمل reset فقط لو خارج mid-flow — لا نُربك العميل وسط إكمال طلبه)
  const isGreeting  = /^(مرحبا|مرحباً|السلام عليكم|وعليكم السلام|هلا|هلو|أهلا|اهلا|hi|hello|hey|رجوع)$/i.test(msg);
  const midFlow     = ["COLLECT_NAME","COLLECT_LOCATION","SCHEDULE_ORDER","COLLECT_TIME","CONFIRM_ORDER","QUANTITY","CART_ACTION","CART_EDIT","POST_ORDER","COUPON","ORDER_BROWSE","AI_BROWSE","NUMERIC_MENU","NUMERIC_FEEDBACK"]
    .includes(session.step);

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
    case "COLLECT_NAME":     return handleCollectName(from, msg, session);
    case "COLLECT_LOCATION": return handleCollectLocation(from, msg, session);
    case "SCHEDULE_ORDER":   return handleScheduleOrder(from, msg, session);
    case "COLLECT_TIME":     return handleCollectTime(from, msg, session);
    case "CONFIRM_ORDER":    return handleConfirmOrder(from, msg, session);
    case "POST_ORDER":       return handlePostOrder(from);
    case "AI_BROWSE":        return handleAIMode(from, incoming, session);
    case "NUMERIC_MENU":     return handleNumericMode(from, incoming, session);
    case "NUMERIC_FEEDBACK": return handleNumericFeedback(from, incoming, session);
    case "DONE":             return; // صمت — ينتظر التقييم أو تحية جديدة
    default:                 return sendWelcome(from);
  }
}

// ─── Step Handlers ────────────────────────────────────────────────────────────

// يبني أقسام رسالة الترحيب ديناميكياً حسب toggles كل متجر
// النصوص الافتراضية لأقسام رسالة الترحيب (قابلة للتخصيص من Master)
const _DEFAULT_SECTION_WEBVIEW =
`🥇 *الطريقة الأولى — الصفحة التفاعلية* ⭐

🔗 اضغط هذا الرابط:
{{order_link}}

ماذا يحدث؟
  ✓ تفتح داخل واتساب (لا تخرج من التطبيق)
  ✓ ترى المنتجات بالصور والأسعار
  ✓ تختار الكميات بأزرار + و −
  ✓ تضيف ملاحظات على الطلب
  ✓ بضغطة "تأكيد" يعود الشات تلقائياً`;

const _DEFAULT_SECTION_NUMERIC =
`🥈 *الطريقة الثانية — اختر بالأرقام*

📤 أرسل الرقم *1*

ستظهر لك قائمة:
  ‎[1] 📜 عرض المنيو
  ‎[2] ☕ طلب جديد بالأرقام
  ‎[3] 📍 موقع الفرع وأوقات العمل
  ‎[4] 📞 شكوى أو اقتراح`;

const _DEFAULT_SECTION_AI =
`🥉 *الطريقة الثالثة — اكتب بكلامك* 🤖

📤 أرسل الرقم *2* ثم اكتب طلبك بحرية

أمثلة يفهمها البوت:
  • _"عايز كباب وعصير برتقال"_
  • _"شيل العصير"_ — حذف
  • _"خلي الكباب 3"_ — تعديل
  • _"كم سعر الكنافة؟"_ — سؤال
  • _"تأكيد"_ — إتمام الطلب`;

function _buildWelcomeSections(store, orderLink, custom = {}) {
  const ew = store?.enableWebview !== false; // default true
  const en = store?.enableNumeric !== false;
  const ea = store?.enableAI      !== false;

  // استبدال المتغيرات في النصوص المخصصة
  const _interp = (s) => String(s || "").replace(/\{\{order_link\}\}/g, orderLink || "");

  // قسم الرابط (مختصر — للاستخدام في {{paths_block}})
  const webviewShort = (ew && orderLink)
    ? `📋 *قائمة الطلب التفاعلية:*\n${orderLink}\n\n_صفحة مصورة كاملة تظهر داخل واتساب_\n_اختر طلبك ثم اضغط تأكيد_`
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

  // سطر التذييل (الإرشادات) — مخصص أو يتكيف بذكاء حسب الميزات المفعّلة
  const customTips = custom.welcomeSectionTips || custom.tips;
  let tipsLine = "";
  if (customTips && String(customTips).trim()) {
    tipsLine = _interp(customTips);
  } else if (en && ea && ew && orderLink) {
    tipsLine = "✏️ للبدء: *1* للأرقام • *2* للكتابة • أو افتح الرابط أعلاه 👆";
  } else if (en && ea) {
    tipsLine = "✏️ للبدء: *1* للأرقام • *2* للكتابة";
  } else if (en && ew && orderLink) {
    tipsLine = "✏️ للبدء: *1* للأرقام • أو افتح الرابط أعلاه 👆";
  } else if (ea && ew && orderLink) {
    tipsLine = "✏️ للبدء: *2* للكتابة • أو افتح الرابط أعلاه 👆";
  } else if (en) {
    tipsLine = "✏️ للبدء: أرسل *1*";
  } else if (ea) {
    tipsLine = "✏️ للبدء: أرسل *2*";
  } else if (ew && orderLink) {
    tipsLine = "✏️ للبدء: افتح الرابط أعلاه 👆";
  }

  // الـ paths_block المختصر (للقوالب البسيطة)
  const blockParts = [];
  if (webviewShort) blockParts.push(webviewShort);
  const chatOpts = [];
  if (en) chatOpts.push("   *1*  ▸  قائمة بالأرقام  🔢");
  if (ea) chatOpts.push("   *2*  ▸  اكتب طلبك بحرية  💬");
  if (chatOpts.length) {
    const intro = (ew && orderLink) ? "*أو إن أحببت الطلب من الشات:*" : "*كيف تحب تطلب؟*";
    blockParts.push(intro + "\n\n" + chatOpts.join("\n"));
  }
  if (tipsLine && blockParts.length) blockParts.push(tipsLine);
  const pathsBlock = blockParts.join("\n\n━━━━━━━━━━━━━━━━━━\n\n");

  return {
    paths_block:     pathsBlock,
    webview_section: webviewDetailed,
    numeric_section: numericDetailed,
    ai_section:      aiDetailed,
    tips_line:       tipsLine,
  };
}

async function sendWelcome(from) {
  sessionManager.set(from, { step: "PATH_SELECT", cart: [], path: null });
  const { store, storeId } = storeCtx.getStore() || {};
  const name = store?.storeName || STORE_NAME;

  if (!isStoreOpen(store)) {
    const hStart = store?.workingHoursStart ?? hourStart;
    const hEnd   = store?.workingHoursEnd   ?? hourEnd;
    return sendText(from,
      `🌙 مرحباً بك في *${name}*\n\nنعتذر، نحن حالياً خارج أوقات العمل.\n\n⏰ أوقات العمل: من ${formatHour(hStart)} حتى ${formatHour(hEnd)}\n\nسنسعد بخدمتك في الوقت المناسب 🌸`
    );
  }

  const greeting = store?.welcomeMessage || `أهلاً وسهلاً في *${name}* 🌴`;
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

  return sendText(from, msg);
}

async function handleMainMenu(from, msg) {
  if (msg === "ORDER_WEB")  return sendTextOrderMenu(from);
  if (msg === "SEE_MENU")   return sendCategoryMenu(from);
  if (msg === "MY_CART")    return showCart(from, sessionManager.get(from));
  if (msg === "CONTACT_US") {
    const { store } = storeCtx.getStore() || {};
    const hStart = store?.workingHoursStart ?? hourStart;
    const hEnd   = store?.workingHoursEnd   ?? hourEnd;
    return sendText(from,
      `📞 *تواصل معنا*\n\n📱 واتساب: نفس هذا الرقم\n⏰ أوقات العمل: ${formatHour(hStart)} – ${formatHour(hEnd)}\n\nاكتب أي رسالة للعودة للقائمة 😊`
    );
  }
  return sendWelcome(from);
}

// ─── Path Selection (مع توجيه ذكي حسب toggles كل متجر) ──────────────────────
async function handlePathSelect(from, msg) {
  const raw = String(msg || "").trim().toLowerCase();
  const { store } = storeCtx.getStore() || {};
  const numericEnabled = store?.enableNumeric !== false;
  const aiEnabled      = store?.enableAI      !== false;

  // المسار 1: أرقام
  if (raw === "1" || /^(ارقام|أرقام|رقم|سريع|بسيط|numeric)/i.test(raw)) {
    if (!numericEnabled) {
      return sendText(from, "هذه الطريقة غير متاحة حالياً في هذا المتجر 🙏\n\nأرسل أي رسالة لرؤية الخيارات المتاحة.");
    }
    sessionManager.update(from, { step: "NUMERIC_MENU", path: "numeric" });
    return sendNumericMenu(from);
  }
  // المسار 2: AI
  if (raw === "2" || /^(كتاب|اكتب|كلام|ذكاء|ai|حر)/i.test(raw)) {
    if (!aiEnabled) {
      return sendText(from, "هذه الطريقة غير متاحة حالياً في هذا المتجر 🙏\n\nأرسل أي رسالة لرؤية الخيارات المتاحة.");
    }
    sessionManager.update(from, { step: "AI_BROWSE", path: "ai", cart: [] });
    const name = store?.storeName || STORE_NAME;
    return sendText(from,
      `ممتاز! 💬 اكتب طلبك بكلامك العادي.\n\n` +
      `أمثلة:\n` +
      `• "عايز كباب وعصير برتقال"\n` +
      `• "ضيف 3 شيش طاووق"\n` +
      `• "كم سعر الكنافة؟"\n` +
      `• "شيل العصير"\n` +
      `• "تأكيد الطلب"\n\n` +
      `_متجر ${name} — مدعوم بذكاء اصطناعي_`
    );
  }
  // نص حر → AI mode (لو متاح)
  if (aiEnabled && msg && /[؀-ۿ]/.test(msg) && msg.length > 3) {
    sessionManager.update(from, { step: "AI_BROWSE", path: "ai", cart: [] });
    return handleAIMode(from, msg, sessionManager.get(from));
  }
  // افتراضي: أعد رسالة الترحيب
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
    `_اكتب 0 للعودة لاختيار طريقة الطلب_`
  );
}

async function handleNumericMode(from, msg, session) {
  const raw = String(msg || "").trim();
  const { store, storeId } = storeCtx.getStore() || {};
  const name     = store?.storeName || STORE_NAME;
  const hStart   = store?.workingHoursStart ?? hourStart;
  const hEnd     = store?.workingHoursEnd   ?? hourEnd;
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
      await sendText(from, "تعذّر إرسال الـ PDF، نعرض القائمة نصياً 👇");
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
      return sendText(from, "عذراً، لا توجد منتجات متاحة حالياً. حاول لاحقاً.");
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
    items.slice(0, 12).forEach(p => { msg += `  • ${p.name} — ${p.price} ${currency}\n`; });
  }
  return sendText(from, msg);
}

async function handleNumericFeedback(from, msg, session) {
  const raw = String(msg || "").trim();
  if (raw === "0" || /^(الغاء|إلغاء|cancel)/i.test(raw)) {
    sessionManager.update(from, { step: "NUMERIC_MENU" });
    return sendNumericMenu(from);
  }
  if (raw.length < 5) {
    return sendText(from, "✏️ من فضلك اكتب رسالة لا تقل عن 5 أحرف، أو اكتب 0 لإلغاء.");
  }
  const { store, storeId } = storeCtx.getStore() || {};
  const ownerPhone = store?.ownerPhone || process.env.MASTER_PHONE;
  // أرسل للمالك
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

function _formatCart(cart, currency) {
  if (!cart.length) return "🛒 السلة فارغة";
  let total = 0;
  let lines = "🛒 *سلتك الحالية:*\n";
  cart.forEach((it, i) => {
    const subtotal = (it.price || 0) * it.qty;
    total += subtotal;
    lines += `${i + 1}. ${it.name} × ${it.qty} = ${subtotal} ${currency}\n`;
  });
  lines += `\n💰 *الإجمالي: ${total} ${currency}*`;
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

  const intent = await aiParser.parseIntent(text, { step: session.step, cart, path: "ai" }, menuCtx);

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
        items.slice(0, 8).forEach(p => { msg += `  • ${p.name} — ${p.price} ${currency}\n`; });
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
      else cart.push({ id: prod.id, name: prod.name, price: Number(prod.price) || 0, qty, imageUrl: prod.imageUrl || null });
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
        cart.push({ id: prod.id, name: prod.name, price: Number(prod.price) || 0, qty, imageUrl: prod.imageUrl || null });
      }
    }
    sessionManager.update(from, { cart });
    return sendText(from, `✅ حُدِّث.\n\n${_formatCart(cart, currency)}`);
  }

  // 6️⃣ تأكيد الطلب
  if (intent.type === "confirm") {
    if (!cart.length) return sendText(from, "🛒 السلة فارغة. اكتب طلبك أولاً.");
    sessionManager.update(from, { step: "COLLECT_NAME", path: "ai" });
    return sendText(from, _formatCart(cart, currency) + `\n\n✏️ *اكتب اسمك للمتابعة:*`);
  }

  // 7️⃣ إلغاء
  if (intent.type === "cancel") {
    sessionManager.reset(from);
    return sendText(from, "تم إلغاء الطلب. اكتب أي رسالة لبداية جديدة 🌸");
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
  sessionManager.update(from, { step: "CATEGORY" });
  const { store } = storeCtx.getStore() || {};
  const categories = (store?.categories || []).filter(cat =>
    (store.products || []).some(p => p.category === cat.id && isProductInStock(p))
  );

  if (categories.length === 0) {
    return sendText(from, "عذراً، لا توجد أصناف متاحة حالياً. اكتب 'ابدأ' للمحاولة لاحقاً.");
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
  });
}

async function handleCategorySelection(from, msg, session) {
  if (msg === "MENU_IMAGE" || msg === "MENU_PDF") return sendFullMenuMedia(from, msg);
  if (!msg.startsWith("CAT_")) return sendCategoryMenu(from);
  return showProductsPage(from, msg.replace("CAT_", ""), 0);
}

async function sendFullMenuMedia(from, type) {
  const { storeId, store } = storeCtx.getStore() || {};
  if (!store) return sendText(from, "عذراً، تعذّر تحميل القائمة. حاول لاحقاً.");

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
    await sendText(from, "عذراً، تعذّر إنشاء القائمة الآن. حاول لاحقاً أو اختر صنفاً مباشرة.");
  }
}

async function showProductsPage(from, cat, page) {
  const { store } = storeCtx.getStore() || {};
  const currency  = store?.currency || CURRENCY;
  const products  = (store?.products || []).filter(p => p.category === cat && isProductInStock(p));

  if (products.length === 0) {
    sessionManager.update(from, { step: "MAIN_MENU" });
    return sendText(from, "عذراً، لا توجد منتجات متاحة حالياً في هذا الصنف. اكتب 'رجوع' للقائمة.");
  }

  const pageSize   = 9;
  const totalPages = Math.ceil(products.length / pageSize);
  const pageItems  = products.slice(page * pageSize, (page + 1) * pageSize);
  const catInfo    = (store?.categories || []).find(c => c.id === cat) || { name: cat, emoji: "📋" };

  sessionManager.update(from, { step: "PRODUCT", currentCategory: cat, currentPage: page });

  const rows = pageItems.map(p => ({
    id:          `PROD_${p.id}`,
    title:       `${p.name} — ${p.price} ${currency}`,
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
  if (!msg.startsWith("PROD_")) return sendCategoryMenu(from);

  const { store } = storeCtx.getStore() || {};
  const currency  = store?.currency || CURRENCY;
  const productId = msg.replace("PROD_", "");
  const product   = (store?.products || []).find(p => String(p.id) === String(productId) && isProductInStock(p));
  if (!product) return sendCategoryMenu(from);

  sessionManager.update(from, { step: "QUANTITY", pendingProduct: product });

  // Send product image if available
  const imgUrl = product.imageUrl || product.image_url || null;
  if (imgUrl) {
    const full = imgUrl.startsWith("http") ? imgUrl : `${PUBLIC_URL.replace(/\/$/, "")}${imgUrl}`;
    await sendImage(from, full, `*${product.name}*\n${product.description || ""}\n💰 ${product.price} ${currency}`);
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
  else {
    const parsed = parseInt(msg);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 99) qty = parsed;
    else return sendText(from, "❌ الكمية غير صحيحة. أرسل رقماً بين 1 و 99.");
  }
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
  else cart.push({ id: product.id, name: product.name, price: product.price, qty, imageUrl: product.imageUrl||null });

  sessionManager.update(from, { step: "CART_ACTION", cart, pendingProduct: null });
  const total = cart.reduce((s, i) => s + i.price * i.qty, 0);

  return sendList(from, {
    body:       `✅ تمت الإضافة!\n\n*${product.name}* × ${qty}\n💰 إجمالي السلة: *${total.toFixed(2)} ${currency}*`,
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
  if (!session.cart || session.cart.length === 0) {
    return sendText(from, "🛒 سلتك فارغة. اكتب 'ابدأ' لعرض القائمة.");
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

  // لو الكوبونات معطّلة ولا توجد نقاط → نتخطى الخطوة ونذهب لجمع الاسم مباشرة
  if (!couponsEnabled && !pointsEnabled) {
    sessionManager.update(from, { step: "COLLECT_NAME" });
    const isFreeText = session.path === "ai" || session.path === "numeric" || session.path === "webview";
    const ask = `🛍️ *تأكيد الطلب*\n\n💰 الإجمالي: *${subtotal.toFixed(2)} ${currency}*\n\n📝 من فضلك *اكتب اسمك الكريم* لإتمام الطلب:`;
    if (isFreeText) return sendText(from, ask);
    return sendButtons(from, { body: ask, buttons: [{ id: "BACK_CART", title: "🔙 تعديل السلة" }] });
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

  // Skip coupon → proceed to collect name
  if (msg === "COUPON_SKIP") {
    sessionManager.update(from, { step: "COLLECT_NAME", couponWaiting: false });
    return sendButtons(from, {
      body:    "📝 *إتمام الطلب*\n\nمن فضلك *اكتب اسمك الكريم* لإكمال الطلب 😊",
      buttons: [{ id: "BACK_CART", title: "🔙 تعديل السلة" }],
    });
  }

  // Open text entry for coupon code
  if (msg === "COUPON_ENTER") {
    sessionManager.update(from, { couponWaiting: true });
    return sendButtons(from, {
      body:    "🎟️ أرسل *كود الخصم* الخاص بك:",
      buttons: [{ id: "BACK_CART", title: "🔙 تعديل السلة" }],
    });
  }

  // Redeem loyalty points
  if (msg === "POINTS_REDEEM") {
    const pts = getPoints(storeId, from);
    const _loySet2 = require("./loyalty").getSettings(store);
    const redeemable = Math.floor(pts.points / _loySet2.pointsForDiscount) * _loySet2.pointsForDiscount;
    if (redeemable < _loySet2.pointsForDiscount) {
      sessionManager.update(from, { step: "COLLECT_NAME" });
      return sendButtons(from, { body: "❌ نقاطك غير كافية للاستبدال.\n\n📝 *اكتب اسمك الكريم* لإكمال الطلب:", buttons: [{ id: "BACK_CART", title: "🔙 تعديل السلة" }] });
    }
    const result = redeemPoints(storeId, from, redeemable, store);
    if (!result) {
      sessionManager.update(from, { step: "COLLECT_NAME" });
      return sendButtons(from, { body: "❌ تعذّر استبدال النقاط.\n\n📝 *اكتب اسمك الكريم* لإكمال الطلب:", buttons: [{ id: "BACK_CART", title: "🔙 تعديل السلة" }] });
    }
    const newSubtotal = Math.max(0, subtotal - result.discount);
    sessionManager.update(from, {
      step: "COLLECT_NAME",
      couponWaiting: false,
      appliedDiscount: result.discount,
      discountLabel: `🏆 استبدال ${redeemable} نقطة`,
      discountedSubtotal: newSubtotal,
    });
    return sendButtons(from, {
      body:    `✅ تم استبدال *${redeemable}* نقطة!\n💰 خصم: *${result.discount.toFixed(2)} ${currency}*\n🏆 نقاطك المتبقية: *${result.remainingPoints}*\n\n📝 *اكتب اسمك الكريم* لإكمال الطلب 😊`,
      buttons: [{ id: "BACK_CART", title: "🔙 تعديل السلة" }],
    });
  }

  // User typed a coupon code — only process when explicitly waiting for one
  if (session.couponWaiting) {
    const result = validateCoupon(msg.trim(), storeId, subtotal, from);
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
      step: "COLLECT_NAME",
      couponWaiting: false,
      appliedCoupon: result.code,
      appliedDiscount: result.discount,
      discountLabel: result.message,
      discountedSubtotal: newSubtotal,
    });
    return sendButtons(from, {
      body:    `${result.message}\n💰 وفرت: *${result.discount.toFixed(2)} ${currency}*\n\n📝 *اكتب اسمك الكريم* لإكمال الطلب 😊`,
      buttons: [{ id: "BACK_CART", title: "🔙 تعديل السلة" }],
    });
  }

  // Fallback
  sessionManager.update(from, { step: "COLLECT_NAME", couponWaiting: false });
  return sendButtons(from, {
    body:    "📝 *إتمام الطلب*\n\nمن فضلك *اكتب اسمك الكريم* لإكمال الطلب 😊",
    buttons: [{ id: "BACK_CART", title: "🔙 تعديل السلة" }],
  });
}

async function handleCollectName(from, msg, session) {
  const name = msg.trim().slice(0, 80);
  const isFreeText = session.path === "ai" || session.path === "numeric";
  // رفض: gibberish، أسئلة شخصية، button IDs، أو أي شيء لا يبدو اسماً
  if (!isValidName(name) || /^[A-Z][A-Z0-9_]*$/.test(name)) {
    const hint = isOffTopicQuery(name)
      ? "🤖 *لاحظت أن هذا سؤال!*\n\nأنا بوت لاستقبال الطلبات فقط. من فضلك اكتب اسمك الكريم لإكمال طلبك 😊"
      : isGibberish(name)
        ? "🤔 *هذا لا يبدو اسماً صحيحاً!*\n\nمن فضلك *اكتب اسمك الكريم* لإكمال الطلب 😊"
        : "📝 *إتمام الطلب*\n\nمن فضلك *اكتب اسمك الكريم* لإكمال الطلب 😊";
    if (isFreeText) return sendText(from, hint);
    return sendButtons(from, {
      body:    hint,
      buttons: [{ id: "BACK_CART", title: "🔙 تعديل السلة" }],
    });
  }
  const { store } = storeCtx.getStore() || {};
  const btype  = getBusinessType(store);
  const labels = businessLabels(btype);

  sessionManager.update(from, { customerName: name, customerLocation: null });

  // pickup & walkin: skip location step entirely
  if (!labels.needsLocation) {
    sessionManager.update(from, { step: "SCHEDULE_ORDER" });
    return sendScheduleAsk(from, `شكراً ${name} 😊`);
  }

  sessionManager.update(from, { step: "COLLECT_LOCATION" });
  return sendText(from,
    `شكراً ${name} 😊\n\n📍 *${labels.locationPrompt}*\n\n` +
    `🗺️ *الطريقة الأسرع:* أرسل موقعك من واتساب\n` +
    `   اضغط 📎 (أو ➕) ← *الموقع* ← *موقعي الحالي*\n\n` +
    `أو اكتب اسم الحي / العنوان كنص 👇\n\n` +
    `_اكتب *"تعديل"* للعودة للسلة_`
  );
}

function isValidLocation(text) {
  if (!text || text.trim().length < 3) return false;
  if (/maps\.google\.com|goo\.gl\/maps|maps\.app\.goo\.gl|google\.com\/maps/.test(text)) return true;
  if (text.startsWith("📍")) return true;
  // الحد الأدنى = 3 حروف (لقبول أسماء قصيرة مثل "جدة" أو "الرياض")
  return text.trim().length >= 3;
}

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
      sessionManager.update(from, {
        step: "COLLECT_LOCATION",
        customerLocation: finalLoc,
        customerLocationLat: resolved.lat,
        customerLocationLng: resolved.lng,
        customerLocationName: resolved.name,
        awaitingLocationNote: true,
      });
      return sendButtons(from, {
        body: `📍 *موقعك مُسجَّل:*\n*${resolved.name}*\n\nتريد إضافة *ملاحظات* لمساعدة السائق؟\n(مثال: أمام محل البقالة، بجانب الجامع، علامة مميزة)`,
        buttons: [
          { id: "LOC_NOTE",      title: "📝 إضافة ملاحظة" },
          { id: "LOC_SKIP_NOTE", title: "✅ متابعة بدون" },
        ],
      });
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

  sessionManager.update(from, { step: "SCHEDULE_ORDER", customerLocation: location });
  return sendScheduleAsk(from);
}

// نص موحد لطلب الوقت — دائماً كتابة حرة بدون buttons
async function sendScheduleAsk(from, prefix = "") {
  const { store } = storeCtx.getStore() || {};
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

  // fee only applies when businessType requires it
  const fee        = labels.feeLabel
    ? (store?.deliveryFee != null ? Number(store.deliveryFee) : deliveryFee)
    : 0;

  const cart        = session.cart || [];
  const rawSubtotal = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const discount    = session.appliedDiscount || 0;
  const grandTotal  = Math.max(0, rawSubtotal - discount) + fee;

  const lines  = cart.map(i => `• ${i.name} × ${i.qty} ........... ${(i.price*i.qty).toFixed(2)} ${currency}`);
  const invoice =
    `🧾 *ملخص طلبك:*\n\n` +
    `الاسم: ${session.customerName}\n` +
    (session.customerLocation ? `العنوان: ${session.customerLocation}\n` : "") +
    (session.scheduledTime ? `⏰ ${labels.timeLabel}: *${session.scheduledTime}*\n` : "") +
    `\n${lines.join("\n")}\n` +
    `──────────────\n` +
    `المجموع: ${rawSubtotal.toFixed(2)} ${currency}\n` +
    (discount > 0 ? `🎟️ الخصم (${session.discountLabel || "كوبون"}): -${discount.toFixed(2)} ${currency}\n` : "") +
    (labels.feeLabel ? `${labels.feeLabel}: ${fee.toFixed(2)} ${currency}\n` : "") +
    `*الإجمالي الكلي: ${grandTotal.toFixed(2)} ${currency}*\n\n` +
    `طريقة الدفع: عند الاستلام 💵`;

  sessionManager.update(from, { pendingInvoice: invoice, grandTotal });

  try {
    const summaryImg = await generateSummaryImage({
      sessionId:      from.slice(-6),
      storeName:      store?.storeName || STORE_NAME,
      invoiceColor:   store?.invoiceColor || null,
      invoiceLogoUrl: store?.invoiceLogoUrl || null,
      items: cart, deliveryFee: fee, total: grandTotal, currency,
    });
    await sendImage(from, summaryImg.filePath || path.join(DATA_DIR,"invoices",summaryImg.fileName), "🛒 ملخص طلبك");
  } catch (err) {
    console.error("Summary image error:", err.message);
  }

  // AI/Numeric: نص حر بدل buttons
  if (session.path === "ai" || session.path === "numeric") {
    return sendText(from,
      invoice +
      `\n\n━━━━━━━━━━\n` +
      `اكتب *"تأكيد"* لإتمام الطلب ✅\n` +
      `أو *"تعديل"* لتعديل الطلب ✏️\n` +
      `أو *"إلغاء"* لإلغاء الطلب ❌`
    );
  }

  return sendButtons(from, {
    body:    invoice,
    buttons: [
      { id: "CONFIRM_YES", title: "✅ تأكيد الطلب" },
      { id: "BACK_CART",   title: "✏️ تعديل الطلب" },
      { id: "CONFIRM_NO",  title: "❌ إلغاء نهائي" },
    ],
  });
}

async function handleConfirmOrder(from, msg, session) {
  // قبول الكلمات النصية في AI/Numeric mode
  const trimmed = String(msg || "").trim();
  if (session.path === "ai" || session.path === "numeric") {
    if (/^(تأكيد|اكد|أكد|نعم|تمام|اوكي|اوك|confirm|yes|ok)$/i.test(trimmed)) {
      msg = "CONFIRM_YES";
    } else if (/^(تعديل|عدل|رجوع|edit|back)$/i.test(trimmed)) {
      msg = "BACK_CART";
    } else if (/^(إلغاء|الغاء|الغ|لا|cancel|no)$/i.test(trimmed)) {
      msg = "CONFIRM_NO";
    }
  }

  if (msg === "CONFIRM_YES") {
    const { store, storeId } = storeCtx.getStore() || {};
    const currency  = store?.currency || CURRENCY;
    const btype     = getBusinessType(store);
    const labels    = businessLabels(btype);
    const fee       = labels.feeLabel
      ? (store?.deliveryFee ?? deliveryFee)
      : 0;
    const rawSubtotal = (session.cart || []).reduce((s, i) => s + i.price * i.qty, 0);
    const discount  = session.appliedDiscount || 0;
    const subtotal  = Math.max(0, rawSubtotal - discount);
    const orderId   = `ORD-${Date.now().toString().slice(-7)}`;

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
      coupon:           session.appliedCoupon || null,
      discount,
      scheduledTime:    session.scheduledTime || null,
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

    await sendText(from,
      `✅ *تم استلام طلبك بنجاح!*\n\n` +
      `رقم الطلب: *${orderId}*\n` +
      `الإجمالي: *${session.grandTotal?.toFixed(2)} ${currency}*\n\n` +
      (previewPoints > 0 ? `🏆 ستكسب *${previewPoints}* نقطة عند قبول الطلب\n\n` : "") +
      `طلبك قيد المراجعة، سيتم التواصل معك قريباً.\n` +
      `شكراً لاختيارك *${storeName}* 💚`
    );

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

      const ownerMsg =
        `🔔 *طلب جديد — ${storeName}*\n\n` +
        `رقم الطلب: *${orderId}*\n` +
        `العميل: *${session.customerName}*\n` +
        `الهاتف: ${phoneNum(from)}\n` +
        locationBlock +
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
      try { await waMgr.sendMessage(storeId, ownerJid, ownerMsg); }
      catch (e) { console.warn("[owner-notify] failed:", e.message); }
    }

    // Generate + send invoice image
    if (hasFeature(store?.plan, "invoiceImage")) {
      try {
        const { filePath } = await generateInvoiceImage({
          orderId, storeName,
          invoiceColor:    store?.invoiceColor || "#1b5e20",
          invoiceLogoUrl:  store?.invoiceLogoUrl || null,
          invoiceTemplate: store?.invoiceTemplate || "classic",
          customerName:    session.customerName,
          customerLocation: session.customerLocation,
          items: session.cart, subtotal, deliveryFee: fee, total: session.grandTotal, currency,
          date: new Date().toISOString().slice(0, 10),
        });
        await sendImage(from, filePath, `🧾 فاتورتك — ${orderId}`);
      } catch (err) {
        console.error("Invoice image error:", err.message);
      }
    }

    // Cancel any previous rating timer before scheduling a new one
    const prevRating = pendingRatings.get(from);
    if (prevRating?.timer) clearTimeout(prevRating.timer);

    // Schedule rating request after 5 minutes; auto-expire entry 30 min after request is sent
    const ratingTimer = setTimeout(async () => {
      try { await waMgr.sendMessage(storeId, from, ratingRequestMessage(storeName, orderId)); }
      catch (e) { console.warn("[rating-request] failed:", e.message); }
      setTimeout(() => { pendingRatings.delete(from); }, 30 * 60 * 1000);
    }, 5 * 60 * 1000);
    pendingRatings.set(from, { storeId, orderId, storeName, timer: ratingTimer });

    // الصمت بعد الطلب — التقييم سيُرسَل بعد 5 دقائق تلقائياً
    return;
  }

  if (msg === "CONFIRM_NO") {
    sessionManager.set(from, { step: "POST_ORDER", cart: [] });
    return sendText(from, "تم إلغاء الطلب. نتمنى أن نخدمك مرة أخرى قريباً 😊");
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
  sessionManager.reset(from);
  return sendWelcome(from);
}

// ─── Rating Submit ────────────────────────────────────────────────────────────
async function handleRatingSubmit(from, ratingText) {
  const pending = pendingRatings.get(from);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRatings.delete(from);

  const rating = parseInt(ratingText);
  try {
    saveRating({ storeId: pending.storeId, phone: from, orderId: pending.orderId, rating });
  } catch (e) { console.warn("[save-rating] failed:", e.message); }

  const stars = ["","⭐","⭐⭐","⭐⭐⭐","⭐⭐⭐⭐","⭐⭐⭐⭐⭐"][rating] || "⭐⭐⭐";
  try {
    await waMgr.sendMessage(pending.storeId, from,
      `${stars} شكراً على تقييمك!\n\nنسعد دائماً بخدمتك في *${pending.storeName}* 💚`
    );
  } catch (e) {
    console.error(`[rating-reply] failed to send to ${from}:`, e.message);
  }
}

// ─── Order Tracking ───────────────────────────────────────────────────────────
async function handleOrderTracking(from, orderId) {
  if (!orderId) {
    return sendText(from,
      `📦 *تتبع طلبك*\n\nأرسل: *تتبع ORD-XXXXXXX*\n\nمثال: تتبع ORD-1234567`
    );
  }
  const orders = readOrders(200);
  const order  = orders.find(o => o.orderId === orderId && phoneNum(o.customerPhone) === phoneNum(from));
  if (!order) {
    return sendText(from,
      `❌ لم يُعثر على الطلب *${orderId}*\n\nتأكد من رقم الطلب أو تواصل مع المتجر مباشرة.`
    );
  }
  const statusMap = {
    pending_confirmation: "⏳ بانتظار التأكيد",
    confirmed:            "✅ تم التأكيد — جاري التحضير",
    preparing:            "🔄 قيد التنفيذ",
    out_for_delivery:     "🚴 في الطريق إليك",
    delivered:            "🎉 تم التوصيل",
    cancelled:            "❌ ملغي",
  };
  const statusLabel = statusMap[order.status] || order.status;
  const lines = (order.items || []).map(i => `• ${i.name} ×${i.qty}`).join("\n");
  return sendText(from,
    `📦 *تفاصيل الطلب*\n\n` +
    `رقم الطلب: *${orderId}*\n` +
    `الحالة: *${statusLabel}*\n` +
    `التاريخ: ${order.date || ""}\n\n` +
    `المنتجات:\n${lines}\n\n` +
    `💰 الإجمالي: *${order.total?.toFixed(2)} ${order.currency || "ر.س"}*`
  );
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function truncate(str, max) {
  if (!str) return "";
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

// Strip WhatsApp JID suffixes for display/storage — keeps full JID for sending
function phoneNum(jid) {
  return (jid || "").replace(/@s\.whatsapp\.net|@lid/g, "");
}

// ─── Baileys Message Router ───────────────────────────────────────────────────
waMgr.setMessageHandler(async (storeId, from, text, rawMsg) => {
  if (isDuplicate(rawMsg?.key?.id)) return;

  // Platform bot
  if (storeId === "platform") {
    await handlePlatformMessage(from, text,
      (to, msg) => waMgr.sendMessage("platform", to, msg),
      PLATFORM_OWNER_PHONE
    );
    return;
  }
  // Lead bot
  if (storeId === "lead") {
    await handleLeadMessage(from, text,
      (to, msg) => waMgr.sendMessage("lead", to, msg),
      LEAD_OWNER_PHONE
    );
    return;
  }
  // Try slots (try_1..try_5) + legacy owner_try — use first active store WITH products as demo
  if (storeId === "owner_try" || /^try_\d+$/.test(storeId)) {
    const stores  = getAllStores().filter(s => s.active && s.subscriptionStatus === "active");
    const demoStore = stores.find(s => (s.products || []).length > 0) || stores[0] || null;
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
            description: `${p.price} ${currency}${p.description ? " • " + p.description : ""}`,
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
          description: `${p.price} ${currency}${p.description ? " • " + p.description : ""}`,
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
      `\n\n💰 *المجموع: ${total.toFixed(2)} ${currency}*\n\n` +
      `📝 *اكتب اسمك الكريم* لإتمام الطلب:`;
    sessionManager.update(from, { step: "COLLECT_NAME", orderProdMap: undefined });
    return sendText(from, summary);
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
      newCart.push({ id: prod.id, name: prod.name, price: Number(prod.price) || 0, qty: 1, imageUrl: prod.imageUrl || null });
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
    .replace(/"/g, "&quot;");
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

// ─── Interactive Card Order Page (يستجيب لـ /:slug و /o/:token و /order/:token) ──
// الـ /:slug للأقصر — pattern 5-12 chars من base62 فقط
app.get(["/order/:token", "/o/:token", "/:token([a-zA-Z0-9]{4,12})"], (req, res) => {
  const sess = waMgr.getWebOrderSession(req.params.token);
  if (!sess) {
    return res.status(410).send(`<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta name="theme-color" content="var(--bg)"><title>انتهت الجلسة</title><style>*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}html,body{height:100%;display:flex;align-items:center;justify-content:center;background:var(--bg);font-family:'Segoe UI',Tahoma,Arial,sans-serif;overflow:hidden}.box{text-align:center;padding:40px 24px;max-width:340px}.ico{font-size:72px;margin-bottom:18px;filter:drop-shadow(0 0 12px rgba(212,175,55,.3))}.h{font-size:20px;font-weight:800;color:var(--accent);margin-bottom:10px;letter-spacing:.3px}.p{font-size:14px;color:#888;line-height:1.7}.back{display:inline-block;margin-top:22px;background:var(--accent);color:#000;padding:12px 28px;border-radius:24px;font-size:14px;font-weight:800;text-decoration:none;cursor:pointer}.back:active{opacity:.8}</style></head><body><div class="box"><div class="ico">⏰</div><div class="h">انتهت صلاحية الرابط</div><div class="p">الرابط صالح لـ 24 ساعة<br>عد للمحادثة وأرسل أي رسالة للبوت</div><a class="back" href="#" onclick="try{window.history.back();}catch(e){}try{window.close();}catch(e){}">💬 العودة للمحادثة</a></div></body></html>`);
  }

  const store    = resolveStore(sess.storeId);
  if (!store) return res.status(404).send("المتجر غير موجود");

  const botPhone   = sess.botPhone || "";
  const rawColor   = store.invoiceColor || "#1b5e20";
  const rawAccent  = store.themeAccent  || "var(--accent)";
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

    productData[String(p.id)] = {
      name:           p.name,
      description:    p.description || "",
      price:          Number(p.price) || 0,
      originalPrice:  originalPrice > p.price ? originalPrice : null,
      imageUrl:       _absUrl(p.imageUrl),
      video:          _videoEmbed(p.videoUrl),
      videoCaption:   p.videoCaption || "",
      categoryId:     String(p.category || ""),
      subCategoryId:  String(p.subCategoryId || ""),
      sizes:          Array.isArray(p.sizes) && p.sizes.length
        ? p.sizes.map(s => ({ label: String(s.label || ""), price: Number(s.price) || 0 })).filter(s => s.label && s.price > 0)
        : null,
      badges,
      popularity:     productOrderCount.get(p.id) || 0,
      stock:          stockNum,
    };
  });

  // نقبل logoUrl أو invoiceLogoUrl (يُحفظ من tab الإعدادات في store-admin)
  const rawLogo = store.logoUrl || store.invoiceLogoUrl || "";
  const logoUrl = rawLogo
    ? (rawLogo.startsWith("http") ? rawLogo : `${(process.env.PUBLIC_URL||"").replace(/\/$/,"")}${rawLogo}`)
    : "";

  const categoriesData = cats.length > 0
    ? cats.map(c => ({
        id:    String(c.id),
        name:  c.name,
        emoji: c.emoji || "◆",
        items: products.filter(p => p.category === c.id).map(p => String(p.id)),
        subCategories: Array.isArray(c.subCategories)
          ? c.subCategories
              .filter(s => s && s.id && s.active !== false)
              .map(s => ({ id: String(s.id), name: String(s.name||""), emoji: String(s.emoji||"") }))
          : [],
      }))
    : [{ id: "__all__", name: "المنتجات", emoji: "🛍️", items: products.map(p => String(p.id)), subCategories: [] }];

  // ─── Header extras: حالة المتجر + التقييم + وقت التوصيل ──────────────────────
  const hStart = store.workingHoursStart ?? 0;
  const hEnd   = store.workingHoursEnd   ?? 24;
  const nowH   = new Date().getHours();
  const isOpen = nowH >= hStart && nowH < hEnd;
  // التقييم: نقرأ من ratings الموجود (إن وُجد) — مجمع per store
  let storeRating = null;
  try {
    const ratingsMod = require("./ratings");
    if (typeof ratingsMod.getStoreSummary === "function") {
      storeRating = ratingsMod.getStoreSummary(storeId);
    }
  } catch {}
  // وقت التوصيل المتوقع: avg من completed orders آخر 30 يوم (لو فيه delivery time tracked)
  let avgDeliveryMin = null;
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

  const token    = JSON.stringify(req.params.token);
  const curr     = JSON.stringify(currency);
  const pdata    = JSON.stringify(productData);
  const cdata    = JSON.stringify(categoriesData);
  const logoJ    = JSON.stringify(logoUrl);
  const nameJ    = JSON.stringify(store.storeName || "متجرنا");
  const colorJ   = JSON.stringify(rawColor);
  const phoneJ   = JSON.stringify(botPhone);
  const extrasJ  = JSON.stringify(headerExtras);

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
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{min-height:100vh;background:var(--bg);font-family:'Segoe UI',Tahoma,Arial,sans-serif;color:var(--text);overflow-x:hidden}
body{display:flex;flex-direction:column;padding-bottom:96px;min-width:320px}

/* ـــ Sticky stack: يجمع كل الأشرطة العلوية في حاوية واحدة ـــ */
.sticky-stack{position:sticky;top:0;z-index:50;background:var(--bg);box-shadow:0 2px 12px rgba(0,0,0,.35)}

.hdr{
  background:linear-gradient(180deg,var(--bg-alt) 0%,var(--bg-alt) 100%);
  color:#fff;padding:14px 16px;
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  border-bottom:1px solid var(--card-bg-alt);
}
.hdr-main{display:flex;align-items:center;gap:13px;min-width:0;flex:1}
.hdr-logo{
  width:56px;height:56px;border-radius:50%;object-fit:cover;
  border:2.5px solid var(--accent);flex-shrink:0;
  background:var(--card-bg);
  box-shadow:0 0 20px rgba(212,175,55,.35), 0 2px 8px rgba(0,0,0,.35), inset 0 0 0 2px var(--bg-header);
  animation:logoIn .5s cubic-bezier(.34,1.56,.64,1);
}
@keyframes logoIn{
  from{transform:scale(.4) rotate(-10deg);opacity:0}
  to{transform:scale(1) rotate(0);opacity:1}
}
.hdr-icon{
  width:56px;height:56px;border-radius:50%;
  background:linear-gradient(135deg,var(--border),var(--card-bg-alt));
  display:flex;align-items:center;justify-content:center;font-size:26px;
  flex-shrink:0;border:2px solid var(--border-dim);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.04), 0 2px 8px rgba(0,0,0,.3);
}
.hdr-text{text-align:right;min-width:0;flex:1}
.hdr-name{font-size:17px;font-weight:800;line-height:1.2;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.2px}
.hdr-sub{font-size:11.5px;color:var(--accent);margin-top:4px;letter-spacing:.2px}
.hdr-back{
  background:var(--card-bg-alt);border:1px solid var(--border-dim);color:#999;
  width:40px;height:40px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;font-size:18px;
  cursor:pointer;flex-shrink:0;
  transition:all .2s cubic-bezier(.4,0,.2,1);
}
.hdr-back:active{background:var(--border);color:var(--accent);transform:scale(.92)}

/* Search bar */
.search-bar{
  background:var(--bg-alt);padding:11px 12px;border-bottom:1px solid var(--card-bg-alt);
}
.search-input{
  width:100%;padding:12px 18px 12px 44px;
  background:linear-gradient(180deg,#171717,var(--card-bg));
  border:1.5px solid var(--border-dim);border-radius:24px;color:#eee;
  font-size:14px;font-family:inherit;outline:none;direction:rtl;
  transition:all .2s cubic-bezier(.4,0,.2,1);
  box-shadow:inset 0 1px 2px rgba(0,0,0,.3);
}
.search-input:focus{
  border-color:var(--accent);
  box-shadow:0 0 0 3px rgba(212,175,55,.12), inset 0 1px 2px rgba(0,0,0,.3);
}
.search-input::placeholder{color:#555}
.search-wrap{position:relative}
.search-icon{
  position:absolute;right:16px;top:50%;transform:translateY(-50%);
  font-size:16px;color:#666;pointer-events:none;
}

.tabs{
  display:flex;gap:8px;padding:11px 12px;overflow-x:auto;
  background:var(--bg-alt);scrollbar-width:none;border-bottom:1px solid var(--card-bg-alt);
}
.tabs::-webkit-scrollbar{display:none}
.tab{
  flex-shrink:0;padding:9px 18px;border-radius:24px;
  border:1.5px solid var(--border-dim);
  background:linear-gradient(180deg,var(--card-bg-alt),var(--bg-alt));
  color:#999;font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap;
  transition:all .25s cubic-bezier(.4,0,.2,1);letter-spacing:-.1px;
}
.tab:active{transform:scale(.95)}
.tab.active{
  background:linear-gradient(135deg,var(--accent) 0%,var(--accent) 100%);
  border-color:var(--accent);color:#000;font-weight:800;
  box-shadow:0 3px 10px rgba(212,175,55,.3), inset 0 1px 0 rgba(255,255,255,.25);
}

/* ─── شريط التصنيفات الفرعية (chips صغيرة، scroll أفقي، snap) ─── */
.sub-chips{
  display:flex;gap:6px;padding:6px 12px 7px;overflow-x:auto;overflow-y:hidden;
  background:var(--bg);scrollbar-width:none;border-bottom:1px solid var(--card-bg-alt);
  scroll-snap-type:x proximity;-webkit-overflow-scrolling:touch;
}
.sub-chips::-webkit-scrollbar{display:none}
.chip{
  flex-shrink:0;padding:4px 10px;border-radius:14px;
  border:1px solid var(--border-dim);background:var(--card-bg);
  color:var(--text-mute);font-size:11.5px;font-weight:700;cursor:pointer;white-space:nowrap;
  transition:all .18s ease;scroll-snap-align:start;line-height:1.5;
}
.chip:active{transform:scale(.94)}
.chip.active{
  background:var(--accent);border-color:var(--accent);color:#000;font-weight:800;
  box-shadow:0 2px 6px rgba(212,175,55,.25);
}

.cat-section{display:none}
.cat-section.visible{display:block}
.card.hidden-by-filter{display:none}
.cat-label{
  font-size:13px;font-weight:800;color:var(--accent);letter-spacing:.5px;
  padding:18px 16px 6px;display:flex;align-items:center;gap:8px;
}

/* Grid: عمودان للهواتف المتوسطة (≥380px)، عمود واحد للأصغر */
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;padding:10px 10px 20px}
@media (max-width: 379px){.grid{grid-template-columns:1fr;gap:12px;padding:10px 12px 20px}}
@media (min-width: 600px){.grid{grid-template-columns:repeat(3,1fr);gap:14px;max-width:900px;margin:0 auto}}

/* تقليص ارتفاع الـ header على الشاشات الصغيرة جداً */
@media (max-width: 360px){
  .hdr{padding:10px 12px;gap:8px}
  .hdr-logo,.hdr-icon{width:44px;height:44px}
  .hdr-icon{font-size:20px}
  .hdr-name{font-size:15px}
  .hdr-sub{font-size:10.5px}
  .hdr-back{width:36px;height:36px;font-size:16px}
  .search-input{font-size:13.5px;padding:10px 16px 10px 40px}
  .tab{padding:7px 14px;font-size:13px}
  .c-img{aspect-ratio:1/1}
  .c-name{font-size:14px}
  .c-price{font-size:14.5px}
}

.card{
  background:linear-gradient(180deg,var(--card-bg) 0%,var(--bg-alt) 100%);
  border-radius:18px;overflow:hidden;
  border:1px solid var(--border);display:flex;flex-direction:column;
  box-shadow:0 2px 8px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.02);
  transition:border-color .25s,box-shadow .25s,transform .12s;
}
.card.has-qty{
  border-color:var(--accent);
  box-shadow:0 4px 16px rgba(212,175,55,.18), inset 0 1px 0 rgba(212,175,55,.08);
}
.c-img{width:100%;aspect-ratio:4/3;overflow:hidden;background:var(--card-bg-alt);flex-shrink:0;position:relative}
.c-img::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 65%,rgba(0,0,0,.35) 100%);pointer-events:none}
.c-img img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .4s ease}
.card:hover .c-img img{transform:scale(1.04)}
.no-img{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:42px;color:var(--border-dim)}
.c-vid-badge{position:absolute;bottom:8px;left:8px;background:rgba(0,0,0,.78);color:#fff;border:none;padding:6px 12px;border-radius:20px;font-size:12px;font-weight:800;cursor:pointer;z-index:3;display:flex;align-items:center;gap:4px;backdrop-filter:blur(6px);box-shadow:0 2px 10px rgba(0,0,0,.4);transition:.2s}
.c-vid-badge:hover{background:#dc2626;transform:scale(1.05)}
.video-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:9999;display:none;align-items:center;justify-content:center;padding:14px}
.video-modal-bg.show{display:flex}
.video-modal{position:relative;width:100%;max-width:780px;background:#000;border-radius:14px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.6)}
.video-modal-close{position:absolute;top:10px;right:10px;background:rgba(255,255,255,.18);border:none;color:#fff;width:38px;height:38px;border-radius:50%;font-size:18px;cursor:pointer;z-index:10;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px)}
.video-modal-close:hover{background:rgba(255,255,255,.32)}
.video-modal-body{position:relative;width:100%;aspect-ratio:16/9;background:#000}
.video-modal-body iframe,.video-modal-body video{width:100%;height:100%;border:none;display:block;background:#000}
.video-modal-caption{padding:12px 16px;color:#f5f5f5;font-size:13px;background:#0a0a0a;text-align:center}

/* ═══════════════ Phase 5 — Rich Header chips ═══════════════ */
.hdr-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.h-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:14px;font-size:11px;font-weight:700;line-height:1.4;letter-spacing:.1px}
.h-chip.open{background:rgba(16,185,129,.15);color:#10b981;border:1px solid rgba(16,185,129,.3)}
.h-chip.closed{background:rgba(220,38,38,.15);color:#ef4444;border:1px solid rgba(220,38,38,.3)}
.h-chip.rating{background:rgba(212,175,55,.15);color:var(--accent);border:1px solid rgba(212,175,55,.3)}
.h-chip.delivery{background:rgba(99,102,241,.15);color:#a5b4fc;border:1px solid rgba(99,102,241,.3)}
.h-chip.busy{background:rgba(245,158,11,.15);color:#fbbf24;border:1px solid rgba(245,158,11,.3)}

/* ═══════════════ Phase 5 — Product Card Badges ═══════════════ */
.c-badges{position:absolute;top:8px;right:8px;display:flex;flex-direction:column;gap:4px;z-index:3;max-width:65%}
.c-badge{display:inline-flex;align-items:center;gap:3px;padding:3px 8px;border-radius:10px;font-size:10.5px;font-weight:800;line-height:1.3;backdrop-filter:blur(8px);box-shadow:0 2px 6px rgba(0,0,0,.4);letter-spacing:.1px;white-space:nowrap}
.c-badge.discount{background:#dc2626;color:#fff}
.c-badge.top{background:#f97316;color:#fff}
.c-badge.low{background:#0a0a0a;color:#fbbf24;border:1px solid rgba(251,191,36,.4)}
.c-badge.new{background:#10b981;color:#fff}
.c-orig-price{font-size:12px;color:var(--text-dim);text-decoration:line-through;margin-right:6px;font-weight:600}

/* ═══════════════ Phase 5 — Skeleton Loading ═══════════════ */
.skeleton-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;padding:10px 10px 20px}
@media (max-width: 379px){.skeleton-grid{grid-template-columns:1fr;gap:12px;padding:10px 12px 20px}}
@media (min-width: 600px){.skeleton-grid{grid-template-columns:repeat(3,1fr);gap:14px;max-width:900px;margin:0 auto}}
.skel-card{background:var(--card-bg);border-radius:18px;overflow:hidden;border:1px solid var(--border)}
.skel-img{width:100%;aspect-ratio:4/3;background:linear-gradient(90deg,var(--card-bg-alt) 0%,var(--border) 50%,var(--card-bg-alt) 100%);background-size:200% 100%;animation:shimmer 1.4s linear infinite}
.skel-body{padding:13px 13px 14px}
.skel-line{height:12px;background:linear-gradient(90deg,var(--card-bg-alt) 0%,var(--border) 50%,var(--card-bg-alt) 100%);background-size:200% 100%;border-radius:6px;animation:shimmer 1.4s linear infinite;margin-bottom:8px}
.skel-line.w-70{width:70%}
.skel-line.w-40{width:40%}
.skel-line.w-90{width:90%;height:9px}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* ═══════════════ Phase 5 — Product Detail Modal (Bottom Sheet) ═══════════════ */
.pd-bg{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:999;display:none;align-items:flex-end;justify-content:center;backdrop-filter:blur(2px);animation:fadeIn .2s ease-out}
.pd-bg.show{display:flex}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.pd-sheet{
  width:100%;max-width:560px;max-height:92vh;
  background:var(--bg-alt);border-radius:24px 24px 0 0;
  display:flex;flex-direction:column;
  box-shadow:0 -8px 32px rgba(0,0,0,.6);
  animation:slideUp .32s cubic-bezier(.25,.46,.45,.94);
  position:relative;overflow:hidden;
}
@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
@media (min-width: 768px){
  .pd-bg{align-items:center}
  .pd-sheet{border-radius:20px;max-height:88vh;animation:popIn .25s cubic-bezier(.25,.46,.45,.94)}
  @keyframes popIn{from{transform:scale(.92);opacity:0}to{transform:scale(1);opacity:1}}
}
.pd-handle{width:44px;height:5px;border-radius:3px;background:#3a3a3a;margin:8px auto 4px;flex-shrink:0;cursor:grab}
.pd-handle:active{cursor:grabbing}
@media (min-width: 768px){.pd-handle{display:none}}
.pd-close{
  position:absolute;top:14px;left:14px;z-index:10;
  width:36px;height:36px;border-radius:50%;border:none;
  background:rgba(255,255,255,.1);color:var(--text);font-size:18px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);
  transition:background .2s
}
.pd-close:hover{background:rgba(255,255,255,.2)}
.pd-scroll{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
.pd-hero{position:relative;width:100%;aspect-ratio:4/3;background:var(--card-bg-alt);overflow:hidden}
.pd-hero img{width:100%;height:100%;object-fit:cover;display:block}
.pd-hero video,.pd-hero iframe{width:100%;height:100%;display:block;border:none;background:#000}
.pd-hero-noimg{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:64px;color:var(--border-dim)}
.pd-hero-vid-toggle{position:absolute;bottom:10px;left:10px;background:rgba(0,0,0,.78);color:#fff;border:none;padding:8px 14px;border-radius:20px;font-size:12.5px;font-weight:800;cursor:pointer;backdrop-filter:blur(8px);display:flex;align-items:center;gap:6px;z-index:2;transition:.2s}
.pd-hero-vid-toggle:hover{background:#dc2626}
.pd-badges-row{position:absolute;top:12px;right:12px;display:flex;flex-direction:column;gap:5px;z-index:2}
.pd-body{padding:18px 18px 20px;display:flex;flex-direction:column;gap:14px}
.pd-title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.pd-name{font-size:22px;font-weight:800;color:var(--text);line-height:1.25;letter-spacing:-.3px;flex:1}
.pd-price-block{display:flex;flex-direction:column;align-items:flex-end;flex-shrink:0}
.pd-price{font-size:24px;font-weight:900;color:var(--accent);line-height:1;letter-spacing:-.4px;white-space:nowrap}
.pd-orig{font-size:14px;color:var(--text-dim);text-decoration:line-through;margin-top:3px}
.pd-desc{font-size:14.5px;line-height:1.7;color:var(--text-mute);white-space:pre-line;word-wrap:break-word}
.pd-section-label{font-size:12px;font-weight:800;color:var(--accent);letter-spacing:.6px;text-transform:uppercase;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.pd-sizes{display:flex;flex-wrap:wrap;gap:8px}
.pd-size-btn{padding:10px 16px;border-radius:24px;border:1.5px solid var(--border-dim);background:var(--card-bg);color:var(--text-mute);font-size:14px;font-weight:700;cursor:pointer;transition:.2s;font-family:inherit;min-height:44px;display:flex;align-items:center;gap:6px}
.pd-size-btn.active{background:var(--accent);border-color:var(--accent);color:#000;font-weight:800;box-shadow:0 3px 10px rgba(212,175,55,.3)}
.pd-size-price{font-size:12px;font-weight:600;opacity:.85}
.pd-notes{
  width:100%;padding:12px 14px;border:1.5px solid var(--border-dim);border-radius:14px;
  background:var(--card-bg);color:var(--text);font-family:inherit;font-size:14px;
  direction:rtl;resize:none;min-height:60px;max-height:120px;outline:none;transition:border-color .2s;
  box-sizing:border-box;
}
.pd-notes:focus{border-color:var(--accent)}
.pd-notes::placeholder{color:var(--text-dim)}
.pd-footer{
  padding:14px 18px 18px;background:var(--bg-alt);border-top:1px solid var(--card-bg-alt);
  display:flex;align-items:center;gap:12px;
  padding-bottom:max(18px, env(safe-area-inset-bottom));
  flex-shrink:0;
}
.pd-qty{display:flex;align-items:center;gap:4px;background:var(--card-bg-alt);border-radius:28px;padding:4px;border:1px solid var(--border)}
.pd-qty-btn{
  width:40px;height:40px;border-radius:50%;border:none;background:transparent;
  color:var(--text-mute);font-size:20px;font-weight:800;cursor:pointer;
  display:flex;align-items:center;justify-content:center;transition:all .15s;
  -webkit-user-select:none;user-select:none;
}
.pd-qty-btn.plus{background:var(--accent);color:#000;box-shadow:0 2px 8px rgba(212,175,55,.35)}
.pd-qty-btn.minus:not(.zero):active{background:var(--border-dim);transform:scale(.92)}
.pd-qty-btn.zero{opacity:.4;pointer-events:none}
.pd-qty-num{font-size:18px;font-weight:800;min-width:32px;text-align:center;color:var(--text)}
.pd-cta{
  flex:1;padding:14px 20px;border:none;border-radius:28px;
  background:var(--accent);color:#000;font-size:15.5px;font-weight:800;
  cursor:pointer;font-family:inherit;letter-spacing:-.1px;
  box-shadow:0 4px 14px rgba(212,175,55,.4);
  transition:transform .12s, box-shadow .2s;
  display:flex;align-items:center;justify-content:center;gap:8px;
  min-height:50px;
}
.pd-cta:active{transform:scale(.97)}
.pd-cta.added{background:#10b981;color:#fff;box-shadow:0 4px 14px rgba(16,185,129,.35)}
.pd-out-of-stock{padding:14px;text-align:center;color:#ef4444;font-weight:800;font-size:14px;background:rgba(220,38,38,.1);border-radius:14px}

/* ═══════════════ Phase 5B — Hero / Featured Banner ═══════════════ */
.hero-banner{margin:10px 12px 0;background:linear-gradient(135deg,rgba(212,175,55,.15) 0%,rgba(212,175,55,.05) 100%);border:1px solid rgba(212,175,55,.3);border-radius:18px;padding:14px 16px;display:flex;align-items:center;gap:14px;cursor:pointer;transition:transform .15s,box-shadow .2s;position:relative;overflow:hidden}
.hero-banner:active{transform:scale(.99)}
.hero-banner::before{content:"";position:absolute;top:-30%;right:-10%;width:200px;height:200px;background:radial-gradient(circle,rgba(212,175,55,.25) 0%,transparent 70%);pointer-events:none}
.hero-img{width:74px;height:74px;border-radius:14px;object-fit:cover;flex-shrink:0;border:2px solid var(--accent);box-shadow:0 4px 12px rgba(212,175,55,.25)}
.hero-noimg{width:74px;height:74px;border-radius:14px;background:var(--card-bg-alt);display:flex;align-items:center;justify-content:center;font-size:32px;flex-shrink:0;border:2px solid var(--accent)}
.hero-info{flex:1;min-width:0;z-index:1}
.hero-tag{display:inline-block;background:#dc2626;color:#fff;font-size:10px;font-weight:800;padding:2px 8px;border-radius:8px;margin-bottom:4px;letter-spacing:.3px}
.hero-name{font-size:15.5px;font-weight:800;color:var(--text);margin-bottom:2px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hero-meta{font-size:12px;color:var(--text-mute);display:flex;align-items:center;gap:8px}
.hero-cta{flex-shrink:0;background:var(--accent);color:#000;border:none;padding:8px 14px;border-radius:20px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;z-index:1;white-space:nowrap}

/* ═══════════════ Phase 5C — Last Order quick re-order ═══════════════ */
.last-order-banner{margin:8px 12px 0;background:linear-gradient(135deg,rgba(99,102,241,.15) 0%,rgba(99,102,241,.05) 100%);border:1px solid rgba(99,102,241,.3);border-radius:14px;padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer;transition:transform .15s}
.last-order-banner:active{transform:scale(.99)}
.lo-icon{width:36px;height:36px;border-radius:10px;background:rgba(99,102,241,.2);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
.lo-info{flex:1;min-width:0}
.lo-title{font-size:13px;font-weight:800;color:#a5b4fc;margin-bottom:1px}
.lo-sub{font-size:11.5px;color:var(--text-mute)}
.lo-btn{flex-shrink:0;background:#6366f1;color:#fff;border:none;padding:7px 12px;border-radius:18px;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;white-space:nowrap}

/* ═══════════════ Phase 5B — Cart Drawer (slide-up preview) ═══════════════ */
.cart-drawer{position:fixed;left:0;right:0;bottom:0;background:var(--bg-alt);border-radius:24px 24px 0 0;z-index:200;transform:translateY(110%);transition:transform .35s cubic-bezier(.25,.46,.45,.94);max-height:78vh;display:flex;flex-direction:column;box-shadow:0 -12px 40px rgba(0,0,0,.6);padding-bottom:max(0px, env(safe-area-inset-bottom))}
.cart-drawer.show{transform:translateY(0)}
.cd-bg{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:199;opacity:0;pointer-events:none;transition:opacity .3s;backdrop-filter:blur(2px)}
.cd-bg.show{opacity:1;pointer-events:auto}
.cd-handle{width:44px;height:5px;border-radius:3px;background:#3a3a3a;margin:8px auto;flex-shrink:0;cursor:grab}
.cd-header{padding:6px 18px 14px;border-bottom:1px solid var(--card-bg-alt);display:flex;align-items:center;justify-content:space-between}
.cd-title{font-size:17px;font-weight:800;color:var(--text)}
.cd-close{width:36px;height:36px;border-radius:50%;border:none;background:var(--card-bg-alt);color:var(--text-mute);font-size:16px;cursor:pointer}
.cd-items{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:10px 14px}
.cd-item{display:flex;align-items:center;gap:10px;padding:10px;background:var(--card-bg);border-radius:14px;margin-bottom:8px;border:1px solid var(--border)}
.cd-item-img{width:50px;height:50px;border-radius:10px;object-fit:cover;background:var(--card-bg-alt);flex-shrink:0}
.cd-item-noimg{width:50px;height:50px;border-radius:10px;background:var(--card-bg-alt);display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0}
.cd-item-info{flex:1;min-width:0}
.cd-item-name{font-size:13.5px;font-weight:800;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cd-item-meta{font-size:11.5px;color:var(--text-mute);margin-top:2px}
.cd-item-price{font-size:13.5px;font-weight:800;color:var(--accent);white-space:nowrap}
.cd-item-qty{display:flex;align-items:center;gap:2px;background:var(--card-bg-alt);border-radius:18px;padding:2px;border:1px solid var(--border-dim)}
.cd-qbtn{width:26px;height:26px;border:none;background:transparent;color:var(--text-mute);font-size:14px;font-weight:800;cursor:pointer;border-radius:50%;line-height:1}
.cd-qbtn.plus{background:var(--accent);color:#000}
.cd-qnum{font-size:12px;font-weight:800;min-width:18px;text-align:center;color:var(--text)}
.cd-empty{padding:50px 20px;text-align:center;color:var(--text-dim);font-size:13.5px}
.cd-footer{padding:14px 18px 16px;border-top:1px solid var(--card-bg-alt);display:flex;flex-direction:column;gap:10px}
.cd-total-row{display:flex;align-items:center;justify-content:space-between}
.cd-total-label{font-size:13.5px;color:var(--text-mute);font-weight:600}
.cd-total-val{font-size:19px;color:var(--accent);font-weight:900}
.cd-confirm{padding:14px;border:none;border-radius:24px;background:var(--accent);color:#000;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit;box-shadow:0 4px 14px rgba(212,175,55,.4)}
.cd-confirm:active{transform:scale(.98)}

/* Cart bar أصبح "preview button" — التفاصيل في الـ drawer */
#cartbar.cb-click{cursor:pointer}
.c-body{padding:13px 13px 14px;display:flex;flex-direction:column;gap:4px;flex:1}
.c-name{font-size:15px;font-weight:800;color:#f5f5f5;line-height:1.3;letter-spacing:-.1px}
.c-desc{font-size:12px;color:#6a6a6a;line-height:1.5;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.c-foot{margin-top:auto;padding-top:12px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.cb-single{
  background:var(--accent);color:#000;border:none;padding:9px 18px;
  border-radius:24px;font-size:13.5px;font-weight:800;cursor:pointer;
  font-family:inherit;transition:.18s;box-shadow:0 3px 10px rgba(212,175,55,.32);
  white-space:nowrap
}
.cb-single:active{transform:scale(.96)}
.cb-single.taken{background:#10b981;color:#fff;box-shadow:0 3px 10px rgba(16,185,129,.35)}
.c-price{font-size:16px;font-weight:800;color:var(--accent);white-space:nowrap;letter-spacing:-.2px}

/* أزرار +/− احترافية */
.c-ctrl{
  display:flex;align-items:center;gap:2px;
  background:var(--card-bg-alt);border-radius:24px;padding:3px;
  border:1px solid #232323;
  box-shadow:inset 0 1px 2px rgba(0,0,0,.4);
}
.cb{
  width:32px;height:32px;border-radius:50%;
  border:none;background:transparent;color:#888;
  font-size:18px;font-weight:600;line-height:1;
  display:flex;align-items:center;justify-content:center;cursor:pointer;
  transition:all .18s cubic-bezier(.4,0,.2,1);
  -webkit-user-select:none;user-select:none;position:relative;
}
.cb.plus{
  background:linear-gradient(135deg,var(--accent) 0%,var(--accent) 100%);
  color:#000;font-weight:800;
  box-shadow:0 2px 6px rgba(212,175,55,.35), inset 0 1px 0 rgba(255,255,255,.25);
}
.cb.plus:active{
  transform:scale(.88);
  box-shadow:0 1px 3px rgba(212,175,55,.5), inset 0 2px 4px rgba(0,0,0,.25);
}
.cb.minus{
  background:#1d1d1d;color:#666;
  border:1px solid var(--border-dim);
}
.cb.minus:not(.zero):active{
  background:var(--border-dim);color:var(--accent);transform:scale(.88);
}
.cb.minus.zero{opacity:.4;pointer-events:none;border-color:#222;color:#3a3a3a}
.cq{
  font-size:15px;font-weight:800;min-width:24px;text-align:center;
  color:#fff;transition:color .15s,transform .2s;
}
.cq.nz{
  color:var(--accent);
  transform:scale(1.05);
}

.empty{padding:60px 20px;text-align:center;color:#555;font-size:14px}

#cartbar{
  position:fixed;bottom:0;left:0;right:0;
  background:linear-gradient(180deg,var(--bg-alt) 0%,var(--bg-alt) 100%);
  color:#fff;padding:14px 16px;
  display:flex;align-items:center;gap:12px;
  box-shadow:0 -8px 32px rgba(0,0,0,.85), 0 -1px 0 rgba(212,175,55,.15);
  z-index:100;border-top:1px solid var(--border);
  transform:translateY(110%);transition:transform .35s cubic-bezier(.25,.46,.45,.94);
  padding-bottom:max(14px, env(safe-area-inset-bottom));
}
#cartbar.on{transform:translateY(0)}
.cm{flex:1;min-width:0;display:flex;align-items:center;gap:10px}
.cart-icon{
  width:38px;height:38px;border-radius:50%;
  background:linear-gradient(135deg,var(--border),var(--card-bg-alt));
  border:1px solid var(--border-dim);
  display:flex;align-items:center;justify-content:center;font-size:18px;
  flex-shrink:0;position:relative;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.04);
}
.cart-badge{
  position:absolute;top:-3px;right:-3px;
  background:var(--accent);color:#000;
  min-width:18px;height:18px;border-radius:9px;padding:0 5px;
  font-size:11px;font-weight:800;
  display:flex;align-items:center;justify-content:center;
  border:2px solid var(--bg-alt);
}
.cm-text{flex:1;min-width:0}
#cc{font-size:14px;font-weight:800;color:#fff;letter-spacing:-.1px}
#ct{font-size:13px;color:var(--accent);margin-top:3px;font-weight:700}
#ok{
  background:linear-gradient(135deg,var(--accent) 0%,var(--accent) 100%);
  color:#000;border:none;
  padding:13px 24px;border-radius:24px;
  font-size:14.5px;font-weight:800;cursor:pointer;white-space:nowrap;flex-shrink:0;
  transition:all .2s cubic-bezier(.4,0,.2,1);letter-spacing:-.1px;
  box-shadow:0 4px 14px rgba(212,175,55,.35), inset 0 1px 0 rgba(255,255,255,.25);
}
#ok:active{transform:scale(.94);box-shadow:0 2px 8px rgba(212,175,55,.4), inset 0 2px 4px rgba(0,0,0,.2)}

#done{
  position:fixed;inset:0;background:#060606;
  display:none;flex-direction:column;align-items:center;justify-content:center;
  text-align:center;padding:40px;gap:16px;z-index:200;animation:fi .3s ease;
}
@keyframes fi{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}
#done .dico{font-size:80px}
#done h2{font-size:24px;font-weight:800;color:var(--accent)}
#done p{font-size:14px;color:#888;line-height:1.8}

/* أحجام (إذا كان المنتج له sizes) */
.c-sizes{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.sz-btn{
  padding:6px 11px;border-radius:16px;font-size:11.5px;font-weight:700;
  background:linear-gradient(180deg,var(--card-bg-alt),var(--card-bg-alt));
  border:1px solid var(--border-dim);color:#999;cursor:pointer;letter-spacing:-.1px;
  transition:all .2s cubic-bezier(.4,0,.2,1);
}
.sz-btn:active{transform:scale(.92)}
.sz-btn.active{
  background:linear-gradient(135deg,var(--accent) 0%,var(--accent) 100%);
  border-color:var(--accent);color:#000;font-weight:800;
  box-shadow:0 2px 6px rgba(212,175,55,.3), inset 0 1px 0 rgba(255,255,255,.25);
}

/* Summary modal — يظهر قبل الإرسال */
#summaryModal{
  position:fixed;inset:0;background:rgba(0,0,0,.85);
  display:none;align-items:flex-end;justify-content:center;
  z-index:150;animation:fade .25s ease;backdrop-filter:blur(6px);
}
@keyframes fade{from{opacity:0}to{opacity:1}}
.sm-sheet{
  background:var(--bg-header);border-radius:22px 22px 0 0;
  width:100%;max-width:560px;max-height:88vh;display:flex;flex-direction:column;
  border-top:1px solid var(--border-dim);animation:slideUp .3s cubic-bezier(.25,.46,.45,.94);
}
@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
.sm-handle{display:flex;justify-content:center;padding:8px 0 0}
.sm-handle-bar{width:40px;height:4px;background:var(--accent);border-radius:2px;opacity:.6}
.sm-hdr{
  padding:16px 20px;border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;
}
.sm-title{font-size:17px;font-weight:800;color:var(--accent)}
.sm-close{
  width:32px;height:32px;border-radius:50%;background:var(--card-bg-alt);
  border:none;color:#888;font-size:18px;cursor:pointer;
}
.sm-body{flex:1;overflow-y:auto;padding:16px 20px}
.sm-item{
  display:flex;justify-content:space-between;align-items:center;
  padding:10px 0;border-bottom:1px dashed var(--card-bg-alt);
}
.sm-item:last-child{border-bottom:none}
.sm-item-name{font-size:14px;color:#eee;font-weight:600}
.sm-item-sub{font-size:11px;color:#666;margin-top:2px}
.sm-item-price{font-size:14px;color:var(--accent);font-weight:700;white-space:nowrap}
.sm-total{
  display:flex;justify-content:space-between;align-items:center;
  padding:14px 20px;background:var(--card-bg);border-top:1px solid var(--border);
}
.sm-total-label{font-size:14px;color:#888;font-weight:700}
.sm-total-value{font-size:20px;color:var(--accent);font-weight:800}
.sm-notes-wrap{padding:14px 20px;border-top:1px solid var(--border);background:var(--bg-alt)}
.sm-notes-label{font-size:12px;font-weight:700;color:#888;margin-bottom:8px;letter-spacing:.5px}
.sm-notes{
  width:100%;min-height:64px;padding:10px 12px;
  background:var(--card-bg-alt);border:1.5px solid var(--border-dim);border-radius:10px;
  color:#eee;font-size:13px;font-family:inherit;resize:vertical;outline:none;
  direction:rtl;
}
.sm-notes:focus{border-color:var(--accent)}
.sm-actions{
  display:flex;gap:10px;padding:14px 20px;
  background:linear-gradient(180deg,var(--bg-alt),#070707);
  border-top:1px solid var(--border);
  padding-bottom:max(14px, env(safe-area-inset-bottom));
}
.sm-btn{
  flex:1;padding:14px;border-radius:16px;font-size:15px;font-weight:800;
  cursor:pointer;border:none;
  transition:all .2s cubic-bezier(.4,0,.2,1);letter-spacing:-.1px;
}
.sm-btn:active{transform:scale(.96)}
.sm-btn.primary{
  background:linear-gradient(135deg,var(--accent) 0%,var(--accent) 100%);
  color:#000;flex:1.5;
  box-shadow:0 4px 14px rgba(212,175,55,.3), inset 0 1px 0 rgba(255,255,255,.25);
}
.sm-btn.primary:active{
  box-shadow:0 2px 6px rgba(212,175,55,.35), inset 0 2px 4px rgba(0,0,0,.2);
}
.sm-btn.ghost{
  background:var(--card-bg-alt);color:#999;border:1px solid var(--border-dim);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.02);
}
.sm-btn.ghost:active{background:#1c1c1c;color:#bbb}
.sm-empty{padding:40px 20px;text-align:center;color:#555;font-size:14px}
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
<script>
var TOKEN = ${token};
var CUR   = ${curr};
var PRODS = ${pdata};
var CATS  = ${cdata};
var LOGO  = ${logoJ};
var NAME  = ${nameJ};
var COLOR = ${colorJ};
var BOT_PHONE = ${phoneJ};
var ORDER_MODE   = ${JSON.stringify(store.adminConfig?.orderMode || "cart")};
var PRIMARY_BTN  = ${JSON.stringify(store.adminConfig?.menuLayout?.primaryButtonText || "اطلب الآن")};
var EXTRAS       = ${extrasJ};
var cart  = {};
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

  // زر العودة للواتساب
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
})();

// ── Build card sections ──
function esc(s) {
  var d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
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

    var card = document.createElement('div');
    card.className = 'card';
    card.dataset.pid = pid;
    card.dataset.cat = String(p.categoryId || cat.id || '');
    card.dataset.sub = String(p.subCategoryId || '');

    // Image wrapper
    var imgDiv = document.createElement('div');
    imgDiv.className = 'c-img';
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
    var priceTxt = (PRODS[pid].price || p.price) + ' ' + CUR;
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
    ctrl.innerHTML =
      (ORDER_MODE === 'single'
        ? '<button class="cb-single" data-id="' + esc(pid) + '">' + (PRIMARY_BTN || 'اطلب الآن') + '</button>'
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
  document.getElementById('heroMeta').innerHTML = '<span>💰 ' + p.price + ' ' + CUR + '</span><span>•</span><span>طُلب ' + p.popularity + 'x آخر شهر</span>';
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
      items.push({ id: pid, name: p.name, price: p.price, qty: q, size: p.selectedSize || null, notes: p.notes || null });
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

  // Hero (image or video toggle)
  var hero = document.getElementById('pdHero');
  hero.innerHTML = '';
  var heroBadges = null;
  if (p.imageUrl) {
    var im = document.createElement('img');
    im.src = p.imageUrl; im.alt = p.name; im.loading = 'lazy';
    im.onerror = function(){ hero.innerHTML = '<div class="pd-hero-noimg">🍽️</div>'; };
    hero.appendChild(im);
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
  document.getElementById('pdPrice').textContent = p.price + ' ' + CUR;
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
  document.getElementById('pdCtaText').textContent = (cart[pid] && cart[pid] > 0) ? 'تحديث السلة' : (PRIMARY_BTN || 'أضف للسلة');

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
  cart = {};
  cart[id] = 1;
  // تحديث visual: حذف "taken" من غيره
  document.querySelectorAll('.cb-single.taken').forEach(function(b){
    b.classList.remove('taken');
    b.textContent = PRIMARY_BTN || 'اطلب الآن';
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
    if (q > 0 && PRODS[id]) items.push({ id: id, name: PRODS[id].name, price: PRODS[id].price, qty: q });
  });
  if (!items.length) return;

  var body = document.getElementById('smBody');
  body.innerHTML = '';
  var total = 0;
  items.forEach(function(it) {
    var sub = it.price * it.qty;
    total += sub;
    var row = document.createElement('div');
    row.className = 'sm-item';
    row.innerHTML =
      '<div><div class="sm-item-name">' + esc(it.name) + '</div>' +
      '<div class="sm-item-sub">' + it.qty + ' × ' + it.price + ' ' + CUR + '</div></div>' +
      '<div class="sm-item-price">' + sub.toFixed(2) + ' ' + CUR + '</div>';
    body.appendChild(row);
  });
  document.getElementById('smTotal').textContent = total.toFixed(2) + ' ' + CUR;
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
    if (q > 0 && PRODS[id]) items.push({ id: id, name: PRODS[id].name, price: PRODS[id].price, qty: q });
  });
  if (!items.length) return;

  var notes  = String(document.getElementById('smNotes').value || '').trim().slice(0, 500);
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
</script>
</body>
</html>`);
});

app.post(["/api/order/:token", "/api/o/:token"], async (req, res) => {
  const sess = waMgr.getWebOrderSession(req.params.token);
  if (!sess) return res.status(410).json({ ok: false, error: "expired" });

  waMgr.clearWebOrderSession(req.params.token);

  const { storeId, from } = sess;
  const { items, notes } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ ok: false, error: "empty cart" });
  }
  const cleanNotes = String(notes || "").trim().slice(0, 500);

  const store = resolveStore(storeId);
  if (!store) return res.status(404).json({ ok: false, error: "store not found" });

  // Build cart with imageUrl from store products
  const cartItems = items
    .map(item => {
      const prod = (store.products || []).find(p => String(p.id) === String(item.id));
      return {
        id:       item.id,
        name:     String(item.name || prod?.name || ""),
        price:    Number(item.price ?? prod?.price ?? 0),
        qty:      Math.max(1, Number(item.qty) || 1),
        imageUrl: prod?.imageUrl || null,
      };
    })
    .filter(i => i.qty > 0 && i.name);

  if (!cartItems.length) return res.status(400).json({ ok: false, error: "invalid items" });

  // Set rule-based session: cart is ready, waiting for name
  // path="webview" يضمن استخدام text plain (لا polls) في checkout flow
  sessionManager.set(from, { step: "COLLECT_NAME", cart: cartItems, path: "webview", orderNotes: cleanNotes });

  // Send WhatsApp name request directly (outside storeCtx)
  console.log(`[web-order] sending reply → storeId=${storeId} from=${from} notes=${cleanNotes.length}`);
  try {
    await waMgr.sendMessage(storeId, from,
      `✅ *تم استلام طلبك!*\n\n` +
      cartItems.map(i => `• ${i.name} × ${i.qty}`).join("\n") +
      (cleanNotes ? `\n\n📝 *ملاحظات:* ${cleanNotes}` : "") +
      `\n\n📝 من فضلك *اكتب اسمك الكريم* لإتمام الطلب:`
    );
    console.log(`[web-order] ✅ reply sent → ${from}`);
  } catch (e) {
    console.error(`[web-order] ❌ sendMessage failed → ${from}: ${e.message}`);
  }

  res.json({ ok: true });
});

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
      require("./accounting").startMonthlyAccountingCron();
    });
  });
}
