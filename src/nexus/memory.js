/**
 * NEXUS Memory — ذاكرة مشتركة بين الوكلاء (RAM + disk)
 *
 * كل وكيل يستطيع:
 *   - remember(key, value) — يحفظ معلومة
 *   - recall(key) — يستردها
 *   - forget(key) — يحذف
 *   - all() — يرى كل ذاكرته
 *
 * RAM للسرعة + JSON file للـ persist.
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR  = path.join(__dirname, "..", "..", "data", "nexus");
const MEM_FILE  = path.join(DATA_DIR, "memory.json");

let _mem = { byAgent: {}, shared: {}, _meta: { savedAt: null } };

function _load() {
  try {
    if (fs.existsSync(MEM_FILE)) {
      _mem = JSON.parse(fs.readFileSync(MEM_FILE, "utf8")) || _mem;
    }
  } catch (e) { console.warn("[nexus/memory] load failed:", e.message); }
}

let _saveTimer = null;
function _save() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      _mem._meta.savedAt = new Date().toISOString();
      fs.writeFileSync(MEM_FILE, JSON.stringify(_mem, null, 2));
    } catch (e) { console.warn("[nexus/memory] save failed:", e.message); }
  }, 3000);
}

_load();

// ─── Per-agent memory ─────────────────────────────────────────────────
function remember(agent, key, value) {
  if (!_mem.byAgent[agent]) _mem.byAgent[agent] = {};
  _mem.byAgent[agent][key] = { value, ts: Date.now() };
  _save();
}

function recall(agent, key) {
  return _mem.byAgent[agent]?.[key]?.value ?? null;
}

function forget(agent, key) {
  if (_mem.byAgent[agent]) {
    delete _mem.byAgent[agent][key];
    _save();
  }
}

function all(agent) {
  return _mem.byAgent[agent] || {};
}

// ─── Shared memory (cross-agent) ──────────────────────────────────────
function setShared(key, value) {
  _mem.shared[key] = { value, ts: Date.now() };
  _save();
}

function getShared(key) {
  return _mem.shared[key]?.value ?? null;
}

// ─── Cleanup (تذكر آخر 30 يوم فقط) ────────────────────────────────────
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  let removed = 0;
  for (const agent of Object.keys(_mem.byAgent)) {
    for (const key of Object.keys(_mem.byAgent[agent])) {
      if (_mem.byAgent[agent][key].ts < cutoff) {
        delete _mem.byAgent[agent][key];
        removed++;
      }
    }
  }
  for (const key of Object.keys(_mem.shared)) {
    if (_mem.shared[key].ts < cutoff) {
      delete _mem.shared[key];
      removed++;
    }
  }
  if (removed > 0) { console.log(`[nexus/memory] cleaned ${removed} old entries`); _save(); }
}, 24 * 60 * 60 * 1000);

module.exports = {
  remember, recall, forget, all,
  setShared, getShared,
};
