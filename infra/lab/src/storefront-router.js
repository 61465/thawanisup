/**
 * Storefront Router — صفحة المتجر العلنية + APIs
 *
 * URL patterns:
 *   GET  /store/:slug                 → صفحة المتجر (HTML)
 *   GET  /api/storefront/:slug        → بيانات المتجر (JSON)
 *   POST /api/storefront/:slug/cart   → إنشاء/تحديث سلة
 *   GET  /api/storefront/:slug/cart/:cartId  → قراءة سلة
 *   POST /api/storefront/:slug/checkout → إنشاء طلب
 *   GET  /api/storefront/:slug/track/:orderId → تتبع طلب
 */

const express = require("express");
const fs      = require("fs");
const path    = require("path");
const router  = express.Router();

const DATA_DIR    = path.join(__dirname, "..", "data");
const STORES_FILE = path.join(DATA_DIR, "stores.json");
const CARTS_DIR   = path.join(DATA_DIR, "carts");

// ─── Helpers ────────────────────────────────────────────────────────
function _readStores() {
  try { return JSON.parse(fs.readFileSync(STORES_FILE, "utf8")); }
  catch { return { stores: [] }; }
}

function _findStore(slug) {
  const { stores } = _readStores();
  // ابحث بـ slug (اسم URL) أو id
  return stores.find(s =>
    s.slug === slug ||
    s.id === slug ||
    (s.storeName && _slugify(s.storeName) === slug)
  ) || null;
}

function _slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^؀-ۿa-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

function _publicStoreData(store) {
  // ما يُكشَف للعموم — لا أسرار
  return {
    id:        store.id,
    slug:      store.slug || _slugify(store.storeName || store.id),
    storeName: store.storeName,
    storeType: store.storeType,
    businessType: store.businessType,
    // 🆕 terms من AI config — تجعل عناوين المنيو ديناميكية حسب البيزنس
    terms: (store.adminConfig && store.adminConfig.terms) ? {
      item:       store.adminConfig.terms.item,
      items:      store.adminConfig.terms.items,
      catalog:    store.adminConfig.terms.catalog,
      cart:       store.adminConfig.terms.cart,
      customer:   store.adminConfig.terms.customer,
      order:      store.adminConfig.terms.order,
    } : null,
    tagline: store.adminConfig?.tagline || null,
    accent:  store.adminConfig?.accent || null,
    welcomeMessage: store.welcomeMessage || "",
    currency:  store.currency || "ر.س",
    deliveryFee: Number(store.deliveryFee || 0),
    invoiceColor: store.invoiceColor || null,
    invoiceLogoUrl: store.invoiceLogoUrl || null,
    address: store.address || "",
    locationMapUrl: store.locationMapUrl || "",
    ownerPhone: store.ownerPhone || "", // للزر "كلّمنا"
    workingHoursStart: store.workingHoursStart || "00:00",
    workingHoursEnd:   store.workingHoursEnd   || "23:59",
    // 💳 Payment methods (info فقط — الحسابات/الأرقام تظهر بعد اختيار الطريقة)
    payment: {
      cash: store.payCash !== false,
      bank: !!store.payBank && {
        name: store.payBankName || "",
        holder: store.payBankHolder || "",
        iban: store.payBankIban || "",
      },
      stc:  !!store.payStc  && { phone: store.payStcPhone || "" },
    },
    // 🎁 Gift wrapping (florist + gift shops)
    giftWrapping: !!store.giftWrapping ? { fee: Number(store.giftWrappingFee || 0) } : null,
    categories: (store.categories || []).map(c => ({
      id: c.id,
      name: c.name,
      emoji: c.emoji,
      subCategories: (c.subCategories || []).filter(s => s.active !== false).map(s => ({
        id: s.id, name: s.name, emoji: s.emoji,
      })),
    })),
    products: (store.products || [])
      .filter(p => p.available !== false)
      .map(p => {
        const base = {
          id: p.id,
          name: p.name,
          description: p.description || "",
          price: Number(p.price) || 0,
          category: p.category,
          subCategoryId: p.subCategoryId || "",
          imageUrl: p.imageUrl || (Array.isArray(p.images) ? p.images[0] : null),
          images: Array.isArray(p.images) ? p.images : (p.imageUrl ? [p.imageUrl] : []),
          priceOnRequest: !!p.priceOnRequest,
        };
        // 🏠 لو وحدة عقارية → أضف معلومات الإقامة + حالة التوفر الآن
        if (p.accommodation) {
          base.accommodation = p.accommodation;
          base.priceLabel = "السعر/ليلة";
          try {
            const bookings = require("./bookings");
            base.availability = bookings.getUnitAvailability(store.id, p.id);
          } catch {}
        }
        return base;
      }),
    isOpen: _isStoreOpen(store),
  };
}

