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
// ⚡ Stores cache (mtime-based) — يوفّر ~1.2s/request على قراءة 1.2MB
let _storesCache = null;
let _storesCacheMtime = 0;
function readStores() {
  try {
    const stat = fs.statSync(STORES_FILE);
    if (_storesCache && stat.mtimeMs === _storesCacheMtime) {
      return _storesCache;
    }
    const data = JSON.parse(fs.readFileSync(STORES_FILE, "utf8"));
    _storesCache = data;
    _storesCacheMtime = stat.mtimeMs;
    return data;
  } catch { return { stores: [] }; }
}

const atomicFs = require("./atomic-fs");
function writeStores(data) {
  atomicFs.writeJsonSync(STORES_FILE, data);
  // invalidate cache فوراً لأن atomicFs.rename يحدّث mtime
  _storesCache = data;
  try { _storesCacheMtime = fs.statSync(STORES_FILE).mtimeMs; } catch {}
  // ⚡ أبطل كاش server.js الذي يقرأه البوت (يضمن وصول التحديث فوراً)
  try { global.invalidateStoresCache?.(); } catch {}
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

// ⚡ Per-store orders cache (mtime-based) — يحفظ JSON parse على كل GET /store/orders
const _ordersCache = new Map(); // storeId → { mtimeMs, orders }
function readOrders(storeId) {
  const file = storeId === "nakheel_001"
    ? path.join(DATA_DIR, "orders.jsonl")
    : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  try {
    const stat = fs.statSync(file);
    const cached = _ordersCache.get(storeId);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.orders;
    const orders = fs.readFileSync(file, "utf8")
      .split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    _ordersCache.set(storeId, { mtimeMs: stat.mtimeMs, orders });
    return orders;
  } catch { return []; }
}
// invalidate cache بعد writes (للاستدعاء من أماكن أخرى تكتب لـ orders)
function _invalidateOrdersCache(storeId) { _ordersCache.delete(storeId); }

// ─── Auth middleware (sliding TTL — تجدّد عند كل طلب) ───────────────────────
function auth(req, res, next) {
  // يدعم header الأساسي + fallback لـ query token (للتنزيلات المباشرة كـ Excel/PDF)
  const token = req.headers["x-store-token"] || (req.query && req.query.token) || null;
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
  // 🔒 فحص حالة الاشتراك — يقطع الادمن فور إلغاء/إيقاف الاشتراك
  // exception: master impersonation تستطيع الوصول لمتجر inactive (لإعادة التفعيل)
  if (!entry.impersonatedBy) {
    const store = getStore(entry.storeId);
    if (!store) {
      sessions.delete(token);
      _saveStoreSessions();
      return res.status(403).json({ error: "المتجر غير موجود", code: "STORE_NOT_FOUND" });
    }
    if (store.active === false) {
      sessions.delete(token);
      _saveStoreSessions();
      return res.status(403).json({ error: "تم تعطيل متجرك مؤقتاً. تواصل مع الإدارة.", code: "STORE_DISABLED" });
    }
    if (store.subscriptionStatus && store.subscriptionStatus !== "active") {
      sessions.delete(token);
      _saveStoreSessions();
      return res.status(403).json({ error: "اشتراكك غير مفعّل. يرجى تجديد الاشتراك للوصول للوحة.", code: "SUBSCRIPTION_INACTIVE" });
    }
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

// 🔓 helper: مسح كل tokens مرتبطة بمتجر معين (يُستدعى من master-router عند الإلغاء)
function revokeStoreTokens(storeId) {
  let count = 0;
  for (const [tok, entry] of sessions) {
    if (entry.storeId === storeId && !entry.impersonatedBy) {
      sessions.delete(tok);
      count++;
    }
  }
  if (count > 0) {
    _saveStoreSessions();
    console.log(`🔓 [${storeId}] revoked ${count} active token(s)`);
  }
  return count;
}
// expose للوصول من master-router
global.revokeStoreTokens = revokeStoreTokens;

// ─── SSE: Real-time events (Tier B/3) ────────────────────────────────────────
// لوحة الادمن تتصل بهذا الـ stream، تستقبل event عند طلب جديد/تحديث
// يحل polling 10s — تأخير الاستجابة من 10s → <100ms
router.get("/store/events", auth, (req, res) => {
  res.set({
    "Content-Type":   "text/event-stream",
    "Cache-Control":  "no-cache, no-transform",
    "Connection":     "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(`event: connected\ndata: {"ts":${Date.now()}}\n\n`);

  const storeId = req.storeId;
  global.sseAdd?.(storeId, res);
  req.on("close", () => global.sseRemove?.(storeId, res));
});

// ─── Login / Logout ───────────────────────────────────────────────────────────
router.post("/store/login", async (req, res) => {
  const { phone, password, storeId: chosenStoreId } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: "رقم الجوال وكلمة المرور مطلوبان" });

  let storeId, storeName, subscriptionStatus;
  // 🛡️ نجمع كل المتاجر التي يطابقها phone+password (قد يوجد أكثر من متجر لنفس المالك)
  const matched = []; // { storeId, storeName }

  // ── Try Firestore first (phone+password check) ───────────────────────────────
  if (firestoreAuth.isReady()) {
    try {
      const result = await firestoreAuth.loginStoreAdmin(phone, password);
      if (result && result.multiple) {
        for (const m of result.matches) matched.push({ storeId: m.storeId, storeName: m.storeName });
      } else if (result && result.storeId) {
        matched.push({ storeId: result.storeId, storeName: result.storeName });
      }
    } catch (e) {
      console.warn("Firestore login error:", e.message);
    }
  }

  // ── Fallback: stores.json (bcrypt مع migration للقديم) ──────────────────────
  if (matched.length === 0) {
    const { stores } = readStores();
    const candidates = stores.filter(s => s.ownerPhone === String(phone).trim());
    for (const s of candidates) {
      if (await verifyStorePassword(s, String(password).trim())) {
        matched.push({ storeId: s.id, storeName: s.storeName });
      }
    }
  }

  // 🛡️ لو تطابق أكثر من متجر — نطلب من العميل اختيار
  if (matched.length > 1) {
    if (!chosenStoreId) {
      audit({ actor: { type: "store" }, action: "login.multiple_stores", meta: { count: matched.length } }, req);
      return res.status(200).json({
        needsStoreSelection: true,
        stores: matched.map(m => ({ storeId: m.storeId, storeName: m.storeName })),
      });
    }
    const picked = matched.find(m => m.storeId === chosenStoreId);
    if (!picked) return res.status(403).json({ error: "المتجر المختار غير مطابق" });
    storeId = picked.storeId;
  } else if (matched.length === 1) {
    storeId = matched[0].storeId;
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

  // 🔒 الحساب موقوف بالكامل حتى إعادة التفعيل من الماستر
  if (storeData.active === false) {
    return res.status(403).json({
      error: "تم تعطيل متجرك. لإعادة التفعيل تواصل مع الإدارة.",
      code: "STORE_DISABLED",
    });
  }
  // أي حالة غير "active" = حساب موقوف (expired, suspended, cancelled, inactive, ...)
  if (subscriptionStatus && subscriptionStatus !== "active") {
    return res.status(403).json({
      error: "اشتراكك غير مفعّل. لإعادة التفعيل تواصل مع مزود الخدمة.",
      code: "SUBSCRIPTION_INACTIVE",
    });
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

// ─── 📦 Inventory Advanced (pharmacy/grocery) ────────────────────────────────
router.get("/store/inventory/analysis", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const { analyzeInventory } = require("./inventory-advanced");
  const result = analyzeInventory(req.storeId, {
    lowThreshold: parseInt(req.query.lowThreshold) || undefined,
    expiryWarnDays: parseInt(req.query.expiryWarnDays) || undefined,
  });
  res.json(result || { error: "فشل التحليل" });
});

router.post("/store/inventory/bulk-update", auth, express.json({ limit: "200kb" }), (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const { bulkUpdateStock } = require("./inventory-advanced");
  const r = bulkUpdateStock(req.storeId, req.body?.updates || []);
  res.status(r.ok ? 200 : 400).json(r);
});

// ─── 📅 Bookings (salon/home/clinic) ─────────────────────────────────────────
router.post("/store/bookings", auth, express.json({ limit: "10kb" }), (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const { createBooking } = require("./bookings");
  const r = createBooking(req.storeId, req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});

router.get("/store/bookings", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const { listBookings, getStats } = require("./bookings");
  // includeExpired=1 → يعطي كل الحجوزات (للـ dashboard + tooltips)
  // الافتراضي: يخفي المنتهية تلقائياً من القائمة الرئيسية
  const includeExpired = req.query.includeExpired === "1" || req.query.includeExpired === "true";
  const list = listBookings(req.storeId, {
    status: req.query.status,
    from: req.query.from,
    to: req.query.to,
    limit: parseInt(req.query.limit) || 100,
    asc: req.query.asc === "1",
    includeExpired,
  });
  res.json({ ok: true, bookings: list, stats: getStats(req.storeId) });
});

router.put("/store/bookings/:id/status", auth, express.json({ limit: "5kb" }), async (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const { updateBookingStatus, getBooking } = require("./bookings");
  const newStatus = req.body?.status;
  const extra = req.body?.extra || {};
  const r = updateBookingStatus(req.storeId, req.params.id, newStatus, extra);
  if (!r.ok) return res.status(404).json(r);

  // 📡 SSE — تحديث فوري للوحة الادمن
  try { global.sseSend?.(req.storeId, "booking_status", { id: r.booking.id, status: newStatus }); } catch {}

  // 📩 رسالة للعميل حسب الحالة الجديدة
  try {
    const b = r.booking;
    if (b.customerPhone) {
      const waMgr = require("./whatsapp-manager");
      const jid = String(b.customerPhone).replace(/\D/g, "") + "@s.whatsapp.net";
      const inDate = b.startAt ? new Date(b.startAt).toLocaleDateString("ar-EG",{weekday:"long",month:"long",day:"numeric"}) : "";
      let msg = "";
      let reason = "status_update";
      if (newStatus === "confirmed") {
        const tpl = store.bookingConfirmedTemplate || `✅ *تم تأكيد حجزك*

أهلاً {{customerName}} 👋

تأكيد حجزك في *{{storeName}}*:

🏠 الوحدة: *{{unitName}}*
📅 التاريخ: {{checkIn}}
💰 الإجمالي: *{{total}} ر.س*

سنذكّرك في يوم الحجز 🔔
نتطلع لاستضافتك 🌹`;
        msg = tpl
          .replace(/\{\{customerName\}\}/g, b.customerName || "عزيزنا")
          .replace(/\{\{storeName\}\}/g, store.storeName || "متجرنا")
          .replace(/\{\{unitName\}\}/g, b.unitName || b.serviceName || "")
          .replace(/\{\{checkIn\}\}/g, inDate)
          .replace(/\{\{total\}\}/g, String(b.totalPrice || ""));
        reason = "order_accepted";
      } else if (newStatus === "cancelled" || newStatus === "rejected") {
        const tpl = store.bookingRejectedTemplate || `❌ *عذراً، تعذّر تأكيد حجزك*

أهلاً {{customerName}}

نأسف لإبلاغك بأن حجزك في *{{storeName}}* (الوحدة: {{unitName}}) لم يُتأكد.
{{reason}}

نرجو التواصل معنا لاختيار موعد آخر متاح 🌹`;
        const reasonText = extra.rejectionReason ? `\nالسبب: ${extra.rejectionReason}\n` : "";
        msg = tpl
          .replace(/\{\{customerName\}\}/g, b.customerName || "عزيزنا")
          .replace(/\{\{storeName\}\}/g, store.storeName || "متجرنا")
          .replace(/\{\{unitName\}\}/g, b.unitName || b.serviceName || "")
          .replace(/\{\{reason\}\}/g, reasonText);
        reason = "order_rejected";
      } else if (newStatus === "completed") {
        const tpl = store.bookingCompletedTemplate || `🌟 *شكراً لاختيارك {{storeName}}*

أهلاً {{customerName}} 👋

نتمنى أن تكون قد قضيت وقتاً ممتعاً في *{{unitName}}*.
سعداء بخدمتك مرة أخرى 🌹`;
        msg = tpl
          .replace(/\{\{customerName\}\}/g, b.customerName || "عزيزنا")
          .replace(/\{\{storeName\}\}/g, store.storeName || "متجرنا")
          .replace(/\{\{unitName\}\}/g, b.unitName || b.serviceName || "");
        reason = "order_completed";
      }
      if (msg) {
        waMgr.sendMessage(req.storeId, jid, msg, { allowCold: true, reason })
          .catch(e => console.warn(`[booking-status-notify] ${b.id}:`, e.message));
      }
      // 🔓 امسح أي handoff تلقائي مرتبط بالحجز — البوت يعود للعمل الطبيعي
      if (["confirmed","cancelled","rejected","completed"].includes(newStatus)) {
        try {
          const fs = require("fs");
          const path = require("path");
          const atomicFs = require("./atomic-fs");
          const handoffFile = path.join(__dirname, "..", "data", "handoffs.json");
          let handoffs = {};
          try { handoffs = JSON.parse(fs.readFileSync(handoffFile, "utf8")); } catch {}
          const hkey = req.storeId + "|" + jid;
          if (handoffs[hkey] && handoffs[hkey].autoStarted) {
            delete handoffs[hkey];
            atomicFs.writeJsonSync(handoffFile, handoffs);
            console.log(`[booking-handoff-clear] booking=${b.id} status=${newStatus}`);
          }
        } catch (e) { console.warn("[booking-handoff-clear] failed:", e.message); }
      }
    }
  } catch (e) { console.warn("[booking-status-notify] error:", e.message); }

  res.status(200).json(r);
});

router.get("/store/bookings/slots", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const { getAvailableSlots } = require("./bookings");
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const slots = getAvailableSlots(req.storeId, date, {
    durationMin: parseInt(req.query.durationMin) || 30,
    staffId: req.query.staffId || null,
    workStart: store.workingHoursStart || "09:00",
    workEnd: store.workingHoursEnd || "21:00",
  });
  res.json({ ok: true, date, slots });
});

// ─── 🔍 AI Image Search ──────────────────────────────────────────────────────
// POST /store/ai/find-image  { productName }
// يُرجع: { ok, images: [{url, thumb, author, source}] }
router.post("/store/ai/find-image", auth, express.json({ limit: "10kb" }), async (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const productName = String(req.body?.productName || "").trim().slice(0, 100);
  if (!productName) return res.status(400).json({ error: "اسم المنتج مطلوب" });
  const count = Math.min(Math.max(parseInt(req.body?.count) || 6, 1), 10);
  try {
    const { search } = require("./ai-image-search");
    const result = await search(productName, { businessType: store.businessType, count });
    res.json(result);
  } catch (e) {
    console.error("[ai-image-search] failed:", e.message);
    res.status(500).json({ ok: false, error: "فشل البحث: " + e.message });
  }
});

// ─── Business Features Config (per businessType) ────────────────────────────
// يُرجع: extraTabs, productFields, orderFlow, aiImageSearch...
router.get("/store/business-features", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const { getConfig } = require("./business-features-config");
  const cfg = getConfig(store.businessType);
  res.json({
    ok: true,
    businessType: store.businessType,
    config: cfg,
  });
});

// ─── Plan ─────────────────────────────────────────────────────────────────────
router.get("/store/plan", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const plan = getPlan(store.plan);
  const { normalizeTrack } = require("./plans");
  // ⭐ trackOverride للمتجر يتجاوز track الباقة (للماستر فقط)
  const effectiveTrack = store.trackOverride
    ? normalizeTrack(store.trackOverride)
    : normalizeTrack(plan.track);
  res.json({
    plan: plan.id,
    nameAr: plan.nameAr,
    emoji: plan.emoji,
    features: plan.features,
    track: effectiveTrack,                  // المحسوب (override أو من الباقة)
    trackFromPlan: normalizeTrack(plan.track),
    trackOverridden: !!store.trackOverride, // للأدمن يعرف أن المسار مُخصَّص
  });
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
  // 🌙 cutoff للـ "وردية الحالية":
  //   - إذا أُنهي يوم يدوياً → من lastShiftEnd
  //   - وإلا → من 00:00 توقيت الرياض اليوم
  const dailyArchive = require("./daily-archive");
  const lastEnd = dailyArchive.getLastShiftEnd(req.storeId);
  const cutoffTs = lastEnd
    ? new Date(lastEnd).getTime()
    : new Date(today + "T00:00:00Z").getTime() - (3 * 60 * 60 * 1000); // 00:00 Riyadh = 21:00 prev UTC
  const isCurrentShift = (o) => new Date(o.timestamp || 0).getTime() > cutoffTs;
  const todayOr = orders.filter(isCurrentShift);

  // 🌙 الـ Dashboard يعرض الوردية الحالية فقط (تنظّف نفسها تلقائياً يومياً)
  const earningStatuses = new Set(["confirmed", "completed", "delivered", "done"]);
  const earnedToday    = todayOr.filter(o => earningStatuses.has(o.status));

  // Top products لهذه الوردية فقط
  const productCounts = {};
  for (const o of earnedToday) {
    for (const item of (o.items || [])) {
      productCounts[item.name] = (productCounts[item.name] || 0) + (item.qty || 1);
    }
  }
  const topProducts = Object.entries(productCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([name, qty]) => ({ name, qty }));

  // متوسط الطلب + عملاء فريدين (للوردية)
  const uniqueCustomers = new Set(todayOr.map(o => o.customerPhone).filter(Boolean)).size;
  const avgOrder = earnedToday.length
    ? parseFloat((earnedToday.reduce((s,o) => s + (o.total||0), 0) / earnedToday.length).toFixed(2))
    : 0;

  res.json({
    // الوردية الحالية فقط — تنظّف يومياً
    ordersTotal:  todayOr.length,                                // عدد طلبات الوردية
    ordersToday:  todayOr.length,                                // alias للاتساق
    revenueTotal: parseFloat(earnedToday.reduce((s, o) => s + (o.total || 0), 0).toFixed(2)),
    revenueToday: parseFloat(earnedToday.reduce((s, o) => s + (o.total || 0), 0).toFixed(2)),
    pending:      todayOr.filter(o => o.status === "pending_confirmation").length,
    confirmed:    earnedToday.length,
    avgOrder,
    uniqueCustomers,
    topProducts,
    shiftStart:   new Date(cutoffTs).toISOString(),
    manualShift:  !!lastEnd,
  });
});

// ─── Daily Archive — أرشيف يومي + ملخص شهري ────────────────────────────────
router.get("/store/archive/daily", auth, (req, res) => {
  const dailyArchive = require("./daily-archive");
  // الشهر = ?month=YYYY-MM (افتراضي الشهر الحالي بتوقيت الرياض)
  const today = dailyArchive._todayRiyadh();
  const month = req.query.month || today.slice(0, 7);
  const current = dailyArchive.getMonthSummary(req.storeId, month);
  // قارن بالشهر السابق
  const [y, m] = month.split("-").map(Number);
  const prevDate = new Date(y, m - 2, 1);
  const prevMonth = prevDate.toISOString().slice(0, 7);
  const previous = dailyArchive.getMonthSummary(req.storeId, prevMonth);
  // قارن change %
  const pct = (curr, prev) => prev ? Math.round(((curr - prev) / prev) * 100) : (curr > 0 ? 100 : 0);
  res.json({
    month,
    today,
    totals: current.totals,
    days: current.days,
    previousMonth: prevMonth,
    previousTotals: previous.totals,
    change: {
      orders:  pct(current.totals.total, previous.totals.total),
      revenue: pct(current.totals.revenue, previous.totals.revenue),
    },
  });
});

// ═════════ 🪡 AI Menu Import — استيراد منيو من صورة ═════════════════════
// POST /store/menu/ai-import — يحلل الصورة بـ 3 عقول AI ويرجع منيو + diff
// Limit: 4 MB image
router.post("/store/menu/ai-import", auth, async (req, res) => {
  const { imageBase64, mimeType } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== "string") {
    return res.status(400).json({ error: "صورة مطلوبة (base64)" });
  }
  // حد ~4 MB (base64 size > raw size بحوالي 33%)
  if (imageBase64.length > 5_500_000) {
    return res.status(413).json({ error: "حجم الصورة كبير جداً (الحد الأقصى 4MB)" });
  }
  const allowedMime = /^image\/(png|jpeg|jpg|webp)$/i;
  if (mimeType && !allowedMime.test(mimeType)) {
    return res.status(415).json({ error: "نوع غير مدعوم — استخدم PNG/JPG/WebP" });
  }
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  try {
    const aiMenu = require("./ai-menu-import");
    const result = await aiMenu.importMenuFromImage({
      imageBase64,
      mimeType:        mimeType || "image/jpeg",
      existingProducts: store.products || [],
      existingCategories: store.categories || [],
      businessType:    store.businessType || store.adminConfig?.label || "متجر",
      storeName:       store.storeName,
    });
    audit({
      actor: { type: "store", id: req.storeId },
      action: "menu.ai-import",
      meta:   { new: result.diff.summary.new, updated: result.diff.summary.updated, unchanged: result.diff.summary.unchanged },
    }, req);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("[ai-import] failed:", e.message);
    res.status(500).json({ error: e.message || "فشل تحليل الصورة" });
  }
});

// POST /store/menu/ai-apply — يطبق النتائج المختارة (يضيف/يحدّث المنيو)
router.post("/store/menu/ai-apply", auth, (req, res) => {
  const { newItems = [], updatedItems = [], newCategories = [] } = req.body || {};
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const products   = [...(store.products || [])];
  const categories = [...(store.categories || [])];

  // أضف الأقسام الجديدة (mapping tempId → realId)
  const catIdMap = new Map();
  for (const nc of newCategories) {
    if (!nc?.name) continue;
    const realId = "c_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    categories.push({ id: realId, name: String(nc.name).trim().slice(0, 80), emoji: String(nc.emoji || "🍽️").slice(0, 8) });
    if (nc._tempId) catIdMap.set(nc._tempId, realId);
  }

  // أضف المنتجات الجديدة
  let added = 0;
  for (const item of newItems) {
    if (!item?.name) continue;
    const catId = catIdMap.get(item.categoryId) || item.categoryId || (categories[0]?.id || "");
    // 🪡 صورة مقتطعة من المنيو (لو AI استخرجها)
    const croppedImg = String(item._croppedImageUrl || "").trim();
    const isValidCrop = croppedImg.startsWith("/store-images/");
    // 📐 sizes/variants: قبول وتنظيف
    const cleanSizes = Array.isArray(item.sizes)
      ? item.sizes
          .map(s => ({ label: String(s?.label || "").trim().slice(0, 40), price: Number(s?.price) || 0 }))
          .filter(s => s.label && s.price > 0)
          .slice(0, 8)
      : [];
    products.push({
      id:           "p_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      name:         String(item.name).trim().slice(0, 120),
      price:        Number(item.price) || (cleanSizes[0]?.price || 0),
      description:  String(item.description || "").trim().slice(0, 500),
      category:     catId,
      available:    true,
      images:       isValidCrop ? [croppedImg] : [],
      imageUrl:     isValidCrop ? croppedImg : null,
      sizes:        cleanSizes,
      stock:        null,
      priceOnRequest: !!item.priceOnRequest,
    });
    added++;
  }

  // طبّق التحديثات (السعر/الاسم)
  let updated = 0;
  for (const up of updatedItems) {
    const idx = products.findIndex(p => p.id === up.id);
    if (idx < 0) continue;
    if (up.newPrice !== undefined && Number(up.newPrice) > 0) products[idx].price = Number(up.newPrice);
    if (up.newName) products[idx].name = String(up.newName).trim().slice(0, 120);
    updated++;
  }

  updateStore(req.storeId, { products, categories });
  audit({
    actor: { type: "store", id: req.storeId },
    action: "menu.ai-apply",
    meta:   { added, updated, newCats: newCategories.length },
  }, req);
  res.json({ ok: true, added, updated, newCats: newCategories.length });
});

// ═════════ 🤖 Bot Questions — الأسئلة الديناميكية لكل بيزنس ═════════════
const DEFAULT_QUESTIONS_BY_TYPE = {
  delivery: [
    { id: "location", label: "العنوان", prompt: "📍 *أرسل موقعك من واتساب أو اكتب الحي/العنوان*", type: "location", required: true },
    { id: "schedule", label: "وقت الاستلام", prompt: "🕐 *متى تريد التوصيل؟*\nاكتب: *الان* أو الوقت المرغوب", type: "schedule", required: true },
  ],
  cafe: [
    { id: "location", label: "العنوان", prompt: "📍 *أرسل موقعك للتوصيل*", type: "location", required: true },
    { id: "schedule", label: "وقت التوصيل", prompt: "🕐 *متى تريد التوصيل؟*", type: "schedule", required: true },
    { id: "notes", label: "ملاحظات", prompt: "📝 *أي ملاحظات؟* (سكر/حليب/...)\nاكتب *تخطي* لو لا يوجد", type: "text", required: false },
  ],
  pickup: [
    { id: "schedule", label: "وقت الاستلام", prompt: "🕐 *متى ستمر لاستلام طلبك؟*\nاكتب: *الان* أو الوقت", type: "schedule", required: true },
  ],
  homeService: [
    { id: "location", label: "موقع الخدمة", prompt: "📍 *أرسل موقع المنزل/المكان*", type: "location", required: true },
    { id: "schedule", label: "موعد الخدمة", prompt: "📅 *متى تريد الخدمة؟*", type: "schedule", required: true },
    { id: "phone_extra", label: "رقم احتياطي", prompt: "📞 *رقم احتياطي للتواصل* (اختياري — اكتب تخطي)", type: "phone", required: false },
  ],
  walkin: [
    { id: "schedule", label: "موعد الزيارة", prompt: "📅 *متى تريد الحجز؟*\nمثلاً: غداً 5 مساءً", type: "schedule", required: true },
    { id: "notes", label: "ملاحظات", prompt: "📝 *أي تفضيلات؟* (اختياري — اكتب تخطي)", type: "text", required: false },
  ],
  software: [
    { id: "project_desc", label: "وصف المشروع", prompt: "💼 *اشرح مشروعك باختصار*\nماذا تحتاج؟ ما الهدف؟", type: "text", required: true },
    { id: "github_link", label: "رابط/ملف", prompt: "🔗 *لو يوجد رابط GitHub أو ملفات شاركها* (اختياري — اكتب تخطي)", type: "text", required: false },
    { id: "budget", label: "الميزانية", prompt: "💰 *ميزانيتك التقريبية؟* (بالأرقام أو 'نناقش')", type: "text", required: false },
    { id: "deadline", label: "الموعد النهائي", prompt: "📅 *موعد التسليم المطلوب؟*", type: "text", required: false },
  ],
  consultation: [
    { id: "topic", label: "موضوع الاستشارة", prompt: "🧠 *ما موضوع استشارتك؟*", type: "text", required: true },
    { id: "schedule", label: "وقت الاتصال", prompt: "📅 *متى تريد الاتصال؟*", type: "schedule", required: true },
    { id: "phone_extra", label: "رقم التواصل", prompt: "📞 *أفضل رقم للتواصل*", type: "phone", required: false },
  ],
  salon: [
    { id: "service_type", label: "نوع الخدمة", prompt: "💅 *ما الخدمة المطلوبة؟*\n(مثلاً: قص، صبغة، باديكير...)", type: "text", required: true },
    { id: "schedule", label: "موعد الحجز", prompt: "📅 *متى تريد الموعد؟*", type: "schedule", required: true },
  ],
  // 💊 صيدلية
  pharmacy: [
    { id: "location", label: "العنوان", prompt: "📍 *أرسل موقعك للتوصيل*", type: "location", required: true },
    { id: "schedule", label: "وقت التوصيل", prompt: "🕐 *متى تريد الاستلام؟*", type: "schedule", required: true },
    { id: "prescription", label: "وصفة طبية", prompt: "💊 *لو الطلب يحتاج وصفة، صورّها وأرسلها* (اختياري — اكتب تخطي)", type: "text", required: false },
  ],
  // 🛒 بقالة
  grocery: [
    { id: "location", label: "العنوان", prompt: "📍 *أرسل موقعك للتوصيل*", type: "location", required: true },
    { id: "schedule", label: "وقت التوصيل", prompt: "🕐 *متى تريد التوصيل؟*", type: "schedule", required: true },
    { id: "notes", label: "ملاحظات", prompt: "📝 *أي طلبات إضافية؟* (اختياري — اكتب تخطي)", type: "text", required: false },
  ],
  // 🎮 شحن ألعاب — كود رقمي فوري، لا يحتاج عنوان/موعد
  gaming_topup: [
    { id: "game_id", label: "ID اللعبة", prompt: "🎮 *أرسل ID اللاعب أو رقم الحساب*", type: "text", required: true },
    { id: "notes", label: "ملاحظات", prompt: "📝 *ملاحظات* (اختياري — اكتب تخطي)", type: "text", required: false },
  ],
  // 🌹 ورد وهدايا
  florist: [
    { id: "location", label: "العنوان", prompt: "📍 *أرسل موقع التوصيل*", type: "location", required: true },
    { id: "schedule", label: "موعد التوصيل", prompt: "📅 *متى يصل الورد؟*", type: "schedule", required: true },
    { id: "recipient_name", label: "اسم المستلم", prompt: "👤 *اسم من سيستلم الهدية؟*", type: "text", required: false },
    { id: "card_message", label: "بطاقة مع الهدية", prompt: "💌 *رسالة على البطاقة؟* (اختياري — اكتب تخطي)", type: "text", required: false },
  ],
  gift_shop: [
    { id: "location", label: "العنوان", prompt: "📍 *أرسل موقع التوصيل*", type: "location", required: true },
    { id: "schedule", label: "موعد التوصيل", prompt: "📅 *متى يصل؟*", type: "schedule", required: true },
    { id: "recipient_name", label: "اسم المستلم", prompt: "👤 *اسم المستلم؟* (اختياري — اكتب تخطي)", type: "text", required: false },
  ],
  // 👕 ملابس + 📱 إلكترونيات
  clothing: [
    { id: "location", label: "العنوان", prompt: "📍 *أرسل موقع التوصيل*", type: "location", required: true },
    { id: "size_notes", label: "المقاس/الملاحظات", prompt: "📏 *المقاس/اللون المفضل؟* (اختياري — اكتب تخطي)", type: "text", required: false },
  ],
  electronics: [
    { id: "location", label: "العنوان", prompt: "📍 *أرسل موقع التوصيل*", type: "location", required: true },
    { id: "notes", label: "ملاحظات", prompt: "📝 *ملاحظات على الطلب؟* (اختياري — اكتب تخطي)", type: "text", required: false },
  ],
  // 🎉 مناسبات
  event: [
    { id: "event_date", label: "تاريخ المناسبة", prompt: "📅 *ما تاريخ المناسبة؟*", type: "schedule", required: true },
    { id: "location", label: "موقع المناسبة", prompt: "📍 *أين تقام المناسبة؟*", type: "location", required: true },
    { id: "guests_count", label: "عدد الضيوف", prompt: "👥 *كم عدد الضيوف المتوقع؟*", type: "number", required: false },
    { id: "notes", label: "تفاصيل إضافية", prompt: "📝 *أي تفاصيل إضافية؟* (اختياري — اكتب تخطي)", type: "text", required: false },
  ],
  // 🔑 تأجير
  // 🔑 تأجير عام (أدوات/سيارات/أزياء) + 🏠 عقارات (شاليهات/منازل/استراحات)
  // الأسئلة الموحّدة تخدم النوعين — العميل يحدد تاريخ بداية ونهاية
  rental: [
    { id: "check_in",  label: "تاريخ الاستلام/الوصول",  prompt: "📅 *تاريخ الاستلام أو الوصول؟*\nاكتب مثل: 1 أغسطس 2026", type: "date", required: true },
    { id: "check_out", label: "تاريخ التسليم/المغادرة", prompt: "📅 *تاريخ التسليم أو المغادرة؟*\nاكتب مثل: 5 أغسطس 2026", type: "date", required: true },
    { id: "guests",    label: "عدد الأشخاص",           prompt: "👥 *كم عدد الأشخاص؟* (للعقارات)\nاكتب رقم — أو *تخطي*", type: "number", required: false },
    { id: "purpose",   label: "ملاحظات إضافية",         prompt: "📝 *أي ملاحظات أو تفضيلات؟* (اختياري — اكتب *تخطي*)", type: "text", required: false },
  ],
  // 🛠️ خدمات أخرى
  dineIn: [
    { id: "schedule", label: "وقت الحضور", prompt: "🕐 *متى ستحضر؟*", type: "schedule", required: true },
    { id: "guests_count", label: "عدد الأشخاص", prompt: "👥 *كم شخص؟*", type: "number", required: false },
  ],
  onSite: [
    { id: "location", label: "موقع الخدمة", prompt: "📍 *أرسل موقعك*", type: "location", required: true },
    { id: "schedule", label: "موعد الخدمة", prompt: "📅 *متى تريد الخدمة؟*", type: "schedule", required: true },
  ],
  remote: [
    { id: "topic", label: "وصف المطلوب", prompt: "💼 *اشرح المطلوب باختصار*", type: "text", required: true },
    { id: "schedule", label: "موعد التسليم", prompt: "📅 *موعد التسليم المطلوب؟*", type: "text", required: false },
  ],
  projectBased: [
    { id: "topic", label: "وصف المشروع", prompt: "📂 *اشرح مشروعك*", type: "text", required: true },
    { id: "budget", label: "الميزانية", prompt: "💰 *الميزانية التقريبية؟* (أو 'نناقش')", type: "text", required: false },
    { id: "deadline", label: "موعد التسليم", prompt: "📅 *موعد التسليم؟*", type: "text", required: false },
  ],
  booking: [
    { id: "schedule", label: "موعد الحجز", prompt: "📅 *متى تريد الموعد؟*", type: "schedule", required: true },
    { id: "notes", label: "ملاحظات", prompt: "📝 *تفضيلات أو ملاحظات؟* (اختياري — اكتب تخطي)", type: "text", required: false },
  ],
  courses: [
    { id: "topic", label: "الدورة المطلوبة", prompt: "🎓 *ما الدورة التي تهمك؟*", type: "text", required: true },
    { id: "schedule", label: "الوقت المفضّل", prompt: "📅 *متى تستطيع الحضور؟*", type: "schedule", required: false },
  ],
  oneOnOne: [
    { id: "topic", label: "موضوع الجلسة", prompt: "🎯 *موضوع الجلسة؟*", type: "text", required: true },
    { id: "schedule", label: "وقت الجلسة", prompt: "📅 *متى تريد الجلسة؟*", type: "schedule", required: true },
  ],
};

// 🔄 يحوّل businessType العربي إلى key معروف في DEFAULT_QUESTIONS_BY_TYPE
function _normalizeBizKey(btype) {
  if (!btype) return "delivery";
  const t = String(btype).toLowerCase();
  // أنواع التأجير/الإقامة → كلها rental
  if (t.includes("تأجير") || t.includes("شاليه") || t.includes("منزل") || t.includes("استراحة") || t.includes("فيلا") || t.includes("فلل") || t === "rental") return "rental";
  if (t.includes("مناسبة") || t.includes("مناسبات") || t.includes("قاعة") || t === "event") return "event";
  if (t.includes("ورد") || t.includes("زهور") || t === "florist") return "florist";
  if (t.includes("هدايا") || t === "gift_shop") return "gift_shop";
  if (t.includes("شحن") || t === "gaming_topup") return "gaming_topup";
  if (t.includes("صيدلية") || t === "pharmacy") return "pharmacy";
  if (t.includes("بقالة") || t === "grocery") return "grocery";
  if (t.includes("صالون") || t === "salon") return "salon";
  if (t.includes("ملابس") || t === "clothing") return "clothing";
  if (t.includes("إلكترون") || t.includes("الكترون") || t === "electronics") return "electronics";
  if (t === "كافيه" || t === "مطعم" || t === "مخبز" || t === "حلويات" || t === "cafe") return "cafe";
  return DEFAULT_QUESTIONS_BY_TYPE[t] ? t : "delivery";
}

function _getStoreQuestions(store, btype) {
  let fields;
  if (store?.botQuestions?.fields && Array.isArray(store.botQuestions.fields) && store.botQuestions.fields.length) {
    fields = store.botQuestions.fields;
  } else {
    const key = _normalizeBizKey(btype);
    fields = DEFAULT_QUESTIONS_BY_TYPE[key] || DEFAULT_QUESTIONS_BY_TYPE.delivery;
  }
  // اضمن enabled: true لكل سؤال لم يحدد قيمته (backward compat)
  return fields.map(f => ({ enabled: true, ...f }));
}

// ⚡ للبوت: يرجع فقط الأسئلة المفعّلة (enabled !== false)
//
// 🎯 قاعدة صارمة (2026-07-04): أسئلة المتجر المخصصة تُحترم بالكامل بلا فلترة تلقائية.
//     المتجر أضاف السؤال عمداً → البوت يسأله. إذا لم يرد المتجر، يعطّله (enabled=false).
//
// الفلترة التلقائية (order_type/table_number/payment) تُطبَّق **فقط** على الأسئلة الافتراضية
// (لما المتجر ما حفظ botQuestions.fields من الأدمن). سبب: الافتراضية تولّد لكل نوع بيزنس
// وقد تحتوي حقول لا يريدها المتجر.
function _getActiveStoreQuestions(store, btype) {
  // 🎯 لو المتجر حفظ أسئلته المخصصة → ارجعها كما هي (فقط enabled فلترة)
  const hasCustom = !!(store?.botQuestions?.fields && Array.isArray(store.botQuestions.fields) && store.botQuestions.fields.length);
  if (hasCustom) {
    return store.botQuestions.fields
      .map(f => ({ enabled: true, ...f }))
      .filter(f => f.enabled !== false);
  }
  // ⚡ الافتراضية: نطبق الفلترة التلقائية (كما كانت)
  const all = _getStoreQuestions(store, btype).filter(f => f.enabled !== false);
  const hasPayments = Array.isArray(store?.paymentMethods) && store.paymentMethods.length > 0;
  const btypeStr = String(store?.businessType || btype || "").toLowerCase();
  const isRestaurantLike = /مطعم|كافيه|cafe|restaurant|مخبز|حلويات|bakery|sweets/.test(btypeStr);

  return all.filter(f => {
    const id = String(f.id || "").toLowerCase();
    const label = String(f.label || "").toLowerCase();
    const prompt = String(f.prompt || "").toLowerCase();
    const text = `${id} ${label} ${prompt}`;

    if (isRestaurantLike) {
      if (id.includes("order_type") || id.includes("table_number")) return false;
      if (/نوع الطلب|تقديم في المطعم|للشحن|للتوصيل أم|توصيل أم|استلام أم|طاولة أم/.test(text)) return false;
      if (/رقم الطاولة|اختر طاولة/.test(text)) return false;
    }
    if (!hasPayments && (id.includes("payment") || id.includes("paymentmethod") || /طريقة الدفع|طرق الدفع|كيف تريد أن تدفع|كاش أم|تحويل أم/.test(text))) return false;

    return true;
  });
}

// GET /store/bot-questions — يقرأ الأسئلة الحالية (أو default إن لم تُحفظ)
router.get("/store/bot-questions", auth, (req, res) => {
  const store = getStore(req.storeId);
  const btype = store?.businessType || "delivery";
  const fields = _getStoreQuestions(store, btype);
  res.json({
    fields,
    businessType: btype,
    source: store?.botQuestions?.fields ? "custom" : "default",
  });
});

// PUT /store/bot-questions — حفظ الأسئلة المعدّلة
router.put("/store/bot-questions", auth, (req, res) => {
  const { fields } = req.body || {};
  if (!Array.isArray(fields)) return res.status(400).json({ error: "fields يجب أن يكون مصفوفة" });
  const ALLOWED_TYPES = ["location", "schedule", "text", "number", "choice", "phone", "date"];
  const clean = [];
  for (const f of fields.slice(0, 12)) {
    if (!f || typeof f !== "object") continue;
    const id = String(f.id || "").trim().slice(0, 50).replace(/[^a-zA-Z0-9_]/g, "_");
    if (!id) continue;
    const label = String(f.label || "").trim().slice(0, 80);
    const prompt = String(f.prompt || "").trim().slice(0, 500);
    const type = ALLOWED_TYPES.includes(f.type) ? f.type : "text";
    if (!label || !prompt) continue;
    const item = {
      id, label, prompt, type,
      required: !!f.required,
      enabled:  f.enabled !== false, // افتراضي مفعّل
    };
    if (type === "choice" && Array.isArray(f.options)) {
      item.options = f.options.slice(0, 10).map(o => String(o).slice(0, 80));
    }
    clean.push(item);
  }
  const data = readStores();
  const idx = data.stores.findIndex(s => s.id === req.storeId);
  if (idx < 0) return res.status(404).json({ error: "المتجر غير موجود" });
  data.stores[idx].botQuestions = { fields: clean, updatedAt: new Date().toISOString() };
  writeStores(data);
  audit({
    actor: req.impersonatedBy ? { type: "master", id: "master" } : { type: "store", id: req.storeId },
    action: "bot-questions.update",
    target: { type: "store", id: req.storeId },
    meta: { count: clean.length },
  }, req);
  res.json({ ok: true, fields: clean });
});

// ─── 📝 Bot Messages — تحكم كامل في كل رسالة يقولها البوت ───────────────────
// GET /store/bot-messages — يرجّع كل الرسائل المتاحة + مخصّصات المتجر
router.get("/store/bot-messages", auth, (req, res) => {
  const store = getStore(req.storeId);
  const { listAll } = require("./bot-messages");
  const custom = (store?.botMessages && typeof store.botMessages === "object") ? store.botMessages : {};
  const entries = listAll().map(e => ({
    ...e,
    custom: custom[e.key] || "",
    isCustomized: !!custom[e.key],
  }));
  // تجميع حسب الفئة للـ UI
  const byCategory = {};
  for (const e of entries) {
    if (!byCategory[e.category]) byCategory[e.category] = [];
    byCategory[e.category].push(e);
  }
  res.json({ entries, byCategory, totalCustom: Object.keys(custom).length });
});

// PUT /store/bot-messages — حفظ الرسائل المخصصة
// body: { messages: { "cart.empty": "نصي المخصص", ... } }
router.put("/store/bot-messages", auth, (req, res) => {
  const { messages } = req.body || {};
  if (!messages || typeof messages !== "object" || Array.isArray(messages)) {
    return res.status(400).json({ error: "messages يجب أن يكون object" });
  }
  const { REGISTRY, sanitize } = require("./bot-messages");
  const clean = {};
  const rejected = [];
  for (const [key, txt] of Object.entries(messages)) {
    if (!REGISTRY[key]) { rejected.push(key); continue; }
    const t = sanitize(txt);
    if (t) clean[key] = t; // فارغ = رجوع للـ default
  }
  const data = readStores();
  const idx = data.stores.findIndex(s => s.id === req.storeId);
  if (idx < 0) return res.status(404).json({ error: "المتجر غير موجود" });
  data.stores[idx].botMessages = clean;
  writeStores(data);
  audit({
    actor: req.impersonatedBy ? { type: "master", id: "master" } : { type: "store", id: req.storeId },
    action: "bot-messages.update",
    target: { type: "store", id: req.storeId },
    meta: { count: Object.keys(clean).length, rejected: rejected.length },
  }, req);
  res.json({ ok: true, count: Object.keys(clean).length, rejected });
});

// POST /store/bot-questions/generate — يُولّد أسئلة بالـ AI حسب نوع البيزنس
// ─── 📩 AI-generated booking messages (للحجوزات) ────────────────────────────
router.post("/store/booking-messages/generate", auth, async (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const btype = store?.businessType || "rental";
  const storeName = store?.storeName || "المتجر";
  const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
  if (!GROQ_API_KEY) return res.status(500).json({ ok: false, error: "AI غير مهيأ (GROQ_API_KEY)" });

  const prompt = `أنت خبير في كتابة رسائل واتساب احترافية للأعمال السعودية.
المتجر: "${storeName}" — نوع: ${btype}

اكتب 7 رسائل لرحلة حجز كاملة بأسلوب سعودي طبيعي + emojis مناسبة.
استخدم placeholders داخل الرسائل: {{customerName}} {{storeName}} {{unitName}} {{checkIn}} {{checkOut}} {{date}} {{time}} {{total}} {{nights}}

أعد JSON صرف بالشكل:
{
  "bookingAckTemplate":       "رسالة عند استلام طلب الحجز (فوري)",
  "bookingConfirmedTemplate": "رسالة عند تأكيد الإدارة للحجز",
  "reminder_24hTemplate":     "تذكير قبل 24 ساعة من الموعد",
  "reminder_dayTemplate":     "تذكير صباح يوم الحجز (8 ص)",
  "reminder_1hTemplate":      "تذكير قبل ساعة من الموعد",
  "bookingRejectedTemplate":  "رسالة عند رفض/إلغاء الحجز",
  "bookingCompletedTemplate": "رسالة بعد انتهاء الحجز (شكر + دعوة للعودة)"
}

قواعد:
- كل رسالة عربية فصيحة + لمسة محلية سعودية
- 3-8 أسطر لكل رسالة (لا طويلة جداً)
- emoji في البداية + 1-2 في الجسم
- استخدم placeholders لتخصيص الرسالة
- لا تستخدم رمز \\n حرفياً — استخدم newlines فعلية في JSON`;

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2500,
        temperature: 0.4,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      const txt = await r.text();
      return res.status(500).json({ ok: false, error: `Groq ${r.status}: ${txt.slice(0,150)}` });
    }
    const data = await r.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);
    const ALLOWED = ["bookingAckTemplate","bookingConfirmedTemplate","reminder_24hTemplate","reminder_dayTemplate","reminder_1hTemplate","bookingRejectedTemplate","bookingCompletedTemplate"];
    const messages = {};
    for (const k of ALLOWED) {
      if (typeof parsed[k] === "string" && parsed[k].trim().length > 5) {
        messages[k] = parsed[k].slice(0, 1500);
      }
    }
    if (!Object.keys(messages).length) return res.status(500).json({ ok: false, error: "AI لم يولّد رسائل صالحة" });

    // احفظ تلقائياً
    const updates = {};
    for (const k of ALLOWED) if (messages[k]) updates[k] = messages[k];
    updateStore(req.storeId, updates);
    res.json({ ok: true, messages, source: "ai" });
  } catch (e) {
    console.error("[booking-messages/generate]", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/store/bot-questions/generate", auth, async (req, res) => {
  const store = getStore(req.storeId);
  const btype = store?.businessType || "delivery";
  const storeName = store?.storeName || "المتجر";
  const businessDesc = req.body?.description || `${storeName} (${btype})`;

  try {
    const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
    if (!GROQ_API_KEY) {
      // لا AI → ارجع defaults حسب النوع
      return res.json({ fields: DEFAULT_QUESTIONS_BY_TYPE[btype] || DEFAULT_QUESTIONS_BY_TYPE.delivery, source: "default" });
    }
    const prompt = `أنت خبير في تصميم بوتات WhatsApp تجارية. للنشاط:
"${businessDesc}"
نوع: ${btype}

اقترح 3-6 أسئلة يسألها البوت للعميل بعد اختياره من المنيو لإكمال الطلب.
أعد JSON صرف:
{
  "fields": [
    {"id":"slug_eng","label":"عنوان السؤال بالعربي","prompt":"النص الكامل الذي يُرسله البوت (مع emoji)","type":"location|schedule|text|number|choice|phone|date","required":true|false,"options":["خيار1","خيار2"]}
  ]
}

قواعد:
- لا تطلب العنوان لنشاطات لا تحتاج (مثل برمجة، استشارات هاتفية)
- اطلب التفاصيل التي يحتاجها المتجر فعلاً
- prompt يكون عربي طبيعي مع emoji واحد
- options فقط لو type="choice"
- id لاتيني snake_case
- 3-6 أسئلة كحد أقصى`;

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 800,
        temperature: 0.3,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      console.warn(`[bot-questions/generate] AI HTTP ${r.status}`);
      return res.json({ fields: DEFAULT_QUESTIONS_BY_TYPE[btype] || DEFAULT_QUESTIONS_BY_TYPE.delivery, source: "default_fallback" });
    }
    const data = await r.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed.fields)) throw new Error("invalid fields");
    res.json({ fields: parsed.fields.slice(0, 12), source: "ai" });
  } catch (e) {
    console.warn(`[bot-questions/generate] failed: ${e.message}`);
    res.json({
      fields: DEFAULT_QUESTIONS_BY_TYPE[btype] || DEFAULT_QUESTIONS_BY_TYPE.delivery,
      source: "default_fallback",
      error: e.message,
    });
  }
});

