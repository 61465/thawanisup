/**
 * Master Admin Router — إدارة جميع متاجر ابو حاتم
 * Routes: /master/*
 */

const express       = require("express");
const crypto        = require("crypto");
const fs            = require("fs");
const path          = require("path");
const bcrypt        = require("bcrypt");
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
  fs.writeFileSync(OWNER_SETTINGS_FILE, JSON.stringify(data, null, 2));
}

// ─── Session store (in-memory) — 24h TTL ─────────────────────────────────────
const MASTER_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessions = new Map();

setInterval(() => {
  const cutoff = Date.now() - MASTER_SESSION_TTL_MS;
  for (const [token, ts] of sessions) {
    if (ts < cutoff) sessions.delete(token);
  }
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

function writeStores(data) {
  fs.writeFileSync(STORES_FILE, JSON.stringify(data, null, 2));
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

// ─── Auth middleware ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers["x-master-token"];
  const ts = sessions.get(token);
  if (!token || ts === undefined) return res.status(401).json({ error: "يرجى تسجيل الدخول" });
  if (Date.now() - ts > MASTER_SESSION_TTL_MS) {
    sessions.delete(token);
    return res.status(401).json({ error: "انتهت الجلسة، يرجى تسجيل الدخول مجدداً" });
  }
  next();
}

// ─── Master Credentials (bcrypt في ملف منفصل) ──────────────────────────────
const MASTER_CRED_FILE = path.join(DATA_DIR, "master-credentials.json");

// returns: { hash, plain } — plain فقط في حال migration legacy
function readMasterCred() {
  try {
    const d = JSON.parse(fs.readFileSync(MASTER_CRED_FILE, "utf8"));
    if (d?.hash) return { hash: d.hash, plain: null };
    if (d?.password) return { hash: null, plain: String(d.password) };
  } catch {}
  return { hash: null, plain: process.env.MASTER_PASSWORD || "gzmaster2026" };
}
function saveMasterHash(hash) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MASTER_CRED_FILE, JSON.stringify({ hash, updatedAt: new Date().toISOString() }, null, 2));
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
router.post("/master/login", async (req, res) => {
  const pass = (req.body?.password || "").trim();
  if (!pass) return res.status(400).json({ error: "كلمة المرور مطلوبة" });
  const ok = await verifyMasterPassword(pass);
  if (!ok) return res.status(403).json({ error: "كلمة المرور خاطئة" });
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now());
  res.json({ ok: true, token });
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
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "فشل التحديث: " + e.message });
  }
});

router.post("/master/logout", auth, (req, res) => {
  sessions.delete(req.headers["x-master-token"]);
  res.json({ ok: true });
});

// ─── Dashboard Stats ──────────────────────────────────────────────────────────
router.get("/master/stats", auth, (req, res) => {
  const { stores } = readStores();
  const today = new Date().toISOString().slice(0, 10);

  let totalOrdersToday = 0;
  let totalRevenue     = 0;
  let monthlyRevenue   = 0;
  const activeStores   = stores.filter(s => s.subscriptionStatus === "active").length;

  for (const store of stores) {
    const orders = readStoreOrders(store.id);
    totalOrdersToday += orders.filter(o => (o.timestamp || "").slice(0, 10) === today).length;
    totalRevenue     += orders.reduce((s, o) => s + (o.total || 0), 0);
    if (store.subscriptionStatus === "active") {
      monthlyRevenue += parseFloat(store.subscriptionFee || 0);
    }
  }

  const expiringCount = stores.filter(s => {
    if (s.subscriptionStatus !== "active" || !s.subscriptionNextPayment) return false;
    const days = Math.ceil((new Date(s.subscriptionNextPayment) - new Date()) / 86400000);
    return days >= 0 && days <= 7;
  }).length;

  res.json({
    totalStores: stores.length,
    activeStores,
    totalOrdersToday,
    totalRevenue:   parseFloat(totalRevenue.toFixed(2)),
    monthlyRevenue: parseFloat(monthlyRevenue.toFixed(2)),
    expiringCount,
  });
});

// ─── Plans list ───────────────────────────────────────────────────────────────
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

router.put("/master/stores/:id", auth, async (req, res) => {
  const data = readStores();
  const idx  = data.stores.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "المتجر غير موجود" });

  const prevStatus = data.stores[idx].subscriptionStatus;
  data.stores[idx] = { ...data.stores[idx], ...req.body, id: req.params.id };
  writeStores(data);

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
router.post("/master/upload-logo", auth, (req, res) => {
  const { base64, ext = "png", storeId } = req.body || {};
  if (!base64 || !storeId) return res.status(400).json({ error: "بيانات ناقصة" });

  const safeExt   = ["jpg","jpeg","png","webp"].includes(ext.toLowerCase()) ? ext.toLowerCase() : "png";
  const filename  = `logo_${storeId}_${Date.now()}.${safeExt}`;
  const imagesDir = path.join(DATA_DIR, "images");
  const filepath  = path.join(imagesDir, filename);

  try {
    fs.mkdirSync(imagesDir, { recursive: true });
    const buffer = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ""), "base64");
    if (buffer.length > 3 * 1024 * 1024) return res.status(413).json({ error: "الصورة أكبر من 3MB" });
    fs.writeFileSync(filepath, buffer);
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
  const token = createStoreToken(store.id);
  res.json({ ok: true, token, storeId: store.id, storeName: store.storeName });
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
  fs.writeFileSync(PENDING_FILE, JSON.stringify(data, null, 2));
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

  // Generate store password
  const rawPass = crypto.randomBytes(9).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "Bot" + Date.now().toString(36).toUpperCase();

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
    storePassword:      rawPass,
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

  // Sync to Firestore
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
