/**
 * Store Admin Router — واجهة كل عميل لإدارة متجره
 * Routes: /store/*
 * Auth: ownerPhone + storePassword → x-store-token header
 */

const express      = require("express");
const crypto       = require("crypto");
const fs           = require("fs");
const path         = require("path");
const { generateInvoiceImage } = require("./invoice-image");
const { generateMenuImage }    = require("./menu-image");
const { getPlan, getPlanFeatures, hasFeature } = require("./plans");
const loyalty      = require("./loyalty");
const couponsMod   = require("./coupons");
const firestoreAuth = require("./firestore-auth");
const waMgr        = require("./whatsapp-manager");
const { audit }    = require("./audit-log");
const bcrypt        = require("bcryptjs");

const BCRYPT_RE = /^\$2[aby]?\$\d{2}\$/;
const BCRYPT_ROUNDS = 12;

// يقارن plain بـ store.storePassword (سواء hash أو plaintext) + migrate أوتوماتيكي
async function verifyStorePassword(store, plain) {
  const stored = String(store?.storePassword || "");
  if (!stored) return false;
  if (BCRYPT_RE.test(stored)) return bcrypt.compare(plain, stored);
  // legacy plaintext: قارن + migrate
  if (plain === stored) {
    try {
      const hash = await bcrypt.hash(plain, BCRYPT_ROUNDS);
      const data = readStores();
      const idx  = data.stores.findIndex(s => s.id === store.id);
      if (idx !== -1) {
        data.stores[idx].storePassword = hash;
        writeStores(data);
        console.log(`[security] store ${store.id} password migrated to bcrypt`);
      }
    } catch (e) { console.warn("[security] store hash migration failed:", e.message); }
    return true;
  }
  return false;
}

const router    = express.Router();
const DATA_DIR  = path.join(__dirname, "..", "data");
const STORES_FILE = path.join(DATA_DIR, "stores.json");

// ─── Persistent sessions: token → { storeId, lastActivity, createdAt } ────────
// Sliding TTL: 7 days من آخر activity (لا absolute)
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STORE_SESSIONS_FILE = path.join(DATA_DIR, "sessions", "store-sessions.json");

function _loadStoreSessions() {
  try {
    if (!fs.existsSync(path.dirname(STORE_SESSIONS_FILE))) fs.mkdirSync(path.dirname(STORE_SESSIONS_FILE), { recursive: true });
    if (!fs.existsSync(STORE_SESSIONS_FILE)) return new Map();
    const data = JSON.parse(fs.readFileSync(STORE_SESSIONS_FILE, "utf8"));
    const m = new Map(Object.entries(data));
    // clean expired on load
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [k, v] of m) if ((v.lastActivity || v.createdAt) < cutoff) m.delete(k);
    return m;
  } catch { return new Map(); }
}
const sessions = _loadStoreSessions();

let _saveStoreSessionsTimer = null;
function _saveStoreSessions() {
  if (_saveStoreSessionsTimer) return;
  // 5s debounce — تقليل I/O بـ 10×
  _saveStoreSessionsTimer = setTimeout(() => {
    _saveStoreSessionsTimer = null;
    try {
      const obj = {}; for (const [k, v] of sessions) obj[k] = v;
      atomicFs.writeJsonSync(STORE_SESSIONS_FILE, obj, false);
    } catch (e) { console.warn("[sessions] save failed:", e.message); }
  }, 5000);
}

// Clean expired sessions every hour
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  let removed = 0;
  for (const [token, val] of sessions) {
    if ((val.lastActivity || val.createdAt) < cutoff) { sessions.delete(token); removed++; }
  }
  if (removed > 0) _saveStoreSessions();
}, 60 * 60 * 1000);

// ─── Storage helpers ──────────────────────────────────────────────────────────
function readStores() {
  try { return JSON.parse(fs.readFileSync(STORES_FILE, "utf8")); }
  catch { return { stores: [] }; }
}

const atomicFs = require("./atomic-fs");
function writeStores(data) {
  atomicFs.writeJsonSync(STORES_FILE, data);
}

function getStore(id) {
  return readStores().stores.find(s => s.id === id) || null;
}

function updateStore(id, updates) {
  const data = readStores();
  const idx  = data.stores.findIndex(s => s.id === id);
  if (idx === -1) return null;
  data.stores[idx] = { ...data.stores[idx], ...updates, id };
  writeStores(data);
  return data.stores[idx];
}

function readOrders(storeId) {
  const file = storeId === "nakheel_001"
    ? path.join(DATA_DIR, "orders.jsonl")
    : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ─── Auth middleware (sliding TTL — تجدّد عند كل طلب) ───────────────────────
function auth(req, res, next) {
  const token = req.headers["x-store-token"];
  const entry = sessions.get(token);
  if (!token || !entry) return res.status(401).json({ error: "يرجى تسجيل الدخول" });
  const lastSeen = entry.lastActivity || entry.createdAt;
  // impersonation: absolute expiry (لا sliding)
  if (entry.absoluteExpiry && Date.now() > entry.absoluteExpiry) {
    sessions.delete(token);
    _saveStoreSessions();
    return res.status(401).json({ error: "انتهت جلسة الانتحال (30 دقيقة)" });
  }
  if (Date.now() - lastSeen > SESSION_TTL_MS) {
    sessions.delete(token);
    _saveStoreSessions();
    return res.status(401).json({ error: "انتهت الجلسة، يرجى تسجيل الدخول مجدداً" });
  }
  // Sliding renewal فقط للجلسات العادية (لا impersonation)
  if (!entry.absoluteExpiry) {
    entry.lastActivity = Date.now();
    _saveStoreSessions();
  }
  req.storeId = entry.storeId;
  req.impersonatedBy = entry.impersonatedBy || null;
  next();
}

// ─── Login / Logout ───────────────────────────────────────────────────────────
router.post("/store/login", async (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: "رقم الجوال وكلمة المرور مطلوبان" });

  let storeId, storeName, subscriptionStatus;

  // ── Try Firestore first (phone+password check) ───────────────────────────────
  if (firestoreAuth.isReady()) {
    try {
      const result = await firestoreAuth.loginStoreAdmin(phone, password);
      if (result) storeId = result.storeId;
    } catch (e) {
      console.warn("Firestore login error:", e.message);
    }
  }

  // ── Fallback: stores.json (bcrypt مع migration للقديم) ──────────────────────
  if (!storeId) {
    const { stores } = readStores();
    const candidates = stores.filter(s => s.ownerPhone === String(phone).trim());
    for (const s of candidates) {
      if (await verifyStorePassword(s, String(password).trim())) {
        storeId = s.id;
        break;
      }
    }
  }

  if (!storeId) {
    audit({ actor: { type: "store" }, action: "login.fail", ok: false, meta: { phone: String(phone).slice(0, 6) + "***" } }, req);
    return res.status(403).json({ error: "رقم الجوال أو كلمة المرور خاطئة" });
  }

  // ── Always read store data from stores.json (single source of truth) ─────────
  const { stores: allStores } = readStores();
  const storeData = allStores.find(s => s.id === storeId);
  if (!storeData) return res.status(403).json({ error: "المتجر غير موجود" });

  storeName          = storeData.storeName;
  subscriptionStatus = storeData.subscriptionStatus;

  if (subscriptionStatus === "expired" || subscriptionStatus === "suspended") {
    return res.status(403).json({ error: "الاشتراك منتهٍ أو موقوف. تواصل مع مزود الخدمة." });
  }

  // باقة "الأساسية" بدون adminPanel — تتعامل مع البوت فقط
  if (!hasFeature(storeData.plan, "adminPanel")) {
    return res.status(403).json({
      error: "لوحة التحكم غير مفعّلة في باقتك. للاستفادة من الإدارة المتقدمة، رقّ باقتك إلى الاحترافية.",
    });
  }

  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { storeId, createdAt: Date.now(), lastActivity: Date.now() });
  _saveStoreSessions();
  audit({ actor: { type: "store", id: storeId }, action: "login.success" }, req);
  res.json({ ok: true, token, storeId, storeName });
});

router.post("/store/logout", auth, (req, res) => {
  sessions.delete(req.headers["x-store-token"]);
  res.json({ ok: true });
});

// ─── Firebase Auth ────────────────────────────────────────────────────────────
const admin = require('./firebase-admin');

router.post("/store/firebase-login", async (req, res) => {
  const { idToken, storeId: inviteId } = req.body || {};
  if (!idToken) {
    audit({ actor: { type: "store" }, action: "login.fail", ok: false, meta: { reason: "no_id_token", route: "firebase-login" } }, req);
    return res.status(400).json({ error: "Firebase idToken مطلوب" });
  }
  if (!admin.apps.length) {
    return res.status(503).json({ error: "Firebase غير مفعّل على الخادم — استخدم تسجيل الدخول العادي" });
  }

  let uid, email;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid   = decoded.uid;
    email = decoded.email;
  } catch (err) {
    audit({ actor: { type: "store" }, action: "login.fail", ok: false, meta: { reason: "bad_id_token", route: "firebase-login" } }, req);
    console.error("Firebase verify:", err.message);
    return res.status(403).json({ error: "فشل التحقق من الهوية" });
  }

  try {
    const data = readStores();
    let store;

    if (inviteId) {
      const idx = data.stores.findIndex(s => s.id === inviteId && !s.firebaseUid);
      if (idx === -1) return res.status(403).json({ error: "كود الدعوة غير صحيح أو تم استخدامه مسبقاً" });
      data.stores[idx] = { ...data.stores[idx], firebaseUid: uid, ownerEmail: email || data.stores[idx].ownerEmail };
      writeStores(data);
      store = data.stores[idx];
    } else {
      store = data.stores.find(s => s.firebaseUid === uid);
      if (!store) return res.status(403).json({ error: "لا يوجد متجر مرتبط بهذا الحساب — سجّل أولاً" });
    }

    if (store.subscriptionStatus === "expired" || store.subscriptionStatus === "suspended") {
      return res.status(403).json({ error: "الاشتراك منتهٍ أو موقوف، تواصل مع مزود الخدمة" });
    }

    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { storeId: store.id, createdAt: Date.now(), lastActivity: Date.now() });
      _saveStoreSessions();
    res.json({ ok: true, token, storeId: store.id, storeName: store.storeName });
  } catch (err) {
    console.error("firebase-login error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// ─── Profile ──────────────────────────────────────────────────────────────────
router.get("/store/profile", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const { token, storePassword, ...safe } = store;
  res.json({ store: safe });
});

// ─── Plan ─────────────────────────────────────────────────────────────────────
router.get("/store/plan", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const plan = getPlan(store.plan);
  res.json({ plan: plan.id, nameAr: plan.nameAr, emoji: plan.emoji, features: plan.features });
});

