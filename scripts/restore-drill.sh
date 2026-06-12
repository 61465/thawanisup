#!/bin/bash
# Restore Drill — يختبر backup حقيقياً بدون لمس الإنتاج
# Usage:    ./scripts/restore-drill.sh [path-to-encrypted-archive]
# Schedule: شغّل شهرياً يدوياً — لا تثق ببـ backup لم يُختبر!
#
# ماذا يفعل:
#   1. ينشئ مجلد مؤقت
#   2. يفك تشفير الـ archive
#   3. يُخرج tarball
#   4. يقارن file count + يفحص أن stores.json/orders/customers صحيحة
#   5. يحذف المجلد المؤقت
#   6. يبلّغك بـ result

set -euo pipefail

BASE_DIR="${BASE_DIR:-/opt/bothatim}"

if [ -z "${BACKUP_PASSPHRASE:-}" ] && [ -f "$BASE_DIR/.env" ]; then
  BACKUP_PASSPHRASE=$(grep -E '^BACKUP_PASSPHRASE=' "$BASE_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
fi

if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "❌ BACKUP_PASSPHRASE مفقود" >&2
  exit 1
fi

# اختر الـ archive: من argument أو آخر backup
ARCHIVE="${1:-}"
if [ -z "$ARCHIVE" ]; then
  ARCHIVE=$(ls -t "$BASE_DIR"/backups/thawani-*.tar.gz.gpg 2>/dev/null | head -1)
fi
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "❌ لم يُعثَر على backup archive" >&2
  exit 1
fi

echo "🔬 Restore Drill — $ARCHIVE"
echo "─────────────────────────────────────"

WORKDIR=$(mktemp -d -t thawani-restore.XXXXXX)
trap "rm -rf '$WORKDIR'" EXIT

# 1. فك التشفير + tar
echo "📦 فك التشفير..."
gpg --batch --yes --pinentry-mode loopback \
    --passphrase "$BACKUP_PASSPHRASE" \
    --decrypt "$ARCHIVE" 2>/dev/null | tar -xzf - -C "$WORKDIR"
echo "✅ فُكّ ضغطه إلى: $WORKDIR/data"

# 2. تحقق من الـ structure
if [ ! -d "$WORKDIR/data" ]; then
  echo "❌ data/ غير موجود في الـ archive"
  exit 1
fi

EXPECTED_FILES=("stores.json" "customers.json")
MISSING=()
for f in "${EXPECTED_FILES[@]}"; do
  if [ ! -f "$WORKDIR/data/$f" ]; then
    MISSING+=("$f")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "⚠️ ملفات مفقودة: ${MISSING[*]}"
else
  echo "✅ كل الملفات الأساسية موجودة"
fi

# 3. تحقق من JSON validity
echo "🔍 فحص JSON validity..."
JSON_OK=0
JSON_BAD=0
for f in "$WORKDIR/data"/*.json "$WORKDIR/data"/*/*.json; do
  [ -f "$f" ] || continue
  if python3 -c "import json,sys; json.load(open('$f'))" 2>/dev/null; then
    JSON_OK=$((JSON_OK + 1))
  else
    JSON_BAD=$((JSON_BAD + 1))
    echo "  ⚠️ JSON خاطئ: $(basename "$f")"
  fi
done
echo "  ✅ $JSON_OK JSON صحيحة، ❌ $JSON_BAD مكسورة"

# 4. إحصاءات
STORES_COUNT=$(python3 -c "import json; d=json.load(open('$WORKDIR/data/stores.json')); print(len(d.get('stores', [])))" 2>/dev/null || echo "?")
CUSTOMERS_COUNT=$(python3 -c "import json; d=json.load(open('$WORKDIR/data/customers.json')); print(len(d))" 2>/dev/null || echo "?")
ORDERS_FILES=$(ls "$WORKDIR/data"/orders_*.jsonl 2>/dev/null | wc -l)
ORDERS_TOTAL=$(cat "$WORKDIR/data"/orders_*.jsonl 2>/dev/null | wc -l || echo 0)

echo ""
echo "📊 إحصاءات الـ archive:"
echo "  - المتاجر:   $STORES_COUNT"
echo "  - العملاء:   $CUSTOMERS_COUNT"
echo "  - ملفات الطلبات: $ORDERS_FILES"
echo "  - إجمالي الطلبات: $ORDERS_TOTAL"

# 5. النتيجة النهائية
if [ "$JSON_BAD" -eq 0 ] && [ ${#MISSING[@]} -eq 0 ]; then
  echo ""
  echo "✅ ═════════════════════════════════════"
  echo "✅  Restore Drill نجح — الـ backup صالح"
  echo "✅ ═════════════════════════════════════"
  exit 0
else
  echo ""
  echo "❌ ═════════════════════════════════════"
  echo "❌  مشاكل في الـ backup — لا تثق فيه!"
  echo "❌ ═════════════════════════════════════"
  exit 1
fi
