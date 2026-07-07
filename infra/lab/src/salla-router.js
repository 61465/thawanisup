/**
 * 🛍️ Salla Router — OAuth + Webhooks + Status
 *
 * Endpoints:
 *   GET  /api/salla/oauth/install     — يبدأ OAuth (يطلب storeId via query لربط المتجر)
 *   GET  /api/salla/oauth/callback    — يستقبل code من Salla → token → install
 *   POST /api/salla/webhook           — يستقبل webhook events من Salla
 *   GET  /api/salla/status            — حالة الربط للمتجر (يحتاج auth)
 *   POST /api/salla/sync-products     — جلب المنتجات من Salla (يحتاج auth)
 *   DELETE /api/salla/disconnect      — فصل ربط Salla (يحتاج auth)
 */

const express = require("express");
const crypto  = require("crypto");
const salla   = require("./salla-client");
const router  = express.Router();

const WEBHOOK_SECRET = process.env.SALLA_WEBHOOK_SECRET || "";

// Lazy-load orders + store helpers (لتفادي circular deps)
let _ordersMod = null;
function getOrdersMod() {
  if (_ordersMod) return _ordersMod;
  try { _ordersMod = require("./orders"); } catch {}
  return _ordersMod;
}
let _storeRouter = null;
function getStoreHelpers() {
  if (_storeRouter) return _storeRouter;
  try {
    const sr = require("./store-router");
    _storeRouter = {
      readStores:  sr.readStores,
      getStore:    sr.getStore,
      updateStore: sr.updateStore,
    };
  } catch {}
  return _storeRouter;
}

// resolve storeId من merchantId عبر installations
function _resolveStoreId(merchantId) {
  if (!merchantId) return null;
  const inst = salla.getInstallationByMerchant(merchantId);
  return inst?.storeId || null;
}

// ─── State store للـ OAuth (يربط state random بـ storeId) ──────────────────
// بسيط in-memory مع TTL — لأن OAuth flow ينتهي في دقائق
const _oauthStates = new Map(); // state → { storeId, createdAt }
const _STATE_TTL = 10 * 60 * 1000; // 10 دقائق

function _cleanupStates() {
  const now = Date.now();
  for (const [k, v] of _oauthStates.entries()) {
    if (now - v.createdAt > _STATE_TTL) _oauthStates.delete(k);
  }
}
setInterval(_cleanupStates, 5 * 60 * 1000).unref();

// ─── Auth middleware (للـ endpoints التي تحتاج storeId) ───────────────────
// نتوقع store-router يصدّر auth — نستخدمه مباشرة
let _storeAuth = null;
function getAuth() {
  if (_storeAuth) return _storeAuth;
  try {
    _storeAuth = require("./store-router").auth;
  } catch {}
  return _storeAuth;
}

// ─── 1) Start OAuth: يحتاج storeId من logged-in store ─────────────────────
router.get("/oauth/install", (req, res) => {
  const auth = getAuth();
  if (!auth) return res.status(500).json({ error: "auth middleware not ready" });

  auth(req, res, () => {
    const storeId = req.storeId;
    if (!storeId) return res.status(401).json({ error: "غير مصرح" });
    if (!salla.CLIENT_ID) return res.status(500).json({ error: "Salla غير مهيأ (SALLA_CLIENT_ID مفقود)" });

    const state = crypto.randomBytes(20).toString("hex");
    _oauthStates.set(state, { storeId, createdAt: Date.now() });

    const url = salla.getAuthorizationUrl(state);
    // ⚡ إن طلب العميل JSON صراحة → JSON (frontend AJAX)
    // وإلا redirect (للوصول المباشر من المتصفح)
    const acceptHeader = String(req.headers.accept || "");
    if (acceptHeader.includes("application/json")) {
      return res.json({ url, state });
    }
    return res.redirect(url);
  });
});