// ─── Preview Order Page (admin → generates short link to /o/:slug) ───────────
router.get("/store/preview-order-link", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const products = (store.products || []).filter(p => p.available !== false);
  if (!products.length) {
    // مصطلح ديناميكي حسب نوع النشاط
    const itemTerm = store.adminConfig?.terms?.item || "منتج";
    return res.status(400).json({ error: `أضف ${itemTerm} واحداً على الأقل لمعاينة صفحة الطلب` });
  }
  // from="preview_admin" — لا يُرسل لأي عميل، فقط للمعاينة
  const waMgr = require("./whatsapp-manager");
  const slug  = waMgr.createWebOrderToken(req.storeId, "preview_admin");
  const base  = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
  res.json({ url: `${base}/${slug}`, slug, ttlMinutes: 15 });
});

// ─── Short-lived edit tokens — صلاحية 10 دقائق، تُستبدل بـ session token ─────
// editToken → { storeId, exp }
const editTokens = new Map();
const EDIT_TOKEN_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of editTokens) if (v.exp < now) editTokens.delete(k);
}, 60_000).unref?.();

// GET /store/edit-mode-link — يُولّد edit-token قصير، لا x-store-token في URL
router.get("/store/edit-mode-link", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const editToken = crypto.randomBytes(16).toString("hex");
  editTokens.set(editToken, { storeId: req.storeId, exp: Date.now() + EDIT_TOKEN_TTL_MS });
  const base = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
  // الـ URL يحوي edit-token قصير الأمد فقط — لا session token
  res.json({
    url: `${base}/preview-edit.html?storeId=${encodeURIComponent(req.storeId)}&edit=${editToken}`,
    ttlMinutes: 10,
  });
});

// POST /store/exchange-edit-token — تبادل edit-token مع session token كامل
// الواجهة preview-edit.html تستدعيها عند التحميل
router.post("/store/exchange-edit-token", (req, res) => {
  const { editToken } = req.body || {};
  if (!editToken || typeof editToken !== "string") return res.status(400).json({ error: "edit token مفقود" });
  const entry = editTokens.get(editToken);
  if (!entry || entry.exp < Date.now()) {
    editTokens.delete(editToken);
    return res.status(410).json({ error: "انتهت صلاحية رابط التعديل" });
  }
  // one-time use
  editTokens.delete(editToken);

  // أنشئ session token صحيح
  const sessionToken = crypto.randomBytes(32).toString("hex");
  sessions.set(sessionToken, { storeId: entry.storeId, createdAt: Date.now(), lastActivity: Date.now() });
  _saveStoreSessions();
  res.json({ ok: true, token: sessionToken, storeId: entry.storeId });
});

// PATCH /store/products/:id/inline — تعديل سريع لحقل واحد (لـ inline editing)
router.patch("/store/products/:id/inline", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const { field, value } = req.body || {};
  const ALLOWED = ["name", "price", "description"];
  if (!ALLOWED.includes(field)) return res.status(400).json({ error: "حقل غير مسموح" });

  // تحقق من وجود المنتج قبل التعديل
  const products = store.products || [];
  const exists = products.some(p => p.id === req.params.id);
  if (!exists) return res.status(404).json({ error: "المنتج غير موجود" });

  let cleanValue = value;
  if (field === "price") {
    cleanValue = parseFloat(value);
    if (!Number.isFinite(cleanValue) || cleanValue < 0) return res.status(400).json({ error: "سعر غير صالح" });
    if (cleanValue > 1_000_000) return res.status(400).json({ error: "السعر مرتفع جداً" });
  } else {
    cleanValue = String(value || "").trim().slice(0, 500);
    if (!cleanValue && field === "name") return res.status(400).json({ error: "الاسم مطلوب" });
  }
  const updated = products.map(p =>
    p.id === req.params.id ? { ...p, [field]: cleanValue } : p
  );
  updateStore(req.storeId, { products: updated });
  res.json({ ok: true, [field]: cleanValue });
});

// ─── Stats — يستثني طلبات الاختبار + يحسب الإيرادات من الـ confirmed فقط ─────
router.get("/store/stats", auth, (req, res) => {
  const allOrders = readOrders(req.storeId);
  // استثني _test orders من كل الإحصاءات
  const orders = allOrders.filter(o => !o._test);
  const today  = new Date().toISOString().slice(0, 10);
  const todayOr = orders.filter(o => (o.timestamp || "").slice(0, 10) === today);

  // الإيرادات تُحسَب فقط من المُكدّة/المؤكدة (يستثني rejected/cancelled/pending)
  const earningStatuses = new Set(["confirmed", "completed", "delivered", "done"]);
  const earnedOrders   = orders.filter(o => earningStatuses.has(o.status));
  const earnedToday    = todayOr.filter(o => earningStatuses.has(o.status));

  const productCounts = {};
  for (const o of earnedOrders) {
    for (const item of (o.items || [])) {
      productCounts[item.name] = (productCounts[item.name] || 0) + (item.qty || 1);
    }
  }
  const topProducts = Object.entries(productCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([name, qty]) => ({ name, qty }));

  res.json({
    ordersTotal:  orders.length,
    ordersToday:  todayOr.length,
    revenueTotal: parseFloat(earnedOrders.reduce((s, o) => s + (o.total || 0), 0).toFixed(2)),
    revenueToday: parseFloat(earnedToday.reduce((s, o) => s + (o.total || 0), 0).toFixed(2)),
    pending:      orders.filter(o => o.status === "pending_confirmation").length,
    topProducts,
  });
});

// ─── Store Settings — مع validation للقيم ─────────────────────────────────────
const SETTING_VALIDATORS = {
  storeName:          v => String(v || "").trim().slice(0, 100),
  currency:           v => String(v || "ر.س").trim().slice(0, 10),
  deliveryFee:        v => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 && n < 10000 ? n : null; },
  workingHoursStart:  v => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 && n <= 24 ? n : null; },
  workingHoursEnd:    v => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 && n <= 24 ? n : null; },
  welcomeMessage:     v => String(v || "").slice(0, 2000),
  invoiceColor:       v => /^#[0-9a-f]{3,8}$/i.test(String(v || "")) ? v : null,
  themeAccent:        v => /^(#[0-9a-f]{3,8}|var\(--[a-z0-9-]+\)|rgba?\([^)]+\))$/i.test(String(v || "")) ? v : null,
  themeText:          v => /^(#[0-9a-f]{3,8}|var\(--[a-z0-9-]+\))$/i.test(String(v || "")) ? v : null,
  themeTextMute:      v => /^(#[0-9a-f]{3,8}|var\(--[a-z0-9-]+\))$/i.test(String(v || "")) ? v : null,
  menuMode:           v => v === "dark" || v === "light" ? v : null,
  invoiceTemplate:    v => ["classic","minimal","bold","elegant"].includes(v) ? v : null,
  businessType:       v => String(v || "").trim().slice(0, 50),
  invoiceLogoUrl:     v => { try { new URL(v); return String(v).slice(0, 500); } catch { return v === "" ? "" : null; } },
  logoUrl:            v => { try { new URL(v); return String(v).slice(0, 500); } catch { return v === "" ? "" : null; } },
  address:            v => String(v || "").trim().slice(0, 300),
  locationMapUrl:     v => { try { new URL(v); return String(v).slice(0, 500); } catch { return v === "" ? "" : null; } },
  requireConfirmation: v => v === true || v === "true" || v === 1,
  enableWebview:      v => v !== false && v !== "false",
  enableNumeric:      v => v !== false && v !== "false",
  enableAI:           v => v !== false && v !== "false",
  enableCoupons:      v => v !== false && v !== "false",
};

router.put("/store/settings", auth, (req, res) => {
  const updates = {};
  const errors = [];
  for (const [key, validator] of Object.entries(SETTING_VALIDATORS)) {
    if (req.body[key] === undefined) continue;
    const cleaned = validator(req.body[key]);
    if (cleaned === null) {
      errors.push(key);
    } else {
      updates[key] = cleaned;
    }
  }
  if (errors.length) {
    return res.status(400).json({ error: "قيم غير صحيحة في: " + errors.join(", ") });
  }
  const updated = updateStore(req.storeId, updates);
  if (!updated) return res.status(404).json({ error: "المتجر غير موجود" });
  res.json({ ok: true });
});

// ─── Products ─────────────────────────────────────────────────────────────────
router.get("/store/products", auth, (req, res) => {
  const store = getStore(req.storeId);
  res.json({ products: store?.products || [], categories: store?.categories || [] });
});

router.post("/store/products", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  // sizes: مصفوفة اختيارية من { label, price }
  const cleanSizes = Array.isArray(req.body.sizes)
    ? req.body.sizes
        .map(s => ({ label: String(s?.label || "").trim(), price: Number(s?.price) || 0 }))
        .filter(s => s.label && s.price > 0)
    : [];

  // المخزون: null = لا محدود؛ عدد ≥ 0 = محدود
  let cleanStock = null;
  if (req.body.stock !== undefined && req.body.stock !== null) {
    const n = parseInt(req.body.stock, 10);
    cleanStock = Number.isFinite(n) && n >= 0 ? n : 0;
  }

  // معالجة الصور: ندعم images[] الجديد + imageUrl القديم (backward compat)
  // النتيجة: images = array of URLs، imageUrl = الأولى (للتوافق مع الكود القديم)
  const cleanImages = Array.isArray(req.body.images)
    ? req.body.images
        .map(img => typeof img === "string" ? img : (img?.url || ""))
        .filter(u => u && u.length < 1000)
        .slice(0, 10) // حد أقصى 10 صور لكل منتج
    : req.body.imageUrl
      ? [req.body.imageUrl]
      : [];

  const product = {
    id:            "p_" + Date.now(),
    category:      req.body.category || "",
    subCategoryId: String(req.body.subCategoryId || "").trim(),
    name:          (req.body.name || "").trim(),
    description:   (req.body.description || "").trim(),
    price:         parseFloat(req.body.price) || 0,
    images:        cleanImages,                          // ⭐ جديد: array
    imageUrl:      cleanImages[0] || null,               // backward compat (الصورة الرئيسية)
    videoUrl:      sanitizeVideoUrl(req.body.videoUrl),
    videoCaption:  String(req.body.videoCaption || "").trim().slice(0, 200),
    available:     true,
    sizes:         cleanSizes,
    stock:         cleanStock,
    customFields:  (req.body.customFields && typeof req.body.customFields === "object") ? req.body.customFields : {},
  };

  if (!product.name) return res.status(400).json({ error: "اسم المنتج مطلوب" });

  const products = [...(store.products || []), product];
  updateStore(req.storeId, { products });
  res.json({ ok: true, product });
});

router.put("/store/products/:id", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const found = (store.products || []).find(p => p.id === req.params.id);
  if (!found) return res.status(404).json({ error: "المنتج غير موجود" });

  // sanitize sizes و stock والتصنيفات إذا أُرسلت
  const patch = { ...req.body };
  // إزالة الحقول القديمة (mainCategory/subCategory) إن أرسلتها واجهة قديمة
  delete patch.mainCategory;
  delete patch.subCategory;
  if (patch.subCategoryId !== undefined) patch.subCategoryId = String(patch.subCategoryId || "").trim();
  if (patch.customFields !== undefined && typeof patch.customFields !== "object") delete patch.customFields;
  if (Array.isArray(patch.sizes)) {
    patch.sizes = patch.sizes
      .map(s => ({ label: String(s?.label || "").trim(), price: Number(s?.price) || 0 }))
      .filter(s => s.label && s.price > 0);
  }
  if (patch.stock !== undefined) {
    if (patch.stock === null) {
      patch.stock = null; // لا محدود
    } else {
      const n = parseInt(patch.stock, 10);
      patch.stock = Number.isFinite(n) && n >= 0 ? n : 0;
    }
  }
  if (patch.videoUrl !== undefined)     patch.videoUrl = sanitizeVideoUrl(patch.videoUrl);
  if (patch.videoCaption !== undefined) patch.videoCaption = String(patch.videoCaption || "").trim().slice(0, 200);

  // ⭐ معالجة الصور المتعددة عند التحديث
  if (patch.images !== undefined) {
    patch.images = Array.isArray(patch.images)
      ? patch.images
          .map(img => typeof img === "string" ? img : (img?.url || ""))
          .filter(u => u && u.length < 1000)
          .slice(0, 10)
      : [];
    // sync imageUrl للـ backward compat (الصورة الأولى = المعروضة في الكود القديم)
    patch.imageUrl = patch.images[0] || null;
  } else if (patch.imageUrl !== undefined && !Array.isArray(found.images)) {
    // لو الكود القديم بعت imageUrl فقط، حافظ على images = [imageUrl]
    patch.images = patch.imageUrl ? [patch.imageUrl] : [];
  }

  const products = (store.products || []).map(p =>
    p.id === req.params.id ? { ...p, ...patch, id: p.id } : p
  );
  updateStore(req.storeId, { products });
  res.json({ ok: true });
});

