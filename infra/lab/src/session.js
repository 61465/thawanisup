/**
 * Session Manager — مع persist على القرص
 * يحفظ سيشن العميل (cart, step, customerName, customerLocation) عبر restart السيرفر
 * Sessions expire after 30 minutes of inactivity.
 */

const fs   = require("fs");
const path = require("path");
const atomicFs = require("./atomic-fs");

const EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
const SESSIONS_FILE = path.join(__dirname, "..", "data", "sessions", "bot-sessions.json");

function _ensureDir() {
  const d = path.dirname(SESSIONS_FILE);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function _load() {
  try {
    _ensureDir();
    if (!fs.existsSync(SESSIONS_FILE)) return new Map();
    const obj = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
    const m = new Map();
    const now = Date.now();
    for (const [k, v] of Object.entries(obj)) {
      if (v && v.lastActive && (now - v.lastActive) <= EXPIRY_MS) m.set(k, v);
    }
    return m;
  } catch (e) {
    console.warn("[session] load failed:", e.message);
    return new Map();
  }
}

const store = _load();

let _saveTimer = null;
// زيدت من 500ms إلى 5s — تقليل I/O بـ 10× على المتاجر النشطة
const SAVE_DEBOUNCE_MS = 5000;
function _save() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      const obj = {};
      for (const [k, v] of store) obj[k] = v;
      atomicFs.writeJsonSync(SESSIONS_FILE, obj, false);
    } catch (e) { console.warn("[session] save failed:", e.message); }
  }, SAVE_DEBOUNCE_MS);
}

// flush قبل الخروج
process.on("beforeExit", () => {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  try {
    _ensureDir();
    const obj = {};
    for (const [k, v] of store) obj[k] = v;
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj));
  } catch {}
});

function get(from) {
  const entry = store.get(from);
  if (!entry) return defaultSession();
  if (Date.now() - entry.lastActive > EXPIRY_MS) {
    store.delete(from);
    _save();
    return defaultSession();
  }
  entry.lastActive = Date.now();
  _save();
  return entry.data;
}

function set(from, data) {
  store.set(from, { data, lastActive: Date.now() });
  _save();
}

function update(from, patch) {
  const current = get(from);
  set(from, { ...current, ...patch });
}

function reset(from) {
  store.delete(from);
  _save();
}

// ⚠️ يحذف entry بمفتاح كامل (storeId|phone) — لاستخدام watchers خارج storeCtx
function resetByFullKey(fullKey) {
  if (!fullKey) return false;
  const removed = store.delete(fullKey);
  if (removed) _save();
  return removed;
}

function defaultSession() {
  return { step: "WELCOME", cart: [] };
}

// Clean expired sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [key, val] of store.entries()) {
    if (now - val.lastActive > EXPIRY_MS) { store.delete(key); removed++; }
  }
  if (removed > 0) _save();
}, 10 * 60 * 1000);

// ─── Iteration helper (لـ inactivity-watcher) ─────────────────────────────────
// يرجع لقطة من كل الـ sessions النشطة مع آخر نشاط، دون كشف الـ Map الداخلية
function snapshotAll() {
  const out = [];
  for (const [key, entry] of store.entries()) {
    out.push({
      key,
      lastActive: entry.lastActive,
      step: entry.data?.step || "WELCOME",
      data: entry.data || {},
    });
  }
  return out;
}

module.exports = {
  sessionManager: { get, set, update, reset, resetByFullKey, snapshotAll },
};
