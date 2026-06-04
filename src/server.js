/**
 * WhatsApp Commerce Bot — Main Server
 * Webhook receiver + Arabic conversation tree + Meta Cloud API client.
 *
 * Architecture:
 *   GET  /webhook   → Meta verification handshake
 *   POST /webhook   → incoming messages (always 200, then process async)
 *   GET  /health    → liveness probe (Railway/Render)
 *   GET  /orders    → simple owner-only orders feed (?token=OWNER_PHONE)
 */

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const {
  getProducts,
  getProductById,
  getAllCategories,
} = require("./sheets");
const { sessionManager } = require("./session");
const { buildInvoice } = require("./invoice");
const { generateInvoiceImage } = require("./invoice-image");
const { logOrder, readOrders } = require("./orders");

const app = express();
app.use(
  express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
  })
);
app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/invoices", express.static(path.join(__dirname, "..", "data", "invoices"), {
  maxAge: "1d",
  setHeaders: (res) => res.setHeader("Content-Type", "image/png"),
}));

const demoCtx = new AsyncLocalStorage();

const {
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID,
  VERIFY_TOKEN,
  OWNER_PHONE,
  STORE_NAME = "متجرنا",
  CURRENCY = "ر.س",
  DELIVERY_FEE = "10",
  WORKING_HOURS_START = "8",
  WORKING_HOURS_END = "24",
  META_APP_SECRET,
  PUBLIC_URL = "",
  PORT = 3000,
} = process.env;

const deliveryFee = parseFloat(DELIVERY_FEE) || 0;
const hourStart = parseInt(WORKING_HOURS_START) || 0;
const hourEnd = parseInt(WORKING_HOURS_END) || 24;

const WHATSAPP_BUTTON_LIMIT = 3;
const WHATSAPP_LIST_ROW_LIMIT = 10;

// ─── Health Check ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({ ok: true, store: STORE_NAME, time: new Date().toISOString() })
);

app.get("/", (_req, res) => res.redirect("/demo.html"));

