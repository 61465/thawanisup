/**
 * Backup module — يدعم استدعاء يدوي من endpoint + نفس logic السكريبت اليومي.
 */
const fs   = require("fs");
const path = require("path");

const DATA_DIR    = path.join(__dirname, "..", "data");
const BACKUP_ROOT = path.join(__dirname, "..", "backups");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath  = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

function sizeOf(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      total += f.isDirectory() ? sizeOf(p) : (fs.statSync(p).size || 0);
    }
  } catch {}
  return total;
}

/**
 * نسخة احتياطية فورية — يستدعى من endpoint.
 * يستخدم timestamp (ليس فقط التاريخ) لتمييز عدة نسخ في نفس اليوم.
 */
function snapshot(label) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dirName = label ? `${ts}_${String(label).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32)}` : ts;
  const destDir = path.join(BACKUP_ROOT, dirName);
  if (fs.existsSync(destDir)) {
    return { ok: false, error: "directory exists" };
  }
  copyDir(DATA_DIR, destDir);
  const sizeMB = +(sizeOf(destDir) / 1024 / 1024).toFixed(2);
  return { ok: true, name: dirName, path: destDir, sizeMB };
}

/**
 * قائمة النسخ المتاحة + حجمها + تاريخها.
 */
function list() {
  if (!fs.existsSync(BACKUP_ROOT)) return [];
  const items = [];
  for (const name of fs.readdirSync(BACKUP_ROOT)) {
    const p = path.join(BACKUP_ROOT, name);
    try {
      const st = fs.statSync(p);
      if (!st.isDirectory()) continue;
      items.push({
        name,
        createdAt: st.mtime.toISOString(),
        sizeMB: +(sizeOf(p) / 1024 / 1024).toFixed(2),
      });
    } catch {}
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

module.exports = { snapshot, list };
