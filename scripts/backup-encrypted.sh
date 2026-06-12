#!/bin/bash
# Daily Encrypted Backup — منصة ثواني (محدّث 2026-06-12)
# Usage:    ./scripts/backup-encrypted.sh
# Schedule: 30 3 * * * /opt/bothatim/scripts/backup-encrypted.sh
# Requires: BACKUP_PASSPHRASE في .env (≥24 char)
# Optional: BACKUP_REMOTE_SSH للـ rsync، أو BACKUP_RCLONE_REMOTE للـ cloud
#
# Strategy:
#   1. tar.gz + GPG AES256 من data/
#   2. آخر 14 يوم محلياً
#   3. rsync إلى remote VPS (اختياري)
#   4. rclone إلى B2/R2/S3 (اختياري — offsite حقيقي)
#   5. تأكيد integrity فوراً بعد الـ encrypt

set -euo pipefail

BASE_DIR="${BASE_DIR:-/opt/bothatim}"
DATA_DIR="$BASE_DIR/data"
BACKUP_DIR="$BASE_DIR/backups"
TIMESTAMP=$(date -u +"%Y%m%d-%H%M%S")
ARCHIVE="$BACKUP_DIR/thawani-$TIMESTAMP.tar.gz.gpg"
LOG="$BASE_DIR/logs/backup.log"

# ─── Load .env ─────────────────────────────────────────────────────────────
if [ -z "${BACKUP_PASSPHRASE:-}" ] && [ -f "$BASE_DIR/.env" ]; then
  BACKUP_PASSPHRASE=$(grep -E '^BACKUP_PASSPHRASE=' "$BASE_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
fi
if [ -z "${BACKUP_REMOTE_SSH:-}" ] && [ -f "$BASE_DIR/.env" ]; then
  BACKUP_REMOTE_SSH=$(grep -E '^BACKUP_REMOTE_SSH=' "$BASE_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
fi
if [ -z "${BACKUP_RCLONE_REMOTE:-}" ] && [ -f "$BASE_DIR/.env" ]; then
  BACKUP_RCLONE_REMOTE=$(grep -E '^BACKUP_RCLONE_REMOTE=' "$BASE_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
fi

if [ -z "${BACKUP_PASSPHRASE:-}" ] || [ ${#BACKUP_PASSPHRASE} -lt 24 ]; then
  echo "[ERROR] BACKUP_PASSPHRASE مفقود أو < 24 حرف" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR" "$(dirname "$LOG")"

log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }

log "═══ بدء النسخ الاحتياطي → $ARCHIVE ═══"

# ─── 1. Create encrypted tarball ──────────────────────────────────────────
EXCLUDES=(
  --exclude='data/sessions/*/baileys_store_multi.json'
  --exclude='data/sessions/*/creds_lock_*'
  --exclude='data/backups'
  --exclude='data/audit'
  --exclude='data/invoices/*.png'   # تُولّد من orders
)

tar -czf - "${EXCLUDES[@]}" -C "$BASE_DIR" data \
  | gpg --batch --yes --pinentry-mode loopback \
        --passphrase "$BACKUP_PASSPHRASE" \
        --cipher-algo AES256 --symmetric \
        --output "$ARCHIVE"

SIZE=$(du -h "$ARCHIVE" | cut -f1)
log "✅ encrypted: $ARCHIVE ($SIZE)"

# ─── 2. Integrity verification (test decrypt) ─────────────────────────────
log "🔍 التحقق من سلامة الـ archive..."
TMPCHECK=$(mktemp)
if gpg --batch --yes --pinentry-mode loopback \
       --passphrase "$BACKUP_PASSPHRASE" \
       --decrypt "$ARCHIVE" 2>/dev/null | tar -tzf - > "$TMPCHECK" 2>&1; then
  ENTRIES=$(wc -l < "$TMPCHECK")
  log "✅ verified: $ENTRIES ملف في الـ archive"
  rm -f "$TMPCHECK"
else
  log "❌ التحقق فشل! الـ archive مكسور — لا تثق فيه"
  rm -f "$TMPCHECK"
  exit 1
fi

# ─── 3. Local pruning (keep last 14 days) ─────────────────────────────────
find "$BACKUP_DIR" -name "thawani-*.tar.gz.gpg" -mtime +14 -delete
log "🧹 حُذفت النسخ > 14 يوم محلياً"

# ─── 4. rsync إلى remote VPS (اختياري) ────────────────────────────────────
if [ -n "${BACKUP_REMOTE_SSH:-}" ]; then
  log "📤 مزامنة rsync → $BACKUP_REMOTE_SSH"
  if scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$ARCHIVE" "$BACKUP_REMOTE_SSH/"; then
    log "✅ rsync OK"
  else
    log "⚠️ rsync فشل — تابع لكن نبّه"
  fi
fi

# ─── 5. rclone إلى offsite cloud (مهم — احفظ خارج VPS الإنتاجي!) ──────────
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ] && command -v rclone >/dev/null 2>&1; then
  log "☁️ رفع لـ offsite cloud: $BACKUP_RCLONE_REMOTE"
  if rclone copy "$ARCHIVE" "$BACKUP_RCLONE_REMOTE/" --transfers=1; then
    log "✅ offsite upload OK"
    # نظافة بعيدة: احتفظ آخر 90 يوم في الـ cloud
    rclone delete "$BACKUP_RCLONE_REMOTE/" --min-age 90d 2>/dev/null || true
  else
    log "⚠️ rclone فشل"
  fi
elif [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  log "⚠️ BACKUP_RCLONE_REMOTE مُحدّد لكن rclone غير مثبّت — ثبّته: curl https://rclone.org/install.sh | sudo bash"
fi

log "═══ تم ═══"
