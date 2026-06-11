#!/bin/bash
# Daily Encrypted Backup — Thawani Platform
# Usage: ./scripts/backup-encrypted.sh
# Requires: BACKUP_PASSPHRASE env var (32+ random chars)
# Strategy: tar.gz the data/ dir → encrypt with GPG (AES256) → keep last 14 days local + last 90 days off-site
set -euo pipefail

BASE_DIR="/opt/bothatim"
DATA_DIR="$BASE_DIR/data"
BACKUP_DIR="$BASE_DIR/backups"
TIMESTAMP=$(date -u +"%Y%m%d-%H%M%S")
ARCHIVE="$BACKUP_DIR/thawani-$TIMESTAMP.tar.gz.gpg"
LOG="$BASE_DIR/logs/backup.log"

if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  if [ -f "$BASE_DIR/.env" ]; then
    BACKUP_PASSPHRASE=$(grep -E '^BACKUP_PASSPHRASE=' "$BASE_DIR/.env" | cut -d= -f2- | tr -d '"' | tr -d "'")
  fi
fi

if [ -z "${BACKUP_PASSPHRASE:-}" ] || [ ${#BACKUP_PASSPHRASE} -lt 24 ]; then
  echo "[ERROR] BACKUP_PASSPHRASE missing or < 24 chars" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR" "$(dirname "$LOG")"

log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }

log "Starting backup → $ARCHIVE"

EXCLUDES=(
  --exclude='data/sessions/*/baileys_store_multi.json'
  --exclude='data/sessions/*/creds_lock_*'
  --exclude='data/backups'
  --exclude='data/audit'
)

tar -czf - "${EXCLUDES[@]}" -C "$BASE_DIR" data \
  | gpg --batch --yes --pinentry-mode loopback \
        --passphrase "$BACKUP_PASSPHRASE" \
        --cipher-algo AES256 --symmetric \
        --output "$ARCHIVE"

SIZE=$(du -h "$ARCHIVE" | cut -f1)
log "Backup complete: $ARCHIVE ($SIZE)"

find "$BACKUP_DIR" -name "thawani-*.tar.gz.gpg" -mtime +14 -delete
log "Pruned local backups older than 14 days"

if [ -n "${BACKUP_REMOTE_SSH:-}" ]; then
  log "Syncing to remote: $BACKUP_REMOTE_SSH"
  scp -o BatchMode=yes -o StrictHostKeyChecking=no "$ARCHIVE" "$BACKUP_REMOTE_SSH/" \
    && log "Remote sync OK" \
    || log "[WARN] Remote sync failed"
fi

log "Done."
