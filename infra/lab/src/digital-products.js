/**
 * Digital Products — نظام المنتجات الرقمية + التسليم التلقائي
 *
 * المنتج الرقمي:
 *   productType: "digital"
 *   digitalContent: "نص ثابت يُرسل لكل عميل" (مثال: رابط Telegram)
 *   codePool: [] أكواد فريدة، كل عميل يستلم واحد ثم يُخصم من القائمة
 *   vipLink: "رابط القروب الخاص" (اختياري)
 *   deliveryMode: "auto" | "manual"
 *     - auto: التسليم فوراً عند checkout (بدون انتظار قبول المالك)
 *     - manual: يبقى pending حتى يقبله المالك
 *   subscriptionDays: مدة الاشتراك بالأيام (للتذكير بالتجديد)
 *
 * كل الميزات تعمل على نفس orders_<storeId>.jsonl
 * + ملفات مخزون الأكواد في data/digital-pool/<storeId>_<productId>.json
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR  = path.join(__dirname, "..", "data");
const POOL_DIR  = path.join(DATA_DIR, "digital-pool");

// ─── Pool storage ──────────────────────────────────────────────────────
function _ensurePoolDir() {
  if (!fs.existsSync(POOL_DIR)) fs.mkdirSync(POOL_DIR, { recursive: true });
}

function _poolPath(storeId, productId) {
  const safe = String(productId).replace(/[^a-z0-9_-]/gi, "_").slice(0, 60);
  return path.join(POOL_DIR, `${storeId}_${safe}.json`);
}

function readPool(storeId, productId) {
  _ensurePoolDir();
  const p = _poolPath(storeId, productId);
  if (!fs.existsSync(p)) return { codes: [], delivered: [], _meta: { lowStockNotified: null } };
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return { codes: [], delivered: [], _meta: {} }; }
}

function writePool(storeId, productId, pool) {
  _ensurePoolDir();
  fs.writeFileSync(_poolPath(storeId, productId), JSON.stringify(pool, null, 2));
}

/**
 * أضف أكواد للمخزون (paste-bulk)
 * @param {string[]} codes — قائمة أكواد (واحد لكل سطر)
 * @returns {added, duplicate, total}
 */
function addCodes(storeId, productId, codes) {
  const pool = readPool(storeId, productId);
  const existing = new Set([...pool.codes, ...pool.delivered.map(d => d.code)]);
  let added = 0, duplicate = 0;
  for (const c of codes) {
    const clean = String(c).trim();
    if (!clean || clean.length < 2) continue;
    if (existing.has(clean)) { duplicate++; continue; }
    pool.codes.push(clean);
    existing.add(clean);
    added++;
  }
  writePool(storeId, productId, pool);
  return { added, duplicate, total: pool.codes.length };
}

/**
 * اسحب كود واحد للعميل (atomic) — يُسجَّل في delivered
 * @returns {code: string|null, remaining: number}
 */
function pullCode(storeId, productId, customerPhone, orderId) {
  const pool = readPool(storeId, productId);
  if (!pool.codes.length) return { code: null, remaining: 0 };
  const code = pool.codes.shift(); // FIFO
  pool.delivered.push({
    code,
    customerPhone,
    orderId,
    at: new Date().toISOString(),
  });
  writePool(storeId, productId, pool);
  // 🚨 Low stock alert (gaming + digital): إذا remaining <= threshold، أبلغ المالك
  const remaining = pool.codes.length;
  _maybeLowStockAlert(storeId, productId, remaining).catch(() => {});
  return { code, remaining };
}

// ─── Low Stock Alert ──────────────────────────────────────────────────────────
async function _maybeLowStockAlert(storeId, productId, remaining) {
  try {
    const fs = require("fs");
    const path = require("path");
    const storesFile = path.join(__dirname, "..", "data", "stores.json");
    const data = JSON.parse(fs.readFileSync(storesFile, "utf8"));
    const store = (data.stores || []).find(s => s.id === storeId);
    if (!store) return;
    const threshold = Number(store.lowStockThreshold || 5);
    if (remaining > threshold) return;

    // ابحث عن المنتج للاسم
    const product = (store.products || []).find(p => p.id === productId);
    const productName = product?.name || productId;

    // throttle: لا تكرر الـ alert في الـ 6 ساعات الأخيرة لنفس المنتج
    const alertsFile = path.join(__dirname, "..", "data", `low_stock_alerts_${storeId}.json`);
    let lastAlerts = {};
    try { lastAlerts = JSON.parse(fs.readFileSync(alertsFile, "utf8")); } catch {}
    const lastAt = lastAlerts[productId] || 0;
    if (Date.now() - lastAt < 6 * 3600 * 1000) return;

    const msg = remaining === 0
      ? `🚨 *نفدت أكواد "${productName}"*\n\nالمخزون = 0\n\nأضف أكواد جديدة من لوحة الإدارة → الأكواد الرقمية لتفادي خسارة طلبات.`
      : `⚠️ *مخزون منخفض: ${productName}*\n\nالأكواد المتبقية: *${remaining}*\nالحد الأدنى: ${threshold}\n\nأضف أكواد جديدة قريباً من لوحة الإدارة.`;

    if (store.ownerPhone) {
      const waMgr = require("./whatsapp-manager");
      const ownerJid = String(store.ownerPhone).replace(/\D/g, "") + "@s.whatsapp.net";
      await waMgr.sendMessage(storeId, ownerJid, msg, { allowCold: true, reason: "low_stock_alert" });
      lastAlerts[productId] = Date.now();
      fs.writeFileSync(alertsFile, JSON.stringify(lastAlerts, null, 2));
      console.log(`🚨 [low-stock] alert sent for ${storeId}/${productId} (remaining=${remaining})`);
    }
  } catch (e) {
    console.warn("[low-stock-alert] failed:", e.message);
  }
}

