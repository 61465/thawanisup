/**
 * Master Admin Router — إدارة جميع متاجر ابو حاتم
 * Routes: /master/*
 */

const express       = require("express");
const crypto        = require("crypto");
const fs            = require("fs");
const path          = require("path");
const bcrypt        = require("bcryptjs");
const rateLimit     = require("express-rate-limit");

// regex: detect if a string is already a bcrypt hash
const BCRYPT_RE = /^\$2[aby]?\$\d{2}\$/;
const BCRYPT_ROUNDS = 12;

// rate limiter: 5 طلبات/IP في الدقيقة لـ /api/register-request
const registerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "تم تجاوز الحد المسموح، حاول بعد دقيقة" },
});

// allowed CORS origins (whitelist)
const CORS_ALLOWED = new Set([
  "https://61465.github.io",
  "https://bothatim-vps.tail19ddab.ts.net",
  "http://localhost:3003",
]);
function setApiCors(req, res) {
  const origin = req.headers.origin || "";
  if (CORS_ALLOWED.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
const { PLANS }     = require("./plans");
const waMgr         = require("./whatsapp-manager");
const firestoreAuth = require("./firestore-auth");
const { generateAdminConfig } = require("./ai-admin-config");
const twoFA        = require("./two-fa");
const { audit }    = require("./audit-log");

// rate limiter for master login (15 attempts / 15min / IP — skipSuccess prevents false-positives)
const masterLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "محاولات دخول كثيرة، حاول بعد 15 دقيقة" },
  skipSuccessfulRequests: true,
});

const router    = express.Router();
const DATA_DIR  = path.join(__dirname, "..", "data");
const STORES_FILE         = path.join(DATA_DIR, "stores.json");
const OWNER_SETTINGS_FILE = path.join(DATA_DIR, "owner-settings.json");
const PENDING_FILE        = path.join(DATA_DIR, "pending-requests.json");

// ─── Owner Settings helpers ───────────────────────────────────────────────────
const DEFAULT_PLANS = {
  starter: {
    nameAr: "الأساسية", emoji: "🌱", price: 80,
    sysFeatures: { adminPanel: true, invoiceImage: false, customerRegistry: false, stripe: false },
    displayFeatures: [
      { text: "استقبال طلبات غير محدودة",  included: true  },
      { text: "قائمة منتجات تفاعلية",       included: true  },
      { text: "لوحة تحكم إدارة الطلبات",   included: true  },
      { text: "إشعارات فورية للمالك",       included: true  },
      { text: "فاتورة صورة تلقائية",        included: false },
      { text: "سجل عملاء VIP",              included: false },
      { text: "دفع إلكتروني بالفيزا",       included: false },
    ],
  },
  pro: {
    nameAr: "الاحترافية", emoji: "⭐", price: 150,
    sysFeatures: { adminPanel: true, invoiceImage: true, customerRegistry: true, stripe: false },
    displayFeatures: [
      { text: "كل مميزات الأساسية",              included: true  },
      { text: "فاتورة صورة تُرسل للعميل تلقائياً", included: true  },
      { text: "سجل عملاء VIP مع التاريخ الكامل", included: true  },
      { text: "تقارير مبيعات يومية",             included: true  },
      { text: "دفع إلكتروني بالفيزا",             included: false },
    ],
  },
  premium: {
    nameAr: "المتقدمة", emoji: "👑", price: 250,
    sysFeatures: { adminPanel: true, invoiceImage: true, customerRegistry: true, stripe: true },
    displayFeatures: [
      { text: "كل مميزات الاحترافية",          included: true },
      { text: "دفع إلكتروني بالفيزا",          included: true },
      { text: "ربط كامل مع بوابة الدفع",        included: true },
      { text: "أولوية الدعم الفني 24/7",        included: true },
    ],
  },
};

const DEFAULT_WELCOME_TEMPLATE =
`{{greeting}}

✨ نسعد بخدمتك في *{{store_name}}*

━━━━━━━━━━━━━━━━━━

{{webview_section}}

━━━━━━━━━━━━━━━━━━

{{numeric_section}}

━━━━━━━━━━━━━━━━━━

{{ai_section}}

━━━━━━━━━━━━━━━━━━

{{tips_line}}`;

const DEFAULT_WELCOME_NO_LINK =
`{{greeting}}

✨ نسعد بخدمتك في *{{store_name}}*

━━━━━━━━━━━━━━━━━━

{{numeric_section}}

━━━━━━━━━━━━━━━━━━

{{ai_section}}

━━━━━━━━━━━━━━━━━━

{{tips_line}}`;

// قوالب جاهزة إضافية يختارها أبو حاتم بنقرة واحدة
// كل القوالب تستخدم {{paths_block}} للأقسام الديناميكية حسب toggles المتجر
const WELCOME_PRESETS = {
  elegant: {
    name: "✨ أنيق فخم (افتراضي)",
    withLink: DEFAULT_WELCOME_TEMPLATE,
    noLink:   DEFAULT_WELCOME_NO_LINK,
  },
  classic: {
    name: "📜 كلاسيكي",
    withLink:
`{{greeting}}

{{paths_block}}`,
    noLink:
`{{greeting}}

{{paths_block}}`,
  },
  minimal: {
    name: "⚪ بسيط مختصر",
    withLink:
`{{greeting}}

{{paths_block}}`,
    noLink:
`{{greeting}}

{{paths_block}}`,
  },
  warm: {
    name: "🤍 دافئ ودود",
    withLink:
`{{greeting}}

أهلاً وسهلاً 🤍
يسعدنا تواجدك في *{{store_name}}* ✨

{{paths_block}}

نتمنى لك تجربة مميزة 🌹`,
    noLink:
`{{greeting}}

أهلاً وسهلاً 🤍
يسعدنا تواجدك في *{{store_name}}* ✨

{{paths_block}}`,
  },
  detailed: {
    name: "📚 شرح مفصل (للعملاء الجدد)",
    withLink:
`{{greeting}}

✨ نسعد بخدمتك في *{{store_name}}*

📌 *لديك طرق سهلة للطلب — اختر الأنسب لك:*

━━━━━━━━━━━━━━━━━━━

{{webview_section}}

━━━━━━━━━━━━━━━━━━━

{{numeric_section}}

━━━━━━━━━━━━━━━━━━━

{{ai_section}}

━━━━━━━━━━━━━━━━━━━

💡 *بعد اختيار منتجاتك، سنطلب:*

  ١. الاسم
  ٢. العنوان
  ٣. الوقت المطلوب
  ٤. التأكيد النهائي

━━━━━━━━━━━━━━━━━━━

{{tips_line}}`,
    noLink:
`{{greeting}}

✨ نسعد بخدمتك في *{{store_name}}*

📌 *لديك طرق سهلة للطلب:*

━━━━━━━━━━━━━━━━━━━

{{numeric_section}}

━━━━━━━━━━━━━━━━━━━

{{ai_section}}

━━━━━━━━━━━━━━━━━━━

{{tips_line}}`,
  },
};

function readOwnerSettings() {
  const defaults = {
    bankName: "", accountHolder: "", iban: "", swift: "",
    paypalLink: "", otherPaymentLink: "",
    supportPhone: "966508572902", supportHours: "9 صباحاً – 10 مساءً",
    planPrices: { starter: 80, pro: 150, premium: 250 },
    plans: DEFAULT_PLANS,
    welcomeTemplate:       DEFAULT_WELCOME_TEMPLATE,
    welcomeTemplateNoLink: DEFAULT_WELCOME_NO_LINK,
    welcomeHeader:         "",
    welcomeFooter:         "",
    welcomeSectionWebview: "",
    welcomeSectionNumeric: "",
    welcomeSectionAI:      "",
  };
  try {
    if (!fs.existsSync(OWNER_SETTINGS_FILE)) return defaults;
    const saved = JSON.parse(fs.readFileSync(OWNER_SETTINGS_FILE, "utf8"));
    // Deep merge plans so missing plan keys fall back to defaults
    const plans = {};
    for (const id of ["starter", "pro", "premium"]) {
      plans[id] = { ...DEFAULT_PLANS[id], ...(saved.plans?.[id] || {}) };
    }
    return { ...defaults, ...saved, plans };
  } catch { return defaults; }
}
function writeOwnerSettings(data) {
  atomicFs.writeJsonSync(OWNER_SETTINGS_FILE, data);
}

// ─── Persistent session store — 7 days sliding TTL ───────────────────────────
const MASTER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MASTER_SESSIONS_FILE = path.join(DATA_DIR, "sessions", "master-sessions.json");