// ⚠️ Note: module.exports._getStoreQuestions منقول لنهاية الملف (بعد module.exports=router) لتفادي الـ overwrite

// POST /store/archive/force — اختبار يدوي (يأرشف أمس فوراً)
router.post("/store/archive/force-yesterday", auth, (req, res) => {
  const dailyArchive = require("./daily-archive");
  const yest = dailyArchive._yesterdayRiyadh();
  const result = dailyArchive.archiveDay(req.storeId, yest);
  res.json({ ok: true, date: yest, saved: !!result, snapshot: result });
});

// 🌙 POST /store/shift/end — يدوي: "إنهاء اليوم" قبل منتصف الليل
router.post("/store/shift/end", auth, (req, res) => {
  const dailyArchive = require("./daily-archive");
  const result = dailyArchive.endDayNow(req.storeId);
  audit({
    actor: req.impersonatedBy ? { type: "master", id: "master" } : { type: "store", id: req.storeId },
    action: "shift.end",
    target: { type: "store", id: req.storeId },
    meta: { saved: result.saved, ordersCount: result.snapshot ? result.snapshot.total : 0 },
  }, req);
  res.json({
    ok: true,
    saved: result.saved,
    merged: result.merged || false,
    reason: result.reason || null,
    snapshot: result.snapshot || null,
    message: result.saved
      ? `تم إنهاء اليوم وحفظ ${result.snapshot.total} طلب في الأرشيف. الداشبورد سيبدأ من الصفر للوردية الجديدة.`
      : "تم إنهاء اليوم. لا توجد طلبات جديدة منذ آخر إغلاق.",
  });
});