// ─── Demo Web Simulator ──────────────────────────────────────────────────────
app.post("/api/sim", async (req, res) => {
  const { from = "demo-user-" + (req.ip || "0"), message = "" } = req.body || {};
  const buffer = [];
  try {
    await demoCtx.run({ buffer }, async () => {
      await handleMessage(String(from), String(message));
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

// ─── Orders Feed (owner only via shared secret) ──────────────────────────────
app.get("/orders", (req, res) => {
  if (!req.query.token || req.query.token !== OWNER_PHONE) {
    return res.status(403).json({ error: "forbidden" });
  }
  res.json({ orders: readOrders(parseInt(req.query.limit) || 50) });
});

// ─── Webhook Verification ────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── Incoming Messages ───────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  if (META_APP_SECRET && !verifySignature(req)) {
    console.warn("⚠️  Invalid webhook signature — rejecting");
    return res.sendStatus(401);
  }
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const msg = change?.value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const type = msg.type;
    let incoming = "";

    if (type === "text") incoming = (msg.text?.body || "").trim();
    else if (type === "interactive") {
      const inter = msg.interactive;
      incoming = inter?.button_reply?.id || inter?.list_reply?.id || "";
    }

    await handleMessage(from, incoming);
  } catch (err) {
    console.error("❌ Error handling message:", err.message);
  }
});

function verifySignature(req) {
  const sig = req.headers["x-hub-signature-256"];
  if (!sig) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody || "").digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Conversation Router ─────────────────────────────────────────────────────
async function handleMessage(from, incoming) {
  const session = sessionManager.get(from);

  if (incoming === "MAIN_MENU" || /^(start|ابدأ|البدايه|البداية|رجوع|الرئيسية)$/i.test(incoming) || !incoming) {
    sessionManager.reset(from);
    return sendWelcome(from);
  }

  switch (session.step) {
    case "WELCOME":          return sendWelcome(from);
    case "MAIN_MENU":        return handleMainMenu(from, incoming);
    case "CATEGORY":         return handleCategorySelection(from, incoming, session);
    case "PRODUCT":          return handleProductSelection(from, incoming, session);
    case "QUANTITY":         return handleQuantity(from, incoming, session);
    case "CART_ACTION":      return handleCartAction(from, incoming, session);
    case "COLLECT_NAME":     return handleCollectName(from, incoming, session);
    case "COLLECT_LOCATION": return handleCollectLocation(from, incoming, session);
    case "CONFIRM_ORDER":    return handleConfirmOrder(from, incoming, session);
    default:                 return sendWelcome(from);
  }
}

// ─── Step Handlers ───────────────────────────────────────────────────────────
async function sendWelcome(from) {
  sessionManager.set(from, { step: "MAIN_MENU", cart: [] });

  if (!isWorkingHours()) {
    return sendText(
      from,
      `🌙 مرحباً بك في *${STORE_NAME}*\n\nنعتذر، نحن حالياً خارج أوقات العمل.\n\n⏰ أوقات العمل: من ${hourStart} ص حتى ${hourEnd === 24 ? "١٢ منتصف الليل" : hourEnd}\n\nسنسعد بخدمتك في الوقت المناسب 🌸`
    );
  }

  return sendButtons(from, {
    body: `أهلاً وسهلاً في *${STORE_NAME}* 🌴\n\nنقدم لك أشهى المنتجات الطازجة يومياً.\n\nكيف يمكنني مساعدتك اليوم؟`,
    buttons: [
      { id: "SEE_MENU", title: "🍽️ عرض القائمة" },
      { id: "MY_CART", title: "🛒 سلة مشترياتي" },
      { id: "CONTACT_US", title: "📞 تواصل معنا" },
    ],
  });
}

async function handleMainMenu(from, incoming) {
  if (incoming === "SEE_MENU") return sendCategoryMenu(from);
  if (incoming === "MY_CART") return showCart(from, sessionManager.get(from));
  if (incoming === "CONTACT_US") {
    return sendText(
      from,
      `📞 *تواصل معنا*\n\n📱 واتساب: نفس هذا الرقم\n⏰ أوقات العمل: ${hourStart} ص – ${hourEnd === 24 ? "١٢م" : hourEnd}\n\nاكتب أي رسالة للعودة للقائمة 😊`
    );
  }
  return sendWelcome(from);
}

async function sendCategoryMenu(from) {
  sessionManager.update(from, { step: "CATEGORY" });

  return sendList(from, {
    body: "اختر من القائمة التالية 🍽️",
    buttonText: "عرض الأصناف",
    sections: [
      {
        title: "الأصناف المتوفرة",
        rows: [
          { id: "CAT_HOT", title: "☕ مشروبات ساخنة", description: "قهوة، شاي، كاكاو..." },
          { id: "CAT_COLD", title: "🧊 مشروبات باردة", description: "فرابتشينو، عصائر، موهيتو..." },
          { id: "CAT_FOOD", title: "🥐 معجنات وحلويات", description: "كرواسان، كيك، كوكيز..." },
        ],
      },
    ],
  });
}

async function handleCategorySelection(from, incoming, session) {
  const categoryMap = { CAT_HOT: "hot", CAT_COLD: "cold", CAT_FOOD: "food" };
  const cat = categoryMap[incoming];
  if (!cat) return sendCategoryMenu(from);

  return showProductsPage(from, cat, 0);
}

async function showProductsPage(from, cat, page) {
  let products;
  try { products = await getProducts(cat); }
  catch (e) { console.error("Sheets error:", e.message); products = getFallbackProducts(cat); }

  if (products.length === 0) products = getFallbackProducts(cat);
  if (products.length === 0) {
    sessionManager.update(from, { step: "MAIN_MENU" });
    return sendText(from, "عذراً، لا توجد منتجات متاحة حالياً في هذا الصنف. اكتب 'رجوع' للقائمة.");
  }

  const pageSize = WHATSAPP_LIST_ROW_LIMIT - 1;
  const totalPages = Math.ceil(products.length / pageSize);
  const startIdx = page * pageSize;
  const pageItems = products.slice(startIdx, startIdx + pageSize);

  sessionManager.update(from, {
    step: "PRODUCT",
    currentCategory: cat,
    currentPage: page,
  });

  const rows = pageItems.map((p) => ({
    id: `PROD_${p.id}`,
    title: truncate(`${p.name} — ${p.price} ${CURRENCY}`, 24),
    description: truncate(p.description || "", 72),
  }));

  if (page + 1 < totalPages) {
    rows.push({ id: `PAGE_NEXT`, title: `➡️ الصفحة التالية (${page + 2}/${totalPages})`, description: "عرض المزيد من المنتجات" });
  }

  return sendList(from, {
    body: `${getCategoryEmoji(cat)} *${getCategoryName(cat)}*\n\nاختر المنتج الذي تريده:`,
    buttonText: "عرض المنتجات",
    sections: [{ title: getCategoryName(cat), rows }],
    footer: totalPages > 1 ? `صفحة ${page + 1} من ${totalPages}` : undefined,
  });
}

async function handleProductSelection(from, incoming, session) {
  if (incoming === "PAGE_NEXT") {
    return showProductsPage(from, session.currentCategory, (session.currentPage || 0) + 1);
  }

  if (incoming.startsWith("PROD_")) {
    const productId = incoming.replace("PROD_", "");
    let product = null;
    try { product = await getProductById(productId); } catch {}
    if (!product) {
      const fallback = getFallbackProducts(session.currentCategory);
      product = fallback.find((p) => String(p.id) === String(productId));
    }
    if (!product) return sendCategoryMenu(from);

    sessionManager.update(from, { step: "QUANTITY", pendingProduct: product });

    if (product.image_url) {
      await sendImage(from, product.image_url, `*${product.name}*\n${product.description || ""}\n💰 ${product.price} ${CURRENCY}`);
    }

    return sendButtons(from, {
      body: `*${product.name}*\n${product.description ? product.description + "\n" : ""}💰 السعر: *${product.price} ${CURRENCY}*\n\nكم عدد الكميات؟`,
      buttons: [
        { id: "QTY_1", title: "1️⃣ قطعة" },
        { id: "QTY_2", title: "2️⃣ قطعتان" },
        { id: "QTY_3", title: "3️⃣ ثلاث قطع" },
      ],
      footer: "أو اكتب الكمية رقماً (مثل: 5)",
    });
  }

  const qty = parseInt(incoming);
  if (!isNaN(qty) && qty > 0 && session.pendingProduct) {
    return addToCart(from, session, qty);
  }

  return sendCategoryMenu(from);
}

async function handleQuantity(from, incoming, session) {
  let qty = 1;
  if (incoming === "QTY_1") qty = 1;
  else if (incoming === "QTY_2") qty = 2;
  else if (incoming === "QTY_3") qty = 3;
  else {
    const parsed = parseInt(incoming);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 99) qty = parsed;
    else return sendText(from, "❌ الكمية غير صحيحة. أرسل رقماً بين 1 و 99.");
  }
  return addToCart(from, session, qty);
}