function _isStoreOpen(store) {
  if (store.active === false) return false;
  if (store.subscriptionStatus && store.subscriptionStatus !== "active") return false;
  // working hours
  try {
    const [sh, sm] = String(store.workingHoursStart || "00:00").split(":").map(Number);
    const [eh, em] = String(store.workingHoursEnd   || "23:59").split(":").map(Number);
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const start = sh * 60 + sm;
    const end   = eh * 60 + em;
    if (start <= end) return cur >= start && cur <= end;
    return cur >= start || cur <= end; // crosses midnight
  } catch { return true; }
}

// ─── Cart storage (file-based, TTL 7 days) ──────────────────────────
function _cartPath(storeId, cartId) {
  const safe = String(cartId).replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
  if (!safe) throw new Error("invalid cartId");
  return path.join(CARTS_DIR, storeId, `${safe}.json`);
}

function _ensureCartDir(storeId) {
  const dir = path.join(CARTS_DIR, storeId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _readCart(storeId, cartId) {
  try {
    const p = _cartPath(storeId, cartId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch { return null; }
}

function _writeCart(storeId, cart) {
  _ensureCartDir(storeId);
  fs.writeFileSync(_cartPath(storeId, cart.id), JSON.stringify(cart, null, 2));
}

function _computeCartTotals(store, items) {
  let subtotal = 0;
  const products = store.products || [];
  const lines = (items || []).map(it => {
    const p = products.find(x => x.id === it.productId);
    if (!p) return null;
    const price = Number(p.price) || 0;
    const qty   = Math.min(99, Math.max(1, Number(it.qty) || 1));
    const line  = { productId: p.id, name: p.name, price, qty, total: price * qty, imageUrl: p.imageUrl || (Array.isArray(p.images) ? p.images[0] : null) };
    subtotal += line.total;
    return line;
  }).filter(Boolean);
  const delivery = Number(store.deliveryFee || 0);
  const total = subtotal + delivery;
  return { lines, subtotal, delivery, total };
}

// ═══════════════════════════════════════════════════════════════════
// 🌐 PUBLIC PAGES
// ═══════════════════════════════════════════════════════════════════

// GET /store/:slug — صفحة المتجر (يُخدم HTML الستاتيك)
// ⚡ no-cache على HTML لضمان نسخ JS الجديدة تصل فوراً عند التحديثات
router.get("/store/:slug", (req, res) => {
  const store = _findStore(req.params.slug);
  if (!store) {
    return res.status(404).sendFile(path.join(__dirname, "..", "public", "storefront", "not-found.html"));
  }
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "..", "public", "storefront", "store.html"));
});

// GET /store/:slug/cart — صفحة السلة المستقلة
router.get("/store/:slug/cart", (req, res) => {
  const store = _findStore(req.params.slug);
  if (!store) {
    return res.status(404).sendFile(path.join(__dirname, "..", "public", "storefront", "not-found.html"));
  }
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "..", "public", "storefront", "cart.html"));
});

// GET /track/:orderId — تتبع طلب
router.get("/track/:orderId", (req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "..", "public", "storefront", "track.html"));
});

// ═══════════════════════════════════════════════════════════════════
// 📡 STOREFRONT APIs
// ═══════════════════════════════════════════════════════════════════

// GET /api/storefront/:slug — بيانات المتجر العلنية
router.get("/api/storefront/:slug", (req, res) => {
  const store = _findStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "store_not_found" });
  res.json(_publicStoreData(store));
});

// POST /api/storefront/:slug/cart — إنشاء/تحديث سلة
// Body: { cartId?, items: [{productId, qty}] }
router.post("/api/storefront/:slug/cart", express.json({ limit: "1mb" }), (req, res) => {
  const store = _findStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "store_not_found" });

  const { cartId, items, customerPhone } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: "items required" });

  // أنشئ cartId جديد لو غير موجود
  const id = cartId || ("c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));

  // تحقق سلامة كل item
  const validItems = items
    .filter(it => it.productId && Number(it.qty) > 0)
    .slice(0, 50); // safety cap

  const totals = _computeCartTotals(store, validItems);
  const existing = _readCart(store.id, id);

  const cart = {
    id,
    storeId: store.id,
    items: validItems,
    ...totals,
    // احفظ رقم العميل لو رغب (للـ cart-abandonment recovery)
    customerPhone: customerPhone
      ? String(customerPhone).replace(/\D/g, "")
      : (existing?.customerPhone || null),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try { _writeCart(store.id, cart); }
  catch (e) { return res.status(500).json({ error: "cart_save_failed", message: e.message }); }

  res.json({ ok: true, cart });
});

