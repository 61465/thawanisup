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

/**
 * read JSONL → apply mutator → write atomically.
 * @param {string} file
 * @param {(lines:string[]) => {lines:string[], result?:any}} mutator
 * @returns {any} the .result from mutator (or false if file missing)
 */
function updateJsonl(file, mutator) {
  if (!fs.existsSync(file)) return false;
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.trim().split("\n").filter(Boolean);
  const out = mutator(lines) || { lines };
  const newContent = out.lines.join("\n") + "\n";
  writeSync(file, newContent, { encoding: "utf8" });
  return out.result !== undefined ? out.result : true;
}

// ─── In-process async lock ────────────────────────────────────────────────
// يحمي من lost updates عند read-modify-write متزامن على نفس الملف.
// مناسب لـ single PM2 process (الإعداد الحالي). لو انتقلنا لـ cluster:
// استبدله بـ proper-lockfile الذي يقفل على نظام الملفات.
const _locks       = new Map(); // file → Promise (آخر عملية في الـ chain)
const _lockCounts  = new Map(); // file → عدد الـ pending

async function withLock(file, fn) {
  const prev = _locks.get(file) || Promise.resolve();
  let release;
  const next = new Promise(r => { release = r; });
  // chain: ننتظر prev ثم نُفعّل next عند الانتهاء (حتى لو prev فشل)
  _locks.set(file, prev.catch(() => {}).then(() => next));
  _lockCounts.set(file, (_lockCounts.get(file) || 0) + 1);
  try {
    await prev.catch(() => {}); // لا نُفجّر بسبب فشل عملية سابقة
    return await fn();
  } finally {
    release();
    // counter-based cleanup: عند 0 pending، نمسح من Map (يمنع تضخم الذاكرة)
    const left = (_lockCounts.get(file) || 1) - 1;
    if (left <= 0) {
      _lockCounts.delete(file);
      _locks.delete(file);
    } else {
      _lockCounts.set(file, left);
    }
  }
}

// نسخة sync (للتوافق مع الكود القديم): تستخدم busy-wait صغير عبر deasync مرفوض.
// بدلاً منه: نوفّر helper async ونحدّث callers تدريجياً.

/**
 * Atomic update لـ JSONL مع lock: يضمن سيريالية الـ read-modify-write.
 * @param {string} file
 * @param {(lines:string[]) => {lines:string[], result?:any}} mutator
 */
async function updateJsonlLocked(file, mutator) {
  return withLock(file, () => {
    if (!fs.existsSync(file)) return false;
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const out = mutator(lines) || { lines };
    const newContent = out.lines.join("\n") + (out.lines.length ? "\n" : "");
    writeSync(file, newContent, { encoding: "utf8" });
    return out.result !== undefined ? out.result : true;
  });
}

module.exports = {
  writeSync, writeJsonSync, readJsonSync, appendJsonlSync, updateJsonl,
  withLock, updateJsonlLocked,
};