// GET /store/shift/status — آخر إغلاق + ساعات منذ آخر إغلاق
router.get("/store/shift/status", auth, (req, res) => {
  const dailyArchive = require("./daily-archive");
  const last = dailyArchive.getLastShiftEnd(req.storeId);
  const minutesSince = last ? Math.floor((Date.now() - new Date(last).getTime()) / 60000) : null;
  res.json({ lastShiftEnd: last, minutesSince });
});

// ─── KPI endpoint — يخدم كل أنواع البيزنس (services/projects/cafe/restaurant…)
router.get("/store/kpi", auth, (req, res) => {
  const allOrders = readOrders(req.storeId);
  const orders = allOrders.filter(o => !o._test);
  const today = new Date().toISOString().slice(0, 10);
  const monthPrefix = today.slice(0, 7);

  const earned = new Set(["confirmed", "completed", "delivered", "done"]);
  const active = new Set(["pending_confirmation", "confirmed", "preparing", "out_for_delivery", "in_progress", "ready_pickup", "awaiting_review"]);
  const completed = new Set(["completed", "delivered", "done", "tasleem"]);

  let revenueTotal = 0, revenueMonth = 0;
  let hoursTotal = 0;
  let pendingInvoices = 0;
  const customers = new Set();
  let activeProjects = 0;
  let completedCount = 0;

  for (const o of orders) {
    const ts = (o.timestamp || "").slice(0, 10);
    const isEarn = earned.has(o.status);
    const total = Number(o.total || 0);
    if (isEarn) revenueTotal += total;
    if (isEarn && ts.startsWith(monthPrefix)) revenueMonth += total;
    if (active.has(o.status)) activeProjects++;
    if (completed.has(o.status)) completedCount++;
    if (o.status === "pending_confirmation") pendingInvoices++;
    if (o.customerPhone) customers.add(String(o.customerPhone));
    // hours من items meta لو موجودة (للخدمات الساعية)
    for (const it of (o.items || [])) {
      const h = Number(it.hours || it.duration || 0);
      if (!isNaN(h) && h > 0) hoursTotal += h * (it.qty || 1);
    }
  }

  // متوسط التقييم
  let rating = 0, ratingsCount = 0;
  try {
    const { getStoreSummary } = require("./ratings");
    const s = getStoreSummary(req.storeId);
    rating = Number(s.average || 0);
    ratingsCount = Number(s.count || 0);
  } catch {}

  const todayOr = orders.filter(o => (o.timestamp || "").slice(0, 10) === today);
  const monthOr = orders.filter(o => (o.timestamp || "").slice(0, 10).startsWith(monthPrefix));

  res.json({
    // متاجر/مطاعم/كافيهات
    orders:        orders.length,
    ordersToday:   todayOr.length,
    ordersMonth:   monthOr.length,
    products:      0, // (يتم تعبئتها من tab المنتجات منفصلاً)
    sales:         parseFloat(revenueTotal.toFixed(2)),
    salesToday:    parseFloat(todayOr.filter(o => earned.has(o.status)).reduce((s, o) => s + Number(o.total || 0), 0).toFixed(2)),
    salesMonth:    parseFloat(revenueMonth.toFixed(2)),
    avgOrder:      orders.length ? parseFloat((revenueTotal / orders.length).toFixed(2)) : 0,
    // خدمات/برمجة/استشارات
    projects:      activeProjects,
    completed:     completedCount,
    hours:         parseFloat(hoursTotal.toFixed(1)),
    invoices:      pendingInvoices,
    // عام
    customers:     customers.size,
    rating:        rating ? rating.toFixed(1) : "0.0",
    ratingsCount,
    pending:       pendingInvoices,
  });
});

// ─── Store Settings — مع validation للقيم ─────────────────────────────────────
const SETTING_VALIDATORS = {
  // ⚠️ storeName + currency + businessType لا يجوز إفراغها (تكسر هوية المتجر)
  storeName:          v => { const s = String(v || "").trim().slice(0, 100); return s.length >= 2 ? s : null; },
  currency:           v => { const s = String(v || "").trim().slice(0, 10); return s.length >= 1 ? s : null; },
  deliveryFee:        v => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 && n < 10000 ? n : null; },
  // يقبل HH:MM (مفضّل) أو رقم 0-24 (backward compat)
  workingHoursStart:  v => {
    if (typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v.trim())) return v.trim().padStart(5, "0");
    const n = parseFloat(v); return Number.isFinite(n) && n >= 0 && n <= 24 ? n : null;
  },
  workingHoursEnd:    v => {
    if (typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v.trim())) return v.trim().padStart(5, "0");
    const n = parseFloat(v); return Number.isFinite(n) && n >= 0 && n <= 24 ? n : null;
  },
  welcomeMessage:     v => String(v || "").slice(0, 2000),
  thankYouMessage:    v => String(v || "").slice(0, 1500),
  apologyMessage:     v => String(v || "").slice(0, 1500),
  // 🏖️ Welcome template للحجوزات (rental/event)
  welcomeTemplate:    v => String(v || "").slice(0, 3000),
  checkInTime:        v => String(v || "").trim().slice(0, 50),
  checkOutTime:       v => String(v || "").trim().slice(0, 50),
  galleryUrl:         v => { const s = String(v || "").trim(); if (!s) return ""; try { new URL(s); return s.slice(0, 500); } catch { return null; } },
  rules:              v => String(v || "").slice(0, 2000),
  // 📩 Booking templates (7 رسائل لرحلة الحجز)
  bookingAckTemplate:       v => String(v || "").slice(0, 1500),
  bookingConfirmedTemplate: v => String(v || "").slice(0, 1500),
  bookingRejectedTemplate:  v => String(v || "").slice(0, 1500),
  bookingCompletedTemplate: v => String(v || "").slice(0, 1500),
  reminder_24hTemplate:     v => String(v || "").slice(0, 1500),
  reminder_dayTemplate:     v => String(v || "").slice(0, 1500),
  reminder_1hTemplate:      v => String(v || "").slice(0, 1500),
  // 🛵 قوالب رسائل حالات الطلب (تدعم {{storeName}} + {{driverPhone}} + {{orderId}})
  outForDeliveryTemplate:   v => String(v || "").slice(0, 1500),
  preparingTemplate:        v => String(v || "").slice(0, 1500),
  readyPickupTemplate:      v => String(v || "").slice(0, 1500),
  // 🎨 Menu Pro theme
  // ⚡ "" = auto-detect (يحذف القيمة → السيرفر يستخدم default للنشاط)
  menuTheme:                v => (v === "" || v == null) ? "" : ((v === "pro" || v === "classic") ? v : null),
  menuThemeName:            v => (v === "" || v == null) ? "" : (["maroon","coffee","forest","midnight","sunset","royal","achay"].includes(v) ? v : null),
  // 🔗 رابط المشاركة العام (uniqueness يُفحص في endpoint منفصل)
  shareSlug:                v => {
    if (v === "" || v == null) return "";
    const s = String(v).toLowerCase().trim();
    if (!/^[a-z0-9][a-z0-9-]{2,18}[a-z0-9]$/.test(s)) return null;
    // كلمات محجوزة
    const reserved = ["admin","master","api","health","health","store","stores","static","public","menu","menu-pro","o","t","m","do","c","try","order","preview","master","support","tickets","ticket","onboarding","login","logout","webhook","webhooks","salla","instagram","ig","facebook","fb","whatsapp","wa","tiktok","snap","snapchat","twitter","x","youtube","yt","cdn","www","mail","email","help","faq","about","contact","privacy","terms","blog","news","app","apps","mobile","ios","android","root","null","undefined","test","demo"];
    if (reserved.includes(s)) return null;
    return s;
  },
  shareWelcomeText:         v => String(v || "").slice(0, 200),
  heroImageUrl:             v => {
    const s = String(v || "").trim();
    if (!s) return "";
    if (s.startsWith("/store-images/") || s.startsWith("/uploads/")) return s.slice(0, 500);
    try { new URL(s); return s.slice(0, 500); } catch { return null; }
  },
  instagramUrl:             v => { const s=String(v||"").trim(); if(!s)return ""; try{new URL(s);return s.slice(0,300);}catch{return null;} },
  twitterUrl:               v => { const s=String(v||"").trim(); if(!s)return ""; try{new URL(s);return s.slice(0,300);}catch{return null;} },
  tiktokUrl:                v => { const s=String(v||"").trim(); if(!s)return ""; try{new URL(s);return s.slice(0,300);}catch{return null;} },
  snapchatUrl:              v => { const s=String(v||"").trim(); if(!s)return ""; try{new URL(s);return s.slice(0,300);}catch{return null;} },
  googleMapsUrl:            v => { const s=String(v||"").trim(); if(!s)return ""; try{new URL(s);return s.slice(0,500);}catch{return null;} },
  // 🍽️ Dine-in tables (طاولات الصالة) — كل طاولة لها رقم وقسم وميزات
  diningTables:             v => {
    if (!Array.isArray(v)) return null;
    const seen = new Set();
    const out = [];
    for (const t of v.slice(0, 100)) {
      if (!t || typeof t !== "object") continue;
      const num = parseInt(t.num, 10);
      if (!Number.isFinite(num) || num < 1 || num > 999) continue;
      if (seen.has(num)) continue; // لا تكرار للأرقام
      seen.add(num);
      out.push({
        num,
        section: String(t.section || "").trim().slice(0, 30),
        area:    String(t.area    || "").trim().slice(0, 30),
        note:    String(t.note    || "").trim().slice(0, 60),
      });
    }
    return out;
  },
  // null/فارغ مقبول (يعني "احذف القيمة" — استخدم الافتراضي)
  invoiceColor:       v => v == null || v === "" ? "" : (/^#[0-9a-f]{3,8}$/i.test(String(v)) ? v : null),
  themeAccent:        v => v == null || v === "" ? "" : (/^(#[0-9a-f]{3,8}|var\(--[a-z0-9-]+\)|rgba?\([^)]+\))$/i.test(String(v)) ? v : null),
  themeText:          v => v == null || v === "" ? "" : (/^(#[0-9a-f]{3,8}|var\(--[a-z0-9-]+\))$/i.test(String(v)) ? v : null),
  themeTextMute:      v => v == null || v === "" ? "" : (/^(#[0-9a-f]{3,8}|var\(--[a-z0-9-]+\))$/i.test(String(v)) ? v : null),
  menuMode:           v => v === "dark" || v === "light" ? v : null,
  invoiceTemplate:    v => ["classic","minimal","bold","elegant","saudi_royal","minimal_mono","warm"].includes(v) ? v : null,
  // 🍽️ إضافات عامة — كل إضافة لها productIds (فارغة = كل المنتجات)
  globalModifiers:    v => {
    if (!Array.isArray(v)) return null;
    return v
      .map(m => ({
        name:  String(m?.name  || "").trim().slice(0, 60),
        price: Math.max(0, Number(m?.price) || 0),
        productIds: Array.isArray(m?.productIds)
          ? m.productIds.filter(id => typeof id === "string" && id.length < 100).slice(0, 200)
          : [],
      }))
      .filter(m => m.name)
      .slice(0, 30);
  },
  // 🚫 مكونات قابلة للإزالة عامة — مع productIds
  globalRemovableIngredients: v => {
    if (!Array.isArray(v)) return null;
    const seen = new Set();
    return v
      .map(it => ({
        name: String(it?.name || "").trim().slice(0, 50),
        productIds: Array.isArray(it?.productIds)
          ? it.productIds.filter(id => typeof id === "string" && id.length < 100).slice(0, 200)
          : [],
      }))
      .filter(it => {
        if (!it.name || seen.has(it.name)) return false;
        seen.add(it.name);
        return true;
      })
      .slice(0, 30);
  },
  // ⭐ تفعيل/إلغاء طلب التقييم بعد التسليم (default: true)
  enableRatings: v => (v === false || v === "false" || v === 0 || v === "0") ? false : true,
  // ✍️ تفعيل/إلغاء الكتابة الحرة للطلب (AI free-text) (default: true)
  enableFreeTextOrder: v => (v === false || v === "false" || v === 0 || v === "0") ? false : true,
  // 🤝 وضع "المالك يتحكم": البوت يستلم الطلب ويصمت، المالك يكلم العميل مباشرة (default: false)
  botSilentAfterOrder: v => v === true || v === "true" || v === 1 || v === "1",
  // 🎨 صفحة استعراض المنتجات — تخصيصات
  showcaseTheme:    v => {
    const allowed = ["royal", "elegance", "midnight"];
    const s = String(v || "").trim().toLowerCase();
    return allowed.includes(s) ? s : "royal";
  },
  showcaseTitle:    v => v == null || v === "" ? "" : String(v).trim().slice(0, 80),
  showcaseSubtitle: v => v == null || v === "" ? "" : String(v).trim().slice(0, 160),
  showcaseEnabled:  v => v !== false && v !== "false",
  // 📝 رسائل البوت المخصصة (per-message override) — object { "key": "text", ... }
  botMessages: v => {
    if (v == null || v === "") return {};
    if (typeof v !== "object" || Array.isArray(v)) return null;
    const { REGISTRY, sanitize } = require("./bot-messages");
    const clean = {};
    for (const [key, txt] of Object.entries(v)) {
      if (!REGISTRY[key]) continue; // مفتاح غير معرّف — تجاهل
      const t = sanitize(txt);
      if (t) clean[key] = t; // فارغ = رجوع للـ default
    }
    return clean;
  },
  businessType:       v => { const s = String(v || "").trim().slice(0, 50); return s.length >= 2 ? s : null; },
  invoiceLogoUrl:     v => {
    const s = String(v || "").trim();
    if (!s) return "";
    if (s.startsWith("/store-images/") || s.startsWith("/uploads/")) return s.slice(0, 500);
    try { new URL(s); return s.slice(0, 500); } catch { return null; }
  },
  logoUrl:            v => {
    const s = String(v || "").trim();
    if (!s) return "";
    if (s.startsWith("/store-images/") || s.startsWith("/uploads/")) return s.slice(0, 500);
    try { new URL(s); return s.slice(0, 500); } catch { return null; }
  },
  // 🖼️ صورة منيو جاهزة (اختيارية — backward compat) — العميل يختار بينها وبين المنيو التفاعلي
  menuImageUrl:       v => {
    const s = String(v || "").trim();
    if (!s) return "";
    if (s.startsWith("/store-images/") || s.startsWith("/uploads/")) return s.slice(0, 500);
    try { new URL(s); return s.slice(0, 500); } catch { return null; }
  },
  // 📄 صفحات المنيو الجاهزة — array من URLs (صور PNG/JPG أو PDF)
  //   لو مرفوعة، تظهر في صفحة عرض بأنيميشن تقليب صفحات
  menuFiles:          v => {
    if (v == null || v === "") return [];
    if (!Array.isArray(v)) return [];
    return v
      .map(u => String(u || "").trim())
      .filter(u => u.startsWith("/store-images/") || u.startsWith("/uploads/") || /^https?:\/\//i.test(u))
      .map(u => u.slice(0, 500))
      .slice(0, 30); // حد أقصى 30 صفحة
  },
  address:            v => String(v || "").trim().slice(0, 300),
  locationMapUrl:     v => { try { new URL(v); return String(v).slice(0, 500); } catch { return v === "" ? "" : null; } },
  requireConfirmation: v => v === true || v === "true" || v === 1,
  enableWebview:      v => v !== false && v !== "false",
  enableNumeric:      v => v !== false && v !== "false",
  enableAI:           v => v !== false && v !== "false",
  enableCoupons:      v => v !== false && v !== "false",
  // 💳 Payment methods
  payCash:            v => v !== false && v !== "false",
  payBank:            v => v === true || v === "true" || v === 1,
  payBankName:        v => String(v || "").trim().slice(0, 80),
  payBankHolder:      v => String(v || "").trim().slice(0, 100),
  payBankIban:        v => String(v || "").trim().toUpperCase().slice(0, 40),
  payStc:             v => v === true || v === "true" || v === 1,
  payStcPhone:        v => String(v || "").replace(/\D/g, "").slice(0, 15),
  // 🎁 Gift wrapping (florist)
  giftWrapping:       v => v === true || v === "true" || v === 1,
  giftWrappingFee:    v => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : 0; },
  // 🚨 Low stock threshold (gaming)
  lowStockThreshold:  v => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : 5; },
  avgDeliveryMin:     v => { if (v === null || v === "" || v === undefined) return null; const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 && n <= 300 ? n : null; },
  // 🕐 وحدة وقت التنفيذ: minute | hour | day (default: minute للتوافق)
  deliveryTimeUnit:   v => {
    const s = String(v || "").trim().toLowerCase();
    return ["minute", "hour", "day"].includes(s) ? s : "minute";
  },
  // 🕐 قيمة الوقت (يقرأ من نفس الحقل — نستخدم avgDeliveryMin كـ raw number مهما كانت الوحدة)
  // لا حقل إضافي — الفرق في العرض فقط عبر deliveryTimeUnit
  // 📍 مناطق التوصيل (delivery zones): [{name, fee}] — يستبدل deliveryFee الرقم الوحيد
  //   إذا فارغ → يستخدم deliveryFee للتوافق
  deliveryZones:      v => {
    if (v == null || v === "") return [];
    if (!Array.isArray(v)) return [];
    return v
      .map(z => ({
        name: String(z?.name || "").trim().slice(0, 60),
        fee:  Math.max(0, Number(z?.fee) || 0),
      }))
      .filter(z => z.name)
      .slice(0, 30);
  },
  // 🚴 مندوبو التوصيل — [{ id, name, phone }]
  //   المتجر يحفظ قائمة، لما يريد إرسال طلب لمندوب يختار من dropdown بدل كتابة الرقم
  deliveryAgents:     v => {
    if (v == null || v === "") return [];
    if (!Array.isArray(v)) return [];
    return v
      .map(a => {
        const rawPhone = String(a?.phone || "").replace(/\D/g, "").slice(0, 15);
        return {
          id:    String(a?.id || `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`).slice(0, 40),
          name:  String(a?.name || "").trim().slice(0, 60),
          phone: rawPhone,
          notes: String(a?.notes || "").trim().slice(0, 200), // اختياري (سيارة، ملاحظات)
        };
      })
      .filter(a => a.name && a.phone && /^\d{8,15}$/.test(a.phone))
      .slice(0, 50);
  },
  // 🛒 حد أدنى للطلب (0 = بلا حد)
  minOrder:           v => { if (v === null || v === "" || v === undefined) return 0; const n = parseFloat(v); return Number.isFinite(n) && n >= 0 && n < 100000 ? n : 0; },
  // ✨ شعار قصير تحت اسم المتجر (يظهر في المنيو)
  tagline:            v => v == null || v === "" ? "" : String(v).trim().slice(0, 160),
  // 🛠️ Maintenance mode — per-store عزل كامل
  maintenanceMode:    v => v === true || v === "true" || v === 1 || v === "1",
  maintenanceMessage: v => v == null || v === "" ? "" : String(v).slice(0, 800),
  maintenanceUntil:   v => {
    if (v == null || v === "") return "";
    const s = String(v).trim();
    // يقبل ISO أو datetime-local "YYYY-MM-DDTHH:mm"
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  },
};

// ترجمة أسماء الحقول لـ user-friendly في الـ warnings
const FIELD_LABELS_AR = {
  storeName: "اسم المتجر", currency: "العملة", deliveryFee: "رسوم التوصيل",
  workingHoursStart: "وقت الفتح", workingHoursEnd: "وقت الإقفال",
  welcomeMessage: "رسالة الترحيب", thankYouMessage: "رسالة الشكر",
  apologyMessage: "رسالة الاعتذار",
  invoiceColor: "لون الفاتورة", themeAccent: "لون التمييز",
  themeText: "لون النص", themeTextMute: "لون النص الثانوي",
  menuMode: "وضع القائمة", invoiceTemplate: "قالب الفاتورة",
  businessType: "نوع النشاط", invoiceLogoUrl: "شعار الفاتورة",
  logoUrl: "شعار المتجر", address: "العنوان", locationMapUrl: "رابط الخريطة",
  requireConfirmation: "تأكيد الطلب", enableWebview: "تفعيل الويب",
  enableFreeTextOrder: "الكتابة الحرة",
  enableNumeric: "تفعيل الأرقام", enableAI: "تفعيل الذكاء",
  enableCoupons: "تفعيل الكوبونات", avgDeliveryMin: "وقت التوصيل المتوقع",
  minOrder: "الحد الأدنى للطلب", tagline: "شعار المتجر",
};

// Best-effort save: نحفظ الصالح، نُبلغ بالفاشل فقط (بدل رفض الكل)
router.put("/store/settings", auth, (req, res) => {
  const updates = {};
  const failed  = [];   // [{ field, label, reason }]
  const saved   = [];   // أسماء الحقول التي حُفظت
  for (const [key, validator] of Object.entries(SETTING_VALIDATORS)) {
    if (req.body[key] === undefined) continue;
    let cleaned;
    try { cleaned = validator(req.body[key]); }
    catch (e) { cleaned = null; }
    if (cleaned === null) {
      failed.push({ field: key, label: FIELD_LABELS_AR[key] || key, value: req.body[key] });
    } else {
      updates[key] = cleaned;
      saved.push(key);
    }
  }
  // احفظ المقبول حتى لو هناك فاشل
  let updated = null;
  if (Object.keys(updates).length) {
    updated = updateStore(req.storeId, updates);
    if (!updated) return res.status(404).json({ error: "المتجر غير موجود" });
  }
  // إن لم يُحفظ شيء وكل الحقول فشلت → 400
  if (!saved.length && failed.length) {
    return res.status(400).json({
      ok: false,
      error: "لم يُحفظ أي حقل — كل القيم غير صالحة",
      failed,
      savedCount: 0,
    });
  }
  // نجاح كامل أو جزئي
  res.json({
    ok: true,
    savedCount: saved.length,
    saved,
    failed,
    partial: failed.length > 0,
  });
});

// ─── Products ─────────────────────────────────────────────────────────────────
router.get("/store/products", auth, (req, res) => {
  const store = getStore(req.storeId);
  res.json({ products: store?.products || [], categories: store?.categories || [] });
});

// 🏠 sanitize للـ accommodation (اختياري — null لو غير عقار)
const ACCOMMODATION_AMENITIES = ["wifi","pool","bbq","parking","kitchen","ac","heater","tv","washer","balcony","garden","seaview","jacuzzi","gym"];
function _sanitizeAccommodation(input) {
  if (!input || typeof input !== "object") return null;
  const safeInt = (v, max) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
  };
  const out = {};
  if (input.bedrooms  != null) out.bedrooms  = safeInt(input.bedrooms,  20);
  if (input.bathrooms != null) out.bathrooms = safeInt(input.bathrooms, 20);
  if (input.maxGuests != null) out.maxGuests = safeInt(input.maxGuests, 200);
  if (input.sizeM2    != null) out.sizeM2    = safeInt(input.sizeM2, 10000);
  if (input.minNights != null) out.minNights = safeInt(input.minNights, 365) || 1;
  if (Array.isArray(input.amenities)) {
    out.amenities = input.amenities
      .filter(a => ACCOMMODATION_AMENITIES.includes(a))
      .slice(0, ACCOMMODATION_AMENITIES.length);
  }
  if (input.location)     out.location     = String(input.location).trim().slice(0, 200);
  if (input.checkInTime)  out.checkInTime  = String(input.checkInTime).match(/^\d{1,2}:\d{2}$/) ? input.checkInTime.padStart(5,"0") : "15:00";
  if (input.checkOutTime) out.checkOutTime = String(input.checkOutTime).match(/^\d{1,2}:\d{2}$/) ? input.checkOutTime.padStart(5,"0") : "12:00";
  if (input.cancellationPolicy && ["flexible","moderate","strict"].includes(input.cancellationPolicy)) {
    out.cancellationPolicy = input.cancellationPolicy;
  }
  return Object.keys(out).length ? out : null;
}

router.post("/store/products", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  // sizes: مصفوفة اختيارية من { label, price }
  const cleanSizes = Array.isArray(req.body.sizes)
    ? req.body.sizes
        .map(s => ({ label: String(s?.label || "").trim(), price: Number(s?.price) || 0 }))
        .filter(s => s.label && s.price > 0)
    : [];

  // 🍽️ modifiers (toppings) — مصفوفة اختيارية من { name, price }
  const cleanModifiers = Array.isArray(req.body.modifiers)
    ? req.body.modifiers
        .map(m => ({ name: String(m?.name || "").trim().slice(0, 60), price: Math.max(0, Number(m?.price) || 0) }))
        .filter(m => m.name)
        .slice(0, 20) // حد 20 modifier لكل منتج
    : [];

  // 🚫 removableIngredients — مكونات قابلة للإزالة (Phase 1)
  // مثلاً: ["سلطة", "باذنجان", "خيار"] — الزبون يطلب "بدون سلطة"
  const cleanRemovable = Array.isArray(req.body.removableIngredients)
    ? Array.from(new Set(
        req.body.removableIngredients
          .map(s => typeof s === "string" ? s.trim().slice(0, 50) : "")
          .filter(s => s.length > 0)
      )).slice(0, 20)
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
    price:         req.body.priceOnRequest ? 0 : (parseFloat(req.body.price) || 0),
    priceOnRequest: !!req.body.priceOnRequest,
    images:        cleanImages,                          // ⭐ جديد: array
    imageUrl:      cleanImages[0] || null,               // backward compat (الصورة الرئيسية)
    videoUrl:      sanitizeVideoUrl(req.body.videoUrl),
    videoCaption:  String(req.body.videoCaption || "").trim().slice(0, 200),
    available:     true,
    sizes:         cleanSizes,
    modifiers:     cleanModifiers,
    removableIngredients: cleanRemovable,
    stock:         cleanStock,
    customFields:  (req.body.customFields && typeof req.body.customFields === "object") ? req.body.customFields : {},
    // 🎁 v3: حقول المنتج الرقمي
    productType:       req.body.productType === "digital" ? "digital" : "physical",
    digitalContent:    String(req.body.digitalContent || "").slice(0, 2000),
    vipLink:           String(req.body.vipLink || "").slice(0, 500),
    deliveryMode:      req.body.deliveryMode === "auto" ? "auto" : "manual",
    requireCodePool:   !!req.body.requireCodePool,
    subscriptionDays:  Math.max(0, parseInt(req.body.subscriptionDays, 10) || 0),
    // 🏠 accommodation (للـ rental) — اختياري كلياً
    accommodation:     _sanitizeAccommodation(req.body.accommodation),
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
  // 🏠 accommodation: لو مرسلة، نظّف؛ لو null صراحة → احذف
  if (patch.accommodation !== undefined) {
    patch.accommodation = patch.accommodation === null ? null : _sanitizeAccommodation(patch.accommodation);
  }
  // 🍽️ modifiers (toppings)
  if (Array.isArray(patch.modifiers)) {
    patch.modifiers = patch.modifiers
      .map(m => ({ name: String(m?.name || "").trim().slice(0, 60), price: Math.max(0, Number(m?.price) || 0) }))
      .filter(m => m.name)
      .slice(0, 20);
  }
  // 🚫 removableIngredients (Phase 1)
  if (Array.isArray(patch.removableIngredients)) {
    patch.removableIngredients = Array.from(new Set(
      patch.removableIngredients
        .map(s => typeof s === "string" ? s.trim().slice(0, 50) : "")
        .filter(s => s.length > 0)
    )).slice(0, 20);
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
  // 🎨 isShowcaseOnly — عرض بلا سعر/زر (للأعمال، معرض الصور، الفيديوهات)
  if (patch.isShowcaseOnly !== undefined) {
    patch.isShowcaseOnly = patch.isShowcaseOnly === true || patch.isShowcaseOnly === "true" || patch.isShowcaseOnly === 1;
  }
  // 🧪 مقادير سحرية (showcase-only) — [{ name, emoji, note }]
  if (patch.showcaseIngredients !== undefined) {
    patch.showcaseIngredients = Array.isArray(patch.showcaseIngredients)
      ? patch.showcaseIngredients
          .map(i => ({
            name:  String(i?.name || "").trim().slice(0, 60),
            emoji: String(i?.emoji || "✨").trim().slice(0, 8) || "✨",
            note:  String(i?.note || "").trim().slice(0, 100),
          }))
          .filter(i => i.name)
          .slice(0, 20)
      : [];
  }
  // 🎁 v3: حقول المنتج الرقمي
  if (patch.productType !== undefined)      patch.productType = patch.productType === "digital" ? "digital" : "physical";
  if (patch.digitalContent !== undefined)   patch.digitalContent = String(patch.digitalContent || "").slice(0, 2000);
  if (patch.vipLink !== undefined)          patch.vipLink = String(patch.vipLink || "").slice(0, 500);
  if (patch.deliveryMode !== undefined)     patch.deliveryMode = patch.deliveryMode === "auto" ? "auto" : "manual";
  if (patch.requireCodePool !== undefined)  patch.requireCodePool = !!patch.requireCodePool;
  if (patch.subscriptionDays !== undefined) patch.subscriptionDays = Math.max(0, parseInt(patch.subscriptionDays, 10) || 0);
  // 💬 priceOnRequest: لو true → احفظ price = 0
  if (patch.priceOnRequest !== undefined) {
    patch.priceOnRequest = !!patch.priceOnRequest;
    if (patch.priceOnRequest) patch.price = 0;
  }
  if (patch.price !== undefined && !patch.priceOnRequest) patch.price = parseFloat(patch.price) || 0;

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
  if (s.length > 500) return null;
  // ✅ نقبل: (1) روابط داخلية للفيديو المرفوع محلياً /store-videos/xxx.mp4
  //          (2) روابط خارجية http/https (YouTube، Vimeo، Drive، CDN)
  if (s.startsWith("/store-videos/") && /^[\/a-zA-Z0-9._-]+$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (!["http:", "https:"].includes(u.protocol)) return null;
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

// ─── Digital Products Code Pool ──────────────────────────────────────────────
// إدارة مخزون الأكواد الرقمية لكل منتج (للمنتجات بـ productType=digital)
const digital = require("./digital-products");

function _findDigitalProduct(store, productId) {
  const product = (store.products || []).find(p => p.id === productId);
  if (!product) return { error: "المنتج غير موجود", status: 404 };
  if (product.productType !== "digital") return { error: "هذا المنتج ليس رقمياً", status: 400 };
  return { product };
}

// POST /store/products/:id/codes  — رفع جماعي (paste-bulk)
// Body: { codes: ["A1","B2",...] }  أو  { text: "A1\nB2\n..." }
router.post("/store/products/:id/codes", auth, express.json({ limit: "1mb" }), (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const check = _findDigitalProduct(store, req.params.id);
  if (check.error) return res.status(check.status).json({ error: check.error });

  let codes = [];
  if (Array.isArray(req.body?.codes)) {
    codes = req.body.codes;
  } else if (typeof req.body?.text === "string") {
    codes = req.body.text.split(/\r?\n/);
  }
  codes = codes.map(c => String(c || "").trim()).filter(Boolean);
  if (!codes.length) return res.status(400).json({ error: "أرسل قائمة أكواد (codes أو text)" });
  if (codes.length > 5000) return res.status(400).json({ error: "حد أقصى 5000 كود في الدفعة الواحدة" });

  const result = digital.addCodes(req.storeId, req.params.id, codes);
  res.json({ ok: true, ...result, stock: digital.getStock(req.storeId, req.params.id) });
});

// GET /store/products/:id/codes  — قائمة الأكواد + سجل التسليم (محدود لحماية الأداء)
// Query: ?limit=100  (افتراضي 100، حد أقصى 500)
router.get("/store/products/:id/codes", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const check = _findDigitalProduct(store, req.params.id);
  if (check.error) return res.status(check.status).json({ error: check.error });

  const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
  const pool = digital.readPool(req.storeId, req.params.id);
  res.json({
    ok: true,
    stock: { available: pool.codes.length, delivered: pool.delivered.length },
    available: pool.codes.slice(0, limit),
    delivered: digital.getDeliveryHistory(req.storeId, req.params.id, limit),
  });
});

// GET /store/products/:id/codes/stock  — العدد فقط (lightweight لـ polling)
router.get("/store/products/:id/codes/stock", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const check = _findDigitalProduct(store, req.params.id);
  if (check.error) return res.status(check.status).json({ error: check.error });

  res.json({ ok: true, ...digital.getStock(req.storeId, req.params.id) });
});

// DELETE /store/products/:id/codes/:code  — حذف كود واحد من المخزون المتاح
// (لا يحذف من delivered — سجل التسليم محفوظ كـ audit)
router.delete("/store/products/:id/codes/:code", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const check = _findDigitalProduct(store, req.params.id);
  if (check.error) return res.status(check.status).json({ error: check.error });

  const targetCode = decodeURIComponent(req.params.code);
  const pool = digital.readPool(req.storeId, req.params.id);
  const before = pool.codes.length;
  pool.codes = pool.codes.filter(c => c !== targetCode);
  const removed = before - pool.codes.length;
  if (!removed) return res.status(404).json({ error: "الكود غير موجود في المخزون المتاح" });

  digital.writePool(req.storeId, req.params.id, pool);
  res.json({ ok: true, removed, stock: { available: pool.codes.length, delivered: pool.delivered.length } });
});

// ─── Important Links (روابط الموردين / لينكات مهمة per-store) ────────────────
// تُخزَّن في store.customFields.gamingLinks[]
function _validateUrl(u) {
  try { const x = new URL(String(u || "").trim()); return ["http:", "https:"].includes(x.protocol) ? x.toString() : null; }
  catch { return null; }
}
function _readLinks(store) {
  const cf = store.customFields || {};
  return Array.isArray(cf.gamingLinks) ? cf.gamingLinks : [];
}
function _writeLinks(storeId, store, links) {
  const cf = { ...(store.customFields || {}), gamingLinks: links };
  updateStore(storeId, { customFields: cf });
}

// GET /store/links — قائمة الروابط (pinned أولاً، ثم بتاريخ الإنشاء)
router.get("/store/links", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const links = _readLinks(store).slice().sort((a, b) => {
    if ((a.pinned ? 1 : 0) !== (b.pinned ? 1 : 0)) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });
  res.json({ ok: true, links });
});

// POST /store/links — إضافة رابط
router.post("/store/links", auth, express.json({ limit: "100kb" }), (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const name = String(req.body?.name || "").trim().slice(0, 100);
  const url = _validateUrl(req.body?.url);
  if (!name) return res.status(400).json({ error: "الاسم مطلوب" });
  if (!url) return res.status(400).json({ error: "رابط غير صحيح (http/https فقط)" });
  const links = _readLinks(store);
  if (links.length >= 200) return res.status(400).json({ error: "حد أقصى 200 رابط" });
  const link = {
    id: require("crypto").randomUUID(),
    name,
    url,
    category: String(req.body?.category || "").trim().slice(0, 60),
    notes: String(req.body?.notes || "").trim().slice(0, 500),
    pinned: !!req.body?.pinned,
    createdAt: new Date().toISOString(),
  };
  links.push(link);
  _writeLinks(req.storeId, store, links);
  res.json({ ok: true, link });
});

// PUT /store/links/:id — تعديل
router.put("/store/links/:id", auth, express.json({ limit: "100kb" }), (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const links = _readLinks(store);
  const idx = links.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "الرابط غير موجود" });
  const patch = req.body || {};
  if (patch.name !== undefined) links[idx].name = String(patch.name).trim().slice(0, 100);
  if (patch.url !== undefined) {
    const u = _validateUrl(patch.url);
    if (!u) return res.status(400).json({ error: "رابط غير صحيح" });
    links[idx].url = u;
  }
  if (patch.category !== undefined) links[idx].category = String(patch.category).trim().slice(0, 60);
  if (patch.notes !== undefined) links[idx].notes = String(patch.notes).trim().slice(0, 500);
  if (patch.pinned !== undefined) links[idx].pinned = !!patch.pinned;
  _writeLinks(req.storeId, store, links);
  res.json({ ok: true, link: links[idx] });
});

// DELETE /store/links/:id
router.delete("/store/links/:id", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const links = _readLinks(store);
  const next = links.filter(l => l.id !== req.params.id);
  if (next.length === links.length) return res.status(404).json({ error: "الرابط غير موجود" });
  _writeLinks(req.storeId, store, next);
  res.json({ ok: true, removed: 1 });
});

