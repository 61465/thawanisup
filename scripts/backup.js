/**
 * Daily Backup Script
 * ينسخ مجلد data/ إلى backups/YYYY-MM-DD/
 * شغّل يدوياً: node scripts/backup.js
 * أو عبر Task Scheduler كل يوم
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR    = path.join(__dirname, "..", "data");
const BACKUP_ROOT = path.join(__dirname, "..", "backups");
const MAX_BACKUPS = 30; // احتفظ بآخر 30 يوم فقط

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath  = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
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

function cleanOldBackups() {
  if (!fs.existsSync(BACKUP_ROOT)) return;
  const dirs = fs.readdirSync(BACKUP_ROOT)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  while (dirs.length > MAX_BACKUPS) {
    const old = dirs.shift();
    fs.rmSync(path.join(BACKUP_ROOT, old), { recursive: true, force: true });
    console.log(`🗑️  حُذفت النسخة القديمة: ${old}`);
  }
}

const today   = new Date().toISOString().slice(0, 10);
const destDir = path.join(BACKUP_ROOT, today);

if (fs.existsSync(destDir)) {
  console.log(`⚠️  نسخة اليوم موجودة بالفعل: ${today}`);
} else {
  console.log(`📦 جاري إنشاء نسخة احتياطية لـ ${today}...`);
  copyDir(DATA_DIR, destDir);
  const sizeMB = (sizeOf(destDir) / 1024 / 1024).toFixed(2);
  console.log(`✅ تم الحفظ في: ${destDir} (${sizeMB} MB)`);
}

cleanOldBackups();

// Clean old invoice images (>90 days)
const INVOICE_DIR = path.join(DATA_DIR, "invoices");
const KEEP_DAYS   = 90;
if (fs.existsSync(INVOICE_DIR)) {
  const cutoff = Date.now() - KEEP_DAYS * 86400 * 1000;
  let deleted = 0;
  for (const f of fs.readdirSync(INVOICE_DIR)) {
    if (!f.endsWith(".png") && !f.endsWith(".jpg")) continue;
    const fp = path.join(INVOICE_DIR, f);
    if (fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); deleted++; }
  }
  if (deleted) console.log(`🧹 حُذفت ${deleted} فاتورة قديمة (أكثر من ${KEEP_DAYS} يوم)`);
}

console.log("🎉 اكتمل الباك أب");
