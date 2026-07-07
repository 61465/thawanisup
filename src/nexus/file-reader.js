/**
 * NEXUS File Reader — يعطي الوكلاء قدرة قراءة ملفات المشروع
 *
 * المبدأ: NEXUS فريق "موظفين" يعمل على نفس الـ codebase. يحتاجون يقرأون:
 *   - الكود (src/*)
 *   - البيانات (data/*)
 *   - السجلات (logs)
 *   - التغييرات (git diff)
 *
 * هذا الملف الوحيد الذي يلامس الـ filesystem لصالح NEXUS.
 * كل وكيل يستدعيه (لا يفتح fs مباشرة) → سهولة الـ audit + تطبيق سياسات.
 */

const fs   = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ─── جذر المشروع ───────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, "..", "..");
const SAFE_DIRS = ["src", "public", "data", "docs", "infra", "."];

function _safePath(rel) {
  // منع directory traversal (../../etc/passwd)
  const abs = path.resolve(ROOT, rel);
  if (!abs.startsWith(ROOT)) throw new Error(`Unsafe path: ${rel}`);
  return abs;
}

// ─── Cache ──────────────────────────────────────────────────────────────
const _cache = new Map(); // path → { content, mtime }
const CACHE_TTL_MS = 30_000; // 30s — معقول للأشياء التي تتغيّر بطيئاً

async function _withCache(key, ttlMs, fn) {
  const now = Date.now();
  const cached = _cache.get(key);
  if (cached && now - cached.ts < ttlMs) return cached.value;
  const value = await fn();
  _cache.set(key, { value, ts: now });
  return value;
}

// ═══════════════════════════════════════════════════════════════════════
// 📄 File operations
// ═══════════════════════════════════════════════════════════════════════

/** قراءة ملف نص */
async function readFile(relPath, opts = {}) {
  const abs = _safePath(relPath);
  if (opts.noCache) return fs.readFile(abs, "utf8");
  return _withCache(`file:${relPath}`, CACHE_TTL_MS, () => fs.readFile(abs, "utf8"));
}

/** قراءة JSON */
async function readJSON(relPath) {
  const text = await readFile(relPath, { noCache: true });
  return JSON.parse(text);
}

/** قراءة JSONL — كل سطر JSON منفصل */
async function readJsonl(relPath, opts = {}) {
  const text = await readFile(relPath, { noCache: true });
  const lines = text.split("\n").filter(Boolean);
  const objs = [];
  for (const l of lines) {
    try { objs.push(JSON.parse(l)); } catch {}
  }
  if (opts.limit) return objs.slice(-opts.limit);
  return objs;
}

/** قراءة آخر N سطر من ملف log */
async function tailLog(relPath, lines = 50) {
  const text = await readFile(relPath, { noCache: true }).catch(() => "");
  const all = text.split("\n");
  return all.slice(-lines).join("\n");
}

/** فحص وجود ملف */
async function exists(relPath) {
  try {
    await fs.access(_safePath(relPath));
    return true;
  } catch { return false; }
}

/** stats — حجم + تاريخ تعديل */
async function stat(relPath) {
  const s = await fs.stat(_safePath(relPath));
  return {
    size: s.size,
    sizeKB: Math.round(s.size / 1024),
    mtime: s.mtime,
    isFile: s.isFile(),
    isDir: s.isDirectory(),
  };
}

/** قائمة ملفات مجلد */
async function readDir(relPath, opts = {}) {
  const abs = _safePath(relPath);
  const items = await fs.readdir(abs);
  let result = items.map(name => ({
    name,
    path: path.join(relPath, name),
  }));
  if (opts.ext) result = result.filter(i => i.name.endsWith(opts.ext));
  if (opts.withStats) {
    result = await Promise.all(result.map(async i => ({
      ...i,
      stat: await stat(i.path).catch(() => null),
    })));
  }
  return result;
}

/** شجرة مجلد بعمق محدد */
async function tree(relPath, depth = 2, prefix = "") {
  if (depth < 0) return [];
  const abs = _safePath(relPath);
  let items;
  try { items = await fs.readdir(abs, { withFileTypes: true }); }
  catch { return []; }
  const lines = [];
  for (const item of items) {
    if (item.name.startsWith(".")) continue;
    if (item.name === "node_modules") continue;
    lines.push(`${prefix}${item.isDirectory() ? "📁" : "📄"} ${item.name}`);
    if (item.isDirectory() && depth > 0) {
      const sub = await tree(path.join(relPath, item.name), depth - 1, prefix + "  ");
      lines.push(...sub);
    }
  }
  return lines;
}

// ═══════════════════════════════════════════════════════════════════════
// 🌿 Git operations (read-only)
// ═══════════════════════════════════════════════════════════════════════

function gitDiff(ref = "HEAD") {
  try {
    return execSync(`git diff ${ref}`, { cwd: ROOT, encoding: "utf8", timeout: 5000 });
  } catch { return null; }
}

function gitLog(limit = 10) {
  try {
    const out = execSync(`git log --oneline -${limit}`, { cwd: ROOT, encoding: "utf8", timeout: 5000 });
    return out.split("\n").filter(Boolean);
  } catch { return []; }
}

function gitStatus() {
  try {
    return execSync(`git status --short`, { cwd: ROOT, encoding: "utf8", timeout: 5000 });
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════
// 🔎 Search
// ═══════════════════════════════════════════════════════════════════════

/** بحث نصي بسيط في الملفات */
async function searchInFiles(query, opts = {}) {
  const dir = opts.dir || "src";
  const ext = opts.ext || ".js";
  const files = [];
  const walk = async (relDir) => {
    const items = await fs.readdir(_safePath(relDir), { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      const p = path.join(relDir, item.name);
      if (item.isDirectory() && !item.name.startsWith(".") && item.name !== "node_modules") {
        await walk(p);
      } else if (item.isFile() && item.name.endsWith(ext)) {
        files.push(p);
      }
    }
  };
  await walk(dir);

  const results = [];
  for (const file of files) {
    const content = await readFile(file).catch(() => "");
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      if (line.toLowerCase().includes(query.toLowerCase())) {
        results.push({ file, line: i + 1, text: line.trim().slice(0, 200) });
      }
    });
    if (results.length >= 100) break; // safety cap
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════
// 🧹 Cache control
// ═══════════════════════════════════════════════════════════════════════

function clearCache() { _cache.clear(); }
function cacheStats() {
  return { entries: _cache.size, keys: [..._cache.keys()].slice(0, 20) };
}

module.exports = {
  ROOT,
  readFile,
  readJSON,
  readJsonl,
  tailLog,
  exists,
  stat,
  readDir,
  tree,
  gitDiff,
  gitLog,
  gitStatus,
  searchInFiles,
  clearCache,
  cacheStats,
};