// ─── 2) OAuth callback: Salla يُحيل هنا بعد قبول التاجر ───────────────────
router.get("/oauth/callback", async (req, res) => {
  const { code, state, error: oauthErr } = req.query;
  // log: query keys only (no values — code/state حساسة)
  console.log(`[salla/callback] hit — keys: ${Object.keys(req.query).join(",") || "(none)"}`);
  if (oauthErr) return res.status(400).send(`❌ Salla refused: ${oauthErr}`);
  if (!code || !state) {
    console.warn(`[salla/callback] missing code/state`);
    return res.status(400).send("❌ code/state مفقود — افتح الرابط من Salla مباشرة");
  }

  const stateInfo = _oauthStates.get(state);
  if (!stateInfo) return res.status(400).send("❌ state غير صالح أو منتهي");
  _oauthStates.delete(state);

  try {
    const tokenData = await salla.exchangeCodeForToken(code);
    // tokenData: { access_token, refresh_token, expires_in, scope, merchant? }
    // محاولة جلب merchant info لمعرفة الـ merchantId
    let merchantId = tokenData.merchant || tokenData.merchant_id;
    let storeInfo = null;
    if (!merchantId) {
      // استدع store/info بـ access_token مؤقت
      try {
        const r = await fetch("https://api.salla.dev/admin/v2/store/info", {
          headers: { "Authorization": `Bearer ${tokenData.access_token}` },
        });
        if (r.ok) {
          const info = await r.json();
          storeInfo = info.data || info;
          merchantId = storeInfo.id || storeInfo.merchant_id;
        }
      } catch {}
    }
    if (!merchantId) merchantId = `unknown_${Date.now()}`;

    salla.saveInstallation({
      merchantId:    String(merchantId),
      storeId:       stateInfo.storeId,
      accessToken:   tokenData.access_token,
      refreshToken:  tokenData.refresh_token || null,
      expiresAt:     new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString(),
      scope:         tokenData.scope || "",
      storeInfo:     storeInfo || null,
    });

    // success page بسيط (redirect للأدمن)
    res.send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>تم الربط ✓</title>
<style>body{font-family:'Segoe UI',Tahoma;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:linear-gradient(135deg,#0e1a14,#08120e);color:#f1f5f4;text-align:center;padding:20px;margin:0}
.box{background:rgba(201,162,75,0.08);border:1px solid rgba(201,162,75,0.35);border-radius:14px;padding:32px;max-width:400px}
h1{color:#86efac;margin:0 0 12px}
p{color:#cfd8d4;line-height:1.7;margin:8px 0}
a{display:inline-block;background:linear-gradient(135deg,#c9a24b,#a07f2e);color:#0e1a14;text-decoration:none;padding:11px 28px;border-radius:9px;font-weight:800;margin-top:16px}</style></head>
<body><div class="box">
<h1>✓ تم ربط متجر Salla بنجاح</h1>
<p>المتجر متصل الآن بمنصة ثواني.</p>
<p style="font-size:12px;color:#9ca3af">Merchant ID: <code>${merchantId}</code></p>
<a href="/store-admin.html">العودة للوحة الأدمن</a>
</div></body></html>`);
  } catch (e) {
    console.error("[salla/callback]", e.message);
    res.status(500).send(`❌ فشل تبادل الـ token: ${e.message}`);
  }
});

// ─── 3) Webhook receiver ──────────────────────────────────────────────────
// Salla يرسل POST /api/salla/webhook مع header X-Salla-Signature
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["x-salla-signature"] || "";
  const rawBody = req.body instanceof Buffer ? req.body.toString("utf8") : (typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}));

  // التحقق من signature (إن وُجد secret)
  if (WEBHOOK_SECRET) {
    const ok = salla.verifyWebhookSignature(rawBody, sig, WEBHOOK_SECRET);
    if (!ok) {
      console.warn("[salla/webhook] signature mismatch");
      return res.status(401).json({ error: "invalid signature" });
    }
  }

  let payload = {};
  try { payload = JSON.parse(rawBody); } catch {
    return res.status(400).json({ error: "invalid JSON" });
  }

  const event      = payload.event || payload.type || "unknown";
  const merchantId = payload.merchant || payload.data?.merchant || payload.data?.store_id;
  console.log(`[salla/webhook] event=${event} merchant=${merchantId}`);

  // التعامل مع events الأساسية + Phase 2 (orders + products)
  try {
    if (event === "app.store.authorize") {
      // تثبيت — نحفظ الـ tokens من webhook data إن وُجدت
      const d = payload.data || {};
      if (d.access_token && merchantId) {
        salla.saveInstallation({
          merchantId:   String(merchantId),
          accessToken:  d.access_token,
          refreshToken: d.refresh_token || null,
          expiresAt:    new Date(Date.now() + (d.expires_in || 3600) * 1000).toISOString(),
          scope:        d.scope || "",
          source:       "webhook",
        });
      }
    } else if (event === "app.store.uninstall" || event === "app.uninstalled") {
      if (merchantId) salla.removeInstallation(String(merchantId));
    } else if (event === "order.created" || event === "order.creation" || event === "order.payment.updated") {
      await _handleOrderCreated(payload, merchantId);
    } else if (event === "order.updated" || event === "order.status.updated") {
      await _handleOrderUpdated(payload, merchantId);
    } else if (event === "product.created") {
      await _handleProductCreated(payload, merchantId);
    } else if (event === "product.updated") {
      await _handleProductUpdated(payload, merchantId);
    } else if (event === "product.deleted") {
      await _handleProductDeleted(payload, merchantId);
    } else {
      // event غير معالج — تسجيل فقط لتسهيل التشخيص
      console.log(`[salla/webhook] unhandled event: ${event}`);
    }
  } catch (e) {
    console.warn(`[salla/webhook] handler error (${event}):`, e.message);
  }

  // Salla تتوقع 200 سريعاً
  res.json({ received: true });
});

// ─── 4) Status للأدمن ─────────────────────────────────────────────────────
router.get("/status", (req, res) => {
  const auth = getAuth();
  if (!auth) return res.status(500).json({ error: "auth middleware not ready" });
  auth(req, res, () => {
    const storeId = req.storeId;
    const installs = salla.listInstallations().filter(i => i.storeId === storeId);
    res.json({
      connected:    installs.length > 0,
      installations: installs.map(i => ({
        merchantId: i.merchantId,
        scope:      i.scope,
        expiresAt:  i.expiresAt,
        createdAt:  i.createdAt,
        storeInfo:  i.storeInfo ? { name: i.storeInfo.name, domain: i.storeInfo.domain } : null,
      })),
    });
  });
});

// ─── 5) Sync products (manual trigger) ────────────────────────────────────
router.post("/sync-products", express.json(), async (req, res) => {
  const auth = getAuth();
  if (!auth) return res.status(500).json({ error: "auth middleware not ready" });
  auth(req, res, async () => {
    const storeId = req.storeId;
    const installs = salla.listInstallations().filter(i => i.storeId === storeId);
    if (!installs.length) return res.status(400).json({ error: "Salla غير مربوط لهذا المتجر" });

    const install = installs[0];
    try {
      const data = await salla.listProducts(install.merchantId, 1);
      const products = data.data || data.products || [];
      res.json({
        ok: true,
        count: products.length,
        sample: products.slice(0, 5).map(p => ({ id: p.id, name: p.name, price: p.price })),
      });
    } catch (e) {
      console.error("[salla/sync-products]", e.message);
      res.status(500).json({ error: e.message });
    }
  });
});

// ─── 6) Disconnect ────────────────────────────────────────────────────────
router.delete("/disconnect", (req, res) => {
  const auth = getAuth();
  if (!auth) return res.status(500).json({ error: "auth middleware not ready" });
  auth(req, res, () => {
    const storeId = req.storeId;
    const installs = salla.listInstallations().filter(i => i.storeId === storeId);
    for (const inst of installs) salla.removeInstallation(inst.merchantId);
    res.json({ ok: true, removed: installs.length });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Phase 2 — Order + Product webhook handlers
// ═══════════════════════════════════════════════════════════════════════════

async function _handleOrderCreated(payload, merchantId) {
  const storeId = _resolveStoreId(merchantId);
  if (!storeId) {
    console.warn(`[salla/order.created] no storeId for merchant=${merchantId}`);
    return;
  }
  const sallaOrder = payload.data || {};
  const mapped = salla.mapSallaOrderToThawani(sallaOrder, storeId, merchantId);
  if (!mapped) {
    console.warn(`[salla/order.created] mapping failed for ${sallaOrder.id}`);
    return;
  }
  // تفادي ازدواج: إن كان الطلب موجوداً → نحدّث بدلاً من إضافة
  const ordersMod = getOrdersMod();
  if (!ordersMod) {
    console.warn("[salla/order.created] orders module not available");
    return;
  }
  const existing = ordersMod.findOrder?.(storeId, mapped.orderId);
  if (existing) {
    // طلب موجود → حدّث status فقط (تفادي إعادة حساب total)
    if (existing.status !== mapped.status && ordersMod.updateOrderStatus) {
      ordersMod.updateOrderStatus(storeId, mapped.orderId, mapped.status);
      console.log(`[salla] order ${mapped.orderId} status → ${mapped.status}`);
    }
    return;
  }
  // جديد → log
  ordersMod.logOrder(mapped);
  console.log(`[salla] order ${mapped.orderId} created (${mapped.items.length} items, ${mapped.total})`);
}

async function _handleOrderUpdated(payload, merchantId) {
  const storeId = _resolveStoreId(merchantId);
  if (!storeId) return;
  const sallaOrder = payload.data || {};
  const orderId = `salla_${sallaOrder.id || sallaOrder.reference_id}`;
  const ordersMod = getOrdersMod();
  if (!ordersMod) return;
  const existing = ordersMod.findOrder?.(storeId, orderId);
  if (!existing) {
    // طلب غير موجود → عاملْه كـ created
    return _handleOrderCreated(payload, merchantId);
  }
  // حدّث الـ status فقط (المعلومة الرئيسية في order.updated)
  const newStatus = salla.mapSallaOrderToThawani(sallaOrder, storeId, merchantId)?.status;
  if (newStatus && existing.status !== newStatus && ordersMod.updateOrderStatus) {
    ordersMod.updateOrderStatus(storeId, orderId, newStatus);
    console.log(`[salla] order ${orderId} updated: status=${newStatus}`);
  }
}

async function _handleProductCreated(payload, merchantId) {
  const storeId = _resolveStoreId(merchantId);
  if (!storeId) return;
  const sallaProd = payload.data || {};
  const mapped = salla.mapSallaProductToThawani(sallaProd, merchantId);
  if (!mapped) return;
  const helpers = getStoreHelpers();
  if (!helpers?.getStore || !helpers?.updateStore) return;
  const store = helpers.getStore(storeId);
  if (!store) return;
  const products = Array.isArray(store.products) ? store.products.slice() : [];
  // تفادي ازدواج
  if (products.some(p => p.id === mapped.id)) {
    console.log(`[salla] product ${mapped.id} exists → switching to update`);
    return _handleProductUpdated(payload, merchantId);
  }
  products.push(mapped);
  helpers.updateStore(storeId, { products });
  console.log(`[salla] product ${mapped.id} created (${mapped.name})`);
}

async function _handleProductUpdated(payload, merchantId) {
  const storeId = _resolveStoreId(merchantId);
  if (!storeId) return;
  const sallaProd = payload.data || {};
  const mapped = salla.mapSallaProductToThawani(sallaProd, merchantId);
  if (!mapped) return;
  const helpers = getStoreHelpers();
  if (!helpers?.getStore || !helpers?.updateStore) return;
  const store = helpers.getStore(storeId);
  if (!store) return;
  const products = Array.isArray(store.products) ? store.products.slice() : [];
  const idx = products.findIndex(p => p.id === mapped.id);
  if (idx === -1) {
    products.push(mapped);
    console.log(`[salla] product ${mapped.id} added via update`);
  } else {
    // حافظ على حقول thawani-specific (مثل category مخصص محلياً، badges) لو وُجدت
    products[idx] = { ...products[idx], ...mapped };
    console.log(`[salla] product ${mapped.id} updated`);
  }
  helpers.updateStore(storeId, { products });
}

async function _handleProductDeleted(payload, merchantId) {
  const storeId = _resolveStoreId(merchantId);
  if (!storeId) return;
  const sallaProd = payload.data || {};
  const productId = `salla_${sallaProd.id}`;
  const helpers = getStoreHelpers();
  if (!helpers?.getStore || !helpers?.updateStore) return;
  const store = helpers.getStore(storeId);
  if (!store) return;
  const products = (store.products || []).filter(p => p.id !== productId);
  helpers.updateStore(storeId, { products });
  console.log(`[salla] product ${productId} deleted`);
}

module.exports = router;