function _loadMasterSessions() {
  try {
    if (!fs.existsSync(path.dirname(MASTER_SESSIONS_FILE))) fs.mkdirSync(path.dirname(MASTER_SESSIONS_FILE), { recursive: true });
    if (!fs.existsSync(MASTER_SESSIONS_FILE)) return new Map();
    const data = JSON.parse(fs.readFileSync(MASTER_SESSIONS_FILE, "utf8"));
    const m = new Map();
    const cutoff = Date.now() - MASTER_SESSION_TTL_MS;
    for (const [k, v] of Object.entries(data)) {
      const ts = typeof v === "number" ? v : (v.lastActivity || v.ts);
      if (ts > cutoff) m.set(k, ts);
    }
    return m;
  } catch { return new Map(); }
}
const sessions = _loadMasterSessions();

let _saveMasterTimer = null;
function _saveMasterSessions() {
  if (_saveMasterTimer) return;
  // 5s debounce بدل 500ms — تقليل I/O بـ 10× مع 50 متجر نشط
  _saveMasterTimer = setTimeout(() => {
    _saveMasterTimer = null;
    try {
      const obj = {}; for (const [k, ts] of sessions) obj[k] = ts;
      atomicFs.writeJsonSync(MASTER_SESSIONS_FILE, obj, false);
    } catch (e) { console.warn("[master-sessions] save failed:", e.message); }
  }, 5000);
}

setInterval(() => {
  const cutoff = Date.now() - MASTER_SESSION_TTL_MS;
  let removed = 0;
  for (const [token, ts] of sessions) {
    if (ts < cutoff) { sessions.delete(token); removed++; }
  }
  if (removed > 0) _saveMasterSessions();
}, 60 * 60 * 1000);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function readStores() {
  try {
    if (!fs.existsSync(STORES_FILE)) {
      const init = { stores: [] };
      fs.writeFileSync(STORES_FILE, JSON.stringify(init, null, 2));
      return init;
    }
    return JSON.parse(fs.readFileSync(STORES_FILE, "utf8"));
  } catch {
    return { stores: [] };
  }
}

const atomicFs = require("./atomic-fs");
function writeStores(data) {
  atomicFs.writeJsonSync(STORES_FILE, data);
}

function readStoreOrders(storeId) {
  const file = storeId === "nakheel_001"
    ? path.join(DATA_DIR, "orders.jsonl")
    : path.join(DATA_DIR, `orders_${storeId}.jsonl`);

  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// ─── Auth middleware (sliding TTL — renews on each request) ───────────────────
function auth(req, res, next) {
  const token = req.headers["x-master-token"];
  const ts = sessions.get(token);
  if (!token || ts === undefined) return res.status(401).json({ error: "يرجى تسجيل الدخول" });
  if (Date.now() - ts > MASTER_SESSION_TTL_MS) {
    sessions.delete(token);
    _saveMasterSessions();
    return res.status(401).json({ error: "انتهت الجلسة، يرجى تسجيل الدخول مجدداً" });
  }
  // Sliding renewal
  sessions.set(token, Date.now());
  _saveMasterSessions();
  next();
}

function isValidSession(token) {
  if (!token) return false;
  const ts = sessions.get(token);
  if (ts === undefined) return false;
  if (Date.now() - ts > MASTER_SESSION_TTL_MS) {
    sessions.delete(token);
    _saveMasterSessions();
    return false;
  }
  sessions.set(token, Date.now());
  _saveMasterSessions();
  return true;
}

// ─── Master Credentials (bcrypt في ملف منفصل) ──────────────────────────────
const MASTER_CRED_FILE = path.join(DATA_DIR, "master-credentials.json");

// returns: { hash, plain } — plain فقط في حال migration legacy
// ⚠️ يرفض الإقلاع إن لم يجد credentials وlا MASTER_PASSWORD في .env
let _masterPasswordValidated = false;
function readMasterCred() {
  try {
    const d = JSON.parse(fs.readFileSync(MASTER_CRED_FILE, "utf8"));
    if (d?.hash) return { hash: d.hash, plain: null };
    if (d?.password) return { hash: null, plain: String(d.password) };
  } catch {}
  // لا default password — يجب أن يُعرَّف MASTER_PASSWORD في .env
  const envPass = process.env.MASTER_PASSWORD;
  if (!envPass) {
    console.error("[FATAL] لا توجد كلمة مرور ماستر — حدّد MASTER_PASSWORD في .env قبل استخدام النظام");
    process.exit(1);
  }
  if (envPass.length < 8) {
    console.error("[FATAL] MASTER_PASSWORD ضعيفة جداً — استخدم 8 أحرف فأكثر");
    process.exit(1);
  }
  return { hash: null, plain: envPass };
}

// Self-check at boot: محاولة قراءة المُعتمَدات → تفعّل process.exit لو غير صحيحة
(function _validateMasterCredOnBoot() {
  if (_masterPasswordValidated) return;
  try { readMasterCred(); _masterPasswordValidated = true; }
  catch (e) { console.error("[FATAL] فشل تحميل master credentials:", e.message); process.exit(1); }
})();
function saveMasterHash(hash) {
  atomicFs.writeJsonSync(MASTER_CRED_FILE, { hash, updatedAt: new Date().toISOString() });
}
async function verifyMasterPassword(plain) {
  const cred = readMasterCred();
  if (cred.hash) return bcrypt.compare(plain, cred.hash);
  // legacy plaintext: قارن + migrate
  if (plain === cred.plain) {
    try {
      const h = await bcrypt.hash(plain, BCRYPT_ROUNDS);
      saveMasterHash(h);
      console.log("[security] master password migrated to bcrypt");
    } catch (e) { console.warn("[security] master hash migration failed:", e.message); }
    return true;
  }
  return false;
}

// ─── Login / Logout ───────────────────────────────────────────────────────────
router.post("/master/login", masterLoginLimiter, async (req, res) => {
  const pass = (req.body?.password || "").trim();
  const otp  = String(req.body?.otp || "").trim();
  if (!pass) return res.status(400).json({ error: "كلمة المرور مطلوبة" });

  const ok = await verifyMasterPassword(pass);
  if (!ok) {
    audit({ actor: { type: "master" }, action: "login.fail", ok: false, meta: { reason: "bad_password" } }, req);
    return res.status(403).json({ error: "كلمة المرور خاطئة" });
  }

  if (twoFA.isEnabled("master")) {
    if (!otp) return res.status(401).json({ error: "رمز التحقق الثنائي مطلوب", twoFARequired: true });
    if (!twoFA.verifyLogin("master", otp)) {
      audit({ actor: { type: "master" }, action: "login.fail", ok: false, meta: { reason: "bad_otp" } }, req);
      return res.status(403).json({ error: "رمز التحقق غير صحيح" });
    }
  }

  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now());
  _saveMasterSessions();
  audit({ actor: { type: "master" }, action: "login.success" }, req);
  res.json({ ok: true, token, twoFAEnabled: twoFA.isEnabled("master") });
});

// ─── 2FA endpoints ────────────────────────────────────────────────────────────
router.get("/master/2fa/status", auth, (req, res) => {
  res.json({ enabled: twoFA.isEnabled("master") });
});

router.post("/master/2fa/setup", auth, (req, res) => {
  if (twoFA.isEnabled("master")) return res.status(400).json({ error: "2FA مفعّل بالفعل، عطّله أولاً" });
  const { secret, url } = twoFA.setupSecret("master", "ThawaniMaster");
  audit({ actor: { type: "master", id: "master" }, action: "2fa.setup" }, req);
  res.json({ secret, otpauthUrl: url });
});

router.post("/master/2fa/enable", auth, (req, res) => {
  const token = String(req.body?.token || "").trim();
  if (!token) return res.status(400).json({ error: "رمز التحقق مطلوب" });
  const r = twoFA.enableForUser("master", token);
  if (!r.ok) {
    audit({ actor: { type: "master", id: "master" }, action: "2fa.enable", ok: false, meta: { reason: r.error } }, req);
    return res.status(400).json({ error: r.error });
  }
  audit({ actor: { type: "master", id: "master" }, action: "2fa.enable" }, req);
  res.json({ ok: true, backupCodes: r.backupCodes });
});

router.post("/master/2fa/disable", auth, (req, res) => {
  const token = String(req.body?.token || "").trim();
  if (!token) return res.status(400).json({ error: "رمز التحقق مطلوب" });
  const r = twoFA.disableForUser("master", token);
  if (!r.ok) return res.status(400).json({ error: r.error });
  audit({ actor: { type: "master", id: "master" }, action: "2fa.disable" }, req);
  res.json({ ok: true });
});

