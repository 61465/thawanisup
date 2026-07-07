/**
 * 🛍️ Salla API Client
 * Wrapper بسيط للـ Salla OAuth + REST API
 *
 * Docs: https://docs.salla.dev/421118m0
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CLIENT_ID     = process.env.SALLA_CLIENT_ID || "";
const CLIENT_SECRET = process.env.SALLA_CLIENT_SECRET || "";
const APP_ID        = process.env.SALLA_APP_ID || "";

const PUBLIC_URL    = (process.env.PUBLIC_URL || "https://thawani.tail19ddab.ts.net").replace(/\/$/, "");
const REDIRECT_URI  = `${PUBLIC_URL}/api/salla/oauth/callback`;

const OAUTH_BASE    = "https://accounts.salla.sa/oauth2";
const API_BASE      = "https://api.salla.dev/admin/v2";

const INSTALLATIONS_FILE = path.join(__dirname, "..", "data", "salla-installations.json");

// ─── Installation storage (per merchant) ──────────────────────────────────
function _readInstallations() {
  try {
    if (!fs.existsSync(INSTALLATIONS_FILE)) return { installations: [] };
    return JSON.parse(fs.readFileSync(INSTALLATIONS_FILE, "utf8"));
  } catch { return { installations: [] }; }
}

function _writeInstallations(data) {
  if (!fs.existsSync(path.dirname(INSTALLATIONS_FILE))) {
    fs.mkdirSync(path.dirname(INSTALLATIONS_FILE), { recursive: true });
  }
  fs.writeFileSync(INSTALLATIONS_FILE, JSON.stringify(data, null, 2));
}

function getInstallation(merchantId) {
  const data = _readInstallations();
  return data.installations.find(i => String(i.merchantId) === String(merchantId)) || null;
}

function saveInstallation(install) {
  const data = _readInstallations();
  const idx = data.installations.findIndex(i => String(i.merchantId) === String(install.merchantId));
  if (idx >= 0) data.installations[idx] = { ...data.installations[idx], ...install, updatedAt: new Date().toISOString() };
  else data.installations.push({ ...install, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  _writeInstallations(data);
}

function removeInstallation(merchantId) {
  const data = _readInstallations();
  data.installations = data.installations.filter(i => String(i.merchantId) !== String(merchantId));
  _writeInstallations(data);
}

function listInstallations() {
  return _readInstallations().installations;
}

// ─── OAuth ─────────────────────────────────────────────────────────────────
function getAuthorizationUrl(state) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    scope:         "offline_access",
    state:         state || crypto.randomBytes(16).toString("hex"),
  });
  return `${OAUTH_BASE}/auth?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    grant_type:    "authorization_code",
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri:  REDIRECT_URI,
    scope:         "offline_access",
  });
  const res = await fetch(`${OAUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Salla token exchange failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type:    "refresh_token",
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
  });
  const res = await fetch(`${OAUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Salla refresh failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Authenticated API call (auto refresh on 401) ─────────────────────────
async function apiCall(merchantId, path, opts = {}) {
  const install = getInstallation(merchantId);
  if (!install) throw new Error(`No Salla installation for merchant ${merchantId}`);

  // Check expiry
  let token = install.accessToken;
  const expiresAt = install.expiresAt ? new Date(install.expiresAt).getTime() : 0;
  if (expiresAt && expiresAt - Date.now() < 60_000 && install.refreshToken) {
    try {
      const fresh = await refreshAccessToken(install.refreshToken);
      const updated = {
        merchantId,
        accessToken:  fresh.access_token,
        refreshToken: fresh.refresh_token || install.refreshToken,
        expiresAt:    new Date(Date.now() + (fresh.expires_in || 3600) * 1000).toISOString(),
        scope:        fresh.scope,
      };
      saveInstallation(updated);
      token = fresh.access_token;
    } catch (e) {
      console.warn(`[salla] refresh failed for ${merchantId}:`, e.message);
    }
  }

  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
      "Accept":        "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Salla API ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Webhook signature verification ───────────────────────────────────────
function verifyWebhookSignature(payload, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const computed = crypto
    .createHmac("sha256", secret)
    .update(typeof payload === "string" ? payload : JSON.stringify(payload))
    .digest("hex");
  // timing-safe compare
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signatureHeader));
  } catch { return false; }
}

// ─── High-level helpers ───────────────────────────────────────────────────
async function getStoreInfo(merchantId) {
  return apiCall(merchantId, "/store/info");
}

async function getOrder(merchantId, orderId) {
  return apiCall(merchantId, `/orders/${orderId}`);
}

async function listProducts(merchantId, page = 1) {
  return apiCall(merchantId, `/products?page=${page}&per_page=50`);
}

// ─── Mappers: Salla → Thawani schema ──────────────────────────────────────
/**
 * يحوّل Salla order payload إلى thawani order schema (متوافق مع orders.logOrder)
 * @param {object} sallaOrder — payload.data من webhook order.created/updated
 * @param {string} storeId — معرّف متجر ثواني
 * @param {string} merchantId — Salla merchant id (للـ traceability)
 */
