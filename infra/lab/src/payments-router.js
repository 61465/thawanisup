/**
 * Payments & Subscriptions Router
 * Stripe integration — Visa / Mastercard / Apple Pay
 * Routes: /payments/*
 */

const express   = require("express");
const fs        = require("fs");
const path      = require("path");
const crypto    = require("crypto");
const rateLimit = require("express-rate-limit");

// تقارن قيمتين بطريقة آمنة من timing attacks
function safeEqualStr(a, b) {
  if (!a || !b) return false;
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Rate limiter: 20 طلب/دقيقة/IP على endpoints الدفع لمنع abuse
const paymentsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "محاولات كثيرة، حاول لاحقاً" },
});

const router   = express.Router();
const DATA_DIR = path.join(__dirname, "..", "data");
const STORES_FILE = path.join(DATA_DIR, "stores.json");
const PROCESSED_EVENTS_FILE = path.join(DATA_DIR, "stripe-processed-events.json");

const STRIPE_SECRET  = process.env.STRIPE_SECRET_KEY  || "";
const STRIPE_WEBHOOK = process.env.STRIPE_WEBHOOK_SECRET || "";
const PUBLIC_URL     = (process.env.PUBLIC_URL || "").replace(/\/$/, "");

// ─── Store auth middleware (يتحقق من x-store-token عبر store-router) ─────────
const { verifyStoreToken } = require("./store-router");
function storeAuth(req, res, next) {
  const token = req.headers["x-store-token"] || (req.body && req.body.token);
  const storeId = verifyStoreToken(token);
  if (!storeId) return res.status(401).json({ error: "يرجى تسجيل الدخول" });
  // يجب أن يطابق storeId المُرسَل في body
  const claimedId = req.body?.storeId || req.params?.storeId;
  if (claimedId && claimedId !== storeId) {
    return res.status(403).json({ error: "غير مصرّح بإدارة هذا المتجر" });
  }
  req.storeId = storeId;
  next();
}

// Plans config — يمكن تعديل الأسعار هنا
const PLANS = {
  basic: {
    name: "الأساسي",
    priceMonthly: 9900,   // بالهللة (99 ر.س)
    priceYearly:  89100,  // (891 ر.س = 9 شهور بسعر 10)
    currency: "sar",
    features: ["بوت واتساب كامل", "لوحة تحكم المتجر", "200 طلب/شهر", "دعم فني"],
  },
  pro: {
    name: "الاحترافي",
    priceMonthly: 19900,
    priceYearly:  179100,
    currency: "sar",
    features: ["كل مميزات الأساسي", "طلبات غير محدودة", "تقارير متقدمة", "دعم أولوي"],
  },
};

const atomicFs = require("./atomic-fs");
// ─── Storage helpers ──────────────────────────────────────────────────────────
function readStores() {
  return atomicFs.readJsonSync(STORES_FILE, { stores: [] });
}
function writeStores(data) {
  atomicFs.writeJsonSync(STORES_FILE, data);
}
function updateStore(id, updates) {
  const data = readStores();
  const idx  = data.stores.findIndex(s => s.id === id);
  if (idx === -1) return null;
  data.stores[idx] = { ...data.stores[idx], ...updates, id };
  writeStores(data);
  return data.stores[idx];
}
function getStore(id) {
  return readStores().stores.find(s => s.id === id) || null;
}

// ─── Stripe lazy init (only if key is configured) ────────────────────────────
let stripe = null;
function getStripe() {
  if (!stripe && STRIPE_SECRET) stripe = require("stripe")(STRIPE_SECRET);
  return stripe;
}

// ─── GET /payments/plans — public, returns plan info ─────────────────────────
router.get("/payments/plans", (_req, res) => {
  res.json({ plans: PLANS });
});