// ─── Audit log viewer (master only) ───────────────────────────────────────────
router.get("/master/audit", auth, (req, res) => {
  const { readAuditMonth, listAuditFiles } = require("./audit-log");
  const month = String(req.query.month || "").trim();
  const target = month || (listAuditFiles()[0] || "").replace(".jsonl", "");
  if (!target) return res.json({ months: [], entries: [] });
  const entries = readAuditMonth(target, {
    action: req.query.action || undefined,
    actor: req.query.actor || undefined,
    failedOnly: req.query.failedOnly === "1",
    limit: parseInt(req.query.limit) || 200,
  });
  res.json({ months: listAuditFiles().map(f => f.replace(".jsonl", "")), current: target, entries });
});

// ─── Master change password ───────────────────────────────────────────────────
router.put("/master/password", auth, async (req, res) => {
  const { current, newPassword } = req.body || {};
  if (!current || !newPassword) return res.status(400).json({ error: "كلمتا المرور مطلوبتان" });
  if (String(newPassword).length < 6) return res.status(400).json({ error: "كلمة المرور الجديدة يجب أن تكون 6 أحرف فأكثر" });
  const ok = await verifyMasterPassword(String(current));
  if (!ok) return res.status(403).json({ error: "كلمة المرور الحالية غير صحيحة" });
  try {
    const hash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
    saveMasterHash(hash);
    audit({ actor: { type: "master", id: "master" }, action: "password.change" }, req);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "فشل التحديث: " + e.message });
  }
});

router.post("/master/logout", auth, (req, res) => {
  sessions.delete(req.headers["x-master-token"]);
  res.json({ ok: true });
});

// ─── Dashboard Stats — مع cache 60 ثانية (يصمد لـ 50+ متجر) ──────────────────
let _statsCache = { ts: 0, data: null };
const STATS_CACHE_TTL_MS = 60 * 1000;

router.get("/master/stats", auth, (req, res) => {
  // serve from cache لو حديث
  if (_statsCache.data && Date.now() - _statsCache.ts < STATS_CACHE_TTL_MS) {
    return res.json({ ..._statsCache.data, _cached: true, cacheAgeSec: Math.floor((Date.now() - _statsCache.ts) / 1000) });
  }

  const { stores } = readStores();
  const today = new Date().toISOString().slice(0, 10);
  const todayPrefix = today;

  let totalOrdersToday = 0;
  let totalRevenue     = 0;
  let monthlyRevenue   = 0;
  const activeStores   = stores.filter(s => s.subscriptionStatus === "active").length;

  // قراءة streaming بدل JSON.parse للملف كاملاً (يقلل memory spike)
  for (const store of stores) {
    const file = store.id === "nakheel_001"
      ? path.join(DATA_DIR, "orders.jsonl")
      : path.join(DATA_DIR, `orders_${store.id}.jsonl`);
    if (!fs.existsSync(file)) continue;
    try {
      // عد طلبات اليوم بـ string match (أسرع من parse + filter)
      const content = fs.readFileSync(file, "utf8");
      const lines = content.split("\n");
      for (const l of lines) {
        if (!l) continue;
        // طلبات اليوم: substring check قبل parse (90% أسرع)
        if (l.indexOf(`"${todayPrefix}`) >= 0 || l.indexOf(`timestamp":"${todayPrefix}`) >= 0) {
          try {
            const o = JSON.parse(l);
            if (o._test) continue;
            if ((o.timestamp || "").slice(0, 10) === today) totalOrdersToday++;
          } catch {}
        }
        // الإيرادات الكلية — فقط للطلبات المكتملة
        try {
          const o = JSON.parse(l);
          if (o._test) continue;
          if (["confirmed", "completed", "delivered", "done"].includes(o.status)) {
            totalRevenue += Number(o.total || 0);
          }
        } catch {}
      }
    } catch {}
    if (store.subscriptionStatus === "active") {
      monthlyRevenue += parseFloat(store.subscriptionFee || 0);
    }
  }

  const expiringCount = stores.filter(s => {
    if (s.subscriptionStatus !== "active" || !s.subscriptionNextPayment) return false;
    const days = Math.ceil((new Date(s.subscriptionNextPayment) - new Date()) / 86400000);
    return days >= 0 && days <= 7;
  }).length;

  const data = {
    totalStores: stores.length,
    activeStores,
    totalOrdersToday,
    totalRevenue:   parseFloat(totalRevenue.toFixed(2)),
    monthlyRevenue: parseFloat(monthlyRevenue.toFixed(2)),
    expiringCount,
  };
  _statsCache = { ts: Date.now(), data };
  res.json(data);
});

// ─── Per-store financial summary — وضع مالي لكل متجر ──────────────────────────
router.get("/master/financial", auth, (_req, res) => {
  const { stores } = readStores();
  const today = new Date().toISOString().slice(0, 10);
  const monthPrefix = today.slice(0, 7);
  const earningStatuses = new Set(["confirmed", "completed", "delivered", "done"]);

  const rows = stores.map(store => {
    const file = store.id === "nakheel_001"
      ? path.join(DATA_DIR, "orders.jsonl")
      : path.join(DATA_DIR, `orders_${store.id}.jsonl`);

    let ordersTotal = 0, ordersToday = 0, ordersMonth = 0;
    let revenueTotal = 0, revenueToday = 0, revenueMonth = 0;
    let lastOrderAt = null;
    let pendingCount = 0;

    if (fs.existsSync(file)) {
      try {
        const lines = fs.readFileSync(file, "utf8").split("\n");
        for (const l of lines) {
          if (!l) continue;
          try {
            const o = JSON.parse(l);
            if (o._test) continue;
            ordersTotal++;
            const ts = (o.timestamp || "").slice(0, 10);
            const isEarning = earningStatuses.has(o.status);
            const total = Number(o.total || 0);
            if (ts === today)            { ordersToday++; if (isEarning) revenueToday += total; }
            if (ts.startsWith(monthPrefix)) { ordersMonth++; if (isEarning) revenueMonth += total; }
            if (isEarning) revenueTotal += total;
            if (o.status === "pending_confirmation") pendingCount++;
            if (!lastOrderAt || (o.timestamp || "") > lastOrderAt) lastOrderAt = o.timestamp || lastOrderAt;
          } catch {}
        }
      } catch {}
    }

    const subFee = parseFloat(store.subscriptionFee || 0) || 0;
    const next = store.subscriptionNextPayment ? new Date(store.subscriptionNextPayment) : null;
    const daysLeft = next ? Math.ceil((next - new Date()) / 86400000) : null;
    const status = store.subscriptionStatus || "inactive";

    return {
      storeId:      store.id,
      storeName:    store.storeName || store.id,
      plan:         store.plan || "basic",
      currency:     store.currency || "ر.س",
      status,
      subscriptionFee:  subFee,
      nextPayment:      store.subscriptionNextPayment || null,
      daysLeft,
      paymentHealth:    status !== "active" ? "expired" :
                        (daysLeft != null && daysLeft <= 3) ? "critical" :
                        (daysLeft != null && daysLeft <= 7) ? "warning" : "healthy",
      ordersTotal, ordersToday, ordersMonth,
      revenueTotal: parseFloat(revenueTotal.toFixed(2)),
      revenueToday: parseFloat(revenueToday.toFixed(2)),
      revenueMonth: parseFloat(revenueMonth.toFixed(2)),
      avgOrder:     ordersTotal ? parseFloat((revenueTotal / ordersTotal).toFixed(2)) : 0,
      pendingCount,
      lastOrderAt,
    };
  });

  // ترتيب: المتأخرين/الحرجين أولاً ثم الأعلى إيراداً
  rows.sort((a, b) => {
    const order = { expired: 0, critical: 1, warning: 2, healthy: 3 };
    const d = order[a.paymentHealth] - order[b.paymentHealth];
    return d !== 0 ? d : (b.revenueMonth - a.revenueMonth);
  });

  res.json({
    rows,
    totals: {
      stores:        rows.length,
      mrr:           parseFloat(rows.filter(r => r.status === "active").reduce((s, r) => s + r.subscriptionFee, 0).toFixed(2)),
      revenueMonth:  parseFloat(rows.reduce((s, r) => s + r.revenueMonth, 0).toFixed(2)),
      ordersMonth:   rows.reduce((s, r) => s + r.ordersMonth, 0),
      expired:       rows.filter(r => r.paymentHealth === "expired").length,
      critical:      rows.filter(r => r.paymentHealth === "critical").length,
    },
  });
});

