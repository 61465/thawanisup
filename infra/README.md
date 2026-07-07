# Infrastructure — بنية تحتية للصيانة والتطوير

3 طبقات منفصلة، أي تعديل يمر `Lab → Staging → Production`.

```
Local Lab (port 3004) → VPS Staging (port 3004) → VPS Production (port 3003)
   بيانات وهمية         بيانات منفصلة             الإنتاج الحي
```

## المسارات

| الطبقة | المكان | كيف تصل لها |
|--------|--------|-------------|
| Lab | `infra/lab/` على جهازك | `./start-lab.ps1` → http://localhost:3004 |
| Staging | `/opt/bothatim-staging/` على VPS | `ssh ... curl localhost:3004` |
| Production | `/opt/bothatim/` على VPS | https://bothatim-vps.tail19ddab.ts.net |

## مفاتيح الـ Lab المحلي
- Master password: `lab12345`
- متاجر تجريبية: `lab_demo_store` (نشط), `lab_expired_store` (لاختبار الـ enforcer)
- بيانات وهمية فقط، لا تتصل بأي رقم واتساب حقيقي

## مفاتيح الـ Staging على VPS
- Master password: تجدها بـ `ssh ... 'grep MASTER_PASSWORD /opt/bothatim-staging/.env'`
- Firebase معطّل، Stripe معطّل، لا أرقام واتساب حقيقية → لا تلوث بيانات الإنتاج
- node_modules symlink للإنتاج (يوفر مساحة + نفس النسخ)

## السكربتات

كل السكربتات في `infra/scripts/` ويجب تشغيلها من PowerShell.

### تطوير يومي
```powershell
cd D:\project\mostqlworkwatssap\whatsapp-cafe-bot\whatsapp-cafe-bot\infra\scripts

# شغّل اللاب (يستخدم نفس src/public — يعكس تعديلاتك فوراً)
.\start-lab.ps1

# في terminal آخر — اختبر التعديلات على http://localhost:3004

# لما تخلص:
.\stop-lab.ps1
```

### نشر تحديث (Lab → Staging → Production)
```powershell
# 1) جرّب التعديلات في اللاب أولاً (راجع .\start-lab.ps1)

# 2) ارفع لـ staging
.\deploy-staging.ps1 src\store-router.js public\master.html

# 3) اختبر staging: ssh للـ VPS وافتح localhost:3004
ssh root@139.84.167.201 "curl -I http://localhost:3004/master.html"

# 4) لو OK: ارفع للإنتاج (backup + auto-rollback مدمج)
.\promote-prod.ps1 src\store-router.js public\master.html
```

### صيانة
```powershell
.\health-check.ps1            # افحص الطبقات الثلاث
.\health-check.ps1 prod       # الإنتاج فقط
.\backup-prod.ps1             # نسخة احتياطية يدوية كاملة
.\rollback.ps1                # رجوع لآخر pre-promote backup
.\sync-from-prod.ps1          # ⚠️  استبدل بيانات اللاب بنسخة من الإنتاج
```

## ضمانات الأمان في `promote-prod.ps1`

1. **يرفض البدء** لو staging مش شغّال (`/health` ≠ 200)
2. **يطلب تأكيد** قبل أي تعديل على الإنتاج
3. **يأخذ backup** للملفات المطروحة فقط (سريع، ثوانٍ)
4. **ينسخ من staging → prod** (نفس الملفات اللي اختُبرت)
5. **pm2 reload** (zero-downtime، لا تنقطع الجلسات)
6. **ينتظر /health** حتى 36 ثانية
7. **Auto-rollback** لو فشل /health — يرجع للملفات السابقة + reload

## كيف يعمل اللاب بدون نسخ كاملة

- `infra/lab/src` و `infra/lab/public` و `infra/lab/node_modules` = **NTFS junctions** للأصل
- أي تعديل تعمله على `src/server.js` يظهر فوراً في اللاب
- اللاب يستخدم **بيانات وهمية مستقلة** في `infra/lab/data/` + **port 3004**
- اللاب يستخدم **.env منفصل** بـ JWT_SECRET مختلف + Firebase معطّل

## للجلسات القادمة

- VPS IP: `139.84.167.201` (Tailscale name: `thawani`)
- SSH key: `~/.ssh/id_ed25519`
- PM2 processes:
  - `whatsapp-bot` (إنتاج، port 3003)
  - `whatsapp-bot-staging` (staging، port 3004)
  - `bot-monitor` (مراقبة، منفصل)
- لا تشغّل `pm2 restart` على الإنتاج — استخدم `pm2 reload`
- لا تنسخ بيانات الإنتاج للاب بدون `sync-from-prod.ps1` (يمسح session creds)