// GET /api/storefront/:slug/cart/:cartId — قراءة سلة
router.get("/api/storefront/:slug/cart/:cartId", (req, res) => {
  const store = _findStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "store_not_found" });
  const cart = _readCart(store.id, req.params.cartId);
  if (!cart) return res.status(404).json({ error: "cart_not_found" });

  // أعد حساب totals (لو السعر تغيّر منذ آخر تحديث)
  const fresh = _computeCartTotals(store, cart.items);
  res.json({ ...cart, ...fresh });
});

// POST /api/storefront/:slug/checkout — إتمام الطلب
// Body: { cartId, customerName, customerPhone, customerLocation, notes? }
router.post("/api/storefront/:slug/checkout", express.json({ limit: "1mb" }), async (req, res) => {
  const store = _findStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "store_not_found" });

  if (!_isStoreOpen(store)) {
    return res.status(403).json({ error: "store_closed", message: "المتجر مغلق حالياً" });
  }

  const { cartId, customerName, customerPhone, customerLocation, notes, customerLat, customerLng, couponCode, paymentMethod, giftWrapping } = req.body || {};
  if (!cartId)          return res.status(400).json({ error: "cartId required" });
  if (!customerName)    return res.status(400).json({ error: "customerName required" });
  if (!customerPhone)   return res.status(400).json({ error: "customerPhone required" });
  if (!customerLocation) return res.status(400).json({ error: "customerLocation required" });

  // validate phone + normalize إلى E.164 صحيح (بدون 0 بادئ، مع country code)
  let phoneClean = String(customerPhone).replace(/\D/g, "");
  // إزالة 00 بادئة دولية (مثل 00201234567890 → 201234567890)
  if (phoneClean.startsWith("00")) phoneClean = phoneClean.slice(2);
  // مصر: 0101234... أو 0111... → 20101234... (11 رقم يبدأ بـ 01)
  if (/^01[0-9]{9}$/.test(phoneClean)) phoneClean = "2" + phoneClean.replace(/^0/, "");
  // السعودية: 05xxxxxxxx → 9665xxxxxxxx (10 أرقام تبدأ بـ 05)
  else if (/^05[0-9]{8}$/.test(phoneClean)) phoneClean = "966" + phoneClean.slice(1);
  // الإمارات: 05xxxxxxxx بنفس نمط 10 أرقام — نتعامل معه فقط لو store.currency يدل (نتجنب التخمين الخاطئ)
  // عام: لا نزيل 0 بادئاً تلقائياً لأرقام أخرى لتجنب تخريب JID

  if (phoneClean.length < 10 || phoneClean.length > 15) {
    return res.status(400).json({ error: "invalid_phone" });
  }
  // رفض الأرقام التي لا تزال تبدأ بـ 0 (تفقد country code)
  if (phoneClean.startsWith("0")) {
    return res.status(400).json({ error: "invalid_phone", message: "أدخل رقمك مع رمز الدولة (مثال: 201234567890 لمصر، 966512345678 للسعودية)" });
  }

  const cart = _readCart(store.id, cartId);
  if (!cart) return res.status(404).json({ error: "cart_not_found" });
  if (!cart.items?.length) return res.status(400).json({ error: "cart_empty" });

  // أعد حساب وحوّل لـ order
  const totals = _computeCartTotals(store, cart.items);
  if (!totals.lines.length) return res.status(400).json({ error: "no_valid_items" });

  // 🎟️ تطبيق كوبون (لو وُجد) — scope='cart' أو 'both'
  let couponApplied = null;
  let discount = 0;
  if (couponCode) {
    try {
      const coupons = require("./coupons");
      const v = coupons.validateCoupon(String(couponCode).trim(), store.id, totals.subtotal, phoneClean, { channel: "cart" });
      if (v.valid) {
        discount = v.discount;
        couponApplied = { code: v.code, type: v.type, discount: v.discount };
      } else {
        return res.status(400).json({ error: "invalid_coupon", message: v.message });
      }
    } catch (e) { console.warn("[storefront/coupon] error:", e.message); }
  }
  // 🎁 Gift wrapping fee
  let giftFee = 0;
  if (giftWrapping && store.giftWrapping) {
    giftFee = Number(store.giftWrappingFee || 0);
  }
  const finalTotal = Math.max(0, totals.total - discount + giftFee);

  const orderId = "ORD-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
  const customerJid = phoneClean + "@s.whatsapp.net";

  // 📍 GPS: لو وُجدت إحداثيات صالحة، اصنع google maps URL
  const lat = parseFloat(customerLat);
  const lng = parseFloat(customerLng);
  const hasGps = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const mapsUrl = hasGps ? `https://www.google.com/maps?q=${lat},${lng}` : "";

  const order = {
    orderId,
    storeId: store.id,
    status: "pending_confirmation",
    timestamp: new Date().toISOString(),
    customerName: String(customerName).slice(0, 60),
    customerPhone: customerJid,
    customerLocation: String(customerLocation).slice(0, 300),
    customerLocationName: String(customerLocation).slice(0, 300),
    customerLocationLat: hasGps ? lat : null,
    customerLocationLng: hasGps ? lng : null,
    customerLocationMapsUrl: mapsUrl || null,
    items: totals.lines.map(l => ({ productId: l.productId, name: l.name, qty: l.qty, price: l.price, imageUrl: l.imageUrl || null })),
    subtotal: totals.subtotal,
    deliveryFee: totals.delivery,
    discount: discount,
    couponCode: couponApplied?.code || null,
    total: finalTotal,
    currency: store.currency || "ر.س",
    // 💳 Payment method (cash/bank/stc) — افتراضي cash
    paymentMethod: ["cash","bank","stc"].includes(paymentMethod) ? paymentMethod : "cash",
    paymentStatus: "pending", // pending → received (يدوياً من المالك)
    // 🎁 Gift wrapping
    giftWrapping: !!giftWrapping && giftFee > 0,
    giftWrappingFee: giftFee,
    notes: notes ? String(notes).slice(0, 300) : "",
    source: "storefront",
    // 🏢 ثبّت businessType وقت الطلب — لمحاسبة per-business بعد تغيير النشاط
    businessType: store.businessType || null,
  };

  // اكتب الطلب في orders_<storeId>.jsonl
  try {
    const ordersFile = path.join(DATA_DIR, `orders_${store.id}.jsonl`);
    fs.appendFileSync(ordersFile, JSON.stringify(order) + "\n");
  } catch (e) {
    console.error("[storefront/checkout] write order failed:", e.message);
    return res.status(500).json({ error: "save_failed" });
  }

  // أبلغ المالك + العميل عبر واتس + تسليم رقمي تلقائي (لو وُجد)
  try {
    const waMgr = require("./whatsapp-manager");
    const digital = require("./digital-products");
    const lines = order.items.map(i => `• ${i.name} × ${i.qty} = ${(i.price * i.qty).toFixed(2)} ${order.currency}`).join("\n");

    // 🎁 تحقق: هل الطلب كله رقمي auto-delivery؟ → سلّم فوراً
    const autoDeliver = digital.isFullyAutoDeliverable(order, store);

    // 📋 تقرير الطلب الكامل
    const custWaLink = `https://wa.me/${phoneClean}`;
    const locationLine = mapsUrl
      ? `📍 *العنوان*: ${order.customerLocation}\n🗺️ *خريطة*: ${mapsUrl}\n`
      : `📍 *العنوان*: ${order.customerLocation}\n`;

    // 💳 الدفع: نضيف تفاصيل البنك/STC للمالك ليعرف ماذا يفحص
    let payLine = "";
    if (order.paymentMethod === "bank") {
      const bankInfo = [
        store.payBankName   ? `   البنك: ${store.payBankName}`   : "",
        store.payBankHolder ? `   باسم: ${store.payBankHolder}` : "",
        store.payBankIban   ? `   IBAN: ${store.payBankIban}`   : "",
      ].filter(Boolean).join("\n");
      payLine = `💳 *الدفع*: 🏦 تحويل بنكي (انتظر screenshot)\n${bankInfo ? bankInfo + "\n" : ""}`;
    } else if (order.paymentMethod === "stc") {
      payLine = `💳 *الدفع*: 📱 STC Pay${store.payStcPhone ? ` (${store.payStcPhone})` : ""} (انتظر screenshot)\n`;
    } else {
      payLine = `💳 *الدفع*: 💵 نقداً عند الاستلام\n`;
    }
    const couponLine = order.couponCode
      ? `🎟️ *كوبون*: ${order.couponCode} (خصم ${order.discount.toFixed(2)} ${order.currency})\n` : "";

    const reportMsg =
      `🛍️ *طلب جديد من المتجر العلني — ${orderId}*\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `👤 *العميل*: ${order.customerName}\n` +
      `📱 *الجوال*: +${phoneClean}\n` +
      `💬 *كلم العميل مباشرة*: ${custWaLink}\n` +
      locationLine +
      (order.notes ? `📝 *ملاحظات*: ${order.notes}\n` : "") +
      `\n📦 *الطلب*:\n${lines}\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `💰 الفرعي: ${order.subtotal.toFixed(2)} ${order.currency}\n` +
      (order.deliveryFee ? `🚚 توصيل: ${order.deliveryFee.toFixed(2)} ${order.currency}\n` : "") +
      (order.giftWrapping ? `🎁 تغليف هدية: ${order.giftWrappingFee.toFixed(2)} ${order.currency}\n` : "") +
      couponLine +
      payLine +
      `*💵 الإجمالي: ${order.total.toFixed(2)} ${order.currency}*\n\n` +
      (autoDeliver
        ? `✨ *منتج رقمي* — تم التسليم التلقائي للعميل`
        : `_للقبول: اكتب_ *قبول*  _أو من لوحة الادمن_`);

    // 🔐 استخرج رقم المتجر الحقيقي من الـ session (المصدر الموثوق — أدق من store.ownerPhone)
    const ownPhone = waMgr.getOwnPhone(store.id) || String(store.ownerPhone || "").replace(/\D/g, "");
    const ownerJid = ownPhone ? (ownPhone + "@s.whatsapp.net") : null;

    // 🛡️ كشف "العميل والمتجر نفس الرقم" — حالة الاختبار أو مالك يطلب من رقمه
    const sameNumber = ownPhone && waMgr.isSamePhone(ownPhone, phoneClean);
    if (sameNumber) {
      console.log(`[storefront] ⚠️ ${orderId}: customer phone == store phone (${phoneClean}). Sending owner-archive only.`);
    }

    // 📂 أرسل التقرير في محادثة الرقم مع نفسه (chat-to-self) للأرشيف الدائم
    if (ownerJid) {
      waMgr.sendMessage(store.id, ownerJid, reportMsg, {
        allowCold: true, reason: "owner_archive",
      })
        .catch(e => console.warn("[storefront] owner-archive failed:", e.message));
    }

    if (autoDeliver) {
      // 🚀 تسليم تلقائي للمنتجات الرقمية
      const result = await digital.deliverDigitalItems(order, store, waMgr.sendMessage);
      console.log(`📦 [auto-deliver] ${orderId}: delivered=${result.delivered}, outOfStock=${result.outOfStock.length}`);

      // حدّث الطلب: confirmed تلقائياً
      if (result.delivered > 0) {
        try {
          const ordersFile = path.join(DATA_DIR, `orders_${store.id}.jsonl`);
          const lines2 = fs.readFileSync(ordersFile, "utf8").split("\n").filter(Boolean);
          const updated = lines2.map(l => {
            try {
              const o = JSON.parse(l);
              if (o.orderId === orderId) {
                o.status = "completed";
                o.completedAt = new Date().toISOString();
                o.deliveryType = "digital_auto";
                return JSON.stringify(o);
              }
              return l;
            } catch { return l; }
          });
          fs.writeFileSync(ordersFile, updated.join("\n") + "\n");
        } catch (e) { console.warn("[auto-deliver] order update failed:", e.message); }
      }
    } else if (!sameNumber) {
      // 📲 إشعار بسيط للعميل — لا حوار، فقط تأكيد + رابط تتبع
      // المالك بنفسه يكلم العميل لأي تواصل (عبر wa.me من التقرير)
      // ⚠️ نتجنب الإرسال لو رقم العميل = رقم المتجر (يصبح chat-to-self مكرر)
      const base = (process.env.PUBLIC_URL || `https://${req.headers.host}`).replace(/\/$/, "");
      const trackUrl = `${base}/track/${orderId}`;
      const custMsg =
        `✅ تم استلام طلبك من *${store.storeName}*\n\n` +
        `رقم الطلب: \`${orderId}\`\n` +
        `الإجمالي: ${order.total.toFixed(2)} ${order.currency}\n\n` +
        `🔍 تتبع طلبك:\n${trackUrl}\n\n` +
        `سيتواصل معك المتجر مباشرة عند تأكيد الطلب.`;
      waMgr.sendMessage(store.id, customerJid, custMsg, { allowCold: true, reason: "order_ack" })
        .then(() => console.log(`[storefront] ✅ ${orderId} customer ack sent to ${phoneClean}`))
        .catch(e => console.warn(`[storefront] customer ack failed for ${phoneClean}:`, e.message));
    }
  } catch (e) { console.warn("[storefront] WA notify error:", e.message); }

  // امسح السلة (تم تحويلها لطلب)
  try { fs.unlinkSync(_cartPath(store.id, cartId)); } catch {}

  // 🎟️ سجّل استخدام الكوبون
  if (couponApplied) {
    try { require("./coupons").useCoupon(couponApplied.code, phoneClean); } catch {}
  }

  res.json({ ok: true, order: { orderId, total: order.total, currency: order.currency, discount: order.discount || 0, couponCode: order.couponCode } });
});