async function addToCart(from, session, qty) {
  const product = session.pendingProduct;
  if (!product) return sendWelcome(from);

  const cart = session.cart || [];
  const existing = cart.find((i) => i.id === product.id);
  if (existing) existing.qty += qty;
  else cart.push({ id: product.id, name: product.name, price: product.price, qty });

  sessionManager.update(from, { step: "CART_ACTION", cart, pendingProduct: null });

  const total = cart.reduce((s, i) => s + i.price * i.qty, 0);

  return sendButtons(from, {
    body: `✅ تمت الإضافة!\n\n*${product.name}* × ${qty}\n💰 إجمالي السلة: *${total.toFixed(2)} ${CURRENCY}*`,
    buttons: [
      { id: "CONTINUE", title: "➕ إضافة المزيد" },
      { id: "VIEW_CART", title: "🛒 عرض السلة" },
      { id: "CHECKOUT", title: "✅ إتمام الطلب" },
    ],
  });
}

async function handleCartAction(from, incoming, session) {
  if (incoming === "CONTINUE") {
    sessionManager.update(from, { step: "CATEGORY" });
    return sendCategoryMenu(from);
  }
  if (incoming === "VIEW_CART") return showCart(from, session);
  if (incoming === "CHECKOUT") return startCheckout(from, session);
  return sendWelcome(from);
}

async function showCart(from, session) {
  const cart = session.cart || [];
  if (cart.length === 0) {
    return sendButtons(from, {
      body: "🛒 سلتك فارغة حالياً!\n\nهل تريد تصفح القائمة؟",
      buttons: [{ id: "SEE_MENU", title: "🍽️ عرض القائمة" }],
    });
  }

  const lines = cart.map((i) => `• ${i.name} × ${i.qty} = ${(i.price * i.qty).toFixed(2)} ${CURRENCY}`);
  const total = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const body = `🛒 *سلة مشترياتك:*\n\n${lines.join("\n")}\n\n──────────────\n💰 *الإجمالي: ${total.toFixed(2)} ${CURRENCY}*`;

  sessionManager.update(from, { step: "CART_ACTION" });

  return sendButtons(from, {
    body,
    buttons: [
      { id: "CHECKOUT", title: "✅ إتمام الطلب" },
      { id: "CONTINUE", title: "➕ إضافة المزيد" },
      { id: "MAIN_MENU", title: "🏠 القائمة الرئيسية" },
    ],
  });
}

