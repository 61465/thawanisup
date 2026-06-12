#!/bin/bash
# deploy.sh — نشر كامل على أي سيرفر Linux مع Docker
set -e

echo "🚀 WhatsApp Bot — Docker Deploy"
echo "================================"

# تأكد من وجود .env
if [ ! -f .env ]; then
  echo "❌ ملف .env غير موجود — انسخه أولاً"
  exit 1
fi

# بناء الصورة
echo "🔨 Building Docker image..."
docker compose build --no-cache

# تشغيل الخدمات
echo "🟢 Starting services..."
docker compose up -d

# انتظر حتى يكون الـ app جاهزاً
echo "⏳ Waiting for bot to be ready..."
timeout 60 bash -c 'until docker compose exec -T app wget -qO- http://localhost:3000/health 2>/dev/null; do sleep 2; done'

echo ""
echo "✅ تم النشر بنجاح!"
docker compose ps
echo ""
echo "📊 Logs: docker compose logs -f app"
echo "🔄 Restart: docker compose restart app"
echo "🛑 Stop:    docker compose down"