// ─── Plans list ───────────────────────────────────────────────────────────────
// ═════ 🎫 Support Tickets (master side) + 📈 Analytics ═══════════════════
router.get("/master/support/tickets", auth, async (req, res) => {
  try {
    const t = require("./support-tickets");
    const items = await t.listAll({ status: req.query.status, priority: req.query.priority, storeId: req.query.storeId });
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get("/master/support/tickets/stats", auth, async (_req, res) => {
  try {
    const stats = await require("./support-tickets").getStats();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 🛡️ Error monitor — قراءة آخر الأخطاء + إحصاءات
router.get("/master/errors", auth, (_req, res) => {
  try {
    const em = require("./error-monitor");
    res.json({ items: em.recent(100), stats: em.stats() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 📦 Backup فوري + قائمة النسخ المتاحة
router.post("/master/backup/snapshot", auth, (req, res) => {
  try {
    const label = String(req.body?.label || "manual").slice(0, 32);
    const result = require("./backup").snapshot(label);
    if (!result.ok) return res.status(400).json(result);
    audit({ actor: { type: "master", id: "master" }, action: "backup.snapshot", target: { type: "backup", id: result.name } }, req);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get("/master/backup/list", auth, (_req, res) => {
  try { res.json({ items: require("./backup").list() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get("/master/support/tickets/:id", auth, async (req, res) => {
  try {
    const t = await require("./support-tickets").getTicket(req.params.id);
    if (!t) return res.status(404).json({ error: "غير موجود" });
    res.json({ ticket: t });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.post("/master/support/tickets/:id/reply", auth, (req, res) => {
  const tk = require("./support-tickets");
  const updated = tk.replyToTicket(req.params.id, { from: "master", message: req.body?.message });
  if (!updated) return res.status(404).json({ error: "غير موجود" });
  audit({ actor: { type: "master", id: "master" }, action: "support.reply", target: { type: "ticket", id: req.params.id } }, req);
  // أبلغ المتجر عبر واتساب (إن أمكن)
  try {
    const stores = readStores().stores;
    const store = stores.find(s => s.id === updated.storeId);
    if (store?.ownerPhone) {
      const waMgr = require("./whatsapp-manager");
      const jid = String(store.ownerPhone).replace(/\D/g, "") + "@s.whatsapp.net";
      waMgr.sendMessage(updated.storeId, jid,
        `📩 *رد جديد على تذكرة دعمك*\n\n` +
        `العنوان: ${updated.subject}\n\n` +
        `الرد: ${String(req.body?.message || "").slice(0, 400)}\n\n` +
        `افتح لوحة التحكم → 🎫 تذاكري للمتابعة.`
      ).catch(() => {});
    }
  } catch {}
  res.json({ ok: true, ticket: updated });
});
router.post("/master/support/tickets/:id/status", auth, (req, res) => {
  try {
    const updated = require("./support-tickets").updateStatus(req.params.id, req.body?.status);
    if (!updated) return res.status(404).json({ error: "غير موجود" });
    audit({ actor: { type: "master", id: "master" }, action: "support.status", target: { type: "ticket", id: req.params.id }, meta: { status: req.body?.status } }, req);
    res.json({ ok: true, ticket: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 📈 Growth analytics
router.get("/master/analytics/growth", auth, (req, res) => {
  const months = Math.min(24, Math.max(3, parseInt(req.query.months) || 12));
  res.json(require("./analytics").getGrowthAnalytics(months));
});

router.get("/master/plans", auth, (_req, res) => {
  res.json({ plans: Object.values(PLANS).map(p => ({
    id: p.id, nameAr: p.nameAr, emoji: p.emoji, color: p.color, features: p.features
  })) });
});

// ─── Stores CRUD ──────────────────────────────────────────────────────────────
router.get("/master/stores", auth, (req, res) => {
  const { stores } = readStores();
  const today = new Date().toISOString().slice(0, 10);

  const enriched = stores.map(store => {
    const orders = readStoreOrders(store.id);
    return {
      ...store,
      ordersTotal: orders.length,
      ordersToday: orders.filter(o => (o.timestamp || "").slice(0, 10) === today).length,
    };
  });

  res.json({ stores: enriched });
});

router.post("/master/stores", auth, async (req, res) => {
  const data = readStores();
  const store = {
    ...req.body,
    id:        "store_" + Date.now(),
    createdAt: new Date().toISOString().slice(0, 10),
    active:    true,
  };
  data.stores.push(store);
  writeStores(data);

  // Sync to Firestore
  firestoreAuth.upsertStoreAdmin({
    storeId:            store.id,
    phone:              store.ownerPhone || "",
    password:           store.storePassword || "",
    storeName:          store.storeName || "",
    subscriptionStatus: store.subscriptionStatus || "active",
    active:             true,
  }).catch(e => console.warn("Firestore sync error:", e.message));

  res.json({ ok: true, store });
});

// قائمة بيضاء للحقول التي يحق للماستر تعديلها
const MASTER_STORE_FIELDS = new Set([
  "storeName", "storeType", "businessType", "city",
  "ownerName", "ownerPhone", "ownerEmail",
  "plan", "subscriptionStatus", "subscriptionFee",
  "subscriptionStartDate", "subscriptionNextPayment",
  "active", "notes", "currency", "deliveryFee",
  "workingHoursStart", "workingHoursEnd",
  "welcomeMessage", "invoiceColor", "invoiceLogoUrl", "invoiceTemplate",
  "themeAccent", "themeText", "themeTextMute", "menuMode",
  "logoUrl", "address", "locationMapUrl",
  "enableWebview", "enableNumeric", "enableAI", "enableCoupons",
  "requireConfirmation",
  "storePassword", // ⚠️ يقبل لكن نتحقق ونـhash
  "adminConfig",   // للماستر فقط (regenerate)
  "loyaltySettings",
]);

router.put("/master/stores/:id", auth, async (req, res) => {
  const data = readStores();
  const idx  = data.stores.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "المتجر غير موجود" });

  // فلتر whitelist — لا تسمح بحقول غير معروفة
  const updates = {};
  for (const k of Object.keys(req.body || {})) {
    if (MASTER_STORE_FIELDS.has(k)) updates[k] = req.body[k];
  }

  // hash للـ storePassword لو أُرسل plaintext
  if (typeof updates.storePassword === "string" && updates.storePassword.length > 0
      && !BCRYPT_RE.test(updates.storePassword)) {
    try {
      updates.storePassword = await bcrypt.hash(updates.storePassword, BCRYPT_ROUNDS);
    } catch (e) {
      return res.status(500).json({ error: "فشل تشفير كلمة المرور" });
    }
  }

  const prevStatus = data.stores[idx].subscriptionStatus;
  data.stores[idx] = { ...data.stores[idx], ...updates, id: req.params.id };
  writeStores(data);

  audit({
    actor: { type: "master", id: "master" },
    action: "store.update",
    target: { type: "store", id: req.params.id },
    meta: { fields: Object.keys(updates) },
  }, req);

  // Sync auth fields to Firestore whenever they change
  const s = data.stores[idx];
  firestoreAuth.upsertStoreAdmin({
    storeId:            s.id,
    phone:              s.ownerPhone || "",
    ...(req.body.storePassword ? { password: s.storePassword } : {}),
    storeName:          s.storeName || "",
    subscriptionStatus: s.subscriptionStatus || "active",
    active:             s.active !== false,
  }).catch(e => console.warn("Firestore sync error:", e.message));

  // ── Send activation confirmation if subscription was just activated ──────────
  const justActivated = prevStatus !== "active" && s.subscriptionStatus === "active";
  if (justActivated && s.ownerPhone) {
    try {
      const PLAN_LABELS = { starter: "🌱 الأساسية", pro: "⭐ الاحترافية", premium: "👑 المتقدمة" };
      const planName   = PLAN_LABELS[s.plan || "starter"] || (s.plan || "الأساسية");
      const expiryDate = s.subscriptionNextPayment
        ? new Date(s.subscriptionNextPayment).toLocaleDateString("ar-EG", { year: "numeric", month: "long", day: "numeric" })
        : "—";

      const confirmMsg =
`✅ *تم تفعيل اشتراكك!*
باقة ${planName} مفعّلة حتى ${expiryDate}.
مرحباً بك في المنصة 🎉`;

      const ownerPhone = s.ownerPhone.replace(/[\s\+\-\(\)]/g, "");
      const jid = ownerPhone + "@s.whatsapp.net";
      const sessions = waMgr.listSessions();
      const activeSession = sessions.find(ss => ss.storeId === "platform" && ss.status === "open")
                         || sessions.find(ss => ss.storeId === "lead"     && ss.status === "open")
                         || sessions.find(ss => ss.status === "open");
      if (activeSession) {
        waMgr.sendMessage(activeSession.storeId, jid, confirmMsg)
          .catch(e => console.warn("Activation msg error:", e.message));
      }
    } catch (e) {
      console.warn("Activation notification error:", e.message);
    }
  }

  res.json({ ok: true, store: s });
});

router.delete("/master/stores/:id", auth, (req, res) => {
  const data = readStores();
  data.stores = data.stores.filter(s => s.id !== req.params.id);
  writeStores(data);

  // Remove from Firestore
  firestoreAuth.deleteStoreAdmin(req.params.id)
    .catch(e => console.warn("Firestore delete error:", e.message));

  res.json({ ok: true });
});

// ─── Generate subscription link for a store ───────────────────────────────────
router.get("/master/stores/:id/subscribe-link", auth, (req, res) => {
  const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
  const link = `${PUBLIC_URL}/subscribe.html?storeId=${encodeURIComponent(req.params.id)}`;
  res.json({ ok: true, link });
});

// ─── Generate store admin invite link ─────────────────────────────────────────
router.get("/master/stores/:id/invite-link", auth, (req, res) => {
  const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
  const link = `${PUBLIC_URL}/store-admin.html?invite=${encodeURIComponent(req.params.id)}`;
  res.json({ ok: true, link });
});

// ─── Get onboarding package links for a store ─────────────────────────────────
router.get("/master/stores/:id/onboarding", auth, (req, res) => {
  const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
  const storeId = req.params.id;
  const { stores } = readStores();
  const store = stores.find(s => s.id === storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const base = `${PUBLIC_URL}`;
  res.json({
    ok: true,
    storeId,
    storeName: store.storeName || store.id,
    links: {
      onboarding: `${base}/onboarding.html?url=${encodeURIComponent(base)}`,
      adminPanel:  `${base}/store-admin.html`,
      webhook:     `${base}/webhook`,
      stripeWebhook: `${base}/payments/webhook`,
    },
    whatsappMessage: buildWelcomeMessage(store, base),
  });
});

function buildWelcomeMessage(store, base) {
  const name = store.storeName || "متجرك";
  return `مرحباً بك في خدمة بوت واتساب المتاجر! 🎉

*${name}* — تم تفعيل بوتك بنجاح ✅

━━━━━━━━━━━━━━━━━━━━━
📖 *دليل الإعداد الكامل:*
${base}/onboarding.html?url=${encodeURIComponent(base)}

🖥️ *لوحة التحكم:*
${base}/store-admin.html

━━━━━━━━━━━━━━━━━━━━━
*الخطوات التالية:*
1️⃣ افتح دليل الإعداد → اربط واتساب
2️⃣ سجّل في stripe.com → أرسل API Key للدعم
3️⃣ افتح لوحة التحكم → أضف منتجاتك وخدماتك وساعات العمل

💬 *الدعم الفني:*
wa.me/966508572902
(متاح 9 صباحاً – 10 مساءً)

نتمنى لك توفيقاً وأرباحاً وفيرة 🚀`;
}

// ─── Logo Upload ──────────────────────────────────────────────────────────────
const { decodeAndVerifyBase64, sanitizeStoreIdForFilename } = require("./upload-safety");

router.post("/master/upload-logo", auth, (req, res) => {
  const { base64, ext = "png", storeId } = req.body || {};
  if (!base64 || !storeId) return res.status(400).json({ error: "بيانات ناقصة" });

  const safeStoreId = sanitizeStoreIdForFilename(storeId);
  if (!safeStoreId) return res.status(400).json({ error: "معرّف المتجر غير صالح" });

  // verify magic bytes + size (3MB)
  const r = decodeAndVerifyBase64(base64, ext, 3 * 1024 * 1024, "image");
  if (!r.ok) return res.status(400).json({ error: r.error });

  const filename  = `logo_${safeStoreId}_${Date.now()}.${r.ext}`;
  const imagesDir = path.join(DATA_DIR, "images");
  const filepath  = path.join(imagesDir, filename);

  try {
    fs.mkdirSync(imagesDir, { recursive: true });
    // تأكيد إضافي ضد path traversal — الـ resolved path يجب أن يبقى داخل imagesDir
    const resolved = path.resolve(filepath);
    if (!resolved.startsWith(path.resolve(imagesDir) + path.sep)) {
      return res.status(400).json({ error: "مسار غير مسموح" });
    }
    fs.writeFileSync(filepath, r.buffer);
    res.json({ ok: true, url: `/store-images/${filename}` });
  } catch (err) {
    console.error("Logo upload error:", err.message);
    res.status(500).json({ error: "فشل رفع الشعار" });
  }
});

// ─── Try Slots (5 test sessions) ─────────────────────────────────────────────
const TRY_SLOTS = ["try_1","try_2","try_3","try_4","try_5"];

// GET /master/try/slots — status of all 5 slots
router.get("/master/try/slots", auth, (req, res) => {
  const slots = TRY_SLOTS.map(id => ({ id, ...waMgr.getStatus(id) }));
  res.json({ ok: true, slots });
});

// POST /master/try/claim — pick first free slot, reset it, return slotId
router.post("/master/try/claim", auth, async (req, res) => {
  // Prefer slots that are disconnected/empty over ones with active QR
  const sorted = [...TRY_SLOTS].sort((a, b) => {
    const sa = waMgr.getStatus(a).status;
    const sb = waMgr.getStatus(b).status;
    const rank = s => s === "open" ? 2 : s === "qr" ? 1 : 0;
    return rank(sa) - rank(sb);
  });

  for (const slotId of sorted) {
    const { status } = waMgr.getStatus(slotId);
    if (status === "open") continue; // slot in use
    try {
      await waMgr.resetSession(slotId);
      return res.json({ ok: true, slotId });
    } catch (e) {
      console.warn(`try claim [${slotId}] failed:`, e.message);
    }
  }
  res.status(503).json({ error: "جميع فتحات التجربة مشغولة حالياً، حاول بعد دقيقة" });
});

// ─── WhatsApp Pairing (Baileys) ───────────────────────────────────────────────

// GET /master/stores/:id/wa-status
router.get("/master/stores/:id/wa-status", auth, (req, res) => {
  const status = waMgr.getStatus(req.params.id);
  res.json({ ok: true, ...status });
});

// ─── Platform Bot Management (بوت المنصة لإرسال رسائل الترحيب) ───────────────
router.get("/master/platform-bot", auth, (req, res) => {
  const settings = readOwnerSettings();
  const status   = waMgr.getStatus("platform");
  res.json({
    configuredPhone: settings.platformBotPhone || "",
    status:          status?.status || "disconnected",
    connectedPhone:  status?.phone || null,
    qr:              status?.qr || null,
    pairingCode:     status?.pairingCode || null,
  });
});

router.post("/master/platform-bot/save-phone", auth, (req, res) => {
  const phone = String(req.body?.phone || "").replace(/[\s\+\-\(\)]/g, "");
  if (phone && !/^\d{10,15}$/.test(phone)) {
    return res.status(400).json({ error: "رقم الهاتف غير صحيح" });
  }
  const current = readOwnerSettings();
  writeOwnerSettings({ ...current, platformBotPhone: phone });
  res.json({ ok: true, phone });
});

router.post("/master/platform-bot/connect", auth, async (req, res) => {
  const settings = readOwnerSettings();
  const phone    = String(req.body?.phone || settings.platformBotPhone || "").replace(/[\s\+\-\(\)]/g, "");
  if (!phone || !/^\d{10,15}$/.test(phone)) {
    return res.status(400).json({ error: "احفظ رقم البوت أولاً" });
  }
  // إذا اختار pairing code
  if (req.body?.method === "pair") {
    try {
      const code = await waMgr.requestPairingCode("platform", phone);
      return res.json({ ok: true, method: "pair", code, phone });
    } catch (err) {
      return res.status(500).json({ error: "فشل توليد كود الربط: " + err.message });
    }
  }
  // الافتراضي: QR — ابدأ session وسيظهر QR في status
  try {
    await waMgr.initSession("platform");
    res.json({ ok: true, method: "qr", phone, message: "افتح /master/platform-bot للحصول على QR" });
  } catch (err) {
    res.status(500).json({ error: "فشل بدء الجلسة: " + err.message });
  }
});

router.post("/master/platform-bot/disconnect", auth, async (req, res) => {
  try {
    await waMgr.logoutSession?.("platform");
    res.json({ ok: true });
  } catch (e) {
    // fallback: امسح الجلسة يدوياً
    const fs   = require("fs");
    const path = require("path");
    const dir  = path.join(__dirname, "..", "data", "sessions", "platform");
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    res.json({ ok: true, message: "تم مسح الجلسة" });
  }
});

// POST /master/stores/:id/wa-pair  { phone: "966501234567" }
router.post("/master/stores/:id/wa-pair", auth, async (req, res) => {
  const storeId = req.params.id;
  const phone   = (req.body?.phone || "").replace(/[\s\+\-\(\)]/g, "");
  if (!phone || !/^\d{10,15}$/.test(phone)) {
    return res.status(400).json({ error: "رقم الهاتف غير صحيح" });
  }
  try {
    const code = await waMgr.requestPairingCode(storeId, phone);
    res.json({ ok: true, code, phone, message: `أدخل الكود في واتساب: الأجهزة المرتبطة ← ربط برقم الهاتف` });
  } catch (err) {
    console.error("Pairing error:", err.message);
    res.status(500).json({ error: "فشل إنشاء كود الربط: " + err.message });
  }
});

// POST /master/stores/:id/wa-start-qr — reset session and get fresh QR
router.post("/master/stores/:id/wa-start-qr", auth, async (req, res) => {
  try {
    await waMgr.resetSession(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /master/stores/:id/wa-session — disconnect
router.delete("/master/stores/:id/wa-session", auth, async (req, res) => {
  await waMgr.disconnectSession(req.params.id);
  res.json({ ok: true });
});

// GET /master/wa-sessions — list all active sessions
router.get("/master/wa-sessions", auth, (_req, res) => {
  res.json({ sessions: waMgr.listSessions() });
});

// ─── Store Orders ─────────────────────────────────────────────────────────────
router.get("/master/stores/:id/orders", auth, (req, res) => {
  const { stores } = readStores();
  if (!stores.find(s => s.id === req.params.id)) {
    return res.status(404).json({ error: "المتجر غير موجود" });
  }
  const orders = readStoreOrders(req.params.id);
  orders.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  res.json({ orders: orders.slice(0, parseInt(req.query.limit) || 100) });
});

// ─── Owner Settings (bank account + plan prices) ──────────────────────────────
router.get("/master/owner-settings", auth, (_req, res) => {
  res.json(readOwnerSettings());
});

router.put("/master/owner-settings", auth, (req, res) => {
  const current = readOwnerSettings();
  const updated = { ...current, ...req.body };
  if (req.body.planPrices) updated.planPrices = { ...current.planPrices, ...req.body.planPrices };
  writeOwnerSettings(updated);
  res.json({ ok: true, settings: updated });
});

// ─── Send Payment Request to store owner ─────────────────────────────────────
router.post("/master/stores/:id/send-payment-request", auth, async (req, res) => {
  const { stores } = readStores();
  const store = stores.find(s => s.id === req.params.id);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const settings = readOwnerSettings();
  const ownerPhone = (store.ownerPhone || "").replace(/[\s\+\-\(\)]/g, "");
  if (!ownerPhone) return res.status(400).json({ error: "رقم مالك المتجر غير مسجّل" });

  const PLAN_LABELS = { starter: "🌱 الأساسية", pro: "⭐ الاحترافية", premium: "👑 المتقدمة" };
  const planId   = store.plan || "starter";
  const planName = PLAN_LABELS[planId] || planId;
  const price    = store.subscriptionFee || settings.planPrices?.[planId] || 0;
  const expiryDate = store.subscriptionNextPayment
    ? new Date(store.subscriptionNextPayment).toLocaleDateString("ar-EG", { year: "numeric", month: "long", day: "numeric" })
    : "—";

  const bankName    = settings.bankName        || "—";
  const holder      = settings.accountHolder   || "—";
  const account     = settings.accountNumber   || settings.iban || settings.otherPaymentLink || "—";
  const customMsg   = settings.paymentExtraNote ? `\n\n${settings.paymentExtraNote}` : "";

  const message =
`🔔 *تفاصيل الاشتراك*

مرحباً، شكراً لثقتك في خدمتنا 🌟

📋 *تفاصيل باقتك:*
• الباقة: ${planName}
• السعر: ${price} ر.س / شهر
• تاريخ الانتهاء: ${expiryDate}

💳 *طريقة الدفع:*
• البنك: ${bankName}
• الاسم: ${holder}
• رقم الحساب: ${account}

📸 بعد التحويل أرسل صورة الإيصال على هذا الرقم لتفعيل اشتراكك فوراً.${customMsg}

شكراً 🙏`;

  try {
    const jid = ownerPhone + "@s.whatsapp.net";
    // Try platform session first, then lead session as fallback
    const sessions = waMgr.listSessions();
    const platformSession = sessions.find(s => s.storeId === "platform" && s.status === "open");
    const leadSession     = sessions.find(s => s.storeId === "lead"     && s.status === "open");
    const fallbackSession = sessions.find(s => s.status === "open");

    const sessionId = platformSession?.storeId || leadSession?.storeId || fallbackSession?.storeId;
    if (!sessionId) return res.status(503).json({ error: "لا توجد جلسة واتساب متصلة لإرسال الرسالة" });

    await waMgr.sendMessage(sessionId, jid, message);
    res.json({ ok: true, message: "تم إرسال طلب الدفع بنجاح" });
  } catch (err) {
    console.error("send-payment-request error:", err.message);
    res.status(500).json({ error: "فشل إرسال الرسالة: " + err.message });
  }
});

// ─── Platform Leads API ───────────────────────────────────────────────────────
const { readPlatformLeads } = require("./platform-bot");

router.get("/master/platform-leads", auth, (req, res) => {
  const leads = readPlatformLeads();
  leads.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  res.json({ leads: leads.slice(0, parseInt(req.query.limit) || 200) });
});

// ─── Customers API ────────────────────────────────────────────────────────────
const { getCustomers, setVip, archiveMonth } = require("./customers");

// GET /master/customers — list all customers
router.get("/master/customers", auth, (req, res) => {
  res.json({ customers: getCustomers() });
});

// PUT /master/customers/:phone/vip — toggle VIP
router.put("/master/customers/:phone/vip", auth, (req, res) => {
  const phone = req.params.phone;
  const isVip = req.body.isVip !== false; // default true
  const ok = setVip(phone, isVip);
  if (!ok) return res.status(404).json({ error: "العميل غير موجود" });
  res.json({ ok: true, phone, isVip });
});

// POST /master/customers/archive — archive non-VIP customers for given month
router.post("/master/customers/archive", auth, (req, res) => {
  const label = req.body.month; // optional e.g. "2026-06"
  const result = archiveMonth(label);
  res.json({ ok: true, ...result });
});

// ─── Master Impersonate — فتح لوحة متجر من ماستر بدون كلمة مرور ──────────────
const { createStoreToken } = require("./store-router");

router.post("/master/impersonate/:storeId", auth, (req, res) => {
  const { stores } = readStores();
  const store = stores.find(s => s.id === req.params.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const token = createStoreToken(store.id, "master");
  audit({
    actor: { type: "master", id: "master" },
    action: "store.impersonate",
    target: { type: "store", id: store.id },
    meta: { storeName: store.storeName, ttlMinutes: 30 },
  }, req);
  res.json({
    ok: true, token, storeId: store.id, storeName: store.storeName,
    ttlMinutes: 30,
    warning: "جلسة الانتحال تنتهي بعد 30 دقيقة وتُسجَّل في audit log",
  });
});

// ─── Send QR via WhatsApp — يُولّد QR جديد ويرسله لأبو حاتم ─────────────────
router.post("/master/send-qr/:storeId", auth, async (req, res) => {
  const { stores } = readStores();
  const store = stores.find(s => s.id === req.params.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const masterPhone = process.env.MASTER_PHONE;
  if (!masterPhone) return res.status(500).json({ error: "MASTER_PHONE غير محدد في .env" });

  try {
    // أعد تهيئة الجلسة لتوليد QR جديد
    await waMgr.resetSession(store.id);

    // انتظر ظهور QR (حتى 20 ثانية)
    let qrStr = null;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 500));
      const s = waMgr.getStatus(store.id);
      if (s.status === "open") return res.json({ ok: true, msg: "المتجر متصل بالفعل، لا حاجة لـ QR" });
      if (s.qr) { qrStr = s.qr; break; }
    }
    if (!qrStr) return res.status(504).json({ error: "لم يظهر QR خلال 20 ثانية، حاول مرة أخرى" });

    // حوّل QR لصورة PNG
    const QRCode = require("qrcode");
    const qrBuffer = await QRCode.toBuffer(qrStr, {
      type: "png", width: 400, margin: 2,
      color: { dark: "#1b5e20", light: "#ffffff" },
    });

    // أرسل عبر أي جلسة مفتوحة
    const allSessions = waMgr.listSessions().filter(
      s => s.storeId !== store.id && s.status === "open"
    );
    if (allSessions.length === 0) return res.status(503).json({ error: "لا توجد جلسات متصلة للإرسال منها" });

    const masterJid = masterPhone.replace(/\D/g, "") + "@s.whatsapp.net";
    const senderStore = allSessions[0].storeId;

    const caption =
      `📷 *QR جديد — ${store.storeName}*\n\n` +
      `👤 المالك: ${store.ownerName || "—"}\n` +
      `📱 الهاتف: ${store.ownerPhone || "—"}\n` +
      `🆔 المعرّف: ${store.id}\n\n` +
      `⏱ صالح لمدة 60 ثانية فقط\n` +
      `💡 امسحه من واتساب: الإعدادات ← الأجهزة المرتبطة ← ربط جهاز`;

    await waMgr.sendImage(senderStore, masterJid, qrBuffer, caption);
    res.json({ ok: true, msg: `تم إرسال QR لرقمك عبر ${senderStore}` });

  } catch(e) {
    console.error(`[send-qr] ${store.id}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Pending Requests helpers ─────────────────────────────────────────────────
function readPending() {
  try {
    if (!fs.existsSync(PENDING_FILE)) return { requests: [] };
    return JSON.parse(fs.readFileSync(PENDING_FILE, "utf8"));
  } catch { return { requests: [] }; }
}
function writePending(data) {
  atomicFs.writeJsonSync(PENDING_FILE, data);
}

// CORS preflight لـ landing page (whitelist)
router.options("/api/register-request", (req, res) => {
  setApiCors(req, res);
  res.sendStatus(204);
});

// POST /api/register-request  (public — no auth, rate-limited)
router.post("/api/register-request", registerLimiter, async (req, res) => {
  setApiCors(req, res);
  const { name, phone, store, type, city, plan } = req.body || {};
  if (!name || !phone || !store || !type) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  // normalize: إزالة الرموز + 00 (دولي) و + من البداية
  let cleanPhone = String(phone).replace(/[\s\-\(\)]/g, "").replace(/^\+/, "").replace(/^00/, "");
  if (!/^\d{10,15}$/.test(cleanPhone)) {
    return res.status(400).json({ error: "رقم الهاتف غير صحيح — يجب أن يكون 10-15 رقماً مع رمز الدولة" });
  }
  if (cleanPhone.startsWith("0")) {
    return res.status(400).json({ error: "أدخل الرقم مع رمز الدولة وبدون 0 في البداية (مثال: 201278632120 أو 966508572902)" });
  }
  const cleanName  = String(name).trim();
  const cleanStore = String(store).trim();
  const cleanType  = String(type).trim();
  const cleanCity  = String(city || "").trim();
  const cleanPlan  = ["starter","pro","premium"].includes(plan) ? plan : "pro";

  const data = readPending();
  const req_id = "req_" + Date.now();
  data.requests.push({
    id: req_id,
    name: cleanName,
    phone: cleanPhone,
    store: cleanStore,
    type:  cleanType,
    city:  cleanCity,
    plan:  cleanPlan,
    submittedAt: new Date().toISOString(),
    status: "pending",
  });
  writePending(data);

  // ── إرسال رسائل تلقائية (للعميل + لأبو حاتم) ──────────────────────────
  const PLAN_LABELS = { starter: "🌱 الأساسية — 80 ر.س", pro: "⭐ الاحترافية — 150 ر.س", premium: "👑 المتقدمة — 250 ر.س" };
  const planName     = PLAN_LABELS[cleanPlan] || cleanPlan;
  const masterPhone  = process.env.MASTER_PHONE || "966508572902";

  const clientMsg =
`🎉 *أهلاً ${cleanName}!*

شكراً لاهتمامك بـ *منصة ثواني* — منصة بوت WhatsApp للمتاجر 🤖

✅ *تم استلام طلبك بنجاح*

━━━━━━━━━━━━━━━━━━━━━
🏪 *المتجر:* ${cleanStore}
🔖 *النوع:* ${cleanType}${cleanCity ? `
📍 *المدينة:* ${cleanCity}` : ""}
💳 *الباقة:* ${planName}
━━━━━━━━━━━━━━━━━━━━━

سيتواصل معك المسؤول قريباً جداً ⏰ لتأكيد طلبك وإرسال تفاصيل التفعيل والاشتراك 💬

نتشرف بخدمتك 🙏`;

  const masterMsg =
`📥 *طلب اشتراك جديد*

👤 *الاسم:* ${cleanName}
📱 *الواتساب:* ${cleanPhone}
🏪 *المتجر:* ${cleanStore}
🔖 *النوع:* ${cleanType}${cleanCity ? `
📍 *المدينة:* ${cleanCity}` : ""}
💳 *الباقة:* ${planName}

افتح *master.html ← طلبات جديدة* للمراجعة وقبول/رفض الطلب ✅`;

  // إرسال متزامن مع logging مفصّل (سابقاً كان يفشل صامتاً)
  await sendPlatformMsgs("register", cleanPhone, masterPhone, clientMsg, masterMsg);
  res.json({ ok: true, id: req_id });
});

// helper موحّد لإرسال رسائل من بوت المنصة — مع logging مفصل + retry على fail
async function sendPlatformMsgs(label, clientPhone, masterPhone, clientMsg, masterMsg) {
  try {
    const sessions = waMgr.listSessions();
    console.log(`[${label}] available sessions:`, sessions.map(s => `${s.storeId}=${s.status}${s.phone?`(${s.phone})`:""}`).join(", ") || "(none)");
    const candidate = sessions.find(ss => ss.phone === masterPhone && ss.status === "open")
                   || sessions.find(ss => ss.storeId === "platform" && ss.status === "open")
                   || sessions.find(ss => ss.storeId === "lead"     && ss.status === "open")
                   || sessions.find(ss => ss.status === "open");
    if (!candidate) {
      console.warn(`[${label}] ⚠️ NO OPEN SESSION — messages not sent (configure platform bot)`);
      return;
    }
    console.log(`[${label}] using session: ${candidate.storeId} (phone=${candidate.phone||"?"})`);
    const clientJid = clientPhone + "@s.whatsapp.net";
    const masterJid = masterPhone + "@s.whatsapp.net";
    if (clientMsg) {
      try {
        await waMgr.sendMessage(candidate.storeId, clientJid, clientMsg);
        console.log(`[${label}] ✅ client msg sent → ${clientPhone}`);
      } catch (e) { console.error(`[${label}] ❌ client msg fail:`, e?.message || e); }
    }
    if (masterMsg) {
      try {
        await waMgr.sendMessage(candidate.storeId, masterJid, masterMsg);
        console.log(`[${label}] ✅ master msg sent → ${masterPhone}`);
      } catch (e) { console.error(`[${label}] ❌ master msg fail:`, e?.message || e); }
    }
  } catch (e) {
    console.error(`[${label}] outer error:`, e?.message || e);
  }
}

// GET /master/pending-requests — يرجع كل الطلبات (pending/approved/rejected)
// والواجهة تفلتر. ?status=pending فقط للـ badge counter
router.get("/master/pending-requests", auth, (req, res) => {
  const { requests } = readPending();
  // طبّع الـ status: undefined/null → pending (طلبات قديمة بدون حقل)
  const normalized = requests.map(r => ({ ...r, status: r.status || "pending" }));
  // ?status=pending يستخدمه الـ badge
  if (req.query.status === "pending") {
    return res.json({ requests: normalized.filter(r => r.status === "pending") });
  }
  // اللائحة الكاملة مرتّبة من الأحدث للأقدم
  normalized.sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""));
  res.json({ requests: normalized });
});

// POST /master/approve-request/:id  — ينشئ المتجر ويرسل واتساب للعميل
router.post("/master/approve-request/:id", auth, async (req, res) => {
  const data = readPending();
  const idx  = data.requests.findIndex(r => r.id === req.params.id && r.status === "pending");
  if (idx === -1) return res.status(404).json({ error: "الطلب غير موجود أو مُعالَج" });

  const pr = data.requests[idx];

  // Generate store password — 12 char base62 (≈72-bit entropy)
  function _genPassword() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"; // بدون 0/O/1/I/l لتجنّب الالتباس
    const buf = crypto.randomBytes(12);
    let s = "";
    for (let i = 0; i < 12; i++) s += chars[buf[i] % chars.length];
    return s;
  }
  const rawPass = _genPassword();
  // ⚠️ نخزّن bcrypt hash مباشرة، لا plaintext
  const hashedPass = await bcrypt.hash(rawPass, BCRYPT_ROUNDS);

  // Create store
  const storesData = readStores();
  const storeId    = "store_" + Date.now();
  const newStore = {
    id:                 storeId,
    storeName:          pr.store,
    storeType:          pr.type,
    city:               pr.city || "",
    ownerName:          pr.name,
    ownerPhone:         pr.phone,
    storePassword:      hashedPass,
    plan:               pr.plan || "pro",
    subscriptionStatus: "active",
    subscriptionFee:    { starter: 80, pro: 150, premium: 250 }[pr.plan] || 150,
    subscriptionStartDate: new Date().toISOString().slice(0, 10),
    subscriptionNextPayment: new Date(Date.now() + 30*24*60*60*1000).toISOString().slice(0, 10),
    active: true,
    createdAt: new Date().toISOString().slice(0, 10),
  };
  storesData.stores.push(newStore);
  writeStores(storesData);

  // ── AI-generated admin config (يعمل في الخلفية، لا يبطئ الـ approve) ──
  generateAdminConfig(pr.type).then(cfg => {
    if (cfg) {
      const data = readStores();
      const idx  = data.stores.findIndex(s => s.id === storeId);
      if (idx !== -1) {
        data.stores[idx].adminConfig = cfg;
        writeStores(data);
        console.log(`[ai-admin] stored config for ${storeId} (${pr.type})`);
      }
    }
  }).catch(e => console.warn("[ai-admin] gen failed:", e.message));

  // Sync to Firestore (نمرّر plaintext مرة واحدة فقط — Firestore يـhash داخلياً)
  firestoreAuth.upsertStoreAdmin({
    storeId:            storeId,
    phone:              pr.phone,
    password:           rawPass,
    storeName:          pr.store,
    subscriptionStatus: "active",
    active:             true,
  }).catch(e => console.warn("Firestore sync error:", e.message));

  // Mark request approved
  data.requests[idx].status    = "approved";
  data.requests[idx].storeId   = storeId;
  data.requests[idx].approvedAt = new Date().toISOString();
  writePending(data);

  // Send WhatsApp welcome message to client
  const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
  const PLAN_LABELS = { starter: "🌱 الأساسية", pro: "⭐ الاحترافية", premium: "👑 المتقدمة" };
  const planName = PLAN_LABELS[pr.plan] || pr.plan || "الاحترافية";
  const adminUrl = `${PUBLIC_URL}/store-admin.html`;
  const supportPhone = process.env.SUPPORT_PHONE || "966508572902";

  const welcomeMsg =
`🎉 *مبروك ${pr.name}!*

تم تفعيل اشتراكك في *منصة ثواني* بنجاح ✅
*البوت الخاص بك جاهز للعمل الآن* 🚀

━━━━━━━━━━━━━━━━━━━━━
🏪 *متجرك:* ${pr.store}
💳 *الباقة المفعّلة:* ${planName}
🗓️ *تجديد الاشتراك:* ${newStore.subscriptionNextPayment}
━━━━━━━━━━━━━━━━━━━━━

🔐 *بيانات الدخول للوحة التحكم:*
📱 رقمك: \`${pr.phone}\`
🔑 كلمة المرور: \`${rawPass}\`

🖥️ *رابط لوحة الإدارة:*
${adminUrl}

━━━━━━━━━━━━━━━━━━━━━
*ابدأ الآن خطوة بخطوة:*

1️⃣ افتح رابط لوحة التحكم أعلاه
2️⃣ سجّل دخولك برقمك وكلمة المرور
3️⃣ من تبويب "📱 ربط واتساب" — اربط رقم متجرك بالبوت
4️⃣ من تبويب "📋 القائمة" — أضف منتجاتك وفئاتك
5️⃣ ابدأ استقبال طلبات عملائك تلقائياً 🎯
━━━━━━━━━━━━━━━━━━━━━

🎁 *نصائح للنجاح:*
• فعّل نظام النقاط من تبويب "🏆 نقاط الولاء" لزيادة ولاء عملائك
• أضف كوبونات ترويجية لتزيد المبيعات
• ابعت رسائل بث للعملاء عند العروض الجديدة

💬 *الدعم الفني المباشر:*
wa.me/${supportPhone}

نحن معك في كل خطوة 🤝
بالتوفيق والأرباح الوفيرة 💚`;

  // helper الموحّد (مع logging + اختيار جلسة)
  await sendPlatformMsgs("approve", pr.phone, supportPhone, welcomeMsg, null);

  res.json({ ok: true, storeId, password: rawPass, store: newStore });
});

// DELETE /master/pending-requests/:id  — رفض الطلب (status=rejected)
router.delete("/master/pending-requests/:id", auth, (req, res) => {
  const data = readPending();
  const idx  = data.requests.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "الطلب غير موجود" });
  data.requests[idx].status     = "rejected";
  data.requests[idx].rejectedAt = new Date().toISOString();
  writePending(data);
  res.json({ ok: true });
});

// DELETE /master/pending-requests/:id/permanent — حذف نهائي من الملف
router.delete("/master/pending-requests/:id/permanent", auth, (req, res) => {
  const data = readPending();
  const before = data.requests.length;
  data.requests = data.requests.filter(r => r.id !== req.params.id);
  if (data.requests.length === before) return res.status(404).json({ error: "الطلب غير موجود" });
  writePending(data);
  res.json({ ok: true });
});

// POST /master/stores/:id/regenerate-admin-config — إعادة توليد config للمتجر
router.post("/master/stores/:id/regenerate-admin-config", auth, async (req, res) => {
  const data = readStores();
  const idx  = data.stores.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "المتجر غير موجود" });
  const storeType = req.body?.storeType || data.stores[idx].storeType || data.stores[idx].businessType;
  if (!storeType) return res.status(400).json({ error: "نوع المتجر مفقود" });
  const cfg = await generateAdminConfig(storeType);
  if (!cfg) return res.status(503).json({ error: "تعذّر توليد الـ config — AI غير متاح أو فشل" });
  data.stores[idx].adminConfig = cfg;
  if (req.body?.storeType) data.stores[idx].storeType = req.body.storeType;
  writeStores(data);
  res.json({ ok: true, adminConfig: cfg });
});

// PUT /master/pending-requests/:id/reopen — إعادة طلب مرفوض لحالة pending
router.put("/master/pending-requests/:id/reopen", auth, (req, res) => {
  const data = readPending();
  const idx  = data.requests.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "الطلب غير موجود" });
  data.requests[idx].status = "pending";
  delete data.requests[idx].rejectedAt;
  writePending(data);
  res.json({ ok: true });
});

// ─── Store Report — معلومات المتجر الكاملة + حالة واتساب الحية ─────────────
router.get("/master/store-report/:storeId", auth, (req, res) => {
  const { stores } = readStores();
  const store = stores.find(s => s.id === req.params.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const waStatus = waMgr.getStatus(store.id);

  // حساب الأيام المتبقية للتجديد
  let daysLeft = null;
  if (store.subscriptionNextPayment) {
    const diff = new Date(store.subscriptionNextPayment) - new Date();
    daysLeft = Math.ceil(diff / (1000 * 60 * 60 * 24));
  }

  res.json({
    ok: true,
    store: {
      id:                      store.id,
      storeName:               store.storeName,
      storeType:               store.storeType || null,
      city:                    store.city || null,
      ownerName:               store.ownerName || null,
      ownerPhone:              store.ownerPhone || null,
      plan:                    store.plan || "starter",
      subscriptionStatus:      store.subscriptionStatus || "active",
      subscriptionFee:         store.subscriptionFee || 0,
      subscriptionStartDate:   store.subscriptionStartDate || null,
      subscriptionNextPayment: store.subscriptionNextPayment || null,
      daysLeft,
      notes:                   store.notes || null,
    },
    wa: waStatus,
    generatedAt: new Date().toISOString(),
  });
});

// Endpoint للحصول على قوالب الترحيب الجاهزة
router.get("/master/welcome-presets", auth, (_req, res) => {
  res.json({ presets: WELCOME_PRESETS });
});

module.exports = router;
module.exports.readOwnerSettings = readOwnerSettings;
module.exports.DEFAULT_WELCOME_TEMPLATE = DEFAULT_WELCOME_TEMPLATE;
module.exports.DEFAULT_WELCOME_NO_LINK  = DEFAULT_WELCOME_NO_LINK;
module.exports.WELCOME_PRESETS = WELCOME_PRESETS;
module.exports.isValidSession = isValidSession;
