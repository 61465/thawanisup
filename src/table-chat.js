/**
 * Table Chat — تخزين رسائل الطاولات (dine-in)
 * - JSONL per-store: data/table_chats_<storeId>.jsonl
 * - in-memory cache (rebuilt on first load per store)
 * - append-only writes (markRead يعيد كتابة الملف الكامل)
 */
const fs   = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const cache = new Map(); // storeId → { loaded: true, list: [msg, ...] }

// 🛡️ منع path-traversal — defense in depth
const STORE_ID_RE = /^[a-zA-Z0-9_-]+$/;
function _assertStoreId(storeId) {
  if (!storeId || typeof storeId !== "string" || !STORE_ID_RE.test(storeId)) {
    throw new Error("invalid_store_id");
  }
}
function _file(storeId) {
  _assertStoreId(storeId);
  return path.join(DATA_DIR, `table_chats_${storeId}.jsonl`);
}

function _ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function _load(storeId) {
  if (cache.get(storeId)?.loaded) return;
  const list = [];
  const file = _file(storeId);
  try {
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (const l of lines) {
        try { list.push(JSON.parse(l)); } catch {}
      }
    }
  } catch (e) {
    console.warn(`[table-chat] load failed for ${storeId}:`, e.message);
  }
  cache.set(storeId, { loaded: true, list });
}

function appendMessage(storeId, table, from, text) {
  _assertStoreId(storeId);
  if (!Number.isFinite(Number(table))) throw new Error("invalid_args");
  if (!["customer", "admin"].includes(from)) throw new Error("invalid_from");
  const clean = String(text || "").trim().slice(0, 300);
  if (!clean) throw new Error("empty_text");
  _ensureDir();
  _load(storeId);
  const msg = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    table: Number(table),
    from,
    text: clean,
    readByAdmin: from === "admin", // admin's own messages always "read"
  };
  fs.appendFileSync(_file(storeId), JSON.stringify(msg) + "\n", "utf8");
  cache.get(storeId).list.push(msg);
  return msg;
}

function getMessages(storeId, table, limit = 50) {
  _assertStoreId(storeId);
  _load(storeId);
  const tableNum = Number(table);
  const all = cache.get(storeId).list;
  const filtered = all.filter(m => m.table === tableNum);
  return filtered.slice(-Math.max(1, Math.min(500, limit)));
}

function getInbox(storeId) {
  _assertStoreId(storeId);
  _load(storeId);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const byTable = new Map();
  for (const m of cache.get(storeId).list) {
    if (m.ts < cutoff) continue;
    let entry = byTable.get(m.table);
    if (!entry) {
      entry = { table: m.table, lastMessage: null, unreadCount: 0, lastTs: 0 };
      byTable.set(m.table, entry);
    }
    if (m.ts > entry.lastTs) {
      entry.lastMessage = { from: m.from, text: m.text, ts: m.ts };
      entry.lastTs = m.ts;
    }
    if (m.from === "customer" && !m.readByAdmin) entry.unreadCount++;
  }
  return Array.from(byTable.values()).sort((a, b) => b.lastTs - a.lastTs);
}

function markRead(storeId, table) {
  _assertStoreId(storeId);
  _load(storeId);
  const tableNum = Number(table);
  const all = cache.get(storeId).list;
  let changed = false;
  for (const m of all) {
    if (m.table === tableNum && m.from === "customer" && !m.readByAdmin) {
      m.readByAdmin = true;
      changed = true;
    }
  }
  if (!changed) return 0;
  // إعادة كتابة الملف بالكامل (markRead نادرة الاستخدام نسبياً)
  try {
    fs.writeFileSync(_file(storeId), all.map(m => JSON.stringify(m)).join("\n") + "\n", "utf8");
  } catch (e) {
    console.warn(`[table-chat] markRead persist failed:`, e.message);
  }
  return 1;
}

module.exports = { appendMessage, getMessages, getInbox, markRead };