// ─── POST /payments/create-checkout ──────────────────────────────────────────
// Body: { storeId, plan: "basic"|"pro", period: "monthly"|"yearly" }
router.post("/payments/create-checkout", paymentsLimiter, storeAuth, async (req, res) => {
  const s = getStripe();
  if (!s) return res.status(503).json({ error: "بوابة الدفع غير مفعّلة بعد" });

  const { plan = "basic", period = "monthly" } = req.body || {};
  const storeId = req.storeId; // من session

  const store = getStore(storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const planData = PLANS[plan];
  if (!planData) return res.status(400).json({ error: "خطة غير صحيحة" });

  const unitAmount = period === "yearly" ? planData.priceYearly : planData.priceMonthly;
  const label      = `${planData.name} — ${period === "yearly" ? "سنوي" : "شهري"}`;

  try {
    const session = await s.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [{
        price_data: {
          currency: planData.currency,
          product_data: {
            name: `بوت واتساب — ${label}`,
            description: planData.features.join(" • "),
          },
          unit_amount: unitAmount,
          recurring: { interval: period === "yearly" ? "year" : "month" },
        },
        quantity: 1,
      }],
      metadata: { storeId, plan, period },
      customer_email: store.ownerEmail || undefined,
      success_url: `${PUBLIC_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${PUBLIC_URL}/store-admin.html`,
      locale: "ar",
    });

    res.json({ ok: true, checkoutUrl: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err.message);
    res.status(500).json({ error: "فشل إنشاء جلسة الدفع" });
  }
});

// ─── POST /payments/manage-subscription ──────────────────────────────────────
// Returns Stripe customer portal URL (storeId مأخوذ من session)
router.post("/payments/manage-subscription", paymentsLimiter, storeAuth, async (req, res) => {
  const s = getStripe();
  if (!s) return res.status(503).json({ error: "بوابة الدفع غير مفعّلة" });

  const store = getStore(req.storeId);
  if (!store?.stripeCustomerId) return res.status(404).json({ error: "لا يوجد اشتراك مفعّل" });

  try {
    const portal = await s.billingPortal.sessions.create({
      customer: store.stripeCustomerId,
      return_url: `${PUBLIC_URL}/store-admin.html`,
    });
    res.json({ ok: true, portalUrl: portal.url });
  } catch (err) {
    console.error("Stripe portal error:", err.message);
    res.status(500).json({ error: "فشل فتح بوابة إدارة الاشتراك" });
  }
});

// ─── Idempotency: تخزين IDs الـ events المُعالَجة (آخر 1000 لمدة 30 يوم) ────
function _loadProcessedEvents() {
  try {
    if (!fs.existsSync(PROCESSED_EVENTS_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(PROCESSED_EVENTS_FILE, "utf8"));
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v > cutoff) out[k] = v;
    }
    return out;
  } catch { return {}; }
}
function _saveProcessedEvent(eventId) {
  const events = _loadProcessedEvents();
  events[eventId] = Date.now();
  // keep last 1000
  const sorted = Object.entries(events).sort((a, b) => b[1] - a[1]).slice(0, 1000);
  fs.writeFileSync(PROCESSED_EVENTS_FILE, JSON.stringify(Object.fromEntries(sorted)), "utf8");
}
function _isEventProcessed(eventId) {
  return !!_loadProcessedEvents()[eventId];
}