// ─── Bulk import default categories (للبيزنس type جديد) ──────────────────────
// Body: { categories: [{ name, emoji, subCategories?: [{ name, emoji }] }] }
// لا يستبدل الأقسام الموجودة — يضيف فقط (skip لو نفس الاسم موجود)
router.post("/store/categories/import-bulk", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const incoming = Array.isArray(req.body?.categories) ? req.body.categories : [];
  if (!incoming.length) return res.status(400).json({ error: "لا توجد أقسام للاستيراد" });

  const existing = store.categories || [];
  const existingNames = new Set(existing.map(c => String(c.name || "").trim().toLowerCase()));

  let added = 0, skipped = 0;
  const newCats = [];
  let counter = Date.now();

  for (const cat of incoming) {
    const name = String(cat?.name || "").trim().slice(0, 60);
    if (!name) { skipped++; continue; }
    if (existingNames.has(name.toLowerCase())) { skipped++; continue; }

    const newCat = {
      id: "cat_" + (counter++),
      name,
      emoji: String(cat?.emoji || "📋").trim().slice(0, 8),
    };

    // subCategories اختيارية
    if (Array.isArray(cat?.subCategories) && cat.subCategories.length) {
      newCat.subCategories = cat.subCategories
        .map(s => ({
          id:    "sub_" + (counter++),
          name:  String(s?.name || "").trim().slice(0, 60),
          emoji: String(s?.emoji || "🏷️").trim().slice(0, 8),
          active: true,
        }))
        .filter(s => s.name);
    }

    newCats.push(newCat);
    existingNames.add(name.toLowerCase());
    added++;
  }

  if (!added) return res.json({ ok: true, added: 0, skipped, categories: existing });

  const categories = [...existing, ...newCats];
  updateStore(req.storeId, { categories });
  audit({ actor: { type: "store", id: req.storeId }, action: "categories.import_bulk", meta: { added, skipped } }, req);

  res.json({ ok: true, added, skipped, categories });
});

// ─── Categories ───────────────────────────────────────────────────────────────
// helper: يقبل icon URL داخلي (/store-images/...) فقط (يمنع SSRF + injection)
function _validCategoryIcon(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > 200) return null;
  if (s.startsWith("/store-images/") && /^[\/a-zA-Z0-9._-]+$/.test(s)) return s;
  return null;
}

router.post("/store/categories", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const cats = store.categories || [];
  const cat = {
    id: "cat_" + Date.now(),
    name:  String(req.body.name  || "").trim().slice(0, 60),
    emoji: String(req.body.emoji || "🍽️").trim().slice(0, 8),
    icon:  _validCategoryIcon(req.body.icon),
    sortOrder: cats.length, // يُضاف لآخر القائمة
  };
  if (!cat.name) return res.status(400).json({ error: "اسم الصنف مطلوب" });
  const categories = [...cats, cat];
  updateStore(req.storeId, { categories });
  res.json({ ok: true, category: cat });
});

// PUT /store/categories/:id — تعديل اسم/إيموجي/أيقونة الصنف
router.put("/store/categories/:id", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const categories = store.categories || [];
  const idx = categories.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "الصنف غير موجود" });

  const patch = {};
  if (req.body.name  !== undefined) patch.name  = String(req.body.name  || "").trim().slice(0, 60);
  if (req.body.emoji !== undefined) patch.emoji = String(req.body.emoji || "").trim().slice(0, 8);
  if (req.body.icon  !== undefined) patch.icon  = _validCategoryIcon(req.body.icon); // null لإزالة
  if (patch.name === "") return res.status(400).json({ error: "اسم الصنف لا يمكن أن يكون فارغاً" });

  categories[idx] = { ...categories[idx], ...patch };
  updateStore(req.storeId, { categories });
  res.json({ ok: true, category: categories[idx] });
});

// POST /store/categories/reorder — يُعيد ترتيب الأصناف
// body: { order: ["cat_1", "cat_2", "cat_3"] }
router.post("/store/categories/reorder", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const newOrder = Array.isArray(req.body?.order) ? req.body.order.map(String) : [];
  if (!newOrder.length) return res.status(400).json({ error: "ترتيب فارغ" });
  const cats = store.categories || [];
  // build map من الـ id إلى category، ثم رتب حسب newOrder، وأضف ما تبقى في النهاية
  const byId = new Map(cats.map(c => [String(c.id), c]));
  const ordered = [];
  newOrder.forEach((id, i) => {
    if (byId.has(id)) { ordered.push({ ...byId.get(id), sortOrder: i }); byId.delete(id); }
  });
  // أي categories لم تكن في newOrder تُضاف لآخر القائمة (حماية ضد فقدان بيانات)
  let i = ordered.length;
  byId.forEach(c => ordered.push({ ...c, sortOrder: i++ }));
  updateStore(req.storeId, { categories: ordered });
  res.json({ ok: true, count: ordered.length });
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
    storeName:    store.storeName || "",
    storeType:    store.storeType || store.businessType || "",
    businessType: store.businessType || "",
    adminConfig:  store.adminConfig || null,
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
    // نحفظ plain أيضاً عشان الماستر يقدر يشوفها للدعم حتى لو غيّرها المتجر
    updateStore(req.storeId, { storePassword: hash, storePasswordPlain: String(newPassword) });

    // ⚡ زامن Firestore بالـ plain (الـ upsert يـ hash داخلياً) لمنع قبول الباس القديمة عبر Firestore login
    firestoreAuth.upsertStoreAdmin({
      storeId:            req.storeId,
      phone:              store.ownerPhone || "",
      password:           String(newPassword),
      storeName:          store.storeName || "",
      subscriptionStatus: store.subscriptionStatus || "active",
      active:             store.active !== false,
    }).catch(e => console.warn("Firestore password sync error:", e.message));

    // ألغِ كل الـ tokens القديمة لهذا المتجر ما عدا الحالي → يُجبر إعادة الدخول بالباس الجديدة
    const currentToken = req.headers["x-store-token"];
    let revoked = 0;
    for (const [tk, val] of sessions) {
      if (val.storeId === req.storeId && tk !== currentToken) {
        sessions.delete(tk); revoked++;
      }
    }
    if (revoked > 0) _saveStoreSessions();

    audit({ actor: { type: "store", id: req.storeId }, action: "password.change", meta: { revokedSessions: revoked } }, req);
    res.json({ ok: true, revokedSessions: revoked });
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
    scope:          ["cart","bot","both"].includes(b.scope) ? b.scope : "both",
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
  if (b.scope !== undefined)           patch.scope    = ["cart","bot","both"].includes(b.scope) ? b.scope : "both";
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

// 📖 رفع ملف منيو (صورة أو PDF) — للمنيو الجاهز
router.post("/store/upload-menu-file", auth, (req, res) => {
  const { base64, ext = "jpg" } = req.body || {};
  if (!base64) return res.status(400).json({ error: "لا يوجد ملف" });

  const safeStoreId = sanitizeStoreIdForFilename(req.storeId);
  if (!safeStoreId) return res.status(400).json({ error: "معرّف المتجر غير صالح" });

  // 12MB يكفي لمنيو PDF ذو صور عالية أو صور 4K
  const r = decodeAndVerifyBase64(base64, ext, 12 * 1024 * 1024, "menu");
  if (!r.ok) return res.status(400).json({ error: r.error });

  const filename  = `${safeStoreId}_menu_${Date.now()}.${r.ext}`;
  const imagesDir = path.join(DATA_DIR, "images");
  const filepath  = path.join(imagesDir, filename);

  try {
    fs.mkdirSync(imagesDir, { recursive: true });
    const resolved = path.resolve(filepath);
    if (!resolved.startsWith(path.resolve(imagesDir) + path.sep)) {
      return res.status(400).json({ error: "مسار غير مسموح" });
    }
    fs.writeFileSync(filepath, r.buffer);
    res.json({ ok: true, url: `/store-images/${filename}`, type: r.ext });
  } catch (err) {
    console.error("Menu upload error:", err.message);
    res.status(500).json({ error: "فشل رفع الملف" });
  }
});

// ════════════════════════════════════════════════════════════════════════
// 📸 AI Vision per Category — استخراج منتجات قسم من صورة رف واحدة
// ════════════════════════════════════════════════════════════════════════

const categoryVision = require("./category-vision");

// POST /store/categories/:catId/ai-extract
// Body: { base64, ext, subCategoryId? }
// يحلل الصورة + يقص صور المنتجات + يرجع candidates للمراجعة (بدون حفظ)
router.post("/store/categories/:catId/ai-extract", auth, async (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const { base64, ext = "jpg", subCategoryId } = req.body || {};
  if (!base64) return res.status(400).json({ error: "صورة الرف مطلوبة" });

  // تحقق من القسم
  const cat = (store.categories || []).find(c => c.id === req.params.catId);
  if (!cat) return res.status(404).json({ error: "القسم غير موجود" });

  // تحقق من الـ sub لو مرر
  let sub = null;
  if (subCategoryId) {
    sub = (cat.subCategories || []).find(s => s.id === subCategoryId);
    if (!sub) return res.status(404).json({ error: "الصنف الفرعي غير موجود" });
  }

  // verify image
  const safeStoreId = sanitizeStoreIdForFilename(req.storeId);
  if (!safeStoreId) return res.status(400).json({ error: "معرّف المتجر غير صالح" });
  const r = decodeAndVerifyBase64(base64, ext, 5 * 1024 * 1024, "image");
  if (!r.ok) return res.status(400).json({ error: r.error });

  try {
    // 1) استخرج المنتجات من AI
    const result = await categoryVision.extractProductsFromCategoryImage({
      imageBase64:    r.buffer.toString("base64"),
      mimeType:       `image/${r.ext}`,
      categoryName:   cat.name,
      subCategoryName: sub?.name || "",
      businessType:   store.businessType || store.storeType || "",
      storeName:      store.storeName || "",
    });

    if (!result.items?.length) {
      return res.json({ ok: true, items: [], message: "لم يتم اكتشاف منتجات في الصورة" });
    }

    // 2) قصّ الصور — احفظها في مجلد crops مؤقت
    const cropsDir = path.join(DATA_DIR, "images", "ai-crops", safeStoreId);
    const cropped = await categoryVision.cropProducts({
      imageBuffer: result.imageBuffer,
      items:       result.items,
      outputDir:   cropsDir,
    });

    // 3) رد للمراجعة
    const items = cropped.map((it, idx) => ({
      _tempId:    `tmp_${Date.now()}_${idx}`,
      name:       it.name,
      brand:      it.brand,
      size:       it.size,
      price:      it.price,
      confidence: it.confidence,
      croppedUrl: it.croppedPath ? `/store-images/ai-crops/${safeStoreId}/${it.croppedPath}` : null,
    }));

    audit({
      actor: { type: "store", id: req.storeId },
      action: "category.ai_extract",
      target: { type: "category", id: cat.id },
      meta: { items: items.length, subCategory: sub?.name },
    }, req);

    res.json({
      ok: true,
      categoryName: cat.name,
      subCategoryName: sub?.name || "",
      items,
      imageSize: { width: result.imageWidth, height: result.imageHeight },
    });
  } catch (e) {
    console.error("[ai-extract] failed:", e.message);
    res.status(500).json({ error: "فشل تحليل الصورة: " + e.message });
  }
});

// POST /store/categories/:catId/ai-extract/commit
// Body: { subCategoryId?, items: [{ name, brand, size, price, croppedUrl }] }
// يحفظ المنتجات المختارة كمنتجات حقيقية في القسم
router.post("/store/categories/:catId/ai-extract/commit", auth, async (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const cat = (store.categories || []).find(c => c.id === req.params.catId);
  if (!cat) return res.status(404).json({ error: "القسم غير موجود" });

  const { subCategoryId, items } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "لا توجد منتجات للحفظ" });
  }

  // تحقق sub لو مرر
  if (subCategoryId) {
    const sub = (cat.subCategories || []).find(s => s.id === subCategoryId);
    if (!sub) return res.status(404).json({ error: "الصنف الفرعي غير موجود" });
  }

  const existingProducts = store.products || [];
  let counter = Date.now();
  const newProducts = [];

  for (const it of items) {
    const name = String(it?.name || "").trim().slice(0, 120);
    if (!name) continue;
    const price = Number(it?.price) || 0;
    const imageUrl = String(it?.croppedUrl || "").trim() || null;

    // أنشئ وصف يجمع الـ brand + size لو موجودين
    let description = "";
    const brand = String(it?.brand || "").trim();
    const size  = String(it?.size  || "").trim();
    if (brand) description += brand;
    if (size)  description += (description ? " — " : "") + size;

    newProducts.push({
      id:            "prod_" + (counter++),
      name,
      description,
      price,
      category:      cat.id,
      subCategoryId: subCategoryId || "",
      images:        imageUrl ? [imageUrl] : [],
      imageUrl,
      available:     true,
      createdAt:     new Date().toISOString(),
      _source:       "ai_vision",
    });
  }

  if (!newProducts.length) {
    return res.status(400).json({ error: "كل المنتجات المرسلة غير صالحة" });
  }

  const products = [...existingProducts, ...newProducts];
  updateStore(req.storeId, { products });

  audit({
    actor: { type: "store", id: req.storeId },
    action: "category.ai_extract_commit",
    target: { type: "category", id: cat.id },
    meta: { added: newProducts.length, subCategory: subCategoryId || null },
  }, req);

  res.json({ ok: true, added: newProducts.length, products });
});

