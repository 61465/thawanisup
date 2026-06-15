/**
 * Orders Logger — per-store JSONL files
 * - Stores with id "nakheel_001" use legacy orders.jsonl (backward compat)
 * - All other stores use data/orders_{storeId}.jsonl (per-store isolation)
 */

const fs = require("fs");
const path = require("path");
const af = require("./atomic-fs");

const DATA_DIR = path.join(__dirname, "..", "data");

function _fileFor(storeId) {
  if (!storeId || storeId === "nakheel_001") {
    return process.env.ORDERS_LOG_PATH || path.join(DATA_DIR, "orders.jsonl");
  }
  return path.join(DATA_DIR, `orders_${storeId}.jsonl`);
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function logOrder(order) {
  try {
    ensureDir();
    const record = {
      timestamp: new Date().toISOString(),
      ...order,
    };
    const file = _fileFor(order.storeId);
    fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
    return true;
  } catch (err) {
    console.error("❌ Failed to log order:", err.message);
    return false;
  }
}

// Read orders for a specific store (or all if storeId omitted)
function readOrders(storeId, limit = 100) {
  try {
    const file = _fileFor(storeId);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch (err) {
    console.error("❌ Failed to read orders:", err.message);
    return [];
  }
}

async function updateOrderStatus(storeIdOrOrderId, orderIdOrStatus, statusMaybe) {
  // Backward compat: legacy signature (orderId, status) → search across all stores
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
    return await af.updateJsonlLocked(file, (lines) => {
      const updated = lines.map(l => {
        try {
          const obj = JSON.parse(l);
          if (obj.orderId === orderId) obj.status = status;
          return JSON.stringify(obj);
        } catch { return l; }
      });
      return { lines: updated, result: true };
    });
  } catch (err) {
    console.error("❌ Failed to update order:", err.message);
    return false;
  }
}

module.exports = { logOrder, readOrders, updateOrderStatus };