// GET /api/storefront/:slug/track/:orderId — تتبع طلب
router.get("/api/storefront/:slug/track/:orderId", (req, res) => {
  const store = _findStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "store_not_found" });
  const { orderId } = req.params;
  try {
    const ordersFile = path.join(DATA_DIR, `orders_${store.id}.jsonl`);
    if (!fs.existsSync(ordersFile)) return res.status(404).json({ error: "order_not_found" });
    const lines = fs.readFileSync(ordersFile, "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        if (o.orderId === orderId) {
          return res.json({
            orderId: o.orderId,
            status: o.status,
            total: o.total,
            currency: o.currency,
            items: o.items,
            timestamp: o.timestamp,
            rejectReason: o.rejectReason || null,
          });
        }
      } catch {}
    }
    res.status(404).json({ error: "order_not_found" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── cleanup carts older than 7 days ────────────────────────────────
setInterval(() => {
  if (!fs.existsSync(CARTS_DIR)) return;
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    const stores = fs.readdirSync(CARTS_DIR);
    for (const sid of stores) {
      const dir = path.join(CARTS_DIR, sid);
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const fp = path.join(dir, f);
        const stat = fs.statSync(fp);
        if (stat.mtime.getTime() < cutoff) {
          fs.unlinkSync(fp);
          removed++;
        }
      }
    }
    if (removed > 0) console.log(`[storefront] cleaned ${removed} expired carts`);
  } catch (e) { console.warn("[storefront] cleanup failed:", e.message); }
}, 60 * 60 * 1000); // كل ساعة

