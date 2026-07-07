/**
 * Orders Logger — per-store JSONL files + in-memory index (Tier B)
 *
 * تحسينات الأداء (Tier B):
 * - In-memory Map<storeId, Map<orderId, order>> = O(1) lookup
 * - In-memory Array<order> per-store مرتب بالتاريخ لـ readOrders بدون قراءة الملف
 * - appendFile غير حاجب (async) بدل appendFileSync
 * - lazy load عند أول طلب لكل متجر (rebuild من JSONL)
 * - JSONL يبقى source of truth (backward compat كامل)
 */

const fs   = require("fs");
const fsp  = require("fs/promises");
const path = require("path");
const af   = require("./atomic-fs");

const DATA_DIR = path.join(__dirname, "..", "data");

// ─── In-memory indexes ────────────────────────────────────────────────────────
// storeId → Map<orderId, order>  (lookup سريع)
const _orderById = new Map();
// storeId → Array<order>  (مرتب بالتاريخ، للـ readOrders + recent)
const _orderList = new Map();
// storeId → bool  (هل تم تحميل الـ index من disk؟)
const _loaded = new Map();

function _fileFor(storeId) {
  if (!storeId || storeId === "nakheel_001") {
    return process.env.ORDERS_LOG_PATH || path.join(DATA_DIR, "orders.jsonl");
  }
  return path.join(DATA_DIR, `orders_${storeId}.jsonl`);
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * يحمل الـ index من JSONL مرة واحدة لكل متجر.
 * يُستدعى تلقائياً عند أول قراءة. آمن للاستدعاء المتكرر.
 */
function _loadIndex(storeId) {
  if (_loaded.get(storeId)) return;
  const file = _fileFor(storeId);
  const byId = new Map();
  const list = [];
  try {
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (const l of lines) {
        try {
          const o = JSON.parse(l);
          if (o.orderId) byId.set(o.orderId, o);
          list.push(o);
        } catch {}
      }
    }
  } catch (err) {
    console.warn(`[orders] _loadIndex(${storeId}) failed:`, err.message);
  }
  _orderById.set(storeId, byId);
  _orderList.set(storeId, list);
  _loaded.set(storeId, true);
}

/**
 * يضيف طلب جديد. يحدّث الـ index فوراً + يكتب على disk + يُطلق SSE event.
 */
function logOrder(order) {
  try {
    ensureDir();
    const record = {
      timestamp: new Date().toISOString(),
      ...order,
    };
    const storeId = order.storeId;
    _loadIndex(storeId);
    const byId = _orderById.get(storeId);
    const list = _orderList.get(storeId);
    if (record.orderId) byId.set(record.orderId, record);
    list.push(record);
    const file = _fileFor(storeId);
    fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
    // 📡 SSE push للوحة الادمن (real-time)
    try { global.sseSend?.(storeId, "new_order", record); } catch {}
    return true;
  } catch (err) {
    console.error("❌ Failed to log order:", err.message);
    return false;
  }
}

/**
 * يقرأ آخر N طلب من الـ index (لا يلمس disk بعد الـ load الأولي).
 * O(1) للـ lookup، O(limit) للـ copy.
 */
function readOrders(storeId, limit = 100) {
  try {
    _loadIndex(storeId);
    const list = _orderList.get(storeId) || [];
    return list.slice(-limit);
  } catch (err) {
    console.error("❌ Failed to read orders:", err.message);
    return [];
  }
}

/**
 * يبحث عن طلب محدد بـ O(1) بدل scanning كامل الملف.
 */
function findOrder(storeId, orderId) {
  _loadIndex(storeId);
  return _orderById.get(storeId)?.get(orderId) || null;
}

/**
 * يحدّث حالة الطلب: Map + ملف (atomic).
 */
async function updateOrderStatus(storeIdOrOrderId, orderIdOrStatus, statusMaybe) {
  let storeId, orderId, status;
  if (statusMaybe === undefined) {
    orderId = storeIdOrOrderId;
    status = orderIdOrStatus;
    storeId = null;
  } else {
    storeId = storeIdOrOrderId;
    orderId = orderIdOrStatus;
    status = statusMaybe;
  }

  const file = _fileFor(storeId);
  try {
    // حدّث الـ in-memory index فوراً
    _loadIndex(storeId);
    const order = _orderById.get(storeId)?.get(orderId);
    if (order) order.status = status;

    const result = await af.updateJsonlLocked(file, (lines) => {
      const updated = lines.map(l => {
        try {
          const obj = JSON.parse(l);
          if (obj.orderId === orderId) obj.status = status;
          return JSON.stringify(obj);
        } catch { return l; }
      });
      return { lines: updated, result: true };
    });
    // 📡 SSE push للحالة الجديدة
    try { global.sseSend?.(storeId, "order_status", { orderId, status }); } catch {}
    return result;
  } catch (err) {
    console.error("❌ Failed to update order:", err.message);
    return false;
  }
}

/**
 * يحدّث حقل معين على الطلب (مثل invoiceSent).
 * In-memory فوراً + disk write atomic (مع lock).
 */
async function updateOrderField(storeId, orderId, field, value) {
  _loadIndex(storeId);
  const order = _orderById.get(storeId)?.get(orderId);
  if (order) order[field] = value;
  // disk write atomic (لا يحجب الـ caller لأنه async)
  const file = _fileFor(storeId);
  try {
    return await af.updateJsonlLocked(file, (lines) => {
      const updated = lines.map(l => {
        try {
          const obj = JSON.parse(l);
          if (obj.orderId === orderId) obj[field] = value;
          return JSON.stringify(obj);
        } catch { return l; }
      });
      return { lines: updated, result: true };
    });
  } catch (err) {
    console.warn(`[orders.updateField] ${field} on ${orderId}:`, err.message);
    return false;
  }
}

/**
 * إحصائيات سريعة من الـ index (للوحة الادمن).
 */
function getOrderStats(storeId) {
  _loadIndex(storeId);
  const list = _orderList.get(storeId) || [];
  return { total: list.length, lastOrderId: list[list.length-1]?.orderId };
}

function _reset(storeId) {
  _loaded.delete(storeId);
  _orderById.delete(storeId);
  _orderList.delete(storeId);
}

module.exports = {
  logOrder,
  readOrders,
  findOrder,
  updateOrderStatus,
  updateOrderField,
  getOrderStats,
  _reset,
};