// ── Helper: sanitize video URL (allow YouTube, Vimeo, direct mp4, Drive) ──────
function sanitizeVideoUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    // basic length cap
    if (s.length > 500) return null;
    return s;
  } catch { return null; }
}

router.delete("/store/products/:id", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const products = (store.products || []).filter(p => p.id !== req.params.id);
  updateStore(req.storeId, { products });
  res.json({ ok: true });
});

// ─── Categories ───────────────────────────────────────────────────────────────
router.post("/store/categories", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const cat = {
    id: "cat_" + Date.now(),
    name:  String(req.body.name  || "").trim().slice(0, 60),
    emoji: String(req.body.emoji || "🍽️").trim().slice(0, 8),
  };
  if (!cat.name) return res.status(400).json({ error: "اسم الصنف مطلوب" });
  const categories = [...(store.categories || []), cat];
  updateStore(req.storeId, { categories });
  res.json({ ok: true, category: cat });
});

// PUT /store/categories/:id — تعديل اسم/إيموجي الصنف
router.put("/store/categories/:id", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const categories = store.categories || [];
  const idx = categories.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "الصنف غير موجود" });

  const patch = {};
  if (req.body.name  !== undefined) patch.name  = String(req.body.name  || "").trim().slice(0, 60);
  if (req.body.emoji !== undefined) patch.emoji = String(req.body.emoji || "").trim().slice(0, 8);
  if (patch.name === "") return res.status(400).json({ error: "اسم الصنف لا يمكن أن يكون فارغاً" });

  categories[idx] = { ...categories[idx], ...patch };
  updateStore(req.storeId, { categories });
  res.json({ ok: true, category: categories[idx] });
});

// DELETE /store/categories/:id — مع خيار للمنتجات
// query/body: action = "delete" (default) | "orphan" | "move"
// لو "move": targetCategoryId مطلوب
router.delete("/store/categories/:id", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const targetId = req.params.id;
  const action   = String(req.query.action || req.body?.action || "orphan").toLowerCase();
  const moveTo   = String(req.query.moveTo || req.body?.moveTo || "").trim();

  const categories = (store.categories || []).filter(c => c.id !== targetId);
  let products = store.products || [];
  const affected = products.filter(p => p.category === targetId);

  if (action === "delete") {
    // احذف كل المنتجات في هذا الصنف
    products = products.filter(p => p.category !== targetId);
  } else if (action === "move") {
    if (!moveTo) return res.status(400).json({ error: "موكان النقل (moveTo) مطلوب" });
    const targetExists = (store.categories || []).some(c => c.id === moveTo);
    if (!targetExists) return res.status(400).json({ error: "الصنف الهدف غير موجود" });
    products = products.map(p =>
      p.category === targetId ? { ...p, category: moveTo, subCategoryId: "" } : p
    );
  } else {
    // orphan (default): اترك المنتجات بدون صنف (category = "")
    products = products.map(p =>
      p.category === targetId ? { ...p, category: "", subCategoryId: "" } : p
    );
  }

  updateStore(req.storeId, { categories, products });
  res.json({
    ok: true,
    action,
    affectedProducts: affected.length,
    totalProducts: products.length,
  });
});

// ─── Store change password (with bcrypt) ─────────────────────────────────────
// GET /store/admin-config — جلب الـ AI-generated config + معلومات النشاط
router.get("/store/admin-config", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  res.json({
    storeType:   store.storeType || store.businessType || "",
    adminConfig: store.adminConfig || null,
  });
});

router.put("/store/password", auth, async (req, res) => {
  const { current, newPassword } = req.body || {};
  if (!current || !newPassword) return res.status(400).json({ error: "كلمتا المرور مطلوبتان" });
  if (String(newPassword).length < 6) return res.status(400).json({ error: "كلمة المرور الجديدة يجب أن تكون 6 أحرف فأكثر" });
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const ok = await verifyStorePassword(store, String(current));
  if (!ok) return res.status(403).json({ error: "كلمة المرور الحالية غير صحيحة" });
  try {
    const hash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
    updateStore(req.storeId, { storePassword: hash });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "فشل التحديث: " + e.message });
  }
});

// ─── Sub-Categories (تحت كل قسم رئيسي) ───────────────────────────────────────
router.post("/store/categories/:catId/sub", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const name  = String(req.body.name || "").trim();
  const emoji = String(req.body.emoji || "").trim();
  const active = req.body.active === false ? false : true;
  if (!name) return res.status(400).json({ error: "اسم الصنف الفرعي مطلوب" });

  const sub = { id: "sub_" + Date.now(), name, emoji, active };
  const categories = (store.categories || []).map(c => {
    if (c.id !== req.params.catId) return c;
    const subs = Array.isArray(c.subCategories) ? c.subCategories : [];
    return { ...c, subCategories: [...subs, sub] };
  });
  if (!categories.find(c => c.id === req.params.catId)) {
    return res.status(404).json({ error: "القسم الرئيسي غير موجود" });
  }
  updateStore(req.storeId, { categories });
  res.json({ ok: true, sub });
});

router.put("/store/categories/:catId/sub/:subId", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const patch = {};
  if (req.body.name   !== undefined) patch.name   = String(req.body.name   || "").trim();
  if (req.body.emoji  !== undefined) patch.emoji  = String(req.body.emoji  || "").trim();
  if (req.body.active !== undefined) patch.active = req.body.active === false ? false : true;

  let found = false;
  const categories = (store.categories || []).map(c => {
    if (c.id !== req.params.catId) return c;
    const subs = (c.subCategories || []).map(s => {
      if (s.id !== req.params.subId) return s;
      found = true;
      return { ...s, ...patch };
    });
    return { ...c, subCategories: subs };
  });
  if (!found) return res.status(404).json({ error: "الصنف الفرعي غير موجود" });
  updateStore(req.storeId, { categories });
  res.json({ ok: true });
});

router.delete("/store/categories/:catId/sub/:subId", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const categories = (store.categories || []).map(c => {
    if (c.id !== req.params.catId) return c;
    return { ...c, subCategories: (c.subCategories || []).filter(s => s.id !== req.params.subId) };
  });
  // أيضاً: امسح subCategoryId من المنتجات المرتبطة
  const products = (store.products || []).map(p =>
    p.subCategoryId === req.params.subId ? { ...p, subCategoryId: "" } : p
  );
  updateStore(req.storeId, { categories, products });
  res.json({ ok: true });
});

// ─── Loyalty Settings (per-store) ─────────────────────────────────────────────
router.get("/store/loyalty-settings", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  res.json({ settings: loyalty.getSettings(store) });
});

