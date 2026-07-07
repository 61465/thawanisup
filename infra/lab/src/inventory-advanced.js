/**
 * 📦 Inventory Advanced — مخزون متقدم للبقالة والصيدليات
 *
 * يدعم:
 *   - stock per product (موجود في product.stock الأصلي، نستهلكه)
 *   - expiry tracking (للأدوية فقط — يقرأ من product.expiryDate)
 *   - low-stock alerts (تنبيه عند نزول stock عن threshold)
 *   - bulk stock update
 *
 * هذا module helper — endpoints تُضاف في store-router.js
 */

const fs = require("fs");
const path = require("path");

function _getStoresFile() {
  return path.join(__dirname, "..", "data", "stores.json");
}
function _readStores() {
  try { return JSON.parse(fs.readFileSync(_getStoresFile(), "utf8")); }
  catch { return { stores: [] }; }
}

/**
 * تحليل مخزون متجر:
 * - low stock items (تحت threshold)
 * - expired items (للأدوية)
 * - expiring soon (خلال 90 يوم)
 */
function analyzeInventory(storeId, options = {}) {
  const { stores } = _readStores();
  const store = stores.find(s => s.id === storeId);
  if (!store) return null;

  const products = store.products || [];
  const businessType = store.businessType || "food";
  const lowThreshold = options.lowThreshold || (businessType === "pharmacy" ? 3 : 5);
  const expiryWarnDays = options.expiryWarnDays || 90;
  const now = Date.now();

  const lowStock = [];
  const outOfStock = [];
  const expired = [];
  const expiringSoon = [];
  const okStock = [];

  for (const p of products) {
    if (p.available === false) continue;
    const stock = typeof p.stock === "number" ? p.stock : null;
    if (stock !== null) {
      if (stock === 0) outOfStock.push({ id: p.id, name: p.name, stock: 0 });
      else if (stock <= lowThreshold) lowStock.push({ id: p.id, name: p.name, stock });
      else okStock.push({ id: p.id, name: p.name, stock });
    }
    // expiry (للصيدليات)
    if (p.expiryDate) {
      const exp = new Date(p.expiryDate).getTime();
      if (!isNaN(exp)) {
        const daysLeft = Math.floor((exp - now) / (24 * 60 * 60 * 1000));
        if (daysLeft < 0) expired.push({ id: p.id, name: p.name, expiryDate: p.expiryDate, daysOverdue: -daysLeft });
        else if (daysLeft <= expiryWarnDays) expiringSoon.push({ id: p.id, name: p.name, expiryDate: p.expiryDate, daysLeft });
      }
    }
  }

  return {
    storeId,
    businessType,
    summary: {
      totalProducts: products.length,
      withStock: okStock.length + lowStock.length + outOfStock.length,
      lowStock: lowStock.length,
      outOfStock: outOfStock.length,
      expired: expired.length,
      expiringSoon: expiringSoon.length,
    },
    alerts: {
      lowStock,
      outOfStock,
      expired,
      expiringSoon,
    },
  };
}

/**
 * Bulk update stock — للاستخدام عند المسح بالباركود أو import
 */
function bulkUpdateStock(storeId, updates) {
  if (!Array.isArray(updates) || !updates.length) {
    return { ok: false, error: "updates array مطلوبة" };
  }
  const data = _readStores();
  const store = data.stores.find(s => s.id === storeId);
  if (!store) return { ok: false, error: "المتجر غير موجود" };

  let updated = 0;
  const errors = [];
  for (const u of updates) {
    if (!u.productId || u.stock === undefined) {
      errors.push({ productId: u.productId, reason: "missing fields" });
      continue;
    }
    const p = (store.products || []).find(x => x.id === u.productId);
    if (!p) { errors.push({ productId: u.productId, reason: "product not found" }); continue; }
    const n = parseInt(u.stock, 10);
    if (!Number.isFinite(n) || n < 0) { errors.push({ productId: u.productId, reason: "invalid stock" }); continue; }
    p.stock = n;
    if (u.expiryDate !== undefined) p.expiryDate = u.expiryDate || null;
    updated++;
  }

  fs.writeFileSync(_getStoresFile(), JSON.stringify(data, null, 2));
  return { ok: true, updated, errors };
}

module.exports = { analyzeInventory, bulkUpdateStock };