function mapSallaOrderToThawani(sallaOrder, storeId, merchantId) {
  if (!sallaOrder || !storeId) return null;
  const o = sallaOrder;
  // معرّفات: نستخدم reference_id (الرقم الذي يراه العميل) إن وُجد
  const orderId = `salla_${o.id || o.reference_id || Date.now()}`;
  // عنصر: Salla يستخدم items[] داخل order
  const items = (o.items || []).map(it => ({
    name:    String(it.name || it.product?.name || "—").slice(0, 200),
    qty:     Number(it.quantity || it.qty || 1),
    price:   Number(it.amounts?.price?.amount ?? it.price ?? it.product?.price ?? 0),
    imageUrl: it.product?.images?.[0]?.url || it.product?.thumbnail || "",
    _sallaItemId: it.id,
  }));
  const subtotal = Number(o.amounts?.sub_total?.amount ?? o.sub_total ?? items.reduce((s,it) => s + it.qty*it.price, 0));
  const total    = Number(o.amounts?.total?.amount    ?? o.total    ?? subtotal);
  // معلومات العميل
  const customer = o.customer || {};
  const customerName  = customer.first_name
    ? `${customer.first_name || ""} ${customer.last_name || ""}`.trim()
    : (customer.name || "—");
  const customerPhone = String(customer.mobile || customer.phone || "").replace(/\D/g, "");
  const shipping = o.shipping || {};
  const shipAddr = shipping.address || {};
  const customerLocation = [shipAddr.shipping_address, shipAddr.city, shipAddr.country]
    .filter(Boolean).join(" - ") || (o.shipping?.address?.street || "");

  return {
    storeId,
    orderId,
    customerName:  customerName  || "عميل Salla",
    customerPhone: customerPhone || "",
    customerLocation,
    items,
    subtotal,
    total,
    deliveryFee: Number(o.amounts?.shipping?.amount ?? 0),
    discount:    Number(o.amounts?.discount?.amount ?? 0),
    paymentMethod: o.payment_method || "salla",
    status: _mapSallaOrderStatus(o.status?.name || o.status || "جديد"),
    notes:  String(o.notes || "").slice(0, 500),
    // metadata للتتبع
    _source:     "salla",
    _sallaId:    o.id,
    _sallaRef:   o.reference_id,
    _merchantId: merchantId,
  };
}

/**
 * يحوّل Salla product payload إلى thawani product schema
 */
function mapSallaProductToThawani(sallaProduct, merchantId) {
  if (!sallaProduct) return null;
  const p = sallaProduct;
  return {
    id:           `salla_${p.id}`,
    name:         String(p.name || "منتج").slice(0, 200),
    description:  String(p.description || p.short_description || "").slice(0, 2000),
    price:        Number(p.price?.amount ?? p.price ?? p.regular_price?.amount ?? 0),
    originalPrice: p.sale_price ? Number(p.regular_price?.amount ?? p.regular_price ?? 0) : null,
    imageUrl:     p.main_image || p.images?.[0]?.url || p.thumbnail || "",
    images:       Array.isArray(p.images) ? p.images.map(i => i.url || i).filter(Boolean).slice(0, 6) : [],
    available:    (p.status === "sale" || p.status === "active" || p.status === undefined),
    stock:        (typeof p.quantity === "number" && p.quantity >= 0) ? p.quantity : null,
    categoryId:   p.categories?.[0]?.id ? `salla_cat_${p.categories[0].id}` : "",
    sku:          p.sku || "",
    // metadata
    _source:     "salla",
    _sallaId:    p.id,
    _merchantId: merchantId,
  };
}

// يحوّل Salla order status (عربي/إنجليزي) → ثواني status (عربي قياسي)
function _mapSallaOrderStatus(s) {
  const key = String(s || "").toLowerCase().trim();
  const map = {
    "pending":        "جديد",
    "under_review":   "قيد المراجعة",
    "in_progress":    "قيد التحضير",
    "ready":          "جاهز للتسليم",
    "delivering":     "قيد التوصيل",
    "delivered":      "تم التسليم",
    "completed":      "مكتمل",
    "canceled":       "ملغى",
    "cancelled":      "ملغى",
    "refunded":       "مسترد",
    "payment_pending":"بانتظار الدفع",
  };
  return map[key] || s || "جديد";
}

// يبحث عن installation بـ merchantId
function getInstallationByMerchant(merchantId) {
  return _readInstallations().installations.find(i => String(i.merchantId) === String(merchantId)) || null;
}

module.exports = {
  CLIENT_ID, CLIENT_SECRET, APP_ID, REDIRECT_URI,
  // OAuth
  getAuthorizationUrl, exchangeCodeForToken, refreshAccessToken,
  // Installations
  getInstallation, saveInstallation, removeInstallation, listInstallations,
  getInstallationByMerchant,
  // API
  apiCall, getStoreInfo, getOrder, listProducts,
  // Webhook
  verifyWebhookSignature,
  // Mappers
  mapSallaOrderToThawani, mapSallaProductToThawani,
};