function updateOrderStatus(storeId, orderId, status, extraMeta) {
  const file = storeId === "nakheel_001"
    ? path.join(DATA_DIR, "orders.jsonl")
    : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
  return atomicFs.updateJsonl(file, lines => {
    const stamp = new Date().toISOString();
    let found = false;
    const updated = lines.map(l => {
      try {
        const obj = JSON.parse(l);
        if (obj.orderId === orderId) {
          found = true;
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
    return { lines: updated, result: found };
  });
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
  // 🆘 Handoff notifications — عملاء يطلبون مسؤول
  try {
    const handoffFile = path.join(DATA_DIR, "handoffs.json");
    if (fs.existsSync(handoffFile)) {
      const handoffs = JSON.parse(fs.readFileSync(handoffFile, "utf8") || "{}");
      for (const [phone, h] of Object.entries(handoffs)) {
        if (h.storeId !== req.storeId) continue;
        const ts = new Date(h.startedAt || h.at || 0).getTime();
        if (ts > sinceTs) {
          notif.push({
            kind: "handoff",
            id: "handoff_" + phone,
            title: "🆘 عميل يطلب مسؤول",
            body: `${String(phone).replace(/\D/g,"").slice(0,9) + "***"} — "${(h.lastMsg||"").slice(0,40)}"`,
            ts,
            link: "#handoffs",
          });
        }
      }
    }
  } catch {}
  notif.sort((a, b) => b.ts - a.ts);
  res.json({ notifications: notif, serverTime: Date.now() });
});

// ─── Orders ───────────────────────────────────────────────────────────────────
// ═════ 🎫 Support Tickets (store side) ═══════════════════════════════════
router.post("/store/support/tickets", auth, (req, res) => {
  const t = require("./support-tickets");
  const { subject, body, priority, category } = req.body || {};
  if (!subject || !body) return res.status(400).json({ error: "العنوان والوصف مطلوبان" });
  const ticket = t.createTicket(req.storeId, { subject, body, priority, category });
  audit({ actor: { type: "store", id: req.storeId }, action: "support.create_ticket", target: { type: "ticket", id: ticket.id } }, req);
  res.json({ ok: true, ticket });
});
router.get("/store/support/tickets", auth, (req, res) => {
  const t = require("./support-tickets");
  res.json({ items: t.listForStore(req.storeId, { status: req.query.status }) });
});
router.get("/store/support/tickets/:id", auth, async (req, res) => {
  try {
    const t = await require("./support-tickets").getTicket(req.params.id);
    if (!t || t.storeId !== req.storeId) return res.status(404).json({ error: "غير موجود" });
    res.json({ ticket: t });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.post("/store/support/tickets/:id/reply", auth, async (req, res) => {
  try {
    const tk = require("./support-tickets");
    const existing = await tk.getTicket(req.params.id);
    if (!existing || existing.storeId !== req.storeId) return res.status(404).json({ error: "غير موجود" });
    const updated = tk.replyToTicket(req.params.id, { from: "store", message: req.body?.message });
    audit({ actor: { type: "store", id: req.storeId }, action: "support.reply", target: { type: "ticket", id: req.params.id } }, req);
    res.json({ ok: true, ticket: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════ 🔔 Notifications Inbox ═════════════════════════════════════════════
router.get("/store/notifications/inbox", auth, (req, res) => {
  const notif = require("./notifications");
  const unreadOnly = req.query.unread === "1";
  const items = notif.listForStore(req.storeId, { unreadOnly });
  res.json({ items, unreadCount: notif.unreadCount(req.storeId) });
});
router.get("/store/notifications/unread-count", auth, (req, res) => {
  res.json({ count: require("./notifications").unreadCount(req.storeId) });
});
router.post("/store/notifications/:id/read", auth, (req, res) => {
  const id = String(req.params.id || "").slice(0, 100);
  require("./notifications").markRead(req.storeId, id);
  res.json({ ok: true });
});
router.post("/store/notifications/read-all", auth, (req, res) => {
  const n = require("./notifications").markAllRead(req.storeId);
  res.json({ ok: true, marked: n });
});

// 📤 GET /store/orders/export.csv — تصدير CSV للطلبات
router.get("/store/orders/export.csv", auth, (req, res) => {
  const orders = readOrders(req.storeId).filter(o => !o._test);
  const from = req.query.from || "";
  const to   = req.query.to   || "";
  const status = req.query.status && req.query.status !== "all" ? req.query.status : null;
  const filtered = orders.filter(o => {
    const d = (o.timestamp || "").slice(0, 10);
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    if (status && o.status !== status) return false;
    return true;
  });
  const maskPhone = (p) => {
    const s = String(p || "").replace(/\D/g, "");
    return s.length >= 4 ? s.slice(0, -4) + "****" : s;
  };
  const escapeCsv = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const headers = [
    "رقم الطلب","التاريخ","الوقت","العميل","رقم العميل (مخفي جزئياً)","العنوان",
    "المنتجات","المجموع","رسوم التوصيل","الخصم","الإجمالي","العملة",
    "الحالة","الوقت المطلوب","المدة المتوقعة (د)","ملاحظات","إجابات الأسئلة","سبب الرفض"
  ];
  const rows = filtered.map(o => [
    o.orderId || "",
    (o.timestamp || "").slice(0, 10),
    (o.timestamp || "").slice(11, 16),
    o.customerName || "",
    maskPhone(o.customerPhone),
    (o.customerLocationName || o.customerLocation || "").replace(/\(📍\s*https?:\/\/[^\)]+\)/g, "").trim(),
    (o.items || []).map(i => `${i.name}×${i.qty}`).join("؛ "),
    o.subtotal || 0,
    o.deliveryFee || 0,
    o.discount || 0,
    o.total || 0,
    o.currency || "ر.س",
    o.status || "",
    o.scheduledTime || "",
    o.estimatedMinutes || "",
    o.notes || o.orderNotes || "",
    o.customAnswers ? JSON.stringify(o.customAnswers) : "",
    o.rejectReason || o.cancelReason || "",
  ]);
  const csv = "﻿" + [headers, ...rows].map(r => r.map(escapeCsv).join(",")).join("\n");
  const today = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="orders-${req.storeId}-${today}.csv"`);
  res.send(csv);
});

// ─── Helpers مشتركة لتصدير الطلبات (Excel + PDF) ───────────────────────────
function _exportFilterOrders(storeId, q) {
  const orders = readOrders(storeId).filter(o => !o._test);
  const from   = q.from || "";
  const to     = q.to   || "";
  const status = q.status && q.status !== "all" ? q.status : null;
  return orders.filter(o => {
    const d = (o.timestamp || "").slice(0, 10);
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    if (status && o.status !== status) return false;
    return true;
  });
}
function _exportRows(filtered) {
  const maskPhone = (p) => {
    const s = String(p || "").replace(/\D/g, "");
    return s.length >= 4 ? s.slice(0, -4) + "****" : s;
  };
  const headers = [
    "رقم الطلب","التاريخ","الوقت","العميل","رقم العميل (مخفي جزئياً)","العنوان",
    "المنتجات","المجموع","رسوم التوصيل","الخصم","الإجمالي","العملة",
    "الحالة","الوقت المطلوب","المدة المتوقعة (د)","ملاحظات","إجابات الأسئلة","سبب الرفض"
  ];
  const rows = filtered.map(o => [
    o.orderId || "",
    (o.timestamp || "").slice(0, 10),
    (o.timestamp || "").slice(11, 16),
    o.customerName || "",
    maskPhone(o.customerPhone),
    (o.customerLocationName || o.customerLocation || "").replace(/\(📍\s*https?:\/\/[^\)]+\)/g, "").trim(),
    (o.items || []).map(i => `${i.name}×${i.qty}`).join("؛ "),
    o.subtotal || 0,
    o.deliveryFee || 0,
    o.discount || 0,
    o.total || 0,
    o.currency || "ر.س",
    o.status || "",
    o.scheduledTime || "",
    o.estimatedMinutes || "",
    o.notes || o.orderNotes || "",
    o.customAnswers ? JSON.stringify(o.customAnswers) : "",
    o.rejectReason || o.cancelReason || "",
  ]);
  return { headers, rows };
}
function _htmlEsc(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 📊 GET /store/orders/export.xlsx — تصدير Excel-HTML (يفتح كـ .xls في Excel)
router.get("/store/orders/export.xlsx", auth, (req, res) => {
  const filtered = _exportFilterOrders(req.storeId, req.query);
  const { headers, rows } = _exportRows(filtered);
  const today = new Date().toISOString().slice(0, 10);
  const thead = headers.map(h => `<th>${_htmlEsc(h)}</th>`).join("");
  const tbody = rows.map(r => `<tr>${r.map(c => `<td>${_htmlEsc(c)}</td>`).join("")}</tr>`).join("");
  const html = `﻿<!DOCTYPE html><html dir="rtl" lang="ar"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Type" content="application/vnd.ms-excel; charset=UTF-8">
<title>طلبات ${_htmlEsc(req.storeId)} - ${today}</title>
<style>
  body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; direction: rtl; }
  table { border-collapse: collapse; width: 100%; }
  th { background-color: #d9d9d9; font-weight: bold; text-align: right; padding: 8px; border: 1px solid #999; }
  td { padding: 6px 8px; border: 1px solid #ccc; text-align: right; mso-number-format:"\\@"; }
  caption { font-weight: bold; font-size: 16px; margin-bottom: 8px; }
</style></head><body>
<table dir="rtl">
<caption>طلبات المتجر — ${_htmlEsc(req.storeId)} — ${today} (${rows.length} طلب)</caption>
<thead><tr>${thead}</tr></thead>
<tbody>${tbody}</tbody>
</table></body></html>`;
  res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="orders-${req.storeId}-${today}.xls"`);
  res.send(html);
});

// 📑 GET /store/orders/export.pdf.html — صفحة طباعة جاهزة (Save as PDF من المتصفح)
router.get("/store/orders/export.pdf.html", auth, (req, res) => {
  const filtered = _exportFilterOrders(req.storeId, req.query);
  const { headers, rows } = _exportRows(filtered);
  const today = new Date().toISOString().slice(0, 10);
  const store = (typeof getStore === "function") ? getStore(req.storeId) : null;
  const storeName = (store && (store.storeName || store.name)) || req.storeId;
  const from = req.query.from || "—";
  const to   = req.query.to   || "—";
  const statusLabel = (req.query.status && req.query.status !== "all") ? req.query.status : "كل الحالات";
  const thead = headers.map(h => `<th>${_htmlEsc(h)}</th>`).join("");
  const tbody = rows.map(r => `<tr>${r.map(c => `<td>${_htmlEsc(c)}</td>`).join("")}</tr>`).join("");
  const html = `<!DOCTYPE html><html dir="rtl" lang="ar"><head>
<meta charset="UTF-8">
<title>طلبات ${_htmlEsc(storeName)} - ${today}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; direction: rtl; margin: 16px; color: #111827; }
  .brand { display:flex; justify-content:space-between; align-items:center; border-bottom: 3px solid #1e3a8a; padding-bottom: 10px; margin-bottom: 14px; }
  .brand h1 { margin:0; font-size: 22px; color:#1e3a8a; }
  .meta { font-size: 12px; color:#374151; line-height:1.7; }
  table { border-collapse: collapse; width: 100%; font-size: 11px; }
  th { background:#1e3a8a; color:#fff; padding:6px 5px; border:1px solid #1e3a8a; text-align:right; font-weight:700; }
  td { padding:5px; border:1px solid #d1d5db; text-align:right; vertical-align:top; word-break: break-word; }
  tr:nth-child(even) td { background:#f9fafb; }
  .foot { margin-top:14px; font-size:11px; color:#6b7280; text-align:center; }
  .noprint { background:#f0f9ff; border:1px solid #bfdbfe; padding:10px 14px; border-radius:8px; margin-bottom:14px; font-size:13px; color:#1e3a8a; }
  .noprint button { background:#1e3a8a; color:#fff; border:none; padding:7px 16px; border-radius:6px; cursor:pointer; font-weight:700; margin-inline-start:8px; }
  @media print {
    .noprint { display:none !important; }
    body { margin: 8mm; }
    table { font-size: 9px; }
    th, td { padding: 3px 4px; }
    @page { size: A4 landscape; margin: 8mm; }
  }
</style></head><body>
<div class="noprint">
  🖨️ نافذة الطباعة ستفتح تلقائياً. اختر <b>"حفظ بصيغة PDF"</b> (Save as PDF) من قائمة الطابعة.
  <button onclick="window.print()">طباعة الآن</button>
</div>
<div class="brand">
  <div>
    <h1>📋 تقرير الطلبات — ${_htmlEsc(storeName)}</h1>
    <div class="meta">
      الفترة: ${_htmlEsc(from)} → ${_htmlEsc(to)} &nbsp;|&nbsp; الحالة: ${_htmlEsc(statusLabel)} &nbsp;|&nbsp; عدد الطلبات: <b>${rows.length}</b>
    </div>
  </div>
  <div class="meta" style="text-align:left">
    تاريخ التقرير: ${today}<br>
    منصة ثواني
  </div>
</div>
<table>
<thead><tr>${thead}</tr></thead>
<tbody>${tbody || `<tr><td colspan="${headers.length}" style="text-align:center;padding:20px;color:#6b7280">لا توجد طلبات للفترة المحددة</td></tr>`}</tbody>
</table>
<div class="foot">تم إنشاء هذا التقرير من لوحة تحكم منصة ثواني — ${today}</div>
<script>
  // تشغيل تلقائي لنافذة الطباعة بعد تحميل الصفحة
  window.addEventListener("load", function(){ setTimeout(function(){ window.print(); }, 400); });
</script>
</body></html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition", `inline; filename="orders-${req.storeId}-${today}.html"`);
  res.send(html);
});

// 🧾 GET /store/orders/:orderId/print — فاتورة قابلة للطباعة (لاصق على المنتج)
//   ?size=thermal (80mm) [default] | a4 | a5
//   ?copies=N (1-5)
//   تفتح + تطبع تلقائياً
router.get("/store/orders/:orderId/print", auth, (req, res) => {
  const { orderId } = req.params;
  const size   = ["a4","a5","thermal"].includes(req.query.size) ? req.query.size : "thermal";
  const copies = Math.min(5, Math.max(1, parseInt(req.query.copies, 10) || 1));
  const orders = readOrders(req.storeId);
  const order  = orders.find(o => o.orderId === orderId);
  if (!order) return res.status(404).send("الطلب غير موجود");
  const store = (typeof getStore === "function") ? getStore(req.storeId) : null;
  const storeName = store?.storeName || req.storeId;
  const _rawCur = store?.currency || "ر.س";
  // 💱 ر.س → ريالٌ في الفاتورة (للعرض الجمالي)
  const currency = /^(ر\.?س|SAR|ريال|ر$)/i.test(String(_rawCur).trim()) ? "ريالٌ" : _rawCur;
  const ts = order.timestamp ? new Date(order.timestamp) : new Date();
  const dateStr = ts.toLocaleDateString("ar-EG", { year: "numeric", month: "long", day: "numeric" });
  const timeStr = ts.toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit", hour12: true });
  const phoneMask = (() => {
    const s = String(order.customerPhone || "").replace(/\D/g, "");
    return s.length >= 4 ? s.slice(0, -4) + "****" : s;
  })();
  const fullPhone = String(order.customerPhone || "").replace(/\D/g, "");
  const items = Array.isArray(order.items) ? order.items : [];
  const cleanAddress = String(order.customerLocationName || order.customerLocation || "")
    .replace(/\s*\(📍\s*https?:\/\/[^)]+\)\s*/g, "").trim();
  const mapsUrl = order.customerLocationMapsUrl
    || (cleanAddress ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(cleanAddress + (store?.city ? ", " + store.city : ""))}` : "");
  // dynamic answers
  const dynRows = order.customAnswers && typeof order.customAnswers === "object"
    ? Object.entries(order.customAnswers)
        .filter(([_, v]) => v && String(v).trim())
        .slice(0, 8)
        .map(([k, v]) => `<tr><td class="lbl">${_htmlEsc(k)}</td><td>${_htmlEsc(v)}</td></tr>`).join("")
    : "";

  const itemsRowsThermal = items.map(it => `
      <div class="item">
        <div class="ix">
          <span class="iname">${_htmlEsc(it.name || "")} <small>×${it.qty || 1}</small></span>
          <span class="iprice">${(Number(it.price || 0) * Number(it.qty || 1)).toFixed(2)}</span>
        </div>
        ${it.notes ? `<div class="inotes">📝 ${_htmlEsc(it.notes)}</div>` : ""}
      </div>`).join("");

  const itemsRowsTable = items.map(it => `
      <tr>
        <td>${_htmlEsc(it.name || "")}</td>
        <td class="num">${it.qty || 1}</td>
        <td class="num">${Number(it.price || 0).toFixed(2)}</td>
        <td class="num">${(Number(it.price || 0) * Number(it.qty || 1)).toFixed(2)}</td>
      </tr>`).join("");

  // ── ticket واحد (يُكرَّر copies مرات) ───────────────────────────────────
  const buildThermalTicket = () => `<div class="ticket th">
    <div class="th-head">
      <div class="th-store">${_htmlEsc(storeName)}</div>
      <div class="th-meta">${_htmlEsc(dateStr)} • ${_htmlEsc(timeStr)}</div>
    </div>
    <div class="th-orderid">طلب رقم: <b>${_htmlEsc(orderId)}</b></div>
    <div class="th-section">
      <div class="th-row"><span>👤</span><span><b>${_htmlEsc(order.customerName || "—")}</b></span></div>
      <div class="th-row"><span>📱</span><span dir="ltr">${_htmlEsc(fullPhone)}</span></div>
      ${cleanAddress ? `<div class="th-row"><span>📍</span><span>${_htmlEsc(cleanAddress)}</span></div>` : ""}
      ${mapsUrl ? `<div class="th-maps"><a href="${_htmlEsc(mapsUrl)}">🗺️ افتح الخريطة</a></div>` : ""}
    </div>
    <div class="th-divider">━━━ المنتجات ━━━</div>
    <div class="items">${itemsRowsThermal}</div>
    ${order.notes || order.orderNotes ? `<div class="th-notes">📝 ${_htmlEsc(order.notes || order.orderNotes)}</div>` : ""}
    <div class="th-divider"></div>
    <div class="th-totals">
      <div class="th-row"><span>المجموع</span><span>${Number(order.subtotal ?? order.total ?? 0).toFixed(2)} ${currency}</span></div>
      ${order.deliveryFee ? `<div class="th-row"><span>التوصيل</span><span>${Number(order.deliveryFee).toFixed(2)} ${currency}</span></div>` : ""}
      ${order.discount ? `<div class="th-row"><span>الخصم</span><span>-${Number(order.discount).toFixed(2)} ${currency}</span></div>` : ""}
      <div class="th-grand"><span>الإجمالي</span><span>${Number(order.total || 0).toFixed(2)} ${currency}</span></div>
    </div>
    <div class="th-divider">━━━━━━━━━━━━━</div>
    ${dynRows ? `<table class="th-dyn"><tbody>${dynRows}</tbody></table>` : ""}
    <div class="th-foot">شكراً لاختيارك ${_htmlEsc(storeName)} 💚</div>
  </div>`;

  const buildA4Ticket = () => `<div class="ticket a">
    <div class="a-head">
      <div>
        <div class="a-store">${_htmlEsc(storeName)}</div>
        <div class="a-meta">${_htmlEsc(dateStr)} — ${_htmlEsc(timeStr)}</div>
      </div>
      <div class="a-orderid">طلب رقم<br><b>${_htmlEsc(orderId)}</b></div>
    </div>
    <div class="a-customer">
      <div><b>العميل:</b> ${_htmlEsc(order.customerName || "—")}</div>
      <div><b>الجوال:</b> <span dir="ltr">${_htmlEsc(fullPhone)}</span></div>
      ${cleanAddress ? `<div><b>العنوان:</b> ${_htmlEsc(cleanAddress)}${mapsUrl ? ` — <a href="${_htmlEsc(mapsUrl)}">🗺️ خريطة</a>` : ""}</div>` : ""}
    </div>
    <table class="a-items">
      <thead><tr><th>المنتج</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr></thead>
      <tbody>${itemsRowsTable}</tbody>
    </table>
    ${order.notes || order.orderNotes ? `<div class="a-notes"><b>📝 ملاحظات:</b> ${_htmlEsc(order.notes || order.orderNotes)}</div>` : ""}
    <div class="a-totals">
      <div><span>المجموع</span><span>${Number(order.subtotal ?? order.total ?? 0).toFixed(2)} ${currency}</span></div>
      ${order.deliveryFee ? `<div><span>التوصيل</span><span>${Number(order.deliveryFee).toFixed(2)} ${currency}</span></div>` : ""}
      ${order.discount ? `<div><span>الخصم</span><span>-${Number(order.discount).toFixed(2)} ${currency}</span></div>` : ""}
      <div class="a-grand"><span>الإجمالي الكلي</span><span>${Number(order.total || 0).toFixed(2)} ${currency}</span></div>
    </div>
    ${dynRows ? `<table class="a-dyn"><tbody>${dynRows}</tbody></table>` : ""}
    <div class="a-foot">شكراً لاختيارك ${_htmlEsc(storeName)} 💚</div>
  </div>`;

  const ticket = size === "thermal" ? buildThermalTicket() : buildA4Ticket();
  const all    = Array(copies).fill(ticket).join('<div class="page-break"></div>');

  // CSS لكل size — @page محدد بالـ mm
  const pageCss = size === "thermal" ? `
    @page { size: 80mm auto; margin: 2mm; }
    body { width: 76mm; }
  ` : size === "a5" ? `
    @page { size: A5; margin: 8mm; }
  ` : `
    @page { size: A4; margin: 12mm; }
  `;

  const html = `<!DOCTYPE html><html dir="rtl" lang="ar"><head>
<meta charset="UTF-8">
<title>طباعة ${_htmlEsc(orderId)}</title>
<style>
  ${pageCss}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Tahoma", Arial, sans-serif; direction: rtl; color: #000; background: #f3f4f6; padding: 14px; }
  .toolbar { background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:12px 16px; margin-bottom:14px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; max-width:480px; margin-left:auto; margin-right:auto; }
  .toolbar b { font-size:14px; }
  .toolbar button { background:#1e3a8a; color:#fff; border:none; padding:9px 18px; border-radius:8px; cursor:pointer; font-weight:700; font-size:13px; }
  .toolbar button.ghost { background:#fff; color:#1e3a8a; border:1px solid #1e3a8a; }
  .toolbar a { color:#1e3a8a; text-decoration:none; font-size:12px; font-weight:700; }
  .page-break { page-break-after: always; }
  .ticket.th { background:#fff; max-width:76mm; margin: 8px auto; padding: 8px; font-size: 12px; line-height: 1.5; border:1px dashed #d1d5db; }
  .th-head { text-align:center; border-bottom:2px dashed #000; padding-bottom:6px; margin-bottom:6px; }
  .th-store { font-size: 16px; font-weight: 900; }
  .th-meta { font-size: 10px; color:#374151; margin-top:3px; }
  .th-orderid { text-align:center; font-size: 13px; padding: 4px; background:#f3f4f6; margin: 4px 0; border-radius: 4px; }
  .th-section { margin: 6px 0; }
  .th-row { display:flex; justify-content:space-between; gap:8px; padding:1px 0; }
  .th-row > span:first-child { font-weight:700; flex-shrink:0; }
  .th-divider { text-align:center; font-weight:700; margin: 5px 0; font-size: 11px; }
  .items .item { margin: 3px 0; padding: 2px 0; border-bottom: 1px dotted #d1d5db; }
  .items .ix { display:flex; justify-content:space-between; gap:6px; }
  .items .iname { font-weight:700; flex:1; }
  .items .iname small { font-weight:400; color:#4b5563; }
  .items .iprice { font-weight:800; }
  .items .inotes { font-size: 10px; color:#6b7280; padding-right: 6px; }
  .th-totals { margin: 4px 0; }
  .th-grand { display:flex; justify-content:space-between; font-weight: 900; font-size: 14px; border-top: 2px dashed #000; margin-top: 4px; padding-top: 4px; }
  .th-notes { background:#fef3c7; padding:5px; margin: 5px 0; border-radius: 4px; font-size: 11px; }
  .th-dyn { width:100%; font-size: 10px; margin: 5px 0; }
  .th-dyn td { padding: 1px 2px; border-bottom: 1px dotted #d1d5db; }
  .th-dyn td.lbl { font-weight:700; width: 35%; }
  .th-foot { text-align:center; font-size: 10px; color:#4b5563; margin-top: 6px; padding-top: 4px; border-top: 1px dashed #d1d5db; }
  .th-maps { text-align:center; padding: 3px 0; }
  .th-maps a { color:#1e40af; font-size: 10px; text-decoration: underline; }

  /* A4/A5 */
  .ticket.a { background:#fff; max-width: 700px; margin: 12px auto; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,.06); border-radius: 8px; }
  .a-head { display:flex; justify-content:space-between; align-items:center; border-bottom: 3px solid #1e3a8a; padding-bottom: 10px; margin-bottom: 14px; }
  .a-store { font-size: 22px; font-weight: 900; color:#1e3a8a; }
  .a-meta { font-size: 12px; color:#6b7280; margin-top: 3px; }
  .a-orderid { text-align:left; font-size:12px; color:#374151; }
  .a-orderid b { font-size: 16px; color:#1e3a8a; }
  .a-customer { background:#f9fafb; padding: 10px 14px; border-radius: 8px; margin-bottom: 14px; font-size: 13px; line-height: 1.9; }
  .a-customer a { color:#1e40af; text-decoration: underline; }
  .a-items { width:100%; border-collapse: collapse; margin: 10px 0; font-size: 13px; }
  .a-items th { background:#1e3a8a; color:#fff; padding: 8px; text-align: right; }
  .a-items td { padding: 7px 8px; border: 1px solid #e5e7eb; }
  .a-items td.num { text-align: center; font-weight: 700; }
  .a-totals { margin-top: 10px; font-size: 14px; }
  .a-totals > div { display:flex; justify-content:space-between; padding: 4px 0; }
  .a-grand { font-weight: 900; font-size: 17px; border-top: 2px solid #1e3a8a; margin-top: 6px; padding-top: 8px; color:#1e3a8a; }
  .a-notes { background:#fef3c7; padding: 10px 14px; border-radius: 8px; margin: 12px 0; font-size: 13px; }
  .a-dyn { width:100%; font-size: 12px; margin-top: 10px; }
  .a-dyn td { padding: 4px 8px; border-bottom: 1px solid #e5e7eb; }
  .a-dyn td.lbl { font-weight: 700; background:#f9fafb; width: 30%; }
  .a-foot { text-align:center; font-size: 12px; color:#6b7280; margin-top: 14px; padding-top: 10px; border-top: 1px solid #e5e7eb; }

  @media print {
    body { background:#fff; padding: 0; }
    .toolbar { display:none !important; }
    .ticket { box-shadow: none; margin: 0; }
  }
</style></head><body>
<div class="toolbar">
  <b>🧾 طباعة ${_htmlEsc(orderId)}</b>
  <button onclick="window.print()">🖨️ طباعة</button>
  <button class="ghost" onclick="changeSize('thermal')">📜 حراري 80mm</button>
  <button class="ghost" onclick="changeSize('a5')">📄 A5</button>
  <button class="ghost" onclick="changeSize('a4')">📄 A4</button>
  <button class="ghost" onclick="changeCopies()">📋 نسخ: ${copies}</button>
</div>
${all}
<script>
function changeSize(s){ const u=new URL(location.href); u.searchParams.set("size",s); location.href=u.toString(); }
function changeCopies(){ const n=prompt("عدد النسخ (1-5)?", ${copies}); if(n){const u=new URL(location.href); u.searchParams.set("copies",n); location.href=u.toString();} }
window.addEventListener("load", function(){ setTimeout(function(){ window.print(); }, 350); });
<\/script>
</body></html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(html);
});

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
  const { status, customMessage, driverPhone, driverName } = req.body || {};
  const ALLOWED = ["preparing","out_for_delivery","ready_pickup","in_progress","awaiting_review"];
  if (!ALLOWED.includes(status)) return res.status(400).json({ error: "حالة غير مسموحة" });

  const orders = readOrders(req.storeId);
  const order  = orders.find(o => o.orderId === orderId);
  if (!order) return res.status(404).json({ error: "الطلب غير موجود" });

  // 🚴 احفظ المندوب على الطلب (للأرشيف)
  const extraMeta = {};
  if (driverPhone) extraMeta.driverPhone = String(driverPhone).replace(/[^\d+]/g, "").slice(0, 15);
  if (driverName)  extraMeta.driverName  = String(driverName).trim().slice(0, 60);
  updateOrderStatus(req.storeId, orderId, status, Object.keys(extraMeta).length ? extraMeta : null);

  const store = getStore(req.storeId);
  const storeName = store?.storeName || "المتجر";
  // قوالب افتراضية + التاجر يقدر يخصصها من تبويب أسئلة البوت (حقول التيمبليت)
  const defaults = {
    preparing:        `👨‍🍳 *جاري تحضير طلبك الآن*\n\nسنخبرك بمجرد جاهزيته 🚀`,
    out_for_delivery: `🚴 *المندوب في الطريق إليك*\n\nاستعد لاستلام طلبك من *{{storeName}}* 📍{{driverLine}}`,
    ready_pickup:     `✅ *طلبك جاهز للاستلام*\n\nيمكنك الحضور لـ *{{storeName}}* لاستلامه 🏪`,
    in_progress:      `⚙️ *العمل على مشروعك بدأ*\n\nسنبقيك على اطلاع بأي تطور 📊`,
    awaiting_review:  `📋 *طلبك جاهز للمراجعة*\n\nراجع التسليم وأخبرنا برأيك ✨`,
  };
  // أولوية: customMessage > تيمبليت المتجر > الافتراضي
  const tmplKey = {
    preparing: "preparingTemplate",
    out_for_delivery: "outForDeliveryTemplate",
    ready_pickup: "readyPickupTemplate",
  }[status];
  let template = customMessage || (tmplKey && store?.[tmplKey]) || defaults[status] || `📦 *تحديث طلبك:* ${status}`;

  // متغيرات التيمبليت
  const driverClean = String(driverPhone || "").replace(/[^\d+]/g, "");
  const driverNameClean = String(driverName || "").trim();
  // 🚴 driverLine ذكي: اسم + رقم لو الاثنين، أو رقم فقط، أو اسم فقط
  let driverLine = "";
  if (driverNameClean && driverClean) {
    driverLine = `\n\n🚴 المندوب: *${driverNameClean}*\n📞 ${driverClean}`;
  } else if (driverClean) {
    driverLine = `\n\n📞 رقم المندوب: ${driverClean}`;
  } else if (driverNameClean) {
    driverLine = `\n\n🚴 المندوب: *${driverNameClean}*`;
  }
  const msg = template
    .replace(/\{\{\s*storeName\s*\}\}/g, storeName)
    .replace(/\{\{\s*orderId\s*\}\}/g, orderId)
    .replace(/\{\{\s*driverPhone\s*\}\}/g, driverClean || "—")
    .replace(/\{\{\s*driverName\s*\}\}/g, driverNameClean || "—")
    .replace(/\{\{\s*driverLine\s*\}\}/g, driverLine);

  if (order.customerPhone && order.customerPhone !== "999999999") {
    try {
      await waMgr.sendMessage(req.storeId, order.customerPhone, msg, {
        allowCold: true,
        reason: "status_update",
      });
    } catch (e) { console.warn("[status-update] msg fail:", e.message); }
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

  // أرسل للعميل طلب تقييم — إلا لو التاجر عطّل التقييمات
  if (order.customerPhone && order.customerPhone !== "999999999") {
    if (store?.enableRatings === false) {
      // 🚫 التقييم معطّل → رسالة شكر فقط
      const thanksMsg = `${emoji} *${label}!*\n\nشكراً لاختيارك *${storeName}* 🙏`;
      try {
        await waMgr.sendMessage(req.storeId, order.customerPhone, thanksMsg, {
          allowCold: true, reason: "order_completed",
        });
      } catch (e) { console.warn("[complete] thanks msg fail:", e.message); }
    } else {
      const ratingMsg =
`${emoji} *${label}!*

شكراً لاختيارك *${storeName}* 🙏

كيف تقيّم تجربتك معنا؟ ⭐

*1* — ⭐
*2* — ⭐⭐
*3* — ⭐⭐⭐
*4* — ⭐⭐⭐⭐
*5* — ⭐⭐⭐⭐⭐

_اكتب رقم التقييم المناسب لك (من 1 إلى 5) 👇_`;
      try {
        await waMgr.sendMessage(req.storeId, order.customerPhone, ratingMsg, {
          allowCold: true, reason: "rating_request",
        });
      } catch (e) { console.warn("[complete] rating msg fail:", e.message); }
    }
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

// 🆘 POST /store/handoff/clear-all — مسح كل handoffs للمتجر دفعة واحدة (panic button)
router.post("/store/handoff/clear-all", auth, async (req, res) => {
  const fs = require("fs");
  const path = require("path");
  const handoffFile = path.join(__dirname, "..", "data", "handoffs.json");
  let handoffs = {};
  try { handoffs = JSON.parse(fs.readFileSync(handoffFile, "utf8")); } catch {}
  const mine = Object.entries(handoffs).filter(([_, h]) => h.storeId === req.storeId);
  if (mine.length === 0) return res.json({ ok: true, cleared: 0 });

  for (const [k] of mine) delete handoffs[k];
  fs.writeFileSync(handoffFile, JSON.stringify(handoffs, null, 2));

  // امسح bot-sessions أيضاً للعملاء المعنيين (يعيد البوت من الترحيب)
  const sessFile = path.join(__dirname, "..", "data", "sessions", "bot-sessions.json");
  try {
    const sessions = JSON.parse(fs.readFileSync(sessFile, "utf8") || "{}");
    for (const [k, h] of mine) {
      const phone = h.phone || k.split("|").pop();
      const skey = req.storeId + "|" + phone;
      delete sessions[skey];
      delete sessions[phone]; // legacy
    }
    fs.writeFileSync(sessFile, JSON.stringify(sessions));
  } catch {}

  audit({
    actor: req.impersonatedBy ? { type: "master", id: "master", impersonating: req.storeId } : { type: "store", id: req.storeId },
    action: "handoff.clear_all",
    meta: { storeId: req.storeId, cleared: mine.length },
  }, req);

  res.json({ ok: true, cleared: mine.length });
});

// POST /store/handoff/resume — استئناف البوت بـ phone مباشرة (بدون orderId)
router.post("/store/handoff/resume", auth, async (req, res) => {
  const phone = String(req.body?.phone || "").replace(/\D/g, "");
  if (!phone) return res.status(400).json({ error: "رقم الهاتف مطلوب" });

  const fs   = require("fs");
  const path = require("path");
  const handoffFile = path.join(__dirname, "..", "data", "handoffs.json");
  let handoffs = {};
  try { handoffs = JSON.parse(fs.readFileSync(handoffFile, "utf8")); } catch {}

  // ابحث عن المفتاح المناسب — مفضّل storeId|phone (composite)
  // ثم fallback للـ legacy keys
  let matchedKey = null;
  let entry = null;
  for (const [k, h] of Object.entries(handoffs)) {
    if (h.storeId !== req.storeId) continue;
    const targetPhone = String(h.phone || k).replace(/\D/g, "");
    if (targetPhone === phone || targetPhone.endsWith(phone) || phone.endsWith(targetPhone)) {
      matchedKey = k;
      entry = h;
      break;
    }
  }
  if (!matchedKey || !entry) return res.status(404).json({ error: "لا يوجد محادثة موقوفة لهذا الرقم" });

  delete handoffs[matchedKey];
  fs.writeFileSync(handoffFile, JSON.stringify(handoffs, null, 2));

  // 🔄 امسح bot-session أيضاً للعميل — يبدأ من الترحيب نظيفاً بدل أن يعلق في PATH_SELECT
  const customerPhone = entry.phone || matchedKey.split("|").pop();
  try {
    const sessFile = path.join(__dirname, "..", "data", "sessions", "bot-sessions.json");
    const sessions = JSON.parse(fs.readFileSync(sessFile, "utf8") || "{}");
    const skey = req.storeId + "|" + customerPhone;
    let changed = false;
    if (sessions[skey])           { delete sessions[skey]; changed = true; }
    if (sessions[customerPhone])  { delete sessions[customerPhone]; changed = true; }
    if (changed) fs.writeFileSync(sessFile, JSON.stringify(sessions));
  } catch (e) { console.warn("[handoff.resume] session clear failed:", e.message); }

  // أبلغ العميل بعودة البوت
  try {
    const waMgr = require("./whatsapp-manager");
    await waMgr.sendMessage(req.storeId, customerPhone,
      `✅ *البوت يعمل من جديد*\n\nيمكنك الكتابة لي مباشرة. شكراً لصبرك 🙏\n\n_اكتب: ابدأ — لبدء طلب جديد_`);
  } catch (e) { console.warn("[handoff.resume] sendMessage failed:", e.message); }

  // ⚡ Audit log — مهم لتتبع من أعاد البوت
  audit({
    actor: req.impersonatedBy
      ? { type: "master", id: "master", impersonating: req.storeId }
      : { type: "store", id: req.storeId },
    action: "handoff.resume",
    target: { type: "customer", id: matchedKey.replace(/\D/g, "").slice(0, 6) + "***" },
    meta: { storeId: req.storeId, durationSec: Math.round((Date.now() - new Date(handoffs[matchedKey]?.startedAt || Date.now()).getTime()) / 1000) },
  }, req);

  res.json({ ok: true, phone: matchedKey, resumed: true });
});

// GET /store/handoffs — قائمة العملاء الذين يحتاجون مسؤول
// POST /store/sessions/reset — يُجبر كل عملاء هذا المتجر على استقبال الترحيب من جديد
router.post("/store/sessions/reset", auth, (req, res) => {
  const sessFile = path.join(DATA_DIR, "sessions", "bot-sessions.json");
  let removed = 0;
  try {
    const all = JSON.parse(fs.readFileSync(sessFile, "utf8") || "{}");
    for (const key of Object.keys(all)) {
      // المفتاح: storeId|phone
      if (key.startsWith(req.storeId + "|")) { delete all[key]; removed++; }
    }
    atomicFs.writeJsonSync(sessFile, all);
  } catch (e) {
    return res.status(500).json({ error: "فشل المسح: " + e.message });
  }
  audit({
    actor: req.impersonatedBy ? { type: "master", id: "master" } : { type: "store", id: req.storeId },
    action: "sessions.reset",
    target: { type: "store", id: req.storeId },
    meta: { removed },
  }, req);
  res.json({ ok: true, removed, message: `تم مسح ${removed} جلسة. سيستقبل العملاء الترحيب الجديد عند رسالتهم القادمة.` });
});

router.get("/store/handoffs", auth, (req, res) => {
  const fs = require("fs");
  const path = require("path");
  const handoffFile = path.join(__dirname, "..", "data", "handoffs.json");
  let handoffs = {};
  try { handoffs = JSON.parse(fs.readFileSync(handoffFile, "utf8")); } catch {}
  // فلتر هذا المتجر فقط — يدعم الـ keys الجديدة (storeId|phone) والقديمة (phone فقط)
  const mine = Object.entries(handoffs)
    .filter(([_, h]) => h.storeId === req.storeId)
    .map(([key, h]) => ({ phone: h.phone || key.split("|").pop(), ...h }))
    .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  res.json({ handoffs: mine, storeId: req.storeId, total: Object.keys(handoffs).length });
});

// 💰 POST /store/orders/:orderId/set-price — يضع السعر المتفق عليه ويُعلِم العميل
router.post("/store/orders/:orderId/set-price", auth, async (req, res) => {
  const { orderId } = req.params;
  const total = Number(req.body?.total);
  if (!total || total <= 0) return res.status(400).json({ error: "سعر غير صحيح" });
  const orders = readOrders(req.storeId);
  const order = orders.find(o => o.orderId === orderId);
  if (!order) return res.status(404).json({ error: "الطلب غير موجود" });
  const ok = updateOrderStatus(req.storeId, orderId, order.status || "pending_confirmation", {
    total,
    negotiatedAt: new Date().toISOString(),
    priceNegotiated: true,
  });
  if (!ok) return res.status(500).json({ error: "فشل التحديث" });

  audit({
    actor: req.impersonatedBy ? { type: "master", id: "master" } : { type: "store", id: req.storeId },
    action: "order.set_price",
    target: { type: "order", id: orderId },
    meta: { total, customerPhone: String(order.customerPhone || "").slice(0, 6) + "***" },
  }, req);

  // أبلغ العميل عبر واتساب
  if (order.customerPhone) {
    try {
      const store = getStore(req.storeId);
      const currency = store?.currency || "ر.س";
      await waMgr.sendMessage(req.storeId, order.customerPhone,
        `💰 *تم تحديد سعر طلبك*\n\n` +
        `رقم الطلب: *${orderId}*\n` +
        `السعر المتفق عليه: *${total.toFixed(2)} ${currency}*\n\n` +
        `إذا توافق على السعر، سيبدأ المتجر بمعالجة طلبك.\n` +
        `لأي استفسار، اكتب *مسؤول* للتواصل المباشر 💬`
      );
    } catch (e) { console.warn("[set-price] notify failed:", e.message); }
  }
  res.json({ ok: true, total });
});

router.post("/store/orders/:orderId/confirm", auth, async (req, res) => {
  const { orderId } = req.params;
  const orders = readOrders(req.storeId);
  const order  = orders.find(o => o.orderId === orderId);
  if (!order) return res.status(404).json({ error: "الطلب غير موجود" });
  if (order.status === "confirmed") return res.status(400).json({ error: "الطلب مؤكد مسبقاً" });

  // ⏱️ مدة التحضير (اختيارية — يحددها المتجر عند التأكيد)
  const estimatedMinutes = Number(req.body?.estimatedMinutes) > 0
    ? Math.min(720, Math.round(Number(req.body.estimatedMinutes)))
    : null;

  // 🚚 رسوم التوصيل — يختارها المتجر يدوياً عند القبول
  //   - deliveryZoneName: اسم المنطقة اللي اختارها المتجر (اختياري)
  //   - deliveryFee: الرسوم الفعلية
  //   - لو الاثنين ما اتبعثوا، تبقى الرسوم اللي حسبها البوت من الموقع
  const extraMeta = {};
  if (estimatedMinutes) extraMeta.estimatedMinutes = estimatedMinutes;
  const _newFee = req.body?.deliveryFee;
  if (_newFee !== undefined && _newFee !== null && _newFee !== "") {
    const feeNum = Number(_newFee);
    if (Number.isFinite(feeNum) && feeNum >= 0 && feeNum < 100000) {
      extraMeta.deliveryFee = feeNum;
      // إعادة حساب الإجمالي
      const _subtotal = Number(order.subtotal) || 0;
      const _discount = Number(order.discount) || 0;
      extraMeta.total = Math.max(0, _subtotal - _discount) + feeNum;
      // حدّث order in-memory قبل استخدامه لاحقاً
      order.deliveryFee = feeNum;
      order.total       = extraMeta.total;
    }
  }
  if (req.body?.deliveryZone) {
    extraMeta.deliveryZone = String(req.body.deliveryZone).trim().slice(0, 60);
    order.deliveryZone     = extraMeta.deliveryZone;
  }

  updateOrderStatus(req.storeId, orderId, "confirmed", Object.keys(extraMeta).length ? extraMeta : null);
  if (extraMeta.estimatedMinutes) Object.assign(order, { estimatedMinutes: extraMeta.estimatedMinutes });

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

  // 📨 رسالة موحّدة للعميل: التأكيد + الفاتورة في رسالة واحدة فقط
  // إن كانت الباقة Pro+ نُرسِل صورة الفاتورة بـ caption يحوي كل معلومات التأكيد
  // وإلا نُرسِل رسالة نصية شاملة فقط (لا رسالة ثانية بعدها)
  if (order.customerPhone) {
    const pointsLine = (earned && earned.newPoints > 0)
      ? `🏆 كسبت *${earned.newPoints}* نقطة! رصيدك: *${earned.totalPoints}*\n`
      : "";
    // 🎯 رسالة تأكيد كاملة: العنوان + الوقت + الجوال + الأصناف + الرسوم + الإجمالي + الدفع + Maps + الملاحظات
    const SEP = "━━━━━━━━━━━━━━";
    const currency = store?.currency || "ر.س";
    const locName = (order.customerLocationName || order.customerLocation || "")
      .replace(/\s*\(📍\s*https?:\/\/[^)]+\)/g, "").trim();
    const mapsUrl = (order.customerLocationLat && order.customerLocationLng)
      ? `https://maps.google.com/?q=${order.customerLocationLat},${order.customerLocationLng}`
      : "";

    // 🛍️ الأصناف
    const itemLines = (order.items || []).map(it => {
      const qty = Number(it.qty || it.quantity || 1);
      return `• ${it.name || ""} ×${qty}`;
    }).join("\n") || "";

    // 🚚 رسوم التوصيل (مع اسم المنطقة إن وجد)
    const feeNum = Number(order.deliveryFee || 0);
    const zoneLabel = order.deliveryZone ? ` (${order.deliveryZone})` : "";
    const feeLine   = feeNum > 0 ? `🚚 *رسوم التوصيل*${zoneLabel}: ${feeNum.toFixed(2)} ${currency}` : "";

    // 💰 الإجمالي
    const totalNum  = Number(order.total || 0);
    const totalLine = `💵 *الإجمالي:* ${totalNum.toFixed(2)} ${currency}`;

    // 💳 طريقة الدفع
    let payLine = "💵 الدفع عند الاستلام";
    if (store?.payBank === true || store?.payBank === "true" || store?.payBank === 1) {
      payLine = "🏦 تحويل بنكي أو الدفع عند الاستلام";
    } else if (store?.payStc === true || store?.payStc === "true" || store?.payStc === 1) {
      payLine = "📱 STC Pay أو الدفع عند الاستلام";
    } else if (store?.payCash === false) {
      payLine = "💳 راجع طرق الدفع مع المتجر";
    }

    // 📝 ملاحظات
    const notesText = (order.notes || order.orderNotes || "").trim();

    // ⏱️ وقت التوصيل التقديري — نحوّل الدقائق لساعة فعلية بتوقيت السعودية
    let etaLine = "";
    if (estimatedMinutes) {
      const etaDate  = new Date(Date.now() + estimatedMinutes * 60 * 1000);
      const etaClock = etaDate.toLocaleTimeString("ar-SA", {
        hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Riyadh"
      });
      etaLine = `⏱️ *موعد التوصيل:* ${etaClock} (بعد ${estimatedMinutes} دقيقة)`;
    }

    // ⏰ وقت الاستلام (اللي طلبه العميل)
    const schedLine = order.scheduledTime
      ? `⏰ *وقت الاستلام:* ${order.scheduledTime}`
      : "";

    const parts = [];
    parts.push(`✅ *تأكيد طلبك — ${orderId}*`);
    parts.push(SEP);
    // العنوان + الوقت + الجوال
    const infoLines = [];
    if (locName) infoLines.push(`📍 *العنوان:* ${locName}`);
    if (schedLine) infoLines.push(schedLine);
    if (order.customerPhone) infoLines.push(`📞 *رقم الجوال:* ${order.customerPhone}`);
    if (infoLines.length) { parts.push(infoLines.join("\n")); parts.push(SEP); }
    // الأصناف
    if (itemLines) { parts.push(`🛍️ *الأصناف:*\n${itemLines}`); parts.push(SEP); }
    // الرسوم + الإجمالي + الدفع
    const payBlock = [];
    if (feeLine) payBlock.push(feeLine);
    payBlock.push(totalLine);
    payBlock.push(payLine);
    parts.push(payBlock.join("\n"));
    parts.push(SEP);
    // Maps
    if (mapsUrl) { parts.push(`🗺️ رابط الموقع:\n${mapsUrl}`); parts.push(SEP); }
    // ملاحظات
    if (notesText) { parts.push(`📝 *ملاحظات:* ${notesText}`); parts.push(SEP); }
    // ETA + roles
    const footerLines = [];
    if (etaLine) footerLines.push(etaLine);
    if (locName) footerLines.push(`⚠️ لتعديل الموقع: *تعديل الموقع*`);
    footerLines.push(`📦 لتتبع الطلب: *تتبع*`);
    if (pointsLine) footerLines.push(pointsLine.trim());
    footerLines.push("");
    footerLines.push(`💚 شكرًا لاختيارك ${storeName}.`);
    parts.push(footerLines.join("\n"));

    const confirmCaption = parts.join("\n");

    const { PUBLIC_URL } = process.env;
    const storeFeatures = getPlanFeatures(store?.plan);
    let sentMerged = false;
    // محاولة 1: صورة فاتورة بـ caption موحّد (Pro+ ولم تُرسل سابقاً)
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
          notes:            order.notes || order.orderNotes || "",
          customAnswers:    order.customAnswers || null,
          deliveryZone:     order.deliveryZone || null,
          paymentSummary:   require("./invoice-image").buildPaymentSummary(store),
          invoiceTemplate:  store?.invoiceTemplate || "classic",
        });
        await waMgr.sendImage(req.storeId, order.customerPhone, img.filePath, confirmCaption, {
          allowCold: true, reason: "order_accepted",
        });
        updateOrderStatus(req.storeId, orderId, "confirmed", { invoiceSent: true });
        sentMerged = true;
      } catch (invErr) {
        console.error("Invoice generation error (merged):", invErr.message);
      }
    }
    // محاولة 2 (fallback): نص فقط — لا فاتورة، لا رسالة إضافية
    if (!sentMerged) {
      try {
        await waMgr.sendMessage(req.storeId, order.customerPhone, confirmCaption, {
          allowCold: true, reason: "order_accepted",
        });
      } catch (e) { console.warn("[confirm] customer notify fail:", e.message); }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // 📨 تقرير كامل للمالك على الواتس — يمكّنه من التواصل مع العميل
  //    دون فتح لوحة الادمن (احتياج العميل في v2)
  // ─────────────────────────────────────────────────────────────────────
  try {
    if (store?.ownerPhone) {
      const ownerJid = String(store.ownerPhone).replace(/\D/g, "") + "@s.whatsapp.net";
      const cust     = String(order.customerPhone || "").replace(/\D/g, "");
      const custWaLink = cust ? `https://wa.me/${cust}` : "";
      const custTelLink = cust ? `tel:+${cust}` : "";

      // العنوان: إن وُجد مع رابط Maps
      const locName = (order.customerLocationName || order.customerLocation || "")
        .replace(/\s*\(📍\s*https?:\/\/[^)]+\)/g, "").trim();
      const mapsUrl = order.customerLocationMapsUrl ||
        (order.customerLocationLat && order.customerLocationLng
          ? `https://maps.google.com/?q=${order.customerLocationLat},${order.customerLocationLng}`
          : null);

      const itemsList = (order.items || [])
        .map(it => `  • ${it.name} × ${it.qty} = ${((it.price || 0) * (it.qty || 1)).toFixed(2)} ${order.currency || "ر.س"}`)
        .join("\n");

      const customAnswers = (order.customAnswers && typeof order.customAnswers === "object")
        ? Object.entries(order.customAnswers).filter(([_, v]) => v).map(([k, v]) => `  • ${k}: ${String(v).slice(0, 100)}`).join("\n")
        : "";

      const ownerReport =
        `✅ *تم قبول الطلب — ${orderId}*\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `👤 *العميل*: ${order.customerName || "—"}\n` +
        (cust ? `📱 *الجوال*: \`${order.customerPhone}\`\n` : "") +
        (custWaLink ? `💬 محادثة واتس: ${custWaLink}\n` : "") +
        (custTelLink ? `📞 اتصال: ${custTelLink}\n` : "") +
        (locName ? `\n📍 *العنوان*: ${locName}\n` : "") +
        (mapsUrl ? `🗺️ خرائط: ${mapsUrl}\n` : "") +
        (estimatedMinutes ? `\n⏱️ *مدة التحضير*: ${estimatedMinutes} دقيقة\n` : "") +
        `\n📦 *الطلب*:\n${itemsList}\n` +
        (customAnswers ? `\n📋 *إجابات إضافية*:\n${customAnswers}\n` : "") +
        `\n━━━━━━━━━━━━━━━━━━━\n` +
        `💰 *الإجمالي*: ${(order.total || 0).toFixed(2)} ${order.currency || "ر.س"}\n` +
        (order.deliveryFee ? `🚚 توصيل: ${order.deliveryFee}\n` : "") +
        `\n_للتواصل مع العميل اضغط على رابط الواتس أعلاه._\n` +
        `_أوامر سريعة: جاهز · مندوب · تم · تراجع_`;

      // إرسال دون انتظار (لا نوقف الـ HTTP response)
      waMgr.sendMessage(req.storeId, ownerJid, ownerReport, {
        allowCold: true, reason: "owner_archive",
      })
        .catch(e => console.warn(`[owner-report] ${orderId} send failed:`, e.message));
    }
  } catch (e) {
    console.warn(`[owner-report] ${orderId} build failed:`, e.message);
  }

  // 🎁 تسليم رقمي تلقائي بعد القبول (للمنتجات الرقمية)
  // هذا الـ flow للمنتجات الرقمية بنمط "manual" — تنتظر قبول المالك ثم تُسلَّم
  try {
    const digital = require("./digital-products");
    const hasDigital = (order.items || []).some(it => {
      const p = (store.products || []).find(x => x.id === it.productId || x.name === it.name);
      return p && digital.isDigital(p);
    });
    if (hasDigital) {
      const result = await digital.deliverDigitalItems(order, store, waMgr.sendMessage);
      if (result.delivered > 0) {
        console.log(`📦 [digital-deliver] ${orderId}: delivered=${result.delivered}, outOfStock=${result.outOfStock.length}`);
        // ضع علامة في الطلب
        try {
          updateOrderStatus(req.storeId, orderId, "completed", {
            deliveryType: "digital",
            digitalDelivered: result.delivered,
            digitalOutOfStock: result.outOfStock,
          });
        } catch {}
      }
    }
  } catch (e) {
    console.warn(`[digital-deliver] ${orderId} failed:`, e.message);
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

  // ⚠️ isolation: امسح تقييم لهذا المتجر فقط (يجرّب كل صيغ مفتاح ممكنة)
  if (order.customerPhone && global.pendingRatings) {
    const phoneDigits = String(order.customerPhone).replace(/[^\d]/g, "");
    const jid = phoneDigits + "@s.whatsapp.net";
    const compKey = req.storeId + "|" + phoneDigits;
    for (const k of [compKey, jid, order.customerPhone, phoneDigits]) {
      if (!k || !global.pendingRatings.has(k)) continue;
      const p = global.pendingRatings.get(k);
      // فقط ما يخص هذا المتجر
      if (p?.storeId !== req.storeId) continue;
      if (p?.timer)         clearTimeout(p.timer);
      if (p?.reminderTimer) clearTimeout(p.reminderTimer);
      if (p?.commentTimer)  clearTimeout(p.commentTimer);
      global.pendingRatings.delete(k);
    }
  }

  // Notify customer via Baileys
  if (order.customerPhone) {
    const rejectMsg =
      `❌ *نأسف، لم نتمكن من تنفيذ طلبك*\n\n` +
      `رقم الطلب: *${orderId}*\n\n` +
      `📋 السبب: ${reason}\n\n` +
      `نأسف على الإزعاج، يسعدنا خدمتك في وقت آخر 🙏\n\n` +
      `*${storeName}*`;
    try {
      await waMgr.sendMessage(req.storeId, order.customerPhone, rejectMsg, {
        allowCold: true, reason: "order_rejected",
      });
    } catch (e) { console.warn("[reject] notify fail:", e.message); }
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
    const updated = await ratings.respondToRating(req.params.ratingId, response);
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

  // ⚠️ امسح أي تقييم معلّق للعميل — الطلب ملغي
  if (order.customerPhone && global.pendingRatings?.has(order.customerPhone)) {
    const p = global.pendingRatings.get(order.customerPhone);
    if (p?.timer) clearTimeout(p.timer);
    if (p?.reminderTimer) clearTimeout(p.reminderTimer);
    global.pendingRatings.delete(order.customerPhone);
  }

  const store = getStore(req.storeId);
  const storeName = store?.storeName || "المتجر";

  // notify the other party
  if (cancelledBy === "store" && order.customerPhone) {
    try {
      await waMgr.sendMessage(req.storeId, order.customerPhone,
        `🚫 *تم إلغاء طلبك*\n\nرقم الطلب: *${orderId}*\nالسبب: ${reasonClean}\n\nيسعدنا خدمتك مرة أخرى 🌸\n\n*${storeName}*`,
        { allowCold: true, reason: "order_rejected" });
    } catch (e) { console.warn("[cancel] cust notify fail:", e.message); }
  }
  if (cancelledBy === "customer" && store?.ownerPhone) {
    try {
      await waMgr.sendMessage(req.storeId, store.ownerPhone,
        `🚫 *العميل ألغى طلبه*\n\nالطلب: *${orderId}*\nالعميل: ${order.customerName || order.customerPhone}\nالسبب: ${reasonClean}`,
        { allowCold: true, reason: "owner_archive" });
    } catch (e) { console.warn("[cancel] owner notify fail:", e.message); }
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

// 📋 Broadcast Templates Library — 12 قالب جاهز
const bcTemplates = require("./broadcast-templates");
router.get("/store/broadcast/templates", auth, (req, res) => {
  res.json({
    ok: true,
    categories: bcTemplates.listCategories(),
    templates: bcTemplates.listTemplates(),
  });
});
router.get("/store/broadcast/templates/:id", auth, (req, res) => {
  const t = bcTemplates.getTemplate(req.params.id);
  if (!t) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, template: t });
});
router.post("/store/broadcast/templates/:id/render", auth, express.json({ limit: "100kb" }), (req, res) => {
  const result = bcTemplates.renderTemplate(req.params.id, req.body?.vars || {});
  if (!result) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, ...result });
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

// ═════ 🆕 Accounting v2 — Compare / Forecast / Break-even / Alerts / Recurring
router.get("/store/accounting/compare", auth, (req, res) => {
  const ym = req.query.yearMonth || new Date().toISOString().slice(0, 7);
  res.json(accounting.compareWithPrevMonth(req.storeId, ym));
});

router.get("/store/accounting/forecast", auth, (req, res) => {
  const ym = req.query.yearMonth || new Date().toISOString().slice(0, 7);
  res.json(accounting.forecastMonthEnd(req.storeId, ym));
});

router.get("/store/accounting/break-even", auth, (req, res) => {
  const ym = req.query.yearMonth || new Date().toISOString().slice(0, 7);
  res.json(accounting.calculateBreakEven(req.storeId, ym));
});

router.get("/store/accounting/alerts", auth, (req, res) => {
  const ym = req.query.yearMonth || new Date().toISOString().slice(0, 7);
  res.json({ alerts: accounting.detectSmartAlerts(req.storeId, ym) });
});

router.get("/store/accounting/recurring", auth, (req, res) => {
  res.json({ items: accounting.listRecurringExpenses(req.storeId) });
});

router.post("/store/accounting/recurring", auth, (req, res) => {
  const { type, amount, note, dayOfMonth, fixed } = req.body || {};
  if (!type || !amount) return res.status(400).json({ error: "type + amount مطلوبان" });
  const item = accounting.addRecurringExpense(req.storeId, { type, amount, note, dayOfMonth, fixed });
  res.json({ ok: true, item });
});

router.delete("/store/accounting/recurring/:id", auth, (req, res) => {
  accounting.deleteRecurringExpense(req.storeId, req.params.id);
  res.json({ ok: true });
});

router.post("/store/accounting/recurring/:id/toggle", auth, (req, res) => {
  const updated = accounting.toggleRecurringExpense(req.storeId, req.params.id);
  if (!updated) return res.status(404).json({ error: "غير موجود" });
  res.json({ ok: true, item: updated });
});

// CSV export للـ P&L
// CSV export للـ P&L
router.get("/store/accounting/monthly/:yearMonth/csv", auth, (req, res) => {
  const pnl = accounting.calculateMonthlyPnL(req.storeId, req.params.yearMonth);
  const rows = [
    ["البند", "القيمة (ر.س)"],
    ["الإيرادات", pnl.revenue],
    ["تكلفة البضاعة المباعة (COGS)", pnl.cogs],
    ["مجمل الربح", pnl.grossProfit],
    ["هامش الربح الإجمالي %", pnl.grossMargin],
    ["مصاريف ثابتة", pnl.fixedExpenses],
    ["مصاريف متغيرة", pnl.variableExpenses],
    ["إجمالي المصاريف", pnl.totalExpenses],
    ["الخصومات", pnl.discounts],
    ["VAT المخرجة", pnl.vatOutput],
    ["صافي الربح", pnl.netProfit],
    ["هامش الربح الصافي %", pnl.netMargin],
    ["عدد الطلبات", pnl.ordersCount],
    ["العملاء الفريدون", pnl.uniqueCustomers],
    ["متوسط قيمة الطلب", pnl.avgOrderValue],
    [],
    ["أفضل المنتجات ربحاً", ""],
    ["المنتج", "الربح", "الكمية"],
    ...pnl.topProducts.slice(0, 10).map(p => [p.name, p.profit, p.qty]),
  ];
  const csv = "﻿" + rows.map(r => r.map(c => `"${String(c || "").replace(/"/g, '""')}"`).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="pnl-${req.params.yearMonth}.csv"`);
  res.send(csv);
});

// Excel export للـ P&L
router.get("/store/accounting/monthly/:yearMonth/xlsx", auth, (req, res) => {
  const pnl = accounting.calculateMonthlyPnL(req.storeId, req.params.yearMonth);
  const rows = [
    ["البند", "القيمة (ر.س)"],
    ["الإيرادات", pnl.revenue],
    ["تكلفة البضاعة المباعة (COGS)", pnl.cogs],
    ["مجمل الربح", pnl.grossProfit],
    ["هامش الربح الإجمالي %", pnl.grossMargin],
    ["مصاريف ثابتة", pnl.fixedExpenses],
    ["مصاريف متغيرة", pnl.variableExpenses],
    ["إجمالي المصاريف", pnl.totalExpenses],
    ["الخصومات", pnl.discounts],
    ["VAT المخرجة", pnl.vatOutput],
    ["صافي الربح", pnl.netProfit],
    ["هامش الربح الصافي %", pnl.netMargin],
    ["عدد الطلبات", pnl.ordersCount],
    ["العملاء الفريدون", pnl.uniqueCustomers],
    ["متوسط قيمة الطلب", pnl.avgOrderValue],
    [],
    ["أفضل المنتجات ربحاً", ""],
    ["المنتج", "الربح", "الكمية"],
    ...pnl.topProducts.slice(0, 10).map(p => [p.name, p.profit, p.qty]),
  ];
  const thead = `<th>البند</th><th>القيمة (ر.س)</th>`;
  const tbody = rows.map(r => `<tr>${r.map(c => `<td>${_htmlEsc(c)}</td>`).join("")}</tr>`).join("");
  const html = `﻿<!DOCTYPE html><html dir="rtl" lang="ar"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Type" content="application/vnd.ms-excel; charset=UTF-8">
<title>أرباح وخسائر ${req.params.yearMonth}</title>
<style>
  body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; direction: rtl; }
  table { border-collapse: collapse; width: 100%; }
  th { background-color: #d9d9d9; font-weight: bold; text-align: right; padding: 8px; border: 1px solid #999; }
  td { padding: 6px 8px; border: 1px solid #ccc; text-align: right; }
  caption { font-weight: bold; font-size: 16px; margin-bottom: 8px; }
</style></head><body>
<table dir="rtl">
<caption>أرباح وخسائر المتجر — ${req.storeId} — ${req.params.yearMonth}</caption>
<thead><tr>${thead}</tr></thead>
<tbody>${tbody}</tbody>
</table></body></html>`;
  res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="pnl-${req.params.yearMonth}.xls"`);
  res.send(html);
});

// PDF page export للـ P&L
router.get("/store/accounting/monthly/:yearMonth/pdf.html", auth, (req, res) => {
  const pnl = accounting.calculateMonthlyPnL(req.storeId, req.params.yearMonth);
  const store = getStore(req.storeId);
  const storeName = store?.storeName || req.storeId;
  const rows = [
    ["الإيرادات", `${pnl.revenue} ر.س`],
    ["تكلفة البضاعة المباعة (COGS)", `${pnl.cogs} ر.س`],
    ["مجمل الربح", `${pnl.grossProfit} ر.س`],
    ["هامش الربح الإجمالي %", `${pnl.grossMargin}%`],
    ["مصاريف ثابتة", `${pnl.fixedExpenses} ر.س`],
    ["مصاريف متغيرة", `${pnl.variableExpenses} ر.س`],
    ["إجمالي المصاريف", `${pnl.totalExpenses} ر.س`],
    ["الخصومات", `${pnl.discounts} ر.س`],
    ["VAT المخرجة", `${pnl.vatOutput} ر.س`],
    ["صافي الربح", `${pnl.netProfit} ر.س`],
    ["هامش الربح الصافي %", `${pnl.netMargin}%`],
    ["عدد الطلبات", pnl.ordersCount],
    ["العملاء الفريدون", pnl.uniqueCustomers],
    ["متوسط قيمة الطلب", `${pnl.avgOrderValue} ر.س`],
  ];
  
  const topProductsRows = pnl.topProducts.slice(0, 10).map(p => 
    `<tr><td>${_htmlEsc(p.name)}</td><td>${p.profit} ر.س</td><td>${p.qty}</td></tr>`
  ).join("");

  const tbody = rows.map(r => `<tr><td>${_htmlEsc(r[0])}</td><td>${_htmlEsc(r[1])}</td></tr>`).join("");
  const html = `<!DOCTYPE html><html dir="rtl" lang="ar"><head>
<meta charset="UTF-8">
<title>أرباح وخسائر ${storeName} - ${req.params.yearMonth}</title>
<style>
  body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; direction: rtl; margin: 24px; color: #111827; }
  .brand { display:flex; justify-content:space-between; align-items:center; border-bottom: 3px solid #10b981; padding-bottom: 10px; margin-bottom: 20px; }
  .brand h1 { margin: 0; font-size: 22px; color: #111827; }
  .meta { font-size: 13px; color: #4b5563; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; margin-top: 15px; margin-bottom: 30px; }
  th, td { border: 1px solid #e5e7eb; padding: 10px 12px; text-align: right; }
  th { background-color: #f3f4f6; font-weight: bold; }
  .sec-title { font-size: 16px; font-weight: bold; margin-top: 20px; color: #10b981; border-bottom: 1px solid #10b981; padding-bottom: 4px; }
</style></head><body>
<div class="brand">
  <div>
    <h1>تقرير الأرباح والخسائر (P&L)</h1>
    <div class="meta">المتجر: <b>${_htmlEsc(storeName)}</b> | الشهر: <b>${req.params.yearMonth}</b></div>
  </div>
  <div class="meta" style="text-align:left">تاريخ التصدير: ${new Date().toISOString().slice(0, 10)}</div>
</div>
<table>
  <thead>
    <tr><th>البند</th><th>القيمة</th></tr>
  </thead>
  <tbody>
    ${tbody}
  </tbody>
</table>

<div class="sec-title">أفضل 10 منتجات ربحاً في هذا الشهر</div>
<table>
  <thead>
    <tr><th>المنتج</th><th>الربح</th><th>الكمية المباعة</th></tr>
  </thead>
  <tbody>
    ${topProductsRows || '<tr><td colspan="3" style="text-align:center">لا توجد بيانات</td></tr>'}
  </tbody>
</table>
<script>
  window.addEventListener("load", function(){ setTimeout(function(){ window.print(); }, 400); });
</script>
</body></html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition", `inline; filename="pnl-${req.params.yearMonth}.html"`);
  res.send(html);
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

// 📅 سجل حجوزات عميل واحد (يشمل المنتهية والملغية والقادمة)
router.get("/store/customers/:phone/bookings", auth, (req, res) => {
  try {
    const { listBookings } = require("./bookings");
    const phoneClean = String(req.params.phone).replace(/\D/g, "");
    const all = listBookings(req.storeId, { includeExpired: true });
    const mine = all.filter(b => String(b.customerPhone || "").replace(/\D/g, "") === phoneClean);
    res.json({ ok: true, bookings: mine });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// ─── 🔗 Share Slug ────────────────────────────────────────────────────────────
// GET /store/share-slug/check?slug=foo → { ok, available, taken_by? }
router.get("/store/share-slug/check", auth, (req, res) => {
  const slug = String(req.query.slug || "").toLowerCase().trim();
  if (!slug) return res.json({ ok: false, available: false, error: "empty" });
  // validate format
  if (!/^[a-z0-9][a-z0-9-]{2,18}[a-z0-9]$/.test(slug)) {
    return res.json({ ok: false, available: false, error: "format" });
  }
  const { stores } = readStores();
  const taken = stores.find(s => s.shareSlug === slug && s.id !== req.storeId);
  if (taken) return res.json({ ok: true, available: false, taken_by: "other" });
  return res.json({ ok: true, available: true });
});

// GET /store/share-slug/suggest?base=foo → ["foo", "foo2", "foo-cafe", ...]
router.get("/store/share-slug/suggest", auth, (req, res) => {
  const base = String(req.query.base || "").toLowerCase().trim().replace(/[^a-z0-9-]/g, "");
  if (!base) return res.json({ suggestions: [] });
  const { stores } = readStores();
  const taken = new Set(stores.map(s => s.shareSlug).filter(Boolean));
  const suffixes = ["", "-shop", "-cafe", "-store", "1", "2", "3", "-app", "-bot"];
  const out = [];
  for (const sfx of suffixes) {
    const cand = (base + sfx).slice(0, 20);
    if (!taken.has(cand) && cand.length >= 3) out.push(cand);
    if (out.length >= 6) break;
  }
  res.json({ suggestions: out });
});

// ─── 💬 Dine-in Table Chat ────────────────────────────────────────────────────
router.get("/store/dine-in/inbox", auth, (req, res) => {
  try {
    const tableChat = require("./table-chat");
    const tables = tableChat.getInbox(req.storeId);
    res.json({ ok: true, tables });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/store/dine-in/tables/:table/messages", auth, (req, res) => {
  try {
    const tableNum = parseInt(req.params.table, 10);
    if (!Number.isFinite(tableNum)) return res.status(400).json({ ok: false, error: "invalid_table" });
    const tableChat = require("./table-chat");
    tableChat.markRead(req.storeId, tableNum);
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const messages = tableChat.getMessages(req.storeId, tableNum, limit);
    res.json({ ok: true, table: tableNum, messages });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/store/dine-in/tables/:table/message", auth, express.json({ limit: "2kb" }), (req, res) => {
  try {
    const tableNum = parseInt(req.params.table, 10);
    if (!Number.isFinite(tableNum)) return res.status(400).json({ ok: false, error: "invalid_table" });
    const text = String(req.body?.text || "").trim().slice(0, 300);
    if (!text) return res.status(400).json({ ok: false, error: "empty_text" });
    const tableChat = require("./table-chat");
    const msg = tableChat.appendMessage(req.storeId, tableNum, "admin", text);
    try { global.sseSend?.(req.storeId, "table_message", { table: tableNum, from: "admin", text, ts: msg.ts, id: msg.id }); } catch {}
    res.json({ ok: true, message: msg });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 🗑️ حذف طلب (لتنظيف اللوحة) — يتحقق من الانتماء للمتجر قبل الحذف
router.delete("/store/orders/:orderId", auth, async (req, res) => {
  try {
    // 🛡️ دفاع: التحقق من نمط storeId (يمنع path-traversal حتى لو دخل قيمة شاذة)
    if (!/^[a-zA-Z0-9_-]+$/.test(req.storeId)) {
      return res.status(400).json({ ok: false, error: "invalid_store_id" });
    }
    const orderId = String(req.params.orderId || "").trim();
    if (!orderId) return res.status(400).json({ ok: false, error: "invalid_order_id" });

    const fs = require("fs");
    const path = require("path");
    const file = path.join(__dirname, "..", "data", `orders_${req.storeId}.jsonl`);
    if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: "no_orders_file" });
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

    // 🛡️ تحقق ثانٍ: تأكد أن الطلب فعلاً في هذا المتجر + احفظه قبل الحذف للـ audit
    let foundOrder = null;
    const remaining = lines.filter(l => {
      try {
        const obj = JSON.parse(l);
        if (obj.orderId === orderId) {
          // 🔒 لو الطلب فيه storeId مخالف لـ req.storeId → ارفض (defense-in-depth)
          if (obj.storeId && obj.storeId !== req.storeId) return true;
          foundOrder = obj;
          return false;
        }
        return true;
      } catch { return true; }
    });
    if (!foundOrder) return res.status(404).json({ ok: false, error: "order_not_found" });

    // إعادة كتابة atomic
    fs.writeFileSync(file + ".tmp", remaining.join("\n") + "\n", "utf8");
    fs.renameSync(file + ".tmp", file);
    // امسح من الـ in-memory index
    try {
      const orders = require("./orders");
      if (orders._reset) orders._reset(req.storeId);
    } catch {}
    // 📜 سجّل في audit
    try {
      require("./audit-log").logAction(req.storeId, "order_deleted", {
        orderId,
        total: foundOrder.total,
        source: foundOrder.source,
        actor: "admin",
      });
    } catch {}
    try { global.sseSend?.(req.storeId, "order_deleted", { orderId }); } catch {}
    console.log(`[orders/delete] ${orderId} from ${req.storeId}`);
    res.json({ ok: true });
  } catch (e) {
    console.warn("[orders/delete]", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
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

// ═══════════════════════ 📅 BOOKINGS ENDPOINTS ════════════════════════════════
const bookingsMod = require("./bookings");

router.get("/store/bookings", auth, (req, res) => {
  try {
    const { status, from, to, asc, limit } = req.query;
    const list = bookingsMod.listBookings(req.storeId, {
      status: status || undefined,
      from: from || undefined,
      to: to || undefined,
      asc: asc === "1" || asc === "true",
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    res.json({ bookings: list, stats: bookingsMod.getStats(req.storeId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/store/bookings", auth, async (req, res) => {
  try {
    const r = await bookingsMod.createBooking(req.storeId, req.body || {});
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 🏠 GET /store/bookings/units-availability — حالة كل الوحدات الآن
// يُستخدم في صفحة المنيو لعرض badges (متاح/محجوز/قادم)
router.get("/store/bookings/units-availability", auth, (req, res) => {
  try {
    const store = getStore(req.storeId);
    const units = (store?.products || []).filter(p => p.accommodation);
    const map = {};
    for (const u of units) {
      map[u.id] = bookingsMod.getUnitAvailability(req.storeId, u.id);
      // أضف معدل الإشغال الشهري
      const occ = bookingsMod.getUnitOccupancyRate(req.storeId, u.id);
      map[u.id].occupancyRate = occ.rate;
    }
    res.json({ units: map });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 🏠 GET /store/bookings/check-unit-availability?unitId=&from=&to=
router.get("/store/bookings/check-unit-availability", auth, (req, res) => {
  const { unitId, from, to } = req.query;
  if (!unitId || !from || !to) return res.status(400).json({ error: "unitId+from+to مطلوبة" });
  const available = bookingsMod.isUnitAvailable(req.storeId, unitId, from, to);
  res.json({ available });
});

router.put("/store/bookings/:id/status", auth, (req, res) => {
  try {
    const { status } = req.body || {};
    if (!["pending","confirmed","in_progress","completed","cancelled","no_show"].includes(status)) {
      return res.status(400).json({ error: "حالة غير صحيحة" });
    }
    const r = bookingsMod.updateBookingStatus(req.storeId, req.params.id, status);
    if (!r.ok) return res.status(404).json({ error: r.error });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/store/bookings/:id", auth, (req, res) => {
  const ok = bookingsMod.deleteBooking(req.storeId, req.params.id);
  if (!ok) return res.status(404).json({ error: "الحجز غير موجود" });
  res.json({ ok: true });
});

router.get("/store/bookings/slots", auth, (req, res) => {
  try {
    const { date, durationMin, workStart, workEnd, slotMinutes } = req.query;
    if (!date) return res.status(400).json({ error: "date مطلوب" });
    const slots = bookingsMod.getAvailableSlots(req.storeId, date, {
      durationMin: parseInt(durationMin) || 30,
      slotMinutes: parseInt(slotMinutes) || 30,
      workStart:   workStart || "09:00",
      workEnd:     workEnd   || "21:00",
    });
    res.json({ slots });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════ 🔄 CHANGE BUSINESS TYPE ════════════════════════════
// يحفظ سجل النشاط السابق + يولّد adminConfig جديد + يُعلِم الـ UI عبر SSE
// ═══════════════════════ 📦 SHIPPING & PARTNERS ════════════════════════════
// shippingConfig يُحفَظ في store object — schema:
// { carriers[], pricingTable[], suppliers[], international[] }
const SHIPPING_DEFAULTS = {
  carriers: [],
  pricingTable: [],
  suppliers: [],
  international: [],
};

router.get("/store/shipping-config", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  res.json({ config: store.shippingConfig || SHIPPING_DEFAULTS });
});

router.put("/store/shipping-config", auth, (req, res) => {
  const b = req.body || {};
  const cfg = {
    carriers:      Array.isArray(b.carriers) ? b.carriers.slice(0, 20).map(c => ({
      id:                c.id || ("c_" + Date.now() + Math.random().toString(36).slice(2,6)),
      name:              String(c.name || "").slice(0, 60),
      trackingUrlTemplate: String(c.trackingUrlTemplate || "").slice(0, 300),
      accountId:         String(c.accountId || "").slice(0, 80),
      phone:             String(c.phone || "").replace(/\D/g, "").slice(0, 15),
      notes:             String(c.notes || "").slice(0, 300),
    })).filter(c => c.name) : [],
    pricingTable:  Array.isArray(b.pricingTable) ? b.pricingTable.slice(0, 50).map(p => ({
      id:       p.id || ("p_" + Date.now() + Math.random().toString(36).slice(2,6)),
      region:   String(p.region || "").slice(0, 80),
      price:    Math.max(0, Number(p.price) || 0),
      eta:      String(p.eta || "").slice(0, 50),
    })).filter(p => p.region) : [],
    suppliers:    Array.isArray(b.suppliers) ? b.suppliers.slice(0, 50).map(s => ({
      id:       s.id || ("s_" + Date.now() + Math.random().toString(36).slice(2,6)),
      name:     String(s.name || "").slice(0, 80),
      url:      String(s.url || "").slice(0, 500),
      category: String(s.category || "").slice(0, 50),
      notes:    String(s.notes || "").slice(0, 300),
    })).filter(s => s.name) : [],
    international: Array.isArray(b.international) ? b.international.slice(0, 30).map(i => ({
      id:           i.id || ("i_" + Date.now() + Math.random().toString(36).slice(2,6)),
      country:      String(i.country || "").slice(0, 60),
      price:        Math.max(0, Number(i.price) || 0),
      customsRate:  Math.max(0, Number(i.customsRate) || 0),
      eta:          String(i.eta || "").slice(0, 50),
      notes:        String(i.notes || "").slice(0, 300),
    })).filter(i => i.country) : [],
    hours:        Array.isArray(b.hours) ? b.hours.slice(0, 7).map(h => ({
      day:    String(h.day || "").slice(0, 30),
      open:   String(h.open || "00:00").slice(0, 5),
      close:  String(h.close || "23:59").slice(0, 5),
      closed: !!h.closed,
    })) : [],
    faq:          Array.isArray(b.faq) ? b.faq.slice(0, 50).map(f => ({
      id:       f.id || ("f_" + Date.now() + Math.random().toString(36).slice(2,6)),
      question: String(f.question || "").slice(0, 200),
      answer:   String(f.answer || "").slice(0, 1000),
    })) : [],
    contacts:    Array.isArray(b.contacts) ? b.contacts.slice(0, 50).map(c => ({
      id:    c.id || ("ct_" + Date.now() + Math.random().toString(36).slice(2,6)),
      name:  String(c.name || "").slice(0, 80),
      role:  String(c.role || "").slice(0, 60),
      phone: String(c.phone || "").replace(/\D/g, "").slice(0, 15),
      notes: String(c.notes || "").slice(0, 300),
    })) : [],
  };
  updateStore(req.storeId, { shippingConfig: cfg });
  res.json({ ok: true, config: cfg });
});

// Quick tracking URL generator
router.get("/store/shipping/track/:trackingNum", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const carrier = String(req.query.carrier || "");
  const cfg = store.shippingConfig || SHIPPING_DEFAULTS;
  const car = (cfg.carriers || []).find(c => c.id === carrier || c.name === carrier);
  if (!car || !car.trackingUrlTemplate) {
    return res.json({ url: "", note: "لا يوجد قالب tracking لهذه الشركة" });
  }
  const url = car.trackingUrlTemplate.replace("{tracking}", encodeURIComponent(req.params.trackingNum));
  res.json({ url, carrier: car.name });
});

router.post("/store/change-business-type", auth, async (req, res) => {
  const { newBusinessType, reason } = req.body || {};
  if (!newBusinessType || typeof newBusinessType !== "string") {
    return res.status(400).json({ error: "نوع النشاط الجديد مطلوب" });
  }
  const cleanType = newBusinessType.trim().slice(0, 60);
  if (!cleanType) return res.status(400).json({ error: "نوع غير صحيح" });

  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const oldType = store.businessType || "غير محدد";
  if (oldType === cleanType) {
    return res.status(400).json({ error: "النوع المختار هو نفسه الحالي" });
  }

  // 📜 سجل النشاط السابق
  const history = Array.isArray(store.businessHistory) ? [...store.businessHistory] : [];
  history.push({
    type:      oldType,
    fromDate:  store.businessTypeChangedAt || store.createdAt || new Date().toISOString(),
    toDate:    new Date().toISOString(),
    reason:    String(reason || "").slice(0, 200),
  });

  // 📦 أرشفة منتجات + أصناف + 🤖 أسئلة البوت للنشاط القديم
  const archive = (store.businessArchive && typeof store.businessArchive === "object") ? { ...store.businessArchive } : {};
  archive[oldType] = {
    products:     Array.isArray(store.products) ? [...store.products] : [],
    categories:   Array.isArray(store.categories) ? [...store.categories] : [],
    botQuestions: store.botQuestions || null,   // 🆕 أرشف أسئلة البوت أيضاً
    archivedAt:   new Date().toISOString(),
    reason:       String(reason || "").slice(0, 200),
  };

  // 🔄 لو المتجر سبق له النشاط الجديد → استعد منتجاته + أسئلته
  let restoredProducts = [];
  let restoredCategories = [];
  let restoredBotQuestions = null;
  let restoredFromArchive = false;
  if (archive[cleanType] && Array.isArray(archive[cleanType].products)) {
    restoredProducts = archive[cleanType].products;
    restoredCategories = archive[cleanType].categories || [];
    restoredBotQuestions = archive[cleanType].botQuestions || null;
    restoredFromArchive = true;
    delete archive[cleanType];
  }

  // 🧠 ولّد adminConfig + أسئلة البوت بالـ AI للنوع الجديد بالتوازي
  let newAdminConfig = null;
  let generatedBotQuestions = null;
  try {
    const { generateAdminConfig } = require("./ai-admin-config");
    // نتوازى: adminConfig + bot questions
    const tasks = [generateAdminConfig(cleanType).catch(e => { console.warn("[change-biz] AI config gen failed:", e.message); return null; })];
    // لو لا توجد أسئلة مُستعادة → ولّد بالـ AI (وإلا استعدها كما هي)
    if (!restoredBotQuestions) {
      tasks.push(_generateBotQuestionsForBiz(cleanType, store?.storeName || "المتجر").catch(e => {
        console.warn("[change-biz] AI bot-questions gen failed:", e.message);
        return null;
      }));
    } else {
      tasks.push(Promise.resolve(null));
    }
    const [cfg, botQ] = await Promise.all(tasks);
    newAdminConfig = cfg;
    if (botQ && Array.isArray(botQ.fields) && botQ.fields.length) {
      generatedBotQuestions = { fields: botQ.fields, source: "ai_auto", updatedAt: new Date().toISOString() };
    }
  } catch (e) {
    console.warn("[change-biz] AI parallel gen failed:", e.message);
  }

  const updates = {
    businessType:          cleanType,
    businessTypeChangedAt: new Date().toISOString(),
    businessHistory:       history,
    businessArchive:       archive,
    products:              restoredProducts,
    categories:            restoredCategories,
  };
  if (newAdminConfig) updates.adminConfig = newAdminConfig;
  // 🤖 أولوية: مُستعاد > مُولَّد AI > حذف (يجعل defaults تعمل)
  if (restoredBotQuestions) {
    updates.botQuestions = restoredBotQuestions;
  } else if (generatedBotQuestions) {
    updates.botQuestions = generatedBotQuestions;
  } else {
    updates.botQuestions = null; // امسح القديم → defaults للنوع الجديد تظهر
  }

  updateStore(req.storeId, updates);

  try { global.sseSend?.(req.storeId, "business_changed", { newType: cleanType, label: newAdminConfig?.label, restored: restoredFromArchive }); } catch {}

  res.json({
    ok: true,
    oldType,
    newType: cleanType,
    adminConfigGenerated: !!newAdminConfig,
    botQuestionsGenerated: !!generatedBotQuestions,
    botQuestionsRestored:  !!restoredBotQuestions,
    historyCount: history.length,
    archivedCount: (store.products || []).length,
    restoredFromArchive,
    restoredProductsCount: restoredProducts.length,
  });
});

// 🤖 helper: ولّد أسئلة بوت تلقائياً للنوع الجديد (يعيد استخدام نفس prompt /bot-questions/generate)
async function _generateBotQuestionsForBiz(btype, storeName) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
  if (!GROQ_API_KEY) {
    // fallback: defaults للنوع
    const key = _normalizeBizKey(btype);
    return { fields: DEFAULT_QUESTIONS_BY_TYPE[key] || DEFAULT_QUESTIONS_BY_TYPE.delivery };
  }
  const businessDesc = `${storeName} (${btype})`;
  const prompt = `أنت خبير في تصميم بوتات WhatsApp تجارية. للنشاط:
"${businessDesc}"
نوع: ${btype}

اقترح 3-6 أسئلة يسألها البوت للعميل بعد اختياره من المنيو لإكمال الطلب.
أعد JSON صرف:
{ "fields": [{"id":"slug_eng","label":"عنوان السؤال بالعربي","prompt":"النص الكامل مع emoji","type":"location|schedule|text|number|choice|phone|date","required":true|false,"options":["خيار1"]}] }

قواعد:
- لا تطلب العنوان لنشاطات لا تحتاج (برمجة/استشارات)
- اطلب التفاصيل التي يحتاجها المتجر فعلاً
- prompt عربي طبيعي مع emoji واحد
- options فقط لو type="choice"
- id لاتيني snake_case
- 3-6 أسئلة كحد أقصى`;
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 800,
      temperature: 0.3,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const key = _normalizeBizKey(btype);
    return { fields: DEFAULT_QUESTIONS_BY_TYPE[key] || DEFAULT_QUESTIONS_BY_TYPE.delivery };
  }
  const data = await r.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed.fields) || !parsed.fields.length) {
    const key = _normalizeBizKey(btype);
    return { fields: DEFAULT_QUESTIONS_BY_TYPE[key] || DEFAULT_QUESTIONS_BY_TYPE.delivery };
  }
  // نظّف وحدّ بـ 12
  const ALLOWED_TYPES = ["location", "schedule", "text", "number", "choice", "phone", "date"];
  return {
    fields: parsed.fields.slice(0, 12).map(f => ({
      id: String(f.id || "").trim().slice(0, 50).replace(/[^a-zA-Z0-9_]/g, "_"),
      label: String(f.label || "").trim().slice(0, 80),
      prompt: String(f.prompt || "").trim().slice(0, 500),
      type: ALLOWED_TYPES.includes(f.type) ? f.type : "text",
      required: !!f.required,
      enabled: true,
      ...(f.type === "choice" && Array.isArray(f.options) ? { options: f.options.slice(0, 10).map(o => String(o).slice(0, 80)) } : {}),
    })).filter(f => f.id && f.label && f.prompt),
  };
}

// ═══════════════════════ 📦 BUSINESS ARCHIVE ════════════════════════════════
// قائمة الأنشطة المؤرشفة + عدد المنتجات/الأصناف لكل واحد
router.get("/store/business-archive", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const arch = store.businessArchive || {};
  const list = Object.entries(arch).map(([type, data]) => ({
    type,
    productsCount: (data.products || []).length,
    categoriesCount: (data.categories || []).length,
    archivedAt: data.archivedAt,
    reason: data.reason || "",
  }));
  res.json({ archive: list });
});

// حذف نهائي من الأرشيف (لا يمكن التراجع)
router.delete("/store/business-archive/:bizType", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const arch = { ...(store.businessArchive || {}) };
  const bizType = decodeURIComponent(req.params.bizType);
  if (!arch[bizType]) return res.status(404).json({ error: "النشاط غير موجود في الأرشيف" });
  const productsCount = (arch[bizType].products || []).length;
  delete arch[bizType];
  updateStore(req.storeId, { businessArchive: arch });
  res.json({ ok: true, deletedType: bizType, deletedProductsCount: productsCount });
});

// استعادة يدوية من الأرشيف (دمج مع المنتجات الحالية بدون تغيير businessType)
router.post("/store/business-archive/:bizType/merge", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const arch = { ...(store.businessArchive || {}) };
  const bizType = decodeURIComponent(req.params.bizType);
  if (!arch[bizType]) return res.status(404).json({ error: "النشاط غير موجود" });
  const archived = arch[bizType];
  const currentProducts = Array.isArray(store.products) ? store.products : [];
  const currentCategories = Array.isArray(store.categories) ? store.categories : [];
  // دمج مع منع التكرار بالـ id
  const existingIds = new Set(currentProducts.map(p => p.id));
  const merged = [...currentProducts, ...(archived.products || []).filter(p => !existingIds.has(p.id))];
  const existingCatIds = new Set(currentCategories.map(c => c.id));
  const mergedCats = [...currentCategories, ...(archived.categories || []).filter(c => !existingCatIds.has(c.id))];
  delete arch[bizType];
  updateStore(req.storeId, { products: merged, categories: mergedCats, businessArchive: arch });
  res.json({ ok: true, mergedProducts: merged.length, mergedCategories: mergedCats.length });
});

// 📥 أرشفة يدوية للمنتجات الحالية تحت اسم بيزنس قديم (للحالات السابقة التي تم تغيير نشاطها قبل ميزة الأرشفة)
router.post("/store/business-archive/manual", auth, (req, res) => {
  const { archiveAs, reason } = req.body || {};
  if (!archiveAs || typeof archiveAs !== "string") return res.status(400).json({ error: "archiveAs مطلوب" });
  const cleanAs = archiveAs.trim().slice(0, 60);
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  if ((store.products || []).length === 0 && (store.categories || []).length === 0) {
    return res.status(400).json({ error: "لا توجد منتجات أو أصناف للأرشفة" });
  }
  const arch = { ...(store.businessArchive || {}) };
  if (arch[cleanAs]) return res.status(400).json({ error: `الأرشيف يحتوي "${cleanAs}" بالفعل — احذفه أولاً أو ادمجه` });
  arch[cleanAs] = {
    products:   Array.isArray(store.products) ? [...store.products] : [],
    categories: Array.isArray(store.categories) ? [...store.categories] : [],
    archivedAt: new Date().toISOString(),
    reason:     String(reason || "أرشفة يدوية").slice(0, 200),
  };
  const archivedCount = arch[cleanAs].products.length;
  updateStore(req.storeId, { businessArchive: arch, products: [], categories: [] });
  res.json({ ok: true, archivedAs: cleanAs, archivedProductsCount: archivedCount, archivedCategoriesCount: arch[cleanAs].categories.length });
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
module.exports._getStoreQuestions = _getStoreQuestions;
module.exports._getActiveStoreQuestions = _getActiveStoreQuestions;
module.exports.generateBotQuestionsForBiz = _generateBotQuestionsForBiz;
module.exports.auth = auth; // للـ salla-router
module.exports.getStore    = getStore;    // للـ salla-router (Phase 2 webhooks)
module.exports.updateStore = updateStore;
module.exports.readStores  = readStores;