router.put("/store/loyalty-settings", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const body = req.body || {};
  const settings = {
    enabled:           body.enabled !== false,
    spendPerPoint:     Math.max(1, parseFloat(body.spendPerPoint)     || 10),
    pointsForDiscount: Math.max(1, parseInt(body.pointsForDiscount, 10) || 100),
    discountValue:     Math.max(0.5, parseFloat(body.discountValue)     || 10),
  };
  updateStore(req.storeId, { loyaltySettings: settings });
  res.json({ ok: true, settings });
});

// ─── Loyalty / Points Management ─────────────────────────────────────────────
router.get("/store/loyalty", auth, (req, res) => {
  const customersModule = require("./customers");
  const couponsModule   = require("./coupons");
  const list = loyalty.listCustomers(req.storeId);
  // اجمع عملاء هذا المتجر فقط (per-store، لا تسرّب)
  let registry = {};
  try { registry = customersModule.getCustomers(req.storeId).reduce((m, c) => { m[c.phone] = c; return m; }, {}); } catch {}
  const known = new Set(list.map(c => c.phone));
  Object.keys(registry).forEach(ph => {
    if (!known.has(ph)) {
      list.push({ phone: ph, points: 0, totalOrders: registry[ph].ordersCount || 0, totalSpent: registry[ph].totalSpend || 0, lastDate: null });
    }
  });
  // دمج بيانات العميل (اسم، موقع، VIP)
  const allCoupons = (typeof couponsModule.listCoupons === "function") ? couponsModule.listCoupons(req.storeId) : [];
  const enriched = list.map(c => {
    const reg = registry[c.phone] || {};
    const couponsForPhone = allCoupons.filter(co =>
      co.phoneRestriction === c.phone ||
      (Array.isArray(co.usedBy) && co.usedBy.includes(c.phone))
    );
    return {
      ...c,
      name:        reg.name || "",
      location:    reg.location || "",
      isVip:       !!reg.isVip,
      firstOrder:  reg.firstOrder || null,
      lastOrder:   reg.lastOrder || null,
      couponsCount: couponsForPhone.length,
    };
  });
  res.json({ customers: enriched });
});

router.get("/store/loyalty/:phone", auth, (req, res) => {
  const customersModule = require("./customers");
  const couponsModule   = require("./coupons");
  const phone = req.params.phone;
  const detail = loyalty.getCustomerDetail(req.storeId, phone) || {
    phone, points: 0, totalOrders: 0, totalSpent: 0, history: [],
  };
  let reg = null;
  try { reg = (customersModule.getCustomers(req.storeId) || []).find(c => c.phone === phone) || null; } catch {}
  const allCoupons = (typeof couponsModule.listCoupons === "function") ? couponsModule.listCoupons(req.storeId) : [];
  const coupons = allCoupons.filter(co =>
    co.phoneRestriction === phone ||
    (Array.isArray(co.usedBy) && co.usedBy.includes(phone))
  ).map(co => ({
    code:           co.code,
    type:           co.type,
    value:          co.value,
    discount:       co.discount,
    isPercent:      co.isPercent,
    used:           Array.isArray(co.usedBy) && co.usedBy.includes(phone),
    forThisPhone:   co.phoneRestriction === phone,
    expiresAt:      co.expiresAt,
    active:         co.active,
    createdAt:      co.createdAt,
  }));
  res.json({
    ...detail,
    name:       reg?.name || "",
    location:   reg?.location || "",
    isVip:      !!reg?.isVip,
    firstOrder: reg?.firstOrder || null,
    lastOrder:  reg?.lastOrder || null,
    coupons,
  });
});

router.post("/store/loyalty/:phone/adjust", auth, (req, res) => {
  const delta  = parseInt(req.body.delta, 10);
  const reason = String(req.body.reason || "").trim();
  if (!Number.isFinite(delta) || delta === 0) {
    return res.status(400).json({ error: "قيمة التعديل مطلوبة (موجبة أو سالبة)" });
  }
  const result = loyalty.adjustPoints(req.storeId, req.params.phone, delta, reason);
  if (!result) return res.status(400).json({ error: "تعذّر التعديل" });
  res.json({ ok: true, ...result });
});

// ─── Coupons CRUD (per-store) ────────────────────────────────────────────────
router.get("/store/coupons", auth, (req, res) => {
  const list = (typeof couponsMod.listCoupons === "function")
    ? couponsMod.listCoupons(req.storeId).filter(c => c.storeId === req.storeId)
    : [];
  const store = getStore(req.storeId);
  res.json({ coupons: list, enableCoupons: store?.enableCoupons !== false });
});

router.post("/store/coupons", auth, (req, res) => {
  const b = req.body || {};
  const code = String(b.code || "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) {
    return res.status(400).json({ error: "الكود يجب أن يكون حروف وأرقام إنجليزية فقط (2-20 حرف)" });
  }
  const type  = (b.type === "percent") ? "percent" : "fixed";
  const value = parseFloat(b.value);
  if (!Number.isFinite(value) || value <= 0) {
    return res.status(400).json({ error: "قيمة الخصم مطلوبة" });
  }
  // تأكد من عدم تكرار الكود في نفس المتجر
  const existing = couponsMod.listCoupons(req.storeId).find(c => c.code === code && c.storeId === req.storeId);
  if (existing) return res.status(400).json({ error: "هذا الكود موجود بالفعل في متجرك" });

  const coupon = couponsMod.createCoupon({
    code, type, value,
    storeId:        req.storeId,
    minOrder:       parseFloat(b.minOrder) || 0,
    maxUses:        b.maxUses ? parseInt(b.maxUses, 10) : null,
    expiresAt:      b.expiresAt || null,
    onePerCustomer: !!b.onePerCustomer,
  });
  // active يأخذ القيمة المُرسلة
  if (b.active === false) {
    const fs = require("fs");
    const path = require("path");
    const f = path.join(__dirname, "..", "data", "coupons.json");
    try {
      const data = JSON.parse(fs.readFileSync(f, "utf8"));
      const idx  = data.coupons.findIndex(c => c.code === code && c.storeId === req.storeId);
      if (idx >= 0) { data.coupons[idx].active = false; fs.writeFileSync(f, JSON.stringify(data, null, 2)); }
    } catch {}
  }
  res.json({ ok: true, coupon });
});

router.put("/store/coupons/:code", auth, (req, res) => {
  const fs = require("fs");
  const path = require("path");
  const f = path.join(__dirname, "..", "data", "coupons.json");
  let data;
  try { data = JSON.parse(fs.readFileSync(f, "utf8")); }
  catch { return res.status(500).json({ error: "تعذّر قراءة الكوبونات" }); }
  const idx = data.coupons.findIndex(c => c.code.toUpperCase() === String(req.params.code).toUpperCase() && c.storeId === req.storeId);
  if (idx < 0) return res.status(404).json({ error: "الكوبون غير موجود" });

  const b = req.body || {};
  const patch = {};
  if (b.type !== undefined)            patch.type     = b.type === "percent" ? "percent" : "fixed";
  if (b.value !== undefined)           patch.value    = parseFloat(b.value) || 0;
  if (b.minOrder !== undefined)        patch.minOrder = parseFloat(b.minOrder) || 0;
  if (b.maxUses !== undefined)         patch.maxUses  = b.maxUses ? parseInt(b.maxUses, 10) : null;
  if (b.expiresAt !== undefined)       patch.expiresAt = b.expiresAt || null;
  if (b.onePerCustomer !== undefined)  patch.onePerCustomer = !!b.onePerCustomer;
  if (b.active !== undefined)          patch.active   = !!b.active;
  data.coupons[idx] = { ...data.coupons[idx], ...patch };
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
  res.json({ ok: true, coupon: data.coupons[idx] });
});

router.delete("/store/coupons/:code", auth, (req, res) => {
  const fs = require("fs");
  const path = require("path");
  const f = path.join(__dirname, "..", "data", "coupons.json");
  try {
    const data = JSON.parse(fs.readFileSync(f, "utf8"));
    const before = data.coupons.length;
    data.coupons = data.coupons.filter(c => !(c.code.toUpperCase() === String(req.params.code).toUpperCase() && c.storeId === req.storeId));
    if (data.coupons.length === before) return res.status(404).json({ error: "الكوبون غير موجود" });
    fs.writeFileSync(f, JSON.stringify(data, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "تعذّر الحذف: " + e.message }); }
});

router.post("/store/loyalty/:phone/coupon", auth, (req, res) => {
  // كوبون خصم خاص برقم محدد
  const couponsModule = require("./coupons");
  const value = parseFloat(req.body.discount);
  const isPercent = req.body.isPercent === true || req.body.isPercent === "true";
  const expiresInDays = parseInt(req.body.expiresInDays || 30, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return res.status(400).json({ error: "قيمة الخصم مطلوبة" });
  }
  try {
    // crypto-safe random code — 8 char base36 من 24 bits randomness
    const code = "VIP" + crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
    const expiresAt = new Date(Date.now() + expiresInDays*24*60*60*1000).toISOString();
    const coupon = couponsModule.createCoupon({
      code,
      type: isPercent ? "percent" : "fixed",
      value,
      storeId: req.storeId,
      maxUses: 1,
      expiresAt,
      onePerCustomer: true,
    });
    // أضف phoneRestriction يدوياً (للحقل المتاح لـ loyalty endpoint للفلترة)
    try {
      const fs = require("fs");
      const path = require("path");
      const f = path.join(__dirname, "..", "data", "coupons.json");
      const data = JSON.parse(fs.readFileSync(f, "utf8"));
      const idx = data.coupons.findIndex(c => c.code === code);
      if (idx >= 0) {
        data.coupons[idx].phoneRestriction = req.params.phone;
        fs.writeFileSync(f, JSON.stringify(data, null, 2));
      }
    } catch {}
    res.json({ ok: true, coupon: { ...coupon, phoneRestriction: req.params.phone } });
  } catch (e) {
    res.status(500).json({ error: "تعذّر إنشاء الكوبون: " + e.message });
  }
});