async function startCheckout(from, session) {
  if (!session.cart || session.cart.length === 0) {
    return sendText(from, "🛒 سلتك فارغة. اكتب 'ابدأ' لعرض القائمة.");
  }
  sessionManager.update(from, { step: "COLLECT_NAME" });
  return sendText(from, "📝 *إتمام الطلب*\n\nمن فضلك أرسل لي *اسمك الكريم* لإكمال الطلب 😊");
}

async function handleCollectName(from, incoming, session) {
  const name = incoming.trim().slice(0, 80);
  if (name.length < 2) return sendText(from, "❌ من فضلك أرسل اسماً صحيحاً (حرفان على الأقل).");
  sessionManager.update(from, { step: "COLLECT_LOCATION", customerName: name });
  return sendText(from, `شكراً ${name} 😊\n\nالآن أرسل *عنوان التوصيل* أو *اسم الحي* 📍`);
}

async function handleCollectLocation(from, incoming, session) {
  const location = incoming.trim().slice(0, 200);
  if (location.length < 3) return sendText(from, "❌ من فضلك أرسل عنواناً صحيحاً.");

  sessionManager.update(from, { step: "CONFIRM_ORDER", customerLocation: location });

  const cart = session.cart || [];
  const subtotal = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const grandTotal = subtotal + deliveryFee;

  const lines = cart.map((i) => `• ${i.name} × ${i.qty} ........... ${(i.price * i.qty).toFixed(2)} ${CURRENCY}`);
  const invoice =
    `🧾 *ملخص طلبك:*\n\n` +
    `الاسم: ${session.customerName}\n` +
    `العنوان: ${location}\n\n` +
    `${lines.join("\n")}\n` +
    `──────────────\n` +
    `المجموع: ${subtotal.toFixed(2)} ${CURRENCY}\n` +
    `رسوم التوصيل: ${deliveryFee.toFixed(2)} ${CURRENCY}\n` +
    `*الإجمالي الكلي: ${grandTotal.toFixed(2)} ${CURRENCY}*\n\n` +
    `طريقة الدفع: عند الاستلام 💵`;

  sessionManager.update(from, { pendingInvoice: invoice, grandTotal });

  return sendButtons(from, {
    body: invoice,
    buttons: [
      { id: "CONFIRM_YES", title: "✅ تأكيد الطلب" },
      { id: "CONFIRM_NO", title: "❌ إلغاء" },
    ],
  });
}

async function handleConfirmOrder(from, incoming, session) {
  if (incoming === "CONFIRM_YES") {
    const orderId = `ORD-${Date.now().toString().slice(-7)}`;
    sessionManager.update(from, { step: "DONE", orderId });

    const subtotal = session.grandTotal - deliveryFee;
    const orderData = {
      orderId,
      storeName: STORE_NAME,
      customerName: session.customerName,
      customerLocation: session.customerLocation,
      items: session.cart,
      subtotal,
      deliveryFee,
      total: session.grandTotal,
      currency: CURRENCY,
      date: new Date().toISOString().slice(0, 10),
    };

    logOrder({
      ...orderData,
      customerPhone: from,
    });

    // توليد فاتورة كصورة
    let invoiceImageUrl = null;
    try {
      const img = generateInvoiceImage(orderData);
      if (PUBLIC_URL) {
        invoiceImageUrl = `${PUBLIC_URL.replace(/\/$/, "")}/invoices/${img.fileName}`;
      }
    } catch (err) {
      console.error("❌ Invoice image generation failed:", err.message);
    }

    await sendText(
      from,
      `*تم استلام طلبك بنجاح!*\n\nرقم الطلب: *${orderId}*\nسيتم التواصل معك قريباً لتأكيد وقت التوصيل.\n\nشكراً لاختيارك *${STORE_NAME}*`
    );

    if (invoiceImageUrl) {
      await sendImage(from, invoiceImageUrl, `فاتورة طلبك رقم ${orderId}`);
    }

    if (OWNER_PHONE) {
      const ownerMsg =
        `*طلب جديد ${orderId}*\n\n` +
        `العميل: ${session.customerName}\n` +
        `الرقم: ${from}\n` +
        `العنوان: ${session.customerLocation}\n\n` +
        session.pendingInvoice;
      await sendText(OWNER_PHONE, ownerMsg);
      if (invoiceImageUrl) {
        await sendImage(OWNER_PHONE, invoiceImageUrl, `فاتورة الطلب ${orderId}`);
      }
    }

    sessionManager.reset(from);
    return;
  }

  sessionManager.reset(from);
  return sendText(from, "تم إلغاء الطلب. نتمنى أن نخدمك مرة أخرى قريباً 😊\n\nاكتب أي رسالة للعودة للقائمة.");
}

