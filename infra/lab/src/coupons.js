/**
 * Coupons & Promotions — نظام الكوبونات والعروض
 * يقرأ من data/coupons.json ويتحقق من الصلاحية
 */
const fs   = require("fs");
const path = require("path");
const atomicFs = require("./atomic-fs");

const COUPONS_FILE = path.join(__dirname, "..", "data", "coupons.json");

function load() {
  return atomicFs.readJsonSync(COUPONS_FILE, { coupons: [] });
}

function save(data) {
  atomicFs.writeJsonSync(COUPONS_FILE, data);
}

/**
 * التحقق من كوبون وإرجاع الخصم
 * @returns { valid, discount, type, message } | null
 */
function validateCoupon(code, storeId, subtotal, phone, opts = {}) {
  const { coupons } = load();
  const c = coupons.find(c =>
    c.code.toUpperCase() === code.toUpperCase() &&
    c.active &&
    (!c.storeId || c.storeId === storeId)
  );

  if (!c) return { valid: false, message: "❌ كود الخصم غير صحيح" };

  // ⭐ scope check: cart / bot / both (افتراضي: both)
  const scope = c.scope || "both";
  const channel = opts.channel || "bot"; // 'cart' أو 'bot'
  if (scope !== "both" && scope !== channel) {
    return { valid: false, message: scope === "cart"
      ? "❌ هذا الكود صالح فقط في المتجر العلني (السلة)"
      : "❌ هذا الكود صالح فقط في بوت الواتس" };
  }

  const now = new Date();
  if (c.expiresAt && new Date(c.expiresAt) < now)
    return { valid: false, message: "❌ انتهت صلاحية الكود" };

  if (c.minOrder && subtotal < c.minOrder)
    return { valid: false, message: `❌ الكود يتطلب طلب بحد أدنى ${c.minOrder} ر.س` };

  if (c.usedCount >= (c.maxUses || Infinity))
    return { valid: false, message: "❌ تم استخدام الكود بالحد الأقصى" };

  if (c.onePerCustomer && (c.usedBy || []).includes(phone))
    return { valid: false, message: "❌ استخدمت هذا الكود مسبقاً" };

  const discount = c.type === "percent"
    ? Math.min(subtotal * c.value / 100, c.maxDiscount || Infinity)
    : c.value;

  return {
    valid:    true,
    code:     c.code,
    discount: Math.min(discount, subtotal),
    type:     c.type,
    message:  `🎟️ تم تطبيق كود *${c.code}* — خصم ${c.type === "percent" ? c.value + "%" : discount + " ر.س"}`,
  };
}

// تسجيل استخدام الكوبون
function useCoupon(code, phone) {
  const data = load();
  const idx  = data.coupons.findIndex(c => c.code.toUpperCase() === code.toUpperCase());
  if (idx === -1) return;
  data.coupons[idx].usedCount = (data.coupons[idx].usedCount || 0) + 1;
  data.coupons[idx].usedBy    = [...(data.coupons[idx].usedBy || []), phone];
  save(data);
}

// إنشاء كوبون جديد (من لوحة التحكم)
function createCoupon({ code, type, value, storeId, minOrder, maxUses, expiresAt, onePerCustomer, maxDiscount, scope }) {
  const data = load();
  const existing = data.coupons.findIndex(c => c.code.toUpperCase() === code.toUpperCase());
  const coupon = {
    code: code.toUpperCase(), type, value,
    storeId: storeId || null, minOrder: minOrder || 0,
    maxUses: maxUses || null, expiresAt: expiresAt || null,
    onePerCustomer: !!onePerCustomer, maxDiscount: maxDiscount || null,
    scope: ["cart","bot","both"].includes(scope) ? scope : "both",
    active: true, usedCount: 0, usedBy: [],
    createdAt: new Date().toISOString().slice(0, 10),
  };
  if (existing >= 0) data.coupons[existing] = coupon;
  else data.coupons.push(coupon);
  save(data);
  return coupon;
}

function listCoupons(storeId) {
  const data = load() || {};
  const coupons = Array.isArray(data.coupons) ? data.coupons : [];
  return storeId ? coupons.filter(c => !c.storeId || c.storeId === storeId) : coupons;
}

function deleteCoupon(code) {
  const data = load();
  data.coupons = data.coupons.filter(c => c.code.toUpperCase() !== code.toUpperCase());
  save(data);
}

// بيانات افتراضية للبداية
function initDefaultCoupons() {
  if (fs.existsSync(COUPONS_FILE)) return;
  save({
    coupons: [
      { code: "WELCOME10", type: "percent", value: 10, minOrder: 30, maxUses: 1000,
        onePerCustomer: true, active: true, usedCount: 0, usedBy: [],
        createdAt: new Date().toISOString().slice(0,10) },
      { code: "NAKHEEL20", type: "fixed", value: 20, minOrder: 100, maxUses: 500,
        onePerCustomer: false, active: true, usedCount: 0, usedBy: [],
        createdAt: new Date().toISOString().slice(0,10) },
    ]
  });
}

initDefaultCoupons();

module.exports = { validateCoupon, useCoupon, createCoupon, listCoupons, deleteCoupon };