// ─── Video Upload (from device gallery) — with magic-byte verification ───────
const { decodeAndVerifyBase64, sanitizeStoreIdForFilename } = require("./upload-safety");

router.post("/store/upload-video", auth, (req, res) => {
  const { base64, ext = "mp4" } = req.body || {};
  if (!base64) return res.status(400).json({ error: "لا يوجد فيديو" });

  const safeStoreId = sanitizeStoreIdForFilename(req.storeId);
  if (!safeStoreId) return res.status(400).json({ error: "معرّف المتجر غير صالح" });

  const r = decodeAndVerifyBase64(base64, ext, 50 * 1024 * 1024, "video");
  if (!r.ok) return res.status(400).json({ error: r.error });

  const filename  = `${safeStoreId}_${Date.now()}.${r.ext}`;
  const videosDir = path.join(DATA_DIR, "videos");
  const filepath  = path.join(videosDir, filename);

  try {
    fs.mkdirSync(videosDir, { recursive: true });
    const resolved = path.resolve(filepath);
    if (!resolved.startsWith(path.resolve(videosDir) + path.sep)) {
      return res.status(400).json({ error: "مسار غير مسموح" });
    }
    fs.writeFileSync(filepath, r.buffer);
    res.json({ ok: true, url: `/store-videos/${filename}`, size: r.buffer.length });
  } catch (err) {
    console.error("Video upload error:", err.message);
    res.status(500).json({ error: "فشل رفع الفيديو" });
  }
});

// optional: delete a previously uploaded video file
router.delete("/store/upload-video", auth, (req, res) => {
  const url = String(req.query.url || "").trim();
  const m = url.match(/^\/store-videos\/([\w\-]+\.(mp4|webm|mov|m4v))$/);
  if (!m) return res.status(400).json({ error: "رابط الفيديو غير صحيح" });
  const filename = m[1];
  // الملف يبدأ بـ storeId — تأمين العزل
  if (!filename.startsWith(req.storeId + "_")) return res.status(403).json({ error: "لا يمكن حذف فيديو متجر آخر" });
  const filepath = path.join(DATA_DIR, "videos", filename);
  try {
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "فشل الحذف" });
  }
});

// ─── Image Upload — magic-byte verification ──────────────────────────────────
router.post("/store/upload-image", auth, (req, res) => {
  const { base64, ext = "jpg" } = req.body || {};
  if (!base64) return res.status(400).json({ error: "لا توجد صورة" });

  const safeStoreId = sanitizeStoreIdForFilename(req.storeId);
  if (!safeStoreId) return res.status(400).json({ error: "معرّف المتجر غير صالح" });

  const r = decodeAndVerifyBase64(base64, ext, 3 * 1024 * 1024, "image");
  if (!r.ok) return res.status(400).json({ error: r.error });

  const filename  = `${safeStoreId}_${Date.now()}.${r.ext}`;
  const imagesDir = path.join(DATA_DIR, "images");
  const filepath  = path.join(imagesDir, filename);

  try {
    fs.mkdirSync(imagesDir, { recursive: true });
    const resolved = path.resolve(filepath);
    if (!resolved.startsWith(path.resolve(imagesDir) + path.sep)) {
      return res.status(400).json({ error: "مسار غير مسموح" });
    }
    fs.writeFileSync(filepath, r.buffer);
    res.json({ ok: true, url: `/store-images/${filename}` });
  } catch (err) {
    console.error("Upload error:", err.message);
    res.status(500).json({ error: "فشل رفع الصورة" });
  }
});

function updateOrderStatus(storeId, orderId, status, extraMeta) {
  const file = storeId === "nakheel_001"
    ? path.join(DATA_DIR, "orders.jsonl")
    : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
  if (!fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const stamp = new Date().toISOString();
  const updated = lines.map(l => {
    try {
      const obj = JSON.parse(l);
      if (obj.orderId === orderId) {
        obj.status = status;
        obj.statusUpdatedAt = stamp;
        if (status === "completed" || status === "delivered" || status === "done") obj.deliveredAt = obj.deliveredAt || stamp;
        if (status === "rejected")  obj.rejectedAt  = stamp;
        if (status === "cancelled") obj.cancelledAt = stamp;
        if (extraMeta && typeof extraMeta === "object") Object.assign(obj, extraMeta);
      }
      return JSON.stringify(obj);
    } catch { return l; }
  });
  fs.writeFileSync(file, updated.join("\n") + "\n", "utf8");
  return true;
}

// ─── Notifications polling — للستور (طلبات جديدة بعد timestamp معين) ─────────
router.get("/store/notifications", auth, (req, res) => {
  const sinceTs = parseInt(req.query.since) || 0;
  const orders = readOrders(req.storeId);
  const notif = [];
  for (const o of orders) {
    if (o._test) continue;
    if (o.status !== "pending_confirmation") continue;
    const ts = new Date(o.timestamp || 0).getTime();
    if (ts > sinceTs) {
      notif.push({
        kind: "new_order",
        id: o.orderId,
        title: "طلب جديد بانتظار التأكيد",
        body: `${o.customerName || o.customerPhone || "عميل"} — ${o.total} ${o.currency || "ر.س"}`,
        ts,
        link: "#orders",
      });
    }
  }
  res.json({ notifications: notif, serverTime: Date.now() });
});

// ─── Orders ───────────────────────────────────────────────────────────────────
router.get("/store/orders", auth, (req, res) => {
  const orders = readOrders(req.storeId);
  orders.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  res.json({ orders: orders.slice(0, parseInt(req.query.limit) || 100) });
});

// POST /store/orders/test — أنشئ طلب اختباري في status pending_confirmation
router.post("/store/orders/test", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const products = (store.products || []).filter(p => p.available !== false);
  if (!products.length) return res.status(400).json({ error: "أضف منتجاً واحداً أولاً" });

  const product = products[0];
  const orderId = "TEST-" + Date.now().toString(36).toUpperCase();
  const fs   = require("fs");
  const path = require("path");
  const file = path.join(__dirname, "..", "data", `orders_${req.storeId}.jsonl`);
  const order = {
    timestamp: new Date().toISOString(),
    storeId:    req.storeId,
    orderId,
    customerName:  "عميل اختبار",
    customerPhone: "999999999",
    customerLocation: "موقع اختبار — انقر هنا للحذف",
    items: [{ id: product.id, name: product.name, price: product.price, qty: 1 }],
    subtotal:    product.price,
    deliveryFee: 0,
    total:       product.price,
    currency:    store.currency || "ر.س",
    date:        new Date().toISOString().slice(0, 10),
    status:      "pending_confirmation",
    _test:       true,
  };
  fs.appendFileSync(file, JSON.stringify(order) + "\n", "utf8");
  res.json({ ok: true, orderId, message: "طلب اختبار أُنشئ — افتح tab الطلبات" });
});

// POST /store/orders/:orderId/status — تحديث حالة عام (يدعم workflow ديناميكي حسب AI)
// مثال: confirmed → preparing → out_for_delivery → completed
router.post("/store/orders/:orderId/status", auth, async (req, res) => {
  const { orderId } = req.params;
  const { status, customMessage } = req.body || {};
  const ALLOWED = ["preparing","out_for_delivery","ready_pickup","in_progress","awaiting_review"];
  if (!ALLOWED.includes(status)) return res.status(400).json({ error: "حالة غير مسموحة" });

  const orders = readOrders(req.storeId);
  const order  = orders.find(o => o.orderId === orderId);
  if (!order) return res.status(404).json({ error: "الطلب غير موجود" });

  updateOrderStatus(req.storeId, orderId, status);

  const store = getStore(req.storeId);
  const storeName = store?.storeName || "المتجر";
  // رسائل افتراضية حسب الـ status
  const MESSAGES = {
    preparing:        `👨‍🍳 *جاري تحضير طلبك الآن*\n\nسنخبرك بمجرد جاهزيته 🚀`,
    out_for_delivery: `🚴 *المندوب في الطريق إليك*\n\nاستعد لاستلام طلبك من *${storeName}* 📍`,
    ready_pickup:     `✅ *طلبك جاهز للاستلام*\n\nيمكنك الحضور لـ *${storeName}* لاستلامه 🏪`,
    in_progress:      `⚙️ *العمل على مشروعك بدأ*\n\nسنبقيك على اطلاع بأي تطور 📊`,
    awaiting_review:  `📋 *طلبك جاهز للمراجعة*\n\nراجع التسليم وأخبرنا برأيك ✨`,
  };
  const msg = customMessage || MESSAGES[status] || `📦 *تحديث طلبك:* ${status}`;
  if (order.customerPhone && order.customerPhone !== "999999999") {
    try { await waMgr.sendMessage(req.storeId, order.customerPhone, msg); }
    catch (e) { console.warn("[status-update] msg fail:", e.message); }
  }
  res.json({ ok: true, status });
});

// POST /store/orders/:orderId/complete — إنهاء الطلب + إرسال طلب تقييم للعميل
router.post("/store/orders/:orderId/complete", auth, async (req, res) => {
  const { orderId } = req.params;
  const orders = readOrders(req.storeId);
  const order  = orders.find(o => o.orderId === orderId);
  if (!order) return res.status(404).json({ error: "الطلب غير موجود" });
  if (order.status === "completed") return res.status(400).json({ error: "الطلب مكتمل مسبقاً" });

  updateOrderStatus(req.storeId, orderId, "completed");

  const store = getStore(req.storeId);
  const cfg   = store?.adminConfig || {};
  const label = cfg.completionLabel || "تم الإنجاز";
  const emoji = cfg.completionEmoji || "✅";
  const storeName = store?.storeName || "المتجر";

  // أرسل للعميل طلب تقييم
  if (order.customerPhone && order.customerPhone !== "999999999") {
    const ratingMsg =
`${emoji} *${label}!*

شكراً لاختيارك *${storeName}* 🙏

نأمل أن تكون تجربتك ممتازة. هل يمكنك تقييم خدمتنا؟

*1* — ⭐ سيء
*2* — ⭐⭐ مقبول
*3* — ⭐⭐⭐ جيد
*4* — ⭐⭐⭐⭐ ممتاز
*5* — ⭐⭐⭐⭐⭐ رائع جداً

_اكتب رقم التقييم (من 1 إلى 5) أو ملاحظاتك_ 💬`;
    try {
      await waMgr.sendMessage(req.storeId, order.customerPhone, ratingMsg);
      // فعّل rating pending لهذا العميل
      const ratings = require("./ratings");
      // الـ ratings تستخدم pendingRatings Set في server.js — نعتمد على flow الموجود
    } catch (e) { console.warn("[complete] rating msg fail:", e.message); }
  }
  res.json({ ok: true, label, emoji });
});

