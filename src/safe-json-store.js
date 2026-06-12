/**
 * Safe JSON Store — atomic write + simple in-process queueing
 * يحلّ race conditions على ملفات data/*.json بدون dependency خارجية.
 *
 * usage:
 *   const store = require('./safe-json-store');
 *   await store.update('data/stores.json', (data) => { data.x = 1; return data; });
 */

const fs   = require("fs");
const path = require("path");

// per-file in-process queue (مفيد لـ multi-request متوازي على نفس process)
const queues = new Map();

function _runNext(file) {
  const q = queues.get(file);
  if (!q || q.running || q.items.length === 0) return;
  q.running = true;
  const { fn, resolve, reject } = q.items.shift();
  Promise.resolve()
    .then(fn)
    .then(v => { q.running = false; resolve(v); _runNext(file); })
    .catch(e => { q.running = false; reject(e); _runNext(file); });
}

function _enqueue(file, fn) {
  let q = queues.get(file);
  if (!q) { q = { running: false, items: [] }; queues.set(file, q); }
  return new Promise((resolve, reject) => {
    q.items.push({ fn, resolve, reject });
    _runNext(file);
  });
}

function _atomicWriteSync(file, content) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp." + process.pid + "." + Date.now();
  fs.writeFileSync(tmp, content, "utf8");
  // rename atomic على معظم الـ filesystems (POSIX guarantee، Windows best-effort)
  fs.renameSync(tmp, file);
}

function readJsonSync(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return fallback; }
}

/**
 * update(file, transformer) — يقرأ، يطبّق التحويل، ويكتب بأمان.
 * يضمن أن لا اثنين update() متوازيين على نفس الملف يتداخلان.
 *
 * @param {string} file - مسار الملف
 * @param {(data:any) => any | Promise<any>} transformer - دالة تأخذ الـ data وترجع الجديد
 * @param {any} [defaultValue={}] - القيمة الافتراضية لو الملف مفقود
 */
async function update(file, transformer, defaultValue) {
  return _enqueue(file, async () => {
    const current = readJsonSync(file, defaultValue === undefined ? {} : defaultValue);
    const next = await transformer(current);
    if (next === undefined) return current; // لا تعديل
    _atomicWriteSync(file, JSON.stringify(next, null, 2));
    return next;
  });
}

/**
 * writeSafe — لو الكاتب يعرف القيمة الكاملة الجديدة (لا يحتاج read-modify-write)
 */
async function writeSafe(file, data) {
  return _enqueue(file, () => {
    _atomicWriteSync(file, JSON.stringify(data, null, 2));
    return data;
  });
}

module.exports = { update, writeSafe, readJsonSync };
