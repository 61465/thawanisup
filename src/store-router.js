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
const bcrypt        = require("bcrypt");

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

// ─── In-memory sessions: token → { storeId, createdAt } ─────────────────────
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const sessions = new Map();

// Clean expired sessions every hour
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [token, val] of sessions) {
    if (val.createdAt < cutoff) sessions.delete(token);
  }
}, 60 * 60 * 1000);

// ─── Storage helpers ──────────────────────────────────────────────────────────
function readStores() {
  try { return JSON.parse(fs.readFileSync(STORES_FILE, "utf8")); }
  catch { return { stores: [] }; }
}

function writeStores(data) {
  fs.writeFileSync(STORES_FILE, JSON.stringify(data, null, 2));
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

// ─── Auth middleware ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers["x-store-token"];
  const entry = sessions.get(token);
  if (!token || !entry) return res.status(401).json({ error: "يرجى تسجيل الدخول" });
  if (Date.now() - entry.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return res.status(401).json({ error: "انتهت الجلسة، يرجى تسجيل الدخول مجدداً" });
  }
  req.storeId = entry.storeId;
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
  sessions.set(token, { storeId, createdAt: Date.now() });
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
  const { idToken, firebaseUid: clientUid, storeId: inviteId } = req.body || {};
  if (!idToken && !clientUid) return res.status(400).json({ error: "بيانات مفقودة" });

  let uid, email;
  if (admin.apps.length && idToken) {
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      uid   = decoded.uid;
      email = decoded.email;
    } catch (err) {
      console.error("Firebase verify:", err.message);
      return res.status(403).json({ error: "فشل التحقق من الهوية" });
    }
  } else if (clientUid) {
    uid = clientUid;
  } else {
    return res.status(400).json({ error: "لم يتم تهيئة Firebase Admin SDK على الخادم" });
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
    sessions.set(token, { storeId: store.id, createdAt: Date.now() });
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

// GET /store/edit-mode-link — رابط معاينة + تعديل مباشر (للستور admin فقط)
router.get("/store/edit-mode-link", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  // نستخدم نفس preview token + flag للـ edit mode
  const token = req.headers["x-store-token"];
  const base  = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
  res.json({ url: `${base}/preview-edit.html?storeId=${encodeURIComponent(req.storeId)}&token=${encodeURIComponent(token)}` });
});

// PATCH /store/products/:id/inline — تعديل سريع لحقل واحد (لـ inline editing)
router.patch("/store/products/:id/inline", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const { field, value } = req.body || {};
  const ALLOWED = ["name", "price", "description"];
  if (!ALLOWED.includes(field)) return res.status(400).json({ error: "حقل غير مسموح" });
  let cleanValue = value;
  if (field === "price") {
    cleanValue = parseFloat(value);
    if (!Number.isFinite(cleanValue) || cleanValue < 0) return res.status(400).json({ error: "سعر غير صالح" });
  } else {
    cleanValue = String(value || "").trim().slice(0, 500);
  }
  const products = (store.products || []).map(p =>
    p.id === req.params.id ? { ...p, [field]: cleanValue } : p
  );
  updateStore(req.storeId, { products });
  res.json({ ok: true, [field]: cleanValue });
});

// ─── Stats ────────────────────────────────────────────────────────────────────
router.get("/store/stats", auth, (req, res) => {
  const orders  = readOrders(req.storeId);
  const today   = new Date().toISOString().slice(0, 10);
  const todayOr = orders.filter(o => (o.timestamp || "").slice(0, 10) === today);

  const productCounts = {};
  for (const o of orders) {
    for (const item of (o.items || [])) {
      productCounts[item.name] = (productCounts[item.name] || 0) + item.qty;
    }
  }
  const topProducts = Object.entries(productCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([name, qty]) => ({ name, qty }));

  res.json({
    ordersTotal:  orders.length,
    ordersToday:  todayOr.length,
    revenueTotal: parseFloat(orders.reduce((s, o) => s + (o.total || 0), 0).toFixed(2)),
    revenueToday: parseFloat(todayOr.reduce((s, o) => s + (o.total || 0), 0).toFixed(2)),
    topProducts,
  });
});

// ─── Store Settings ───────────────────────────────────────────────────────────
router.put("/store/settings", auth, (req, res) => {
  const allowed = [
    "storeName", "currency", "deliveryFee",
    "workingHoursStart", "workingHoursEnd",
    "welcomeMessage", "invoiceColor", "invoiceLogoUrl",
    "requireConfirmation",
    // الحقول الجديدة (themes + ألوان + قالب الفاتورة + business type)
    "businessType",
    "themeAccent", "themeText", "themeTextMute",
    "menuMode", "invoiceTemplate",
    "logoUrl", "address", "locationMapUrl",
    // toggles المسارات (Adaptive Bot) + الكوبونات
    "enableWebview", "enableNumeric", "enableAI",
    "enableCoupons",
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
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

  const product = {
    id:            "p_" + Date.now(),
    category:      req.body.category || "",
    subCategoryId: String(req.body.subCategoryId || "").trim(),
    name:          (req.body.name || "").trim(),
    description:   (req.body.description || "").trim(),
    price:         parseFloat(req.body.price) || 0,
    imageUrl:      req.body.imageUrl || null,
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

  const products = (store.products || []).map(p =>
    p.id === req.params.id ? { ...p, ...patch, id: p.id } : p
  );
  updateStore(req.storeId, { products });
  res.json({ ok: true });
});

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

  const cat = { id: "cat_" + Date.now(), name: req.body.name || "", emoji: req.body.emoji || "🍽️" };
  const categories = [...(store.categories || []), cat];
  updateStore(req.storeId, { categories });
  res.json({ ok: true, category: cat });
});