// POST /store/orders/:orderId/handoff/resume — استئناف البوت بعد human handoff
router.post("/store/orders/:orderId/handoff/resume", auth, async (req, res) => {
  const orders = readOrders(req.storeId);
  const order  = orders.find(o => o.orderId === req.params.orderId);
  if (!order) return res.status(404).json({ error: "الطلب غير موجود" });
  // إزالة الـ handoff state للعميل
  const fs = require("fs");
  const path = require("path");
  const handoffFile = path.join(__dirname, "..", "data", "handoffs.json");
  let handoffs = {};
  try { handoffs = JSON.parse(fs.readFileSync(handoffFile, "utf8")); } catch {}
  if (handoffs[order.customerPhone]) delete handoffs[order.customerPhone];
  fs.writeFileSync(handoffFile, JSON.stringify(handoffs, null, 2));

  // أبلغ العميل: البوت عاد للخدمة
  if (order.customerPhone) {
    const msg = `✅ *البوت يعمل من جديد*\n\nيمكنك الكتابة لي مباشرة. شكراً لصبرك 🙏`;
    try { await waMgr.sendMessage(req.storeId, order.customerPhone, msg); } catch {}
  }
  res.json({ ok: true });
});

// ─── Archives (شهري) ──────────────────────────────────────────────────────────
const monthlyArchive = require("./monthly-archive");

router.get("/store/archives", auth, (req, res) => {
  res.json({ archives: monthlyArchive.listArchives(req.storeId) });
});

router.get("/store/archives/:month", auth, (req, res) => {
  const orders = monthlyArchive.getArchiveOrders(req.storeId, req.params.month);
  res.json({ month: req.params.month, orders });
});

// POST /store/archives/run — تشغيل أرشفة يدوياً للشهر الماضي
router.post("/store/archives/run", auth, (req, res) => {
  const { month } = req.body || {};
  const yearMonth = month || new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15).toISOString().slice(0, 7);
  try {
    const result = monthlyArchive.archiveStoreMonth(req.storeId, yearMonth);
    res.json({ ok: true, ...result, month: yearMonth });
  } catch (e) {
    res.status(500).json({ error: "فشل الأرشفة: " + e.message });
  }
});

// GET /store/handoffs — قائمة العملاء الذين يحتاجون مسؤول
router.get("/store/handoffs", auth, (req, res) => {
  const fs = require("fs");
  const path = require("path");
  const handoffFile = path.join(__dirname, "..", "data", "handoffs.json");
  let handoffs = {};
  try { handoffs = JSON.parse(fs.readFileSync(handoffFile, "utf8")); } catch {}
  // فلتر هذا المتجر فقط
  const mine = Object.entries(handoffs)
    .filter(([_, h]) => h.storeId === req.storeId)
    .map(([phone, h]) => ({ phone, ...h }))
    .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  res.json({ handoffs: mine });
});

router.post("/store/orders/:orderId/confirm", auth, async (req, res) => {
  const { orderId } = req.params;
  const orders = readOrders(req.storeId);
  const order  = orders.find(o => o.orderId === orderId);
  if (!order) return res.status(404).json({ error: "الطلب غير موجود" });
  if (order.status === "confirmed") return res.status(400).json({ error: "الطلب مؤكد مسبقاً" });

  updateOrderStatus(req.storeId, orderId, "confirmed");

  audit({
    actor: req.impersonatedBy ? { type: "master", id: "master", impersonating: req.storeId } : { type: "store", id: req.storeId },
    action: "order.confirm",
    target: { type: "order", id: orderId },
    meta: { total: order.total, customerPhone: String(order.customerPhone || "").slice(0, 6) + "***" },
  }, req);

  const store     = getStore(req.storeId);
  const storeName = store?.storeName || "المتجر";

  // ── Loyalty + Customer registry — تُمنح فقط الآن (بعد قبول المالك) ──────────
  let earned = null;
  try {
    if (order.customerPhone && hasFeature(store?.plan, "customerRegistry")) {
      const { upsertCustomer } = require("./customers");
      upsertCustomer({
        phone:    String(order.customerPhone).replace(/\D/g, ""),
        name:     order.customerName || "",
        location: order.customerLocation || "",
        total:    Number(order.total || 0),
        storeId:  req.storeId,
      });
    }
  } catch (e) { console.warn("[confirm] upsertCustomer failed:", e.message); }
  try {
    if (order.customerPhone) {
      const { addPoints } = require("./loyalty");
      earned = addPoints(req.storeId, order.customerPhone, Number(order.total || 0), orderId, store);
    }
  } catch (e) { console.warn("[confirm] addPoints failed:", e.message); }

  // Notify customer via Baileys (same WhatsApp session used by the bot)
  if (order.customerPhone) {
    const pointsLine = (earned && earned.newPoints > 0)
      ? `\n🏆 كسبت *${earned.newPoints}* نقطة! رصيدك: *${earned.totalPoints}*\n`
      : "";
    const confirmMsg =
      `✅ *تم تأكيد طلبك!*\n\n` +
      `رقم الطلب: *${orderId}*\n` +
      pointsLine +
      `سيتم توصيل طلبك قريباً إن شاء الله 🚴\n\n` +
      `شكراً لاختيارك *${storeName}*`;
    try { await waMgr.sendMessage(req.storeId, order.customerPhone, confirmMsg); } catch {}

    // Generate and send invoice image (Pro+ only) — يُرسَل مرة واحدة فقط حتى لو تأكيد مكرر
    const { PUBLIC_URL } = process.env;
    const storeFeatures = getPlanFeatures(store?.plan);
    if (storeFeatures.invoiceImage && PUBLIC_URL && !order.invoiceSent) {
      try {
        const img = await generateInvoiceImage({
          orderId:          order.orderId,
          storeName:        storeName,
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
        });
        try {
          await waMgr.sendImage(req.storeId, order.customerPhone, img.filePath, `🧾 فاتورة طلبك رقم ${orderId}`);
          // علِّم الطلب أن الفاتورة أُرسلت لمنع التكرار
          updateOrderStatus(req.storeId, orderId, "confirmed", { invoiceSent: true });
        } catch {}
      } catch (invErr) {
        console.error("Invoice generation error:", invErr.message);
      }
    }
  }

  res.json({ ok: true });
});

router.post("/store/orders/:orderId/reject", auth, async (req, res) => {
  const { orderId } = req.params;
  const { reason }  = req.body || {};
  if (!reason) return res.status(400).json({ error: "سبب الرفض مطلوب" });

  const orders = readOrders(req.storeId);
  const order  = orders.find(o => o.orderId === orderId);
  if (!order) return res.status(404).json({ error: "الطلب غير موجود" });
  if (order.status === "rejected") return res.status(400).json({ error: "الطلب مرفوض مسبقاً" });
  if (order.status === "cancelled") return res.status(400).json({ error: "الطلب ملغي بالفعل" });

  updateOrderStatus(req.storeId, orderId, "rejected", { rejectReason: String(reason).slice(0, 300) });

  const storeName = getStore(req.storeId)?.storeName || "المتجر";

  // Notify customer via Baileys
  if (order.customerPhone) {
    const rejectMsg =
      `❌ *نأسف، لم نتمكن من تنفيذ طلبك*\n\n` +
      `رقم الطلب: *${orderId}*\n\n` +
      `📋 السبب: ${reason}\n\n` +
      `نأسف على الإزعاج، يسعدنا خدمتك في وقت آخر 🙏\n\n` +
      `*${storeName}*`;
    try { await waMgr.sendMessage(req.storeId, order.customerPhone, rejectMsg); } catch {}
  }

  res.json({ ok: true });
});