// ─── WhatsApp API Helpers ────────────────────────────────────────────────────
async function sendText(to, body) {
  return apiCall({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body, preview_url: false },
  });
}

async function sendImage(to, link, caption) {
  return apiCall({
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { link, caption: truncate(caption || "", 1024) },
  });
}

async function sendButtons(to, { body, buttons, footer }) {
  const safeButtons = buttons.slice(0, WHATSAPP_BUTTON_LIMIT).map((b) => ({
    type: "reply",
    reply: { id: b.id, title: truncate(b.title, 20) },
  }));
  return apiCall({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: truncate(body, 1024) },
      ...(footer ? { footer: { text: truncate(footer, 60) } } : {}),
      action: { buttons: safeButtons },
    },
  });
}

async function sendList(to, { body, buttonText, sections, footer }) {
  const safeSections = sections.map((s) => ({
    title: truncate(s.title, 24),
    rows: s.rows.slice(0, WHATSAPP_LIST_ROW_LIMIT).map((r) => ({
      id: r.id,
      title: truncate(r.title, 24),
      description: truncate(r.description || "", 72),
    })),
  }));
  return apiCall({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: truncate(body, 1024) },
      ...(footer ? { footer: { text: truncate(footer, 60) } } : {}),
      action: { button: truncate(buttonText, 20), sections: safeSections },
    },
  });
}

async function apiCall(payload) {
  const store = demoCtx.getStore();
  if (store) {
    store.buffer.push(payload);
    return { messages: [{ id: "demo_" + Date.now() }] };
  }

  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    console.error("❌ WHATSAPP_TOKEN or WHATSAPP_PHONE_ID not set — cannot send");
    return;
  }
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );
    return res.data;
  } catch (err) {
    console.error("❌ WhatsApp API error:", err.response?.data?.error || err.message);
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────
function truncate(str, max) {
  if (!str) return "";
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

function isWorkingHours() {
  const hour = new Date().getHours();
  return hour >= hourStart && hour < hourEnd;
}

function getCategoryName(cat) {
  return { hot: "مشروبات ساخنة", cold: "مشروبات باردة", food: "معجنات وحلويات" }[cat] || cat;
}

function getCategoryEmoji(cat) {
  return { hot: "☕", cold: "🧊", food: "🥐" }[cat] || "🍽️";
}

function getFallbackProducts(cat) {
  const products = {
    hot: [
      { id: "h1", name: "قهوة عربية", price: 12, description: "قهوة عربية أصيلة بالهيل" },
      { id: "h2", name: "كابتشينو", price: 18, description: "كابتشينو إيطالي كلاسيكي" },
      { id: "h3", name: "لاتيه", price: 20, description: "حليب مبخر مع إسبريسو" },
      { id: "h4", name: "شاي أخضر", price: 10, description: "شاي أخضر طبيعي بالنعناع" },
    ],
    cold: [
      { id: "c1", name: "فرابتشينو", price: 22, description: "مشروب قهوة بارد بالكريمة" },
      { id: "c2", name: "موهيتو ليمون", price: 18, description: "موهيتو منعش بالليمون" },
      { id: "c3", name: "كولد برو", price: 20, description: "قهوة باردة مبردة 12 ساعة" },
      { id: "c4", name: "ميلك شيك", price: 25, description: "ميلك شيك كريمي بالشوكولاتة" },
    ],
    food: [
      { id: "f1", name: "كرواسان", price: 15, description: "كرواسان فرنسي طازج" },
      { id: "f2", name: "كيك شوكولاته", price: 22, description: "كيك بلجيكي فاخر" },
      { id: "f3", name: "كوكيز", price: 12, description: "كوكيز بالشوكولاتة" },
      { id: "f4", name: "تشيز كيك", price: 25, description: "تشيز كيك نيويورك" },
    ],
  };
  return products[cat] || [];
}

// ─── Exports for testing ─────────────────────────────────────────────────────
module.exports = { app, handleMessage };

// ─── Start Server (when run directly) ────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🤖 ${STORE_NAME} — WhatsApp Bot`);
    console.log(`📡 Listening on port ${PORT}`);
    console.log(`🔗 Webhook URL: <your-domain>/webhook`);
    console.log(`💚 Health: <your-domain>/health\n`);
  });
}