router.delete("/store/categories/:id", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const categories = (store.categories || []).filter(c => c.id !== req.params.id);
  updateStore(req.storeId, { categories });
  res.json({ ok: true });
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
    const code = "VIP" + Math.random().toString(36).slice(2, 8).toUpperCase();
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

// ─── Image Upload ─────────────────────────────────────────────────────────────
router.post("/store/upload-image", auth, (req, res) => {
  const { base64, ext = "jpg" } = req.body || {};
  if (!base64) return res.status(400).json({ error: "لا توجد صورة" });

  const safeExt  = ["jpg","jpeg","png","webp"].includes(ext.toLowerCase()) ? ext.toLowerCase() : "jpg";
  const filename = `${req.storeId}_${Date.now()}.${safeExt}`;
  const imagesDir = path.join(DATA_DIR, "images");
  const filepath  = path.join(imagesDir, filename);

  try {
    fs.mkdirSync(imagesDir, { recursive: true });
    const buffer = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ""), "base64");
    if (buffer.length > 3 * 1024 * 1024) return res.status(413).json({ error: "الصورة أكبر من 3MB" });
    fs.writeFileSync(filepath, buffer);
    res.json({ ok: true, url: `/store-images/${filename}` });
  } catch (err) {
    console.error("Upload error:", err.message);
    res.status(500).json({ error: "فشل رفع الصورة" });
  }
});

function updateOrderStatus(storeId, orderId, status) {
  const file = storeId === "nakheel_001"
    ? path.join(DATA_DIR, "orders.jsonl")
    : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
  if (!fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const updated = lines.map(l => {
    try {
      const obj = JSON.parse(l);
      if (obj.orderId === orderId) obj.status = status;
      return JSON.stringify(obj);
    } catch { return l; }
  });
  fs.writeFileSync(file, updated.join("\n") + "\n", "utf8");
  return true;
}

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

⭐ = سيء
⭐⭐ = مقبول
⭐⭐⭐ = جيد
⭐⭐⭐⭐ = ممتاز
⭐⭐⭐⭐⭐ = رائع جداً

*أرسل عدد النجوم أو اكتب ملاحظاتك* 💬`;
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

  const store     = getStore(req.storeId);
  const storeName = store?.storeName || "المتجر";

  // Notify customer via Baileys (same WhatsApp session used by the bot)
  if (order.customerPhone) {
    const confirmMsg =
      `✅ *تم تأكيد طلبك!*\n\n` +
      `رقم الطلب: *${orderId}*\n` +
      `سيتم توصيل طلبك قريباً إن شاء الله 🚴\n\n` +
      `شكراً لاختيارك *${storeName}*`;
    try { await waMgr.sendMessage(req.storeId, order.customerPhone, confirmMsg); } catch {}

    // Generate and send invoice image (Pro+ only)
    const { PUBLIC_URL } = process.env;
    const storeFeatures = getPlanFeatures(store?.plan);
    if (storeFeatures.invoiceImage && PUBLIC_URL) {
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

  updateOrderStatus(req.storeId, orderId, "rejected");

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

// ─── Broadcast (Pro+) ────────────────────────────────────────────────────────
router.get("/store/broadcast/count", auth, (req, res) => {
  const { getStoreCustomerPhones, checkCooldown, MAX_PER_RUN, COOLDOWN_HOURS } = require("./broadcast");
  const count = getStoreCustomerPhones(req.storeId).length;
  const cd = checkCooldown(req.storeId);
  res.json({
    count,
    sendLimit: MAX_PER_RUN,
    willSend: Math.min(count, MAX_PER_RUN),
    cooldownReady: cd.ok,
    cooldownHoursLeft: cd.hoursLeft || 0,
    cooldownTotalHours: COOLDOWN_HOURS,
  });
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

  const { broadcast, getStoreCustomerPhones, checkCooldown, MAX_PER_RUN, COOLDOWN_HOURS } = require("./broadcast");

  const cd = checkCooldown(req.storeId);
  if (!cd.ok) {
    return res.status(429).json({
      error: `يجب الانتظار ${cd.hoursLeft} ساعة قبل البث التالي (للحماية من حظر واتساب). الحد: بث واحد كل ${COOLDOWN_HOURS} ساعة.`,
      cooldownHoursLeft: cd.hoursLeft,
    });
  }

  const count = getStoreCustomerPhones(req.storeId).length;
  if (count === 0) return res.status(400).json({ error: "لا يوجد عملاء حقيقيون للإرسال إليهم بعد" });

  const willSend = Math.min(count, MAX_PER_RUN);

  broadcast(req.storeId, message)
    .then(r => console.log(`📢 broadcast ${req.storeId}: ${r.sent}/${r.total}${r.stopped ? " stopped:"+r.stopped : ""}`))
    .catch(e => console.error(`❌ broadcast ${req.storeId}:`, e.message));

  const estimatedMin = Math.ceil((willSend * 11.5) / 60);
  res.json({
    ok: true,
    recipients: willSend,
    estimatedMinutes: estimatedMin,
    message: `جاري الإرسال لـ ${willSend} عميل (${estimatedMin} دقيقة تقريباً) 📢`,
  });
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
  const result = archiveMonth(req.body.month);
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
function createStoreToken(storeId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { storeId, createdAt: Date.now() });
  return token;
}

module.exports = router;
module.exports.createStoreToken = createStoreToken;
