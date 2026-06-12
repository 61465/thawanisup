#!/bin/bash
# Deploy Script — منصة ثواني
# Usage: ./scripts/deploy.sh [--no-migrate] [--no-restart]
# يفترض أن تكون داخل /opt/bothatim على الـ VPS

set -euo pipefail

BASE_DIR="${BASE_DIR:-/opt/bothatim}"
NO_MIGRATE=0
NO_RESTART=0

for arg in "$@"; do
  case $arg in
    --no-migrate) NO_MIGRATE=1 ;;
    --no-restart) NO_RESTART=1 ;;
    -h|--help)
      echo "Usage: $0 [--no-migrate] [--no-restart]"
      exit 0
      ;;
  esac
done

cd "$BASE_DIR"
echo "═══ Deploy منصة ثواني ═══"
echo "📍 $(pwd)"
echo "🕐 $(date)"
echo ""

# ─── 0. Backup قبل أي شيء ────────────────────────────────────────────────
echo "💾 [1/6] أخذ backup قبل الـ deploy..."
STAMP=$(date +%Y%m%d-%H%M%S)
PREDEPLOY_DIR="backups/pre-deploy-$STAMP"
mkdir -p "$PREDEPLOY_DIR"
cp -r data "$PREDEPLOY_DIR/"
cp .env "$PREDEPLOY_DIR/.env.backup" 2>/dev/null || true
echo "   ✅ نسخة: $PREDEPLOY_DIR ($(du -sh "$PREDEPLOY_DIR" | cut -f1))"
echo ""

# ─── 1. Git pull ─────────────────────────────────────────────────────────
echo "📥 [2/6] git pull origin main..."
git fetch origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "   ℹ️ بالفعل أحدث commit — لا تغيير"
else
  git pull origin main
  echo "   ✅ من $LOCAL → $REMOTE"
fi
echo ""

# ─── 2. npm install (لو package.json تغيّر) ──────────────────────────────
echo "📦 [3/6] فحص dependencies..."
if git diff "$LOCAL" "$REMOTE" --name-only 2>/dev/null | grep -q "package.json\|package-lock.json"; then
  echo "   🔄 package.json تغيّر — تثبيت..."
  npm install --omit=dev
  # rebuild bcrypt إذا لزم
  npm rebuild bcrypt --build-from-source 2>/dev/null || true
else
  echo "   ✅ لا تغيير في dependencies"
fi
echo ""

# ─── 3. تحقق من .env ──────────────────────────────────────────────────────
echo "🔐 [4/6] فحص .env..."
MISSING=0
for VAR in JWT_SECRET MASTER_PASSWORD; do
  VAL=$(grep "^$VAR=" .env 2>/dev/null | cut -d= -f2- || true)
  if [ -z "$VAL" ]; then
    echo "   ❌ $VAR مفقود!"
    MISSING=1
  fi
done
JWT_LEN=$(grep "^JWT_SECRET=" .env | cut -d= -f2- | wc -c)
if [ "$JWT_LEN" -lt 48 ]; then
  echo "   ❌ JWT_SECRET أقصر من 48 حرف ($JWT_LEN)"
  MISSING=1
fi
if [ "$MISSING" -eq 1 ]; then
  echo ""
  echo "   ❌ ABORT: .env ناقص. أصلحه قبل الـ deploy."
  exit 1
fi
echo "   ✅ .env صالح"
echo ""

# ─── 4. Tests ─────────────────────────────────────────────────────────────
echo "🧪 [5/6] تشغيل security tests..."
if npm run test:security; then
  echo "   ✅ كل الاختبارات نجحت"
else
  echo ""
  echo "   ❌ ABORT: اختبارات الأمان فشلت."
  exit 1
fi
echo ""

# ─── 5. Migration (لو -no-migrate غير مُمرّر) ─────────────────────────────
if [ "$NO_MIGRATE" -eq 0 ]; then
  echo "🔄 [6/6a] تحقق من plaintext passwords..."
  PLAIN=$(node -e "
    const data = JSON.parse(require('fs').readFileSync('data/stores.json'));
    const c = data.stores.filter(s => s.storePassword && !/^\\\$2[aby]?\\\$/.test(s.storePassword)).length;
    console.log(c);
  ")
  if [ "$PLAIN" -gt 0 ]; then
    echo "   ⚠️ $PLAIN كلمة مرور plaintext — تشغيل migration"
    npm run migrate:passwords 2>&1 | tee "/tmp/migration-$STAMP.log"
    echo "   📋 الكلمات الأصلية محفوظة في /tmp/migration-$STAMP.log"
    echo "   ⚠️ ⚠️ ⚠️  أرسلها لأصحاب المتاجر ثم احذف الملف"
  else
    echo "   ✅ كل كلمات المرور bcrypt-hashed بالفعل"
  fi
else
  echo "🔄 [6/6a] migration تخطّى (--no-migrate)"
fi
echo ""

# ─── 6. Restart ───────────────────────────────────────────────────────────
if [ "$NO_RESTART" -eq 0 ]; then
  echo "🚀 [6/6b] إعادة تشغيل PM2..."
  pm2 restart whatsapp-bot
  sleep 3
  pm2 list | grep whatsapp-bot
  echo ""
  echo "📡 آخر 20 سطر من logs:"
  pm2 logs whatsapp-bot --lines 20 --nostream
  echo ""

  # health check
  echo "🩺 فحص /health..."
  sleep 5
  if curl -sf http://localhost:3003/health > /dev/null; then
    echo "   ✅ السيرفر يستجيب"
  else
    echo "   ⚠️ السيرفر لا يستجيب — راجع logs!"
    pm2 logs whatsapp-bot --lines 50 --nostream
    exit 1
  fi
else
  echo "🚀 [6/6b] restart تخطّى (--no-restart)"
fi
echo ""

echo "═══════════════════════════════"
echo "✅  Deploy ناجح في $(date)"
echo "═══════════════════════════════"
echo ""
echo "📋 الخطوات التالية اليدوية:"
echo "  1. تابع pm2 logs whatsapp-bot لمدة 10 دقائق"
echo "  2. سجّل دخول إلى master.html للتأكد"
echo "  3. لو كانت في migration: أرسل الكلمات لأصحاب المتاجر ثم rm /tmp/migration-*.log"