// ═══════════════════════════════════════════════════════════════
// 🛍️ STOREFRONT v2 — Search + Filters + Share + Customer History
// ═══════════════════════════════════════════════════════════════

// 🔍 GET /api/storefront/:slug/search?q=...&cat=...&min=...&max=...
// بحث ذكي في المنتجات (اسم + وصف + سعر) — يعمل offline بدون AI
// 🏠 GET /api/storefront/:slug/unit-bookings/:unitId
// public — يرجع كل الفترات المحجوزة للوحدة (للعرض في كالندر الحجز)
router.get("/api/storefront/:slug/unit-bookings/:unitId", (req, res) => {
  const store = _findStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "store_not_found" });
  const unitId = req.params.unitId;
  const unit = (store.products || []).find(p => p.id === unitId && p.accommodation);
  if (!unit) return res.status(404).json({ error: "unit_not_found" });
  try {
    const bookings = require("./bookings");
    // ⚠️ includeExpired=true — نحتاج كل الحجوزات لمنع double-booking
    const all = bookings.listBookings(store.id, { includeExpired: true });
    const now = Date.now();
    // فقط الحجوزات النشطة (غير الملغاة + endAt مستقبلي)
    const periods = all
      .filter(b => b.unitId === unitId && b.endAt && !["cancelled","rejected","no_show"].includes(b.status))
      .filter(b => new Date(b.endAt).getTime() > now)
      .map(b => ({ startAt: b.startAt, endAt: b.endAt, status: b.status }));
    res.json({ unitId, periods });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 🏠 GET /api/storefront/:slug/check-availability?unitId=&from=&to=
// public — للعميل ليتأكد قبل الإرسال (الـ source of truth في POST /book-unit)
router.get("/api/storefront/:slug/check-availability", (req, res) => {
  const store = _findStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "store_not_found" });
  const { unitId, from, to } = req.query;
  if (!unitId || !from || !to) return res.status(400).json({ error: "unitId+from+to مطلوبة" });
  const unit = (store.products || []).find(p => p.id === unitId && p.accommodation);
  if (!unit) return res.status(404).json({ error: "unit_not_found" });
  try {
    const bookings = require("./bookings");
    const available = bookings.isUnitAvailable(store.id, unitId, from, to);
    res.json({ available });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 🏠 POST /api/storefront/:slug/book-unit — حجز وحدة عقارية من webview العلني
// Body: { unitId, unitName, startAt, endAt, pricePerNight, guests, customerName, customerPhone, notes }
router.post("/api/storefront/:slug/book-unit", express.json({ limit: "5kb" }), async (req, res) => {
  const store = _findStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "store_not_found" });
  const b = req.body || {};
  if (!b.unitId || !b.startAt || !b.endAt) return res.status(400).json({ error: "unitId+startAt+endAt مطلوبة" });
  if (!b.customerName || !b.customerPhone) return res.status(400).json({ error: "اسم العميل + رقم الجوال مطلوبان" });
  const unit = (store.products || []).find(p => p.id === b.unitId && p.accommodation);
  if (!unit) return res.status(404).json({ error: "unit_not_found" });

  // فحص + إنشاء حجز ذرّياً (الأول يفوز عند التأكيد)
  try {
    const bookings = require("./bookings");
    const r = await bookings.createBooking(store.id, {
      customerName:  String(b.customerName).slice(0, 80),
      customerPhone: String(b.customerPhone).replace(/\D/g, "").slice(0, 15),
      serviceName:   unit.name,
      startAt:       b.startAt,
      endAt:         b.endAt,
      unitId:        b.unitId,
      unitName:      unit.name,
      pricePerNight: Number(unit.price) || 0,
      guests:        b.guests || null,
      notes:         String(b.notes || "").slice(0, 300),
    });
    if (!r.ok) return res.status(r.code === "UNIT_UNAVAILABLE" ? 409 : 400).json({ error: r.error });
    // إشعار المالك في الواتس (بدون await — يتم في الخلفية)
    try {
      const ownerPhone = String(store.ownerPhone || "").replace(/\D/g,"");
      if (ownerPhone) {
        const waMgr = require("./whatsapp-manager");
        const ownerJid = ownerPhone + "@s.whatsapp.net";
        const inDate  = new Date(b.startAt).toLocaleDateString("ar-EG",{month:"short",day:"numeric"});
        const outDate = new Date(b.endAt).toLocaleDateString("ar-EG",{month:"short",day:"numeric"});
        const guestsTxt = b.guests ? ` · 👥 ${b.guests}` : "";
        const msg = `🏠 *حجز جديد للوحدة "${unit.name}"*\n\n` +
          `👤 ${b.customerName}\n📱 +${String(b.customerPhone).replace(/\D/g,"")}\n` +
          `🔑 ${inDate} → 👋 ${outDate}${guestsTxt}\n` +
          `💰 ${r.booking.totalPrice} ر.س (${r.booking.nights} ليلة)\n` +
          (b.notes ? `📝 ${b.notes}\n` : "") +
          `\n📋 افتح لوحة التاجر لتأكيد الحجز`;
        waMgr.sendMessage(store.id, ownerJid, msg).catch(()=>{});
      }
    } catch {}
    res.json({ ok: true, booking: r.booking });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/storefront/:slug/search", (req, res) => {
  const store = _findStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "store_not_found" });
  const q   = String(req.query.q || "").trim().toLowerCase();
  const cat = String(req.query.cat || "").trim();
  const min = parseFloat(req.query.min) || 0;
  const max = parseFloat(req.query.max) || Infinity;

  const products = (store.products || []).filter(p => p.available !== false);
  let results = products.filter(p => {
    if (cat && p.category !== cat) return false;
    if (p.price < min || p.price > max) return false;
    if (!q) return true;
    const hay = `${p.name || ""} ${p.description || ""}`.toLowerCase();
    // كل كلمة في الـ q يجب أن تظهر (AND search)
    return q.split(/\s+/).every(word => hay.includes(word));
  });
  res.json({
    ok: true,
    total: results.length,
    products: results.slice(0, 100).map(p => ({
      id: p.id, name: p.name, price: p.price, category: p.category,
      imageUrl: p.imageUrl || (p.images && p.images[0]) || null,
      digital: p.productType === "digital" || undefined,
    })),
  });
});

