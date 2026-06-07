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
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
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

app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/invoices",     express.static(path.join(__dirname, "..", "data", "invoices"),  { maxAge:"1d" }));
app.use("/store-images", express.static(path.join(__dirname, "..", "data", "images")));

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
app.get("/", (_req, res) => res.redirect("/platform.html"));

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
      // Use first active store config for demo
      const store = getStoreById("nakheel_001") || getAllStores()[0] || null;
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

// ─── Preview Invoice ──────────────────────────────────────────────────────────
app.get("/preview-invoice", async (req, res) => {
  try {
    const store    = getAllStores()[0] || {};
    const products = (store.products || []).filter(p => p.available !== false).slice(0, 4);
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
    case "homeService": return { needsLocation: true,  feeLabel: "رسوم الخدمة",   timeLabel: "الخدمة",    locationPrompt: "اكتب عنوانك للخدمة" };
    case "walkin":      return { needsLocation: false, feeLabel: null,            timeLabel: "الموعد",    locationPrompt: null };
    default:            return { needsLocation: true,  feeLabel: "رسوم التوصيل",  timeLabel: "التوصيل",   locationPrompt: "اكتب عنوانك أو مكان الاستلام" };
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

// sendButtons: tries real Baileys buttons, falls back to numbered text
async function sendButtons(to, { body, buttons, footer }) {
  const demo = demoCtx.getStore();
  const safe = buttons.slice(0, 3);
  // Always keep numeric map as fallback (if user types 1/2/3)
  const btnMap = {};
  safe.forEach((b, i) => { btnMap[String(i + 1)] = b.id; });
  sessionManager.update(to, { _btnMap: btnMap });

  if (demo) {
    const nums = ["1️⃣","2️⃣","3️⃣"];
    const opts = safe.map((b, i) => `${nums[i]} ${b.title}`).join("\n");
    demo.buffer.push({ type: "text", body: body + "\n\n" + opts + (footer ? "\n\n" + footer : "") });
    return;
  }
  const { storeId } = storeCtx.getStore() || {};
  if (!storeId) return;
  await waMgr.sendButtons(storeId, to, { body, buttons: safe, footer });
}

// sendList: tries real Baileys list message, falls back to numbered text
async function sendList(to, { body, sections, footer, buttonText }) {
  const demo = demoCtx.getStore();
  const rows = sections.flatMap(s => s.rows);
  // Always keep numeric map as fallback
  const rowMap = {};
  rows.forEach((r, i) => { rowMap[String(i + 1)] = r.id; });
  sessionManager.update(to, { _btnMap: rowMap });

  if (demo) {
    const nums = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
    const opts = rows.map((r, i) => `${nums[i] || `${i+1}.`} ${r.title}`).join("\n");
    demo.buffer.push({ type: "text", body: body + "\n\n" + opts + (footer ? "\n\n" + footer : "") });
    return;
  }
  const { storeId } = storeCtx.getStore() || {};
  if (!storeId) return;
  await waMgr.sendList(storeId, to, { body, sections, footer, buttonText });
}

// ─── Conversation Router ──────────────────────────────────────────────────────
async function handleMessage(from, incoming) {
  const { store, storeId } = storeCtx.getStore() || {};
  const session   = sessionManager.get(from);

  // Resolve numbered input → button ID using session's _btnMap
  let msg = incoming;
  if (/^\d+$/.test(incoming) && session._btnMap?.[incoming]) {
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
    return sendText(from, pointsMessage(from));
  }

  // Block outside working hours (except mid-flow)
  if (!isStoreOpen(store)) {
    const midFlow = ["COLLECT_NAME","COLLECT_LOCATION","CONFIRM_ORDER","QUANTITY","CART_ACTION","POST_ORDER","COUPON","RATING"]
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

  const isResetCmd = msg === "MAIN_MENU" || /^(start|ابدأ|البدايه|البداية|رجوع|الرئيسية|مرحبا|مرحباً|السلام عليكم|وعليكم السلام|هلا|هلو|أهلا|اهلا|hi|hello|hey)$/i.test(msg);
  const midFlow    = ["COLLECT_NAME","COLLECT_LOCATION","SCHEDULE_ORDER","COLLECT_TIME","CONFIRM_ORDER","QUANTITY","CART_ACTION","CART_EDIT","POST_ORDER","COUPON"]
    .includes(session.step);

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

  switch (session.step) {
    case "WELCOME":          return sendWelcome(from);
    case "MAIN_MENU":        return handleMainMenu(from, msg);
    case "CATEGORY":         return handleCategorySelection(from, msg, session);
    case "PRODUCT":          return handleProductSelection(from, msg, session);
    case "QUANTITY":         return handleQuantity(from, msg, session);
    case "CART_ACTION":      return handleCartAction(from, msg, session);
    case "CART_EDIT":        return handleCartEdit(from, msg, session);
    case "COUPON":           return handleCouponStep(from, msg, session);
    case "COLLECT_NAME":     return handleCollectName(from, msg, session);
    case "COLLECT_LOCATION": return handleCollectLocation(from, msg, session);
    case "SCHEDULE_ORDER":   return handleScheduleOrder(from, msg, session);
    case "COLLECT_TIME":     return handleCollectTime(from, msg, session);
    case "CONFIRM_ORDER":    return handleConfirmOrder(from, msg, session);
    case "POST_ORDER":       return handlePostOrder(from);
    case "DONE":             return; // صمت — ينتظر التقييم أو تحية جديدة
    default:                 return sendWelcome(from);
  }
}

// ─── Step Handlers ────────────────────────────────────────────────────────────
async function sendWelcome(from) {
  sessionManager.set(from, { step: "MAIN_MENU", cart: [] });
  const { store } = storeCtx.getStore() || {};
  const name = store?.storeName || STORE_NAME;

  if (!isStoreOpen(store)) {
    const hStart = store?.workingHoursStart ?? hourStart;
    const hEnd   = store?.workingHoursEnd   ?? hourEnd;
    return sendText(from,
      `🌙 مرحباً بك في *${name}*\n\nنعتذر، نحن حالياً خارج أوقات العمل.\n\n⏰ أوقات العمل: من ${formatHour(hStart)} حتى ${formatHour(hEnd)}\n\nسنسعد بخدمتك في الوقت المناسب 🌸`
    );
  }

  const welcome = store?.welcomeMessage || `أهلاً وسهلاً في *${name}* 🌴\n\nكيف يمكنني مساعدتك اليوم؟`;
  return sendButtons(from, {
    body: welcome,
    buttons: [
      { id: "SEE_MENU",    title: "📋 عرض القائمة" },
      { id: "MY_CART",     title: "🛒 سلة مشترياتي" },
      { id: "CONTACT_US",  title: "📞 تواصل معنا" },
    ],
  });
}

async function handleMainMenu(from, msg) {
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

async function sendCategoryMenu(from) {
  sessionManager.update(from, { step: "CATEGORY" });
  const { store } = storeCtx.getStore() || {};
  const categories = (store?.categories || []).filter(cat =>
    (store.products || []).some(p => p.category === cat.id && p.available !== false)
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
  const products  = (store?.products || []).filter(p => p.category === cat && p.available !== false);

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
  const product   = (store?.products || []).find(p => String(p.id) === String(productId) && p.available !== false);
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
  const pts       = getPoints(from);
  const redeemable = Math.floor(pts.points / 100) * 100;

  sessionManager.update(from, { step: "COUPON", couponWaiting: false });

  const couponRows = [
    { id: "COUPON_SKIP",  title: "⏭️ بدون كوبون",     description: "المتابعة بدون خصم" },
    { id: "COUPON_ENTER", title: "🎟️ لدي كود خصم",    description: "أدخل كود الخصم" },
  ];
  if (redeemable >= 100) {
    couponRows.push({ id: "POINTS_REDEEM", title: `🏆 استبدل ${redeemable} نقطة`, description: `خصم إضافي على طلبك` });
  }
  couponRows.push({ id: "BACK_CART", title: "🔙 تعديل السلة", description: "العودة لتعديل مشترياتك" });

  return sendList(from, {
    body:
      `🛍️ *تأكيد الطلب*\n\n` +
      `إجمالي السلة: *${subtotal.toFixed(2)} ${currency}*\n` +
      (pts.points > 0 ? `🏆 رصيد نقاطك: *${pts.points}* نقطة\n` : "") +
      `\nهل لديك كود خصم أو تريد استبدال نقاطك؟`,
    buttonText: "اختر",
    sections:   [{ title: "خيارات الخصم", rows: couponRows }],
    footer:     "أو اكتب كود الخصم مباشرة",
  });
}

async function handleCouponStep(from, msg, session) {
  const { store, storeId } = storeCtx.getStore() || {};
  const currency  = store?.currency || CURRENCY;
  const subtotal  = (session.cart || []).reduce((s, i) => s + i.price * i.qty, 0);

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
    const pts = getPoints(from);
    const redeemable = Math.floor(pts.points / 100) * 100;
    if (redeemable < 100) {
      sessionManager.update(from, { step: "COLLECT_NAME" });
      return sendButtons(from, { body: "❌ نقاطك غير كافية للاستبدال.\n\n📝 *اكتب اسمك الكريم* لإكمال الطلب:", buttons: [{ id: "BACK_CART", title: "🔙 تعديل السلة" }] });
    }
    const result = redeemPoints(from, redeemable);
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
  if (name.length < 2) {
    return sendButtons(from, {
      body:    "❌ من فضلك أرسل اسماً صحيحاً (حرفان على الأقل).",
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
    return sendButtons(from, {
      body:    `شكراً ${name} 😊\n\nمتى تريد ${labels.timeLabel}؟`,
      buttons: [
        { id: "SCHED_NOW",  title: "⚡ الآن" },
        { id: "SCHED_TIME", title: "🕐 وقت محدد" },
        { id: "BACK_CART",  title: "🔙 تعديل الطلب" },
      ],
    });
  }

  sessionManager.update(from, { step: "COLLECT_LOCATION" });
  return sendButtons(from, {
    body:    `شكراً ${name} 😊\n\nالآن *${labels.locationPrompt}* 📍\n\nيمكنك:\n• كتابة اسم الحي أو العنوان\n• أو مشاركة موقعك من واتساب 📌`,
    buttons: [{ id: "BACK_CART", title: "🔙 تعديل السلة" }],
  });
}

function isValidLocation(text) {
  if (!text || text.trim().length < 3) return false;
  if (/maps\.google\.com|goo\.gl\/maps|maps\.app\.goo\.gl|google\.com\/maps/.test(text)) return true;
  if (text.startsWith("📍")) return true;
  return text.trim().length >= 5;
}

async function handleCollectLocation(from, msg, session) {
  const location = msg.trim().slice(0, 500);
  if (!isValidLocation(location)) {
    return sendButtons(from, {
      body:    "❌ من فضلك أرسل عنوانك أو مكان الاستلام، أو شارك موقعك من واتساب.",
      buttons: [{ id: "BACK_CART", title: "🔙 تعديل السلة" }],
    });
  }

  sessionManager.update(from, { step: "SCHEDULE_ORDER", customerLocation: location });

  return sendButtons(from, {
    body:   `✅ *تم تسجيل العنوان*\n\n${location}\n\nمتى تريد الاستلام؟`,
    buttons: [
      { id: "SCHED_NOW",  title: "⚡ الآن" },
      { id: "SCHED_TIME", title: "🕐 وقت محدد" },
      { id: "BACK_CART",  title: "🔙 تعديل الطلب" },
    ],
  });
}

async function handleScheduleOrder(from, msg, session) {
  const { store } = storeCtx.getStore() || {};
  const { timeLabel } = businessLabels(getBusinessType(store));

  if (msg === "SCHED_NOW") {
    sessionManager.update(from, { scheduledTime: null });
    return showOrderSummary(from, sessionManager.get(from));
  }
  if (msg === "SCHED_TIME") {
    sessionManager.update(from, { step: "COLLECT_TIME" });
    return sendList(from, {
      body:       `🕐 *متى تريد ${timeLabel}؟*\n\nاختر وقتاً سريعاً أو اكتب الوقت بنفسك:`,
      buttonText: "اختر الوقت",
      sections: [{
        title: `أوقات ${timeLabel}`,
        rows: [
          { id: "TIME_30",   title: "⏱️ بعد 30 دقيقة",   description: "أقرب وقت متاح" },
          { id: "TIME_60",   title: "⏱️ بعد ساعة",        description: "" },
          { id: "TIME_90",   title: "⏱️ بعد ساعة ونصف",  description: "" },
          { id: "TIME_120",  title: "⏱️ بعد ساعتين",      description: "" },
          { id: "BACK_SCHED",title: "🔙 رجوع",             description: "" },
        ],
      }],
      footer: "أو اكتب الوقت مثل: 7:30 مساء",
    });
  }
  return sendButtons(from, {
    body:    `متى تريد ${timeLabel}؟`,
    buttons: [
      { id: "SCHED_NOW",  title: "⚡ الآن" },
      { id: "SCHED_TIME", title: "🕐 وقت محدد" },
      { id: "BACK_CART",  title: "🔙 تعديل الطلب" },
    ],
  });
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

    sessionManager.update(from, { step: "DONE", orderId });

    logOrder({
      orderId,
      storeId:          storeId || "unknown",
      storeName:        store?.storeName || STORE_NAME,
      invoiceColor:     store?.invoiceColor || null,
      invoiceLogoUrl:   store?.invoiceLogoUrl || null,
      customerName:     session.customerName,
      customerLocation: session.customerLocation,
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
      try { useCoupon(session.appliedCoupon, from); } catch {}
    }

    if (hasFeature(store?.plan, "customerRegistry")) {
      upsertCustomer({ phone: phoneNum(from), name: session.customerName, location: session.customerLocation, total: session.grandTotal });
    }

    // Award loyalty points
    const earned = addPoints(from, session.grandTotal, orderId);
    const storeName = store?.storeName || STORE_NAME;

    await sendText(from,
      `✅ *تم استلام طلبك بنجاح!*\n\n` +
      `رقم الطلب: *${orderId}*\n` +
      `الإجمالي: *${session.grandTotal?.toFixed(2)} ${currency}*\n\n` +
      `🏆 كسبت *${earned.newPoints}* نقطة! رصيدك الكلي: *${earned.totalPoints}* نقطة\n\n` +
      `طلبك قيد المراجعة، سيتم التواصل معك قريباً.\n` +
      `شكراً لاختيارك *${storeName}* 💚`
    );

    // Owner WhatsApp notification
    const ownerPhone = store?.ownerPhone;
    if (ownerPhone && storeId) {
      const orderLines = (session.cart || []).map(i => `• ${i.name} ×${i.qty}`).join("\n");
      const ownerMsg =
        `🔔 *طلب جديد — ${storeName}*\n\n` +
        `رقم الطلب: *${orderId}*\n` +
        `العميل: *${session.customerName}*\n` +
        `الهاتف: ${phoneNum(from)}\n` +
        (session.customerLocation ? `العنوان: ${session.customerLocation}\n` : "") +
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
      try { await waMgr.sendMessage(storeId, ownerJid, ownerMsg); } catch {}
    }

    // Generate + send invoice image
    if (hasFeature(store?.plan, "invoiceImage")) {
      try {
        const { filePath } = await generateInvoiceImage({
          orderId, storeName,
          invoiceColor:  store?.invoiceColor || "#1b5e20",
          invoiceLogoUrl: store?.invoiceLogoUrl || null,
          customerName:  session.customerName,
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
      try { await waMgr.sendMessage(storeId, from, ratingRequestMessage(storeName, orderId)); } catch {}
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
  } catch {}

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
  // Try slots (try_1..try_5) + legacy owner_try — use first active store as demo config
  if (storeId === "owner_try" || /^try_\d+$/.test(storeId)) {
    const demoStore = getAllStores().find(s => s.active && s.subscriptionStatus === "active") || null;
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

// ─── Pairing API (used by master panel) ──────────────────────────────────────
// Note: actual endpoints in master-router.js call waMgr directly

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
    });
  });
}