// ─── POST /payments/webhook — Stripe webhook (raw body needed) ────────────────
router.post("/payments/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!STRIPE_WEBHOOK) return res.sendStatus(200);

    let event;
    try {
      event = require("stripe")(STRIPE_SECRET).webhooks.constructEvent(
        req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK
      );
    } catch (err) {
      console.error("Stripe webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Idempotency check — منع معالجة نفس event مرّتين
    if (_isEventProcessed(event.id)) {
      console.log(`[stripe-webhook] event ${event.id} already processed — skipping`);
      return res.sendStatus(200);
    }

    const data   = event.data.object;
    const meta   = data.metadata || {};

    switch (event.type) {
      case "checkout.session.completed": {
        const storeId  = meta.storeId;
        const plan     = meta.plan || "basic";
        const period   = meta.period || "monthly";
        const months   = period === "yearly" ? 12 : 1;
        const expiry   = new Date();
        expiry.setMonth(expiry.getMonth() + months);

        updateStore(storeId, {
          subscriptionStatus:   "active",
          subscriptionPlan:     plan,
          subscriptionPeriod:   period, // ⚠️ كان مفقوداً — يلزم لتجديد invoice.payment_succeeded
          subscriptionExpiry:   expiry.toISOString().slice(0, 10),
          stripeCustomerId:     data.customer,
          stripeSubscriptionId: data.subscription,
        });

        console.log(`✅ Payment confirmed for store ${storeId} — plan: ${plan}/${period}`);

        // إرسال إشعار واتساب للمتجر
        await sendWhatsAppPaymentConfirm(storeId, plan, period, expiry);
        break;
      }

      case "invoice.payment_succeeded": {
        // تجديد تلقائي
        const customerId = data.customer;
        const stores = readStores().stores;
        const store  = stores.find(s => s.stripeCustomerId === customerId);
        if (store) {
          const months = store.subscriptionPlan === "pro"
            ? (store.subscriptionPeriod === "yearly" ? 12 : 1)
            : 1;
          const expiry = new Date();
          expiry.setMonth(expiry.getMonth() + months);
          updateStore(store.id, {
            subscriptionStatus: "active",
            subscriptionExpiry: expiry.toISOString().slice(0, 10),
          });
          console.log(`🔄 Subscription renewed for ${store.id}`);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const customerId = data.customer;
        const stores = readStores().stores;
        const store  = stores.find(s => s.stripeCustomerId === customerId);
        if (store) {
          updateStore(store.id, { subscriptionStatus: "expired" });
          console.log(`❌ Subscription cancelled for ${store.id}`);
        }
        break;
      }
    }

    // mark event as processed بعد إنهاء كل الـ side effects
    _saveProcessedEvent(event.id);
    res.sendStatus(200);
  }
);

// ─── GET /payments/status/:storeId — يستخدم master session OR store session ──
router.get("/payments/status/:storeId", (req, res) => {
  const masterTok = req.headers["x-master-token"];
  const storeTok  = req.headers["x-store-token"];

  // master: يقرأ أي متجر — نعتمد على المصادقة في master-router عبر passing through
  // لكن لأن الـ payments-router مستقل، نتحقق إن `MASTER_PASSWORD` ولا نعتمد على token shared فقط
  const masterPass = process.env.MASTER_PASSWORD || "";
  const isMaster = masterPass && safeEqualStr(masterTok, masterPass);
  // store: يقرأ متجره فقط
  const storeIdFromToken = storeTok ? verifyStoreToken(storeTok) : null;
  const isOwnStore = storeIdFromToken === req.params.storeId;

  if (!isMaster && !isOwnStore) {
    return res.status(401).json({ error: "غير مصرح" });
  }
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  res.json({
    storeId:             store.id,
    subscriptionStatus:  store.subscriptionStatus || "trial",
    subscriptionPlan:    store.subscriptionPlan || null,
    subscriptionExpiry:  store.subscriptionExpiry || null,
    stripeCustomerId:    store.stripeCustomerId || null,
  });
});

// ─── Helper: send WhatsApp notification after payment (Baileys فقط، لا Meta) ─
async function sendWhatsAppPaymentConfirm(storeId, plan, period, expiry) {
  const waMgr = require("./whatsapp-manager");
  const store = getStore(storeId);
  if (!store?.ownerPhone) return;

  const planName   = PLANS[plan]?.name || plan;
  const periodText = period === "yearly" ? "سنوي" : "شهري";
  const expiryStr  = expiry.toLocaleDateString("ar-SA");
  const body =
    `✅ *تم تفعيل اشتراكك بنجاح!*\n\n` +
    `🏪 المتجر: ${store.storeName}\n` +
    `📦 الخطة: ${planName} (${periodText})\n` +
    `📅 ينتهي في: ${expiryStr}\n\n` +
    `شكراً لاختيارك خدمتنا 🙏`;

  const jid = String(store.ownerPhone).replace(/\D/g, "") + "@s.whatsapp.net";

  // اختر جلسة Baileys مفتوحة: platform → lead → أي جلسة active
  const sessions = waMgr.listSessions();
  const candidate = sessions.find(s => s.storeId === "platform" && s.status === "open")
                 || sessions.find(s => s.storeId === "lead"     && s.status === "open")
                 || sessions.find(s => s.status === "open");

  if (!candidate) {
    console.warn(`[payments] لا توجد جلسة واتساب لإرسال تأكيد الدفع لـ ${storeId}`);
    return;
  }

  try {
    await waMgr.sendMessage(candidate.storeId, jid, body);
    console.log(`[payments] ✅ تأكيد الدفع أُرسل لـ ${storeId} via ${candidate.storeId}`);
  } catch (err) {
    console.error("[payments] WhatsApp confirm error:", err.message);
  }
}

module.exports = router;