// 📤 GET /api/storefront/:slug/share-url?cartId=...
// رابط واتس لمشاركة سلة (يدعم Web Share API)
router.get("/api/storefront/:slug/share-url", (req, res) => {
  const store = _findStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "store_not_found" });
  const base = (process.env.PUBLIC_URL || `https://${req.headers.host}`).replace(/\/$/, "");
  const cartId = String(req.query.cartId || "").trim();
  const slug = encodeURIComponent(store.slug || store.id);
  const url = cartId ? `${base}/store/${slug}/cart?c=${cartId}` : `${base}/store/${slug}`;
  const text = encodeURIComponent(`شف منتجات ${store.storeName || "المتجر"} 🛍️\n${url}`);
  res.json({
    ok: true,
    url,
    whatsapp: `https://wa.me/?text=${text}`,
    twitter: `https://twitter.com/intent/tweet?text=${text}`,
    telegram: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(store.storeName || "")}`,
  });
});

// 👤 GET /api/storefront/:slug/my-orders?phone=...
// تاريخ طلبات عميل بناءً على رقم الجوال (lookup سريع، بدون login)
router.get("/api/storefront/:slug/my-orders", (req, res) => {
  const store = _findStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "store_not_found" });
  const phone = String(req.query.phone || "").replace(/\D/g, "");
  if (!phone) return res.status(400).json({ error: "phone required" });
  try {
    const fs = require("fs");
    const ordersFile = require("path").join(__dirname, "..", "data", `orders_${store.id}.jsonl`);
    if (!fs.existsSync(ordersFile)) return res.json({ ok: true, orders: [] });
    const lines = fs.readFileSync(ordersFile, "utf8").trim().split("\n").filter(Boolean);
    const last9 = phone.slice(-9);
    const mine = [];
    for (const l of lines) {
      try {
        const o = JSON.parse(l);
        const opPhone = String(o.customerPhone || "").replace(/\D/g, "");
        if (opPhone.endsWith(last9)) {
          mine.push({
            orderId: o.orderId,
            timestamp: o.timestamp,
            status: o.status,
            total: o.total,
            items: (o.items || []).slice(0, 5).map(i => ({ name: i.name, qty: i.qty })),
          });
        }
      } catch {}
    }
    res.json({ ok: true, orders: mine.slice(-20).reverse() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 🎟️ POST /api/storefront/:slug/coupon/validate
// التحقق من كوبون قبل checkout — يرجع discount + message للعميل
router.post("/api/storefront/:slug/coupon/validate", express.json({ limit: "32kb" }), (req, res) => {
  const store = _findStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "store_not_found" });
  const { code, cartId, phone } = req.body || {};
  if (!code) return res.status(400).json({ error: "code_required" });

  const cart = cartId ? _readCart(store.id, cartId) : null;
  if (!cart || !cart.items?.length) return res.status(400).json({ error: "cart_empty" });

  const totals = _computeCartTotals(store, cart.items);
  const phoneClean = phone ? String(phone).replace(/\D/g, "") : "";

  try {
    const coupons = require("./coupons");
    const v = coupons.validateCoupon(String(code).trim(), store.id, totals.subtotal, phoneClean, { channel: "cart" });
    if (!v.valid) return res.status(400).json({ valid: false, message: v.message });
    res.json({
      valid: true,
      code: v.code,
      discount: v.discount,
      type: v.type,
      message: v.message,
      newTotal: Math.max(0, totals.total - v.discount),
    });
  } catch (e) {
    res.status(500).json({ error: "validate_failed", message: e.message });
  }
});

// 📊 GET /api/storefront/:slug/popular
// أكثر 10 منتجات مبيعاً (آخر 30 يوم) — للعرض في "الأكثر طلباً"
router.get("/api/storefront/:slug/popular", (req, res) => {
  const store = _findStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "store_not_found" });
  try {
    const fs = require("fs");
    const ordersFile = require("path").join(__dirname, "..", "data", `orders_${store.id}.jsonl`);
    if (!fs.existsSync(ordersFile)) return res.json({ ok: true, popular: [] });
    const lines = fs.readFileSync(ordersFile, "utf8").trim().split("\n").filter(Boolean).slice(-500);
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const counts = new Map();
    for (const l of lines) {
      try {
        const o = JSON.parse(l);
        if (o._test || new Date(o.timestamp).getTime() < cutoff) continue;
        for (const it of (o.items || [])) {
          const key = it.productId || it.name;
          counts.set(key, (counts.get(key) || 0) + (it.qty || 1));
        }
      } catch {}
    }
    const products = store.products || [];
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([key, count]) => {
        const p = products.find(x => x.id === key || x.name === key);
        if (!p) return null;
        return {
          id: p.id, name: p.name, price: p.price,
          imageUrl: p.imageUrl || (p.images && p.images[0]) || null,
          soldCount: count,
        };
      })
      .filter(Boolean);
    res.json({ ok: true, popular: top });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