function getStock(storeId, productId) {
  const pool = readPool(storeId, productId);
  return { available: pool.codes.length, delivered: pool.delivered.length };
}

function getDeliveryHistory(storeId, productId, limit = 50) {
  const pool = readPool(storeId, productId);
  return pool.delivered.slice(-limit).reverse();
}

// ─── Build delivery message للعميل ─────────────────────────────────────
/**
 * يبني رسالة التسليم الرقمي حسب نوع المنتج
 * @param {object} product — منتج
 * @param {string|null} code — كود فريد (إن وُجد)
 * @returns {string} رسالة جاهزة لإرسالها
 */
function buildDeliveryMessage(product, code = null) {
  const lines = [];
  lines.push(`🎉 *تم تسليم منتجك الرقمي*`);
  lines.push(`━━━━━━━━━━━━━━━━━━━`);
  lines.push(``);
  lines.push(`📦 *المنتج*: ${product.name}`);

  if (code) {
    lines.push(`🔑 *الكود الخاص بك*:`);
    lines.push(``);
    lines.push(`\`${code}\``);
    lines.push(``);
  } else if (product.digitalContent) {
    lines.push(``);
    lines.push(`📋 *المحتوى الرقمي*:`);
    lines.push(``);
    lines.push(product.digitalContent);
    lines.push(``);
  }

  if (product.vipLink) {
    lines.push(`━━━━━━━━━━━━━━━━━━━`);
    lines.push(`✨ *قروب خاص للمشتركين*`);
    lines.push(`✨ ${product.vipLink}`);
    lines.push(``);
  }

  lines.push(`_شكراً لشرائك! للدعم: اكتب *مسؤول*_`);

  return lines.join("\n");
}

/**
 * هل المنتج رقمي؟
 */
function isDigital(product) {
  return product?.productType === "digital";
}

/**
 * يسلّم كل المنتجات الرقمية في طلب → يرسل رسالة للعميل
 * يستدعى من checkout (storefront) أو من قبول الطلب (admin)
 *
 * @param {object} order
 * @param {object} store
 * @param {function} sendMessage — async (storeId, jid, text, opts?)
 * @returns {Promise<{delivered: number, outOfStock: string[]}>}
 */
async function deliverDigitalItems(order, store, sendMessage) {
  if (!sendMessage) return { delivered: 0, outOfStock: [] };

  const products = store.products || [];
  let delivered = 0;
  const outOfStock = [];
  const phone = String(order.customerPhone || "").replace(/\D/g, "");
  if (!phone) return { delivered: 0, outOfStock: [] };
  const jid = phone + "@s.whatsapp.net";

  for (const item of (order.items || [])) {
    const product = products.find(p =>
      p.id === item.productId || p.name === item.name
    );
    if (!product || !isDigital(product)) continue;

    const qty = Number(item.qty) || 1;
    for (let i = 0; i < qty; i++) {
      let code = null;

      // 1) لو فيه مخزون أكواد، اسحب واحد
      const stock = getStock(store.id, product.id);
      if (stock.available > 0) {
        const pulled = pullCode(store.id, product.id, phone, order.orderId);
        code = pulled.code;
      } else if (product.requireCodePool) {
        // المنتج يتطلب أكواد لكن المخزون فاضي
        outOfStock.push(product.name);
        continue;
      }
      // وإلا (لا code) → نسلّم digitalContent فقط

      // 2) ابعت رسالة التسليم
      const msg = buildDeliveryMessage(product, code);
      try {
        await sendMessage(store.id, jid, msg, {
          allowCold: true, reason: "order_notification",
        });
        delivered++;
      } catch (e) {
        console.warn(`[digital-deliver] failed for ${order.orderId}/${product.id}:`, e.message);
      }
    }
  }

  // 3) لو نفد المخزون لمنتج، أبلغ المالك
  if (outOfStock.length && store.ownerPhone) {
    try {
      const ownerJid = String(store.ownerPhone).replace(/\D/g, "") + "@s.whatsapp.net";
      const warn =
        `⚠️ *نفد مخزون أكواد*\n\n` +
        `الطلب ${order.orderId} يحتوي منتجات نفدت أكوادها:\n` +
        outOfStock.map(n => `• ${n}`).join("\n") +
        `\n\nالعميل: ${order.customerName}\n` +
        `الهاتف: ${order.customerPhone}\n\n` +
        `_أضف أكواد جديدة من لوحة الادمن → المنتج → "إدارة الأكواد"_`;
      await sendMessage(store.id, ownerJid, warn);
    } catch {}
  }

  return { delivered, outOfStock };
}

/**
 * يفحص الطلب: هل كل عناصره رقمية تسليم تلقائي؟
 */
function isFullyAutoDeliverable(order, store) {
  const items = order.items || [];
  if (!items.length) return false;
  const products = store.products || [];
  return items.every(it => {
    const p = products.find(x => x.id === it.productId || x.name === it.name);
    return p && isDigital(p) && p.deliveryMode === "auto";
  });
}

module.exports = {
  isDigital,
  buildDeliveryMessage,
  deliverDigitalItems,
  isFullyAutoDeliverable,
  // Code pool
  readPool,
  writePool,
  addCodes,
  pullCode,
  getStock,
  getDeliveryHistory,
};
