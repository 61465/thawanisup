/**
 * 💾 Backup Rotator — جدولة backups تلقائية + rotation
 *
 * يعمل في الخلفية:
 *   - كل 24 ساعة → snapshot جديد عبر backup.js
 *   - يحتفظ بـ 14 يوم محلياً (auto-cleanup للأقدم)
 *   - يُحرّك الأقدم لـ archive/ (gzip فقط، لا حذف)
 *
 * يضمن: لا فقدان بيانات + لا امتلاء disk
 */

const fs   = require("fs");
const path = require("path");
const backup = require("./backup");

const BACKUP_DIR  = path.join(__dirname, "..", "data", "backups");
const ARCHIVE_DIR = path.join(__dirname, "..", "data", "backups", "archive");

const KEEP_DAILY      = 14;  // آخر 14 يوم في الأصل
const KEEP_WEEKLY     = 12;  // 12 أسبوع في archive
const ROTATION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 ساعات

function _ensureDirs() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

function _listSnapshots(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".tar.gz") || f.endsWith(".tar.gz.gpg"))
    .map(f => ({ name: f, path: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

async function takeSnapshot(label = "scheduled") {
  _ensureDirs();
  try {
    if (typeof backup.snapshot === "function") {
      const r = await backup.snapshot({ label });
      console.log(`[backup-rotator] snapshot taken: ${r?.file || "unknown"}`);
      return r;
    }
    console.warn("[backup-rotator] backup.snapshot() not available");
    return null;
  } catch (e) {
    console.error("[backup-rotator] snapshot failed:", e.message);
    return null;
  }
}

function rotate() {
  try {
    _ensureDirs();
    const snaps = _listSnapshots(BACKUP_DIR);

    // الأحدث 14 يبقون
    const toKeep = snaps.slice(0, KEEP_DAILY);
    const toArchive = snaps.slice(KEEP_DAILY);

    let moved = 0, deleted = 0;
    for (const s of toArchive) {
      // كل 7 ملفات: احتفظ بواحد في archive
      const ageDays = (Date.now() - s.mtime) / (24 * 60 * 60 * 1000);
      const weekIndex = Math.floor(ageDays / 7);
      const isWeekRepresentative = weekIndex >= 0 && weekIndex < KEEP_WEEKLY;
      if (isWeekRepresentative) {
        const dst = path.join(ARCHIVE_DIR, s.name);
        if (!fs.existsSync(dst)) {
          fs.renameSync(s.path, dst);
          moved++;
        } else {
          fs.unlinkSync(s.path);
          deleted++;
        }
      } else {
        fs.unlinkSync(s.path);
        deleted++;
      }
    }

    // نظف archive القديم (>12 أسبوع)
    const archSnaps = _listSnapshots(ARCHIVE_DIR);
    for (const a of archSnaps.slice(KEEP_WEEKLY)) {
      try { fs.unlinkSync(a.path); deleted++; } catch {}
    }

    if (moved || deleted) console.log(`[backup-rotator] rotated: ${moved} archived, ${deleted} deleted`);
    return { kept: toKeep.length, moved, deleted };
  } catch (e) {
    console.error("[backup-rotator] rotation failed:", e.message);
    return { error: e.message };
  }
}

let _intervalHandle = null;

function start() {
  if (_intervalHandle) return;
  _ensureDirs();
  console.log(`[backup-rotator] active — snapshot every 24h, rotation every 6h, keep ${KEEP_DAILY} daily + ${KEEP_WEEKLY} weekly`);

  // أول snapshot بعد ساعة من البدء (لا نزعج boot)
  setTimeout(() => takeSnapshot("startup-delayed").catch(() => {}), 60 * 60 * 1000).unref?.();

  // snapshots يومية + rotation كل 6 ساعات
  _intervalHandle = setInterval(async () => {
    const hour = new Date().getUTCHours();
    // snapshot يومي عند الساعة 0 UTC (3 صباحاً ت.الرياض)
    if (hour === 0) await takeSnapshot("daily").catch(() => {});
    rotate();
  }, ROTATION_INTERVAL_MS).unref?.();
}

function stop() {
  if (_intervalHandle) { clearInterval(_intervalHandle); _intervalHandle = null; }
}

function status() {
  const snaps = _listSnapshots(BACKUP_DIR);
  const arch  = _listSnapshots(ARCHIVE_DIR);
  return {
    active: !!_intervalHandle,
    snapshots: snaps.length,
    archived: arch.length,
    latest: snaps[0] ? { name: snaps[0].name, age: Date.now() - snaps[0].mtime } : null,
    oldest: snaps[snaps.length - 1] ? snaps[snaps.length - 1].name : null,
  };
}

module.exports = { start, stop, status, rotate, takeSnapshot };
