/**
 * Atomic File System — sync API يضمن:
 *   1. لو العملية ماتت أثناء write → الملف الأصلي يبقى سليم (rename atomic)
 *   2. القارئون يرون الإصدار القديم كاملاً أو الجديد كاملاً، لا shape مكسور
 *   3. zero dependency، drop-in بديل لـ fs.writeFileSync
 *
 * Usage:
 *   const af = require('./atomic-fs');
 *   af.writeSync('data/stores.json', JSON.stringify({...}, null, 2));
 *   af.writeJsonSync('data/stores.json', { stores: [...] });
 */
const fs   = require("fs");
const path = require("path");

function _ensureDir(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * write content to file via tmp + rename (atomic).
 * @param {string} file
 * @param {string|Buffer} content
 * @param {object} opts - { encoding: "utf8" }
 */
function writeSync(file, content, opts) {
  _ensureDir(file);
  const enc = (opts && opts.encoding) || "utf8";
  const tmp = file + ".tmp." + process.pid + "." + Date.now();
  try {
    fs.writeFileSync(tmp, content, enc);
    // POSIX rename atomic؛ Windows best-effort (lo overlapping I/O)
    fs.renameSync(tmp, file);
  } catch (e) {
    // cleanup tmp في حال فشل الـ rename
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

/**
 * write JSON object atomically
 * @param {string} file
 * @param {any} obj
 * @param {boolean} pretty - default true (2-space indent)
 */
function writeJsonSync(file, obj, pretty) {
  const content = pretty === false ? JSON.stringify(obj) : JSON.stringify(obj, null, 2);
  writeSync(file, content, { encoding: "utf8" });
}

/**
 * read JSON safely with fallback
 */
function readJsonSync(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return fallback; }
}

/**
 * append to JSONL file atomically (kept for symmetry — appendFileSync بالفعل آمن للـ small writes)
 */
function appendJsonlSync(file, obj) {
  _ensureDir(file);
  fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
}

module.exports = { writeSync, writeJsonSync, readJsonSync, appendJsonlSync };