// ─── Ratings — تقييمات العملاء ───────────────────────────────────────────────
router.get("/store/ratings", auth, (req, res) => {
  try {
    const ratings = require("./ratings");
    const summary = ratings.getStoreSummary(req.storeId);
    let all = ratings.getStoreRatings(req.storeId)
      .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
    const filter = req.query.filter;
    if (filter === "5")           all = all.filter(r => r.rating === 5);
    else if (filter === "1")      all = all.filter(r => r.rating <= 2);
    else if (filter === "comm")   all = all.filter(r => r.comment && r.comment.trim());
    else if (filter === "noresp") all = all.filter(r => !r.response);
    res.json({
      summary,
      trend: ratings.getTrend(req.storeId, 30),
      ratings: all.slice(0, parseInt(req.query.limit) || 100),
      total: all.length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/store/ratings/:ratingId/respond", auth, async (req, res) => {
  try {
    const { response } = req.body || {};
    if (!response || !String(response).trim()) return res.status(400).json({ error: "نص الرد مطلوب" });
    const ratings = require("./ratings");
    const all = ratings.getStoreRatings(req.storeId);
    const target = all.find(r => r.id === req.params.ratingId);
    if (!target) return res.status(404).json({ error: "التقييم غير موجود" });
    const updated = ratings.respondToRating(req.params.ratingId, response);
    if (target.phone) {
      try {
        const store = getStore(req.storeId);
        await waMgr.sendMessage(req.storeId, target.phone,
          `💬 *رد ${store?.storeName || "المتجر"} على تقييمك:*\n\n${String(response).trim()}\n\n_شكراً لمشاركتنا رأيك_`);
      } catch (e) { console.warn("[rating-respond] send failed:", e.message); }
    }
    res.json({ ok: true, rating: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/store/ratings/ai-analysis", auth, async (req, res) => {
  try {
    const store = getStore(req.storeId);
    const ratings = require("./ratings");
    const days = parseInt(req.body?.days) || 30;
    const recent = ratings.getRecentRatings(req.storeId, days);
    const aiAccountant = require("./ai-accountant");
    const bizType = store?.adminConfig?.businessType || store?.businessType || "generic";
    const analysis = await aiAccountant.analyzeRatings(bizType, recent);
    res.json({ days, count: recent.length, businessType: bizType, ...analysis });
  } catch (e) { res.status(500).json({ error: "تعذّر التحليل: " + e.message }); }
});

// ─── Rejected/Cancelled summary — تقرير أسباب الرفض والإلغاء ────────────────
router.get("/store/orders/rejected-summary", auth, (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
  const cutoff = Date.now() - days * 86400_000;

  const orders = readOrders(req.storeId);
  const rejected  = orders.filter(o => o.status === "rejected"  && new Date(o.timestamp || 0).getTime() >= cutoff);
  const cancelled = orders.filter(o => o.status === "cancelled" && new Date(o.timestamp || 0).getTime() >= cutoff);

  // group reasons
  const groupReasons = (list, reasonField) => {
    const map = new Map();
    let totalLost = 0;
    for (const o of list) {
      const reason = String(o[reasonField] || "بدون سبب").trim().slice(0, 120);
      const key = reason.toLowerCase();
      const cur = map.get(key) || { reason, count: 0, lostRevenue: 0, lastSeen: null, examples: [] };
      cur.count++;
      cur.lostRevenue += Number(o.total || 0);
      cur.lastSeen = o.timestamp || cur.lastSeen;
      if (cur.examples.length < 3) cur.examples.push({ orderId: o.orderId, customer: o.customerName || o.customerPhone, total: o.total, when: o.timestamp });
      map.set(key, cur);
      totalLost += Number(o.total || 0);
    }
    return {
      total: list.length,
      totalLostRevenue: Math.round(totalLost * 100) / 100,
      reasons: [...map.values()].sort((a, b) => b.count - a.count),
    };
  };

  // الزبائن الأكثر إلغاءً (top abusers)
  const byCustomer = new Map();
  for (const o of cancelled.filter(x => x.cancelledBy === "customer")) {
    const phone = String(o.customerPhone || "").replace(/\D/g, "");
    if (!phone) continue;
    const cur = byCustomer.get(phone) || { phone, name: o.customerName || phone, count: 0, lostRevenue: 0 };
    cur.count++;
    cur.lostRevenue += Number(o.total || 0);
    byCustomer.set(phone, cur);
  }
  const topCancellingCustomers = [...byCustomer.values()]
    .filter(c => c.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  res.json({
    days,
    rejected:  groupReasons(rejected,  "rejectReason"),
    cancelled: groupReasons(cancelled, "cancelReason"),
    topCancellingCustomers,
  });
});

// ─── Inventory — جرد المخزون ─────────────────────────────────────────────────
router.get("/store/inventory", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const products = (store.products || []).map(p => ({
    id: p.id,
    name: p.name,
    category: p.category,
    price: Number(p.price) || 0,
    stock: typeof p.stock === "number" ? p.stock : null, // null = لا محدود
    available: p.available !== false,
    imageUrl: p.imageUrl || null,
    lowStock: typeof p.stock === "number" && p.stock > 0 && p.stock < 5,
    outOfStock: p.stock === 0 || p.available === false,
  }));
  // sort: out-of-stock أولاً، ثم low-stock، ثم العادي
  products.sort((a, b) => (b.outOfStock ? 2 : b.lowStock ? 1 : 0) - (a.outOfStock ? 2 : a.lowStock ? 1 : 0));
  const summary = {
    total: products.length,
    outOfStock: products.filter(p => p.outOfStock).length,
    lowStock:   products.filter(p => p.lowStock).length,
    unlimited:  products.filter(p => p.stock === null).length,
    inStock:    products.filter(p => typeof p.stock === "number" && p.stock >= 5).length,
  };
  res.json({ products, summary });
});

// PATCH /store/inventory/:productId — تعديل سريع للمخزون
router.patch("/store/inventory/:productId", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const product = (store.products || []).find(p => p.id === req.params.productId);
  if (!product) return res.status(404).json({ error: "المنتج غير موجود" });

  const { stock, available, mode } = req.body || {};
  const patch = {};

  if (stock !== undefined) {
    if (stock === null) patch.stock = null;
    else {
      const n = parseInt(stock, 10);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: "المخزون يجب أن يكون رقم موجب أو null" });
      // mode: 'set' (default), 'add', 'sub'
      if (mode === "add") patch.stock = (typeof product.stock === "number" ? product.stock : 0) + n;
      else if (mode === "sub") patch.stock = Math.max(0, (typeof product.stock === "number" ? product.stock : 0) - n);
      else patch.stock = n;
    }
  }
  if (typeof available === "boolean") patch.available = available;

  const products = (store.products || []).map(p =>
    p.id === req.params.productId ? { ...p, ...patch } : p
  );
  updateStore(req.storeId, { products });

  audit({
    actor: { type: "store", id: req.storeId },
    action: "inventory.update",
    target: { type: "product", id: req.params.productId },
    meta: { storeId: req.storeId, oldStock: product.stock, newStock: patch.stock, available: patch.available },
  }, req);

  res.json({ ok: true, product: { id: product.id, name: product.name, ...patch } });
});

// ─── Cancel order — من المالك أو من العميل (عبر البوت) ───────────────────────
router.post("/store/orders/:orderId/cancel", auth, async (req, res) => {
  const { orderId } = req.params;
  const { reason, by } = req.body || {};
  const orders = readOrders(req.storeId);
  const order  = orders.find(o => o.orderId === orderId);
  if (!order) return res.status(404).json({ error: "الطلب غير موجود" });
  if (["cancelled","rejected","completed","delivered","done"].includes(order.status)) {
    return res.status(400).json({ error: "لا يمكن إلغاء طلب " + order.status });
  }

  const cancelledBy = by === "customer" ? "customer" : "store";
  const reasonClean = String(reason || (cancelledBy === "customer" ? "ألغى العميل الطلب" : "ألغى المالك الطلب")).slice(0, 300);
  updateOrderStatus(req.storeId, orderId, "cancelled", { cancelledBy, cancelReason: reasonClean });

  const store = getStore(req.storeId);
  const storeName = store?.storeName || "المتجر";

  // notify the other party
  if (cancelledBy === "store" && order.customerPhone) {
    try {
      await waMgr.sendMessage(req.storeId, order.customerPhone,
        `🚫 *تم إلغاء طلبك*\n\nرقم الطلب: *${orderId}*\nالسبب: ${reasonClean}\n\nيسعدنا خدمتك مرة أخرى 🌸\n\n*${storeName}*`);
    } catch {}
  }
  if (cancelledBy === "customer" && store?.ownerPhone) {
    try {
      await waMgr.sendMessage(req.storeId, store.ownerPhone,
        `🚫 *العميل ألغى طلبه*\n\nالطلب: *${orderId}*\nالعميل: ${order.customerName || order.customerPhone}\nالسبب: ${reasonClean}`);
    } catch {}
  }

  audit({
    actor: req.impersonatedBy ? { type: "master", id: "master", impersonating: req.storeId } : { type: "store", id: req.storeId },
    action: "order.cancel",
    target: { type: "order", id: orderId },
    meta: { cancelledBy, reason: reasonClean, total: order.total },
  }, req);

  res.json({ ok: true });
});

// ─── Broadcast (Pro+) — persistent queue مع resume بعد crash ─────────────────
const broadcastQueue = require("./broadcast-queue");
const MAX_PER_RUN_LEGACY = 50;

router.get("/store/broadcast/count", auth, (req, res) => {
  const { getStoreCustomerPhones } = require("./broadcast");
  const count = getStoreCustomerPhones(req.storeId).length;
  const cd = broadcastQueue.checkCooldown(req.storeId);
  res.json({
    count,
    sendLimit: MAX_PER_RUN_LEGACY,
    willSend: Math.min(count, MAX_PER_RUN_LEGACY),
    cooldownReady: cd.ok,
    cooldownHoursLeft: cd.hoursLeft || 0,
    cooldownTotalHours: broadcastQueue.COOLDOWN_HOURS,
  });
});

// GET /store/broadcast/progress — حالة البث الجاري
router.get("/store/broadcast/progress", auth, (req, res) => {
  const p = broadcastQueue.getProgress(req.storeId);
  if (!p) return res.json({ active: false });
  res.json({ active: !p.completed && !p.cancelled, ...p });
});

router.post("/store/broadcast", auth, async (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const { getPlanFeatures } = require("./plans");
  const features = getPlanFeatures(store.plan);
  if (!features.customerRegistry) {
    return res.status(403).json({ error: "البث متاح في الباقة الاحترافية فأعلى" });
  }

  const message = (req.body?.message || "").trim();
  if (!message)              return res.status(400).json({ error: "الرسالة فارغة" });
  if (message.length > 1000) return res.status(400).json({ error: "الرسالة أكثر من 1000 حرف" });

  const { getStoreCustomers } = require("./broadcast");
  const recipients = getStoreCustomers(req.storeId).slice(0, MAX_PER_RUN_LEGACY);
  if (recipients.length === 0) return res.status(400).json({ error: "لا يوجد عملاء حقيقيون للإرسال إليهم بعد" });

  const r = broadcastQueue.enqueue(req.storeId, message, recipients);
  if (!r.ok) {
    if (r.cooldownHoursLeft) {
      return res.status(429).json({
        error: `يجب الانتظار ${r.cooldownHoursLeft} ساعة قبل البث التالي`,
        cooldownHoursLeft: r.cooldownHoursLeft,
      });
    }
    return res.status(400).json({ error: r.error });
  }

  audit({
    actor: { type: "store", id: req.storeId },
    action: "broadcast.start",
    meta: { recipients: r.queued, messageLength: message.length },
  }, req);

  const estimatedMin = Math.ceil((r.willSend * 11.5) / 60);
  res.json({
    ok: true,
    recipients: r.willSend,
    estimatedMinutes: estimatedMin,
    message: `جاري الإرسال لـ ${r.willSend} عميل (${estimatedMin} دقيقة تقريباً) — يمكنك متابعة التقدّم 📢`,
  });
});

// POST /store/broadcast/cancel
router.post("/store/broadcast/cancel", auth, (req, res) => {
  const r = broadcastQueue.cancel(req.storeId);
  if (!r.ok) return res.status(404).json({ error: r.error });
  audit({ actor: { type: "store", id: req.storeId }, action: "broadcast.cancel" }, req);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── ACCOUNTING — مدير الحسابات ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
const accounting    = require("./accounting");
const aiAccountant  = require("./ai-accountant");

const actorFor = (req) => ({ type: "store", id: req.storeId });

// ── KPIs dashboard للحسابات
router.get("/store/accounting/dashboard", auth, (req, res) => {
  try {
    const kpis = accounting.getDashboardKPIs(req.storeId);
    res.json(kpis);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── تكاليف المنتجات
router.get("/store/accounting/product-costs", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const costs = accounting.getAllProductCosts(req.storeId);
  const products = (store.products || []).map(p => {
    const c = costs[p.id];
    const cost = c?.cost ?? 0;
    const profit = (p.price || 0) - cost;
    const margin = (p.price || 0) > 0 ? (profit / p.price) * 100 : 0;
    return {
      id: p.id,
      name: p.name,
      price: p.price || 0,
      cost,
      profit: Math.round(profit * 100) / 100,
      margin: Math.round(margin * 10) / 10,
      updatedAt: c?.updatedAt || null,
      historyCount: (c?.history || []).length,
    };
  });
  res.json({ products });
});

router.put("/store/accounting/product-costs/:productId", auth, (req, res) => {
  const { cost } = req.body || {};
  if (cost === undefined || cost === null) return res.status(400).json({ error: "التكلفة مطلوبة" });
  try {
    const entry = accounting.setProductCost(req.storeId, req.params.productId, Number(cost), actorFor(req), req);
    res.json({ ok: true, cost: entry.cost });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get("/store/accounting/product-costs/:productId/history", auth, (req, res) => {
  const all = accounting.getAllProductCosts(req.storeId);
  res.json({ history: all[req.params.productId]?.history || [], current: all[req.params.productId]?.cost ?? 0 });
});

// ── المصاريف
router.get("/store/accounting/expenses", auth, (req, res) => {
  const list = accounting.listExpenses(req.storeId, {
    yearMonth: req.query.month,
    year:      req.query.year,
  });
  res.json({ expenses: list, types: accounting.EXPENSE_TYPES });
});

router.post("/store/accounting/expenses", auth, (req, res) => {
  try {
    const entry = accounting.addExpense(req.storeId, req.body || {}, actorFor(req), req);
    res.json({ ok: true, expense: entry });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete("/store/accounting/expenses/:expenseId", auth, (req, res) => {
  const ok = accounting.deleteExpense(req.storeId, req.params.expenseId, actorFor(req), req);
  if (!ok) return res.status(404).json({ error: "مصروف غير موجود" });
  res.json({ ok: true });
});

// ── P&L شهري
router.get("/store/accounting/monthly/:yearMonth", auth, (req, res) => {
  try {
    const stored = accounting.getStoredMonthlyPnL(req.storeId, req.params.yearMonth);
    const data = stored || accounting.calculateMonthlyPnL(req.storeId, req.params.yearMonth);
    res.json({ ...data, closed: !!stored?.closed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/store/accounting/monthly/:yearMonth/close", auth, (req, res) => {
  try {
    const closed = accounting.closeMonth(req.storeId, req.params.yearMonth, actorFor(req), req);
    res.json({ ok: true, ...closed });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get("/store/accounting/monthly", auth, (req, res) => {
  res.json({ months: accounting.listMonthlyReports(req.storeId) });
});

// ── ملخص سنوي + تقفيل السنة
router.get("/store/accounting/yearly/:year", auth, (req, res) => {
  try { res.json(accounting.calculateYearlySummary(req.storeId, req.params.year)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/store/accounting/yearly/:year/close", auth, (req, res) => {
  try {
    const closed = accounting.closeYear(req.storeId, req.params.year, actorFor(req), req);
    res.json({ ok: true, ...closed });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── المنتجات الأكثر ربحية
router.get("/store/accounting/top-products", auth, (req, res) => {
  const ym = req.query.month || new Date().toISOString().slice(0, 7);
  const pnl = accounting.calculateMonthlyPnL(req.storeId, ym);
  res.json({
    yearMonth: ym,
    top:   pnl.topProducts,
    worst: pnl.worstProducts,
  });
});

// ── نصائح AI المحاسب
router.post("/store/accounting/ai-advice", auth, async (req, res) => {
  try {
    const store = getStore(req.storeId);
    const ym = req.body?.yearMonth || new Date().toISOString().slice(0, 7);
    const pnl = accounting.calculateMonthlyPnL(req.storeId, ym);
    const bizType = store?.adminConfig?.businessType || store?.businessType || "generic";
    const advice = await aiAccountant.analyzeMonthlyPnL(bizType, pnl);
    res.json({ yearMonth: ym, businessType: bizType, ...advice });
  } catch (e) {
    console.error("[ai-advice]", e.message);
    res.status(500).json({ error: "تعذّر تحليل البيانات حالياً" });
  }
});

// ── توصية فيديو AI لمنتج
router.post("/store/products/:id/video-recommend", auth, async (req, res) => {
  try {
    const store = getStore(req.storeId);
    const product = (store?.products || []).find(p => p.id === req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });
    const bizType = store?.adminConfig?.businessType || store?.businessType || "generic";
    const rec = await aiAccountant.recommendVideoType(bizType, product.name, product.description);
    res.json(rec);
  } catch (e) { res.status(500).json({ error: "تعذّر التوصية حالياً" }); }
});

// ─── Menu Image (authenticated) ──────────────────────────────────────────────
router.get("/store/menu-image", auth, async (req, res) => {
  try {
    const store = getStore(req.storeId);
    if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

    const { filePath } = await generateMenuImage({
      storeId:        store.id,
      storeName:      store.storeName,
      invoiceColor:   store.invoiceColor  || null,
      invoiceLogoUrl: store.invoiceLogoUrl || null,
      categories:     store.categories    || [],
      products:       store.products      || [],
      currency:       store.currency      || "ر.س",
    });

    if (!fs.existsSync(filePath)) {
      return res.status(500).json({ error: "فشل توليد صورة المنيو" });
    }

    res.setHeader("Content-Type", "image/png");
    res.sendFile(filePath);
  } catch (err) {
    console.error("Menu image error:", err.message);
    res.status(500).json({ error: "خطأ في توليد صورة المنيو" });
  }
});

// ─── Customers (للعميل) ───────────────────────────────────────────────────────
const { getCustomers, setVip, archiveMonth } = require("./customers");

router.get("/store/customers", auth, (req, res) => {
  // فلترة per-store — يمنع التسرّب
  const list = getCustomers(req.storeId);
  res.json({ customers: list });
});

router.put("/store/customers/:phone/vip", auth, (req, res) => {
  const ok = setVip(req.params.phone, req.body.isVip !== false, req.storeId);
  if (!ok) return res.status(404).json({ error: "العميل غير موجود" });
  res.json({ ok: true });
});

router.post("/store/customers/archive", auth, (req, res) => {
  // ⚠️ تمرير storeId يحفظ عزل المتاجر — لا يُمسح عملاء متاجر أخرى
  const result = archiveMonth(req.body.month, req.storeId);
  res.json({ ok: true, ...result });
});

// ─── WhatsApp Status (للعميل) ─────────────────────────────────────────────────
router.get("/store/wa-status", auth, (req, res) => {
  const s = waMgr.getStatus(req.storeId);
  res.json(s);
});

// ─── WhatsApp Pair (للعميل يربط رقمه بنفسه) ─────────────────────────────────
router.post("/store/wa-pair", auth, async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: "رقم الهاتف مطلوب" });
  try {
    const code = await waMgr.requestPairingCode(req.storeId, phone);
    res.json({ ok: true, code });
  } catch (e) {
    console.error(`[wa-pair] ${req.storeId}:`, e.message);
    res.status(500).json({ error: "تعذّر توليد الكود — تأكد أن الرقم مسجّل في واتساب وحاول مجدداً" });
  }
});

// ─── WhatsApp Disconnect (قطع الربط وإعادة تعيين الجلسة) ─────────────────────
router.post("/store/wa-disconnect", auth, async (req, res) => {
  try {
    await waMgr.resetSession(req.storeId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Create store token (for master impersonation) ───────────────────────────
// Impersonation sessions تنتهي خلال 30 دقيقة، مع flag impersonatedBy + audit
const IMPERSONATION_TTL_MS = 30 * 60 * 1000;
function createStoreToken(storeId, impersonatedBy) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  sessions.set(token, {
    storeId,
    createdAt: now,
    lastActivity: now,
    impersonatedBy: impersonatedBy || null,
    // override الـ TTL للـ impersonation: 30 دقيقة من createdAt (absolute، لا sliding)
    absoluteExpiry: impersonatedBy ? now + IMPERSONATION_TTL_MS : null,
  });
  _saveStoreSessions();
  return token;
}

// ─── Verify a store token externally (used by payments-router) ───────────────
function verifyStoreToken(token) {
  if (!token) return null;
  const entry = sessions.get(token);
  if (!entry) return null;
  if (entry.absoluteExpiry && Date.now() > entry.absoluteExpiry) {
    sessions.delete(token);
    _saveStoreSessions();
    return null;
  }
  const lastSeen = entry.lastActivity || entry.createdAt;
  if (Date.now() - lastSeen > SESSION_TTL_MS) {
    sessions.delete(token);
    _saveStoreSessions();
    return null;
  }
  if (!entry.absoluteExpiry) {
    entry.lastActivity = Date.now();
    _saveStoreSessions();
  }
  return entry.storeId;
}

module.exports = router;
module.exports.createStoreToken = createStoreToken;
module.exports.verifyStoreToken = verifyStoreToken;
