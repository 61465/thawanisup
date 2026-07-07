# promote-prod.ps1 — يرفع نفس الملفات من staging → production
# يأخذ backup أوتوماتيك قبل + يعمل rollback أوتوماتيك لو /health فشل
# Usage: ./promote-prod.ps1 [-Yes] src/file1.js public/file2.html ...
#        -Yes  لتخطي تأكيد المستخدم (للاستخدام في scripts/CI)
. "$PSScriptRoot\_config.ps1"

# اعزل -Yes عن قائمة الملفات
$autoYes = $false
$files = @()
foreach ($a in $args) {
    if ($a -eq "-Yes" -or $a -eq "-y") { $autoYes = $true }
    else { $files += $a }
}
$args = $files

if ($args.Count -eq 0) {
    Write-Err "حدد ملفات للترقية (نفس اللي رفعتها للـ staging)"
    Write-Info "مثال: ./promote-prod.ps1 src/store-router.js public/master.html"
    Write-Info "       ./promote-prod.ps1 -Yes src/server.js  (بدون تأكيد)"
    exit 1
}

# 1) تأكد staging يعمل (لا ترقّي من staging مكسور)
Write-Step "تحقق staging شغّال على port $STAGE_PORT"
if (-not (Test-VpsHealth -RemoteUrl "http://localhost:$STAGE_PORT/health")) {
    Write-Err "staging مش شغّال — اختبر السكربت أولاً عبر ./deploy-staging.ps1"
    exit 1
}
Write-Ok "staging سليم"

# 2) تأكيد المستخدم
Write-Warn "هذا ينشر للإنتاج المباشر ($PROD_PORT)"
if ($autoYes) {
    Write-Info "تخطي التأكيد (-Yes)"
} else {
    $ans = Read-Host "متابعة؟ (y/N)"
    if ($ans -ne "y") { Write-Info "إلغاء"; exit 0 }
}

# 3) backup قبل الترقية — فقط للملفات الموجودة بالفعل (الملفات الجديدة لا تحتاج backup)
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$bkName = "pre-promote-$stamp"
$remoteBk = "/tmp/$bkName.tar.gz"
# تأكد كل المسارات للملفات بـ forward-slash لـ tar على Linux
$normFiles = $args | ForEach-Object { $_ -replace '\\', '/' }

# افحص أي ملفات موجودة على prod (للـ backup) وأيها جديدة (تُسجّل فقط)
Write-Step "فحص الملفات على الإنتاج..."
$existingFiles = @()
$newFiles      = @()
foreach ($f in $normFiles) {
    $check = Invoke-VpsSsh "test -f $VPS_PROD_DIR/$f && echo EXISTS || echo NEW"
    if ($check -match "EXISTS") { $existingFiles += $f } else { $newFiles += $f }
}
if ($newFiles.Count -gt 0) {
    Write-Info "ملفات جديدة (لا backup لها): $($newFiles -join ', ')"
}

if ($existingFiles.Count -gt 0) {
    Write-Step "backup للملفات الموجودة: $bkName"
    $bkFilesArg = $existingFiles -join " "
    Invoke-VpsSsh "cd $VPS_PROD_DIR && tar czf $remoteBk $bkFilesArg && ls -lh $remoteBk"
    if ($LASTEXITCODE -ne 0) { Write-Err "فشل backup — إلغاء"; exit 1 }
    # اسحب الـ backup محلياً
    $bkLocal = Join-Path $BACKUPS_DIR "$bkName.tar.gz"
    & scp -o BatchMode=yes -o StrictHostKeyChecking=no -i $SSH_KEY "${VPS_USER}@${VPS_IP}:$remoteBk" $bkLocal | Out-Null
    Write-Ok "backup محلي: $bkLocal"
} else {
    Write-Info "كل الملفات جديدة — لا backup مطلوب"
    $bkLocal = $null
}

$filesArg = $normFiles -join " "

# 4) انسخ الملفات من staging → prod (atomic-style: tar + extract)
Write-Step "نسخ الملفات من staging → production"
$copyCmd = "cd $VPS_STAGE_DIR && tar czf - $filesArg | (cd $VPS_PROD_DIR && tar xzf -)"
Invoke-VpsSsh $copyCmd
if ($LASTEXITCODE -ne 0) { Write-Err "فشل النسخ"; exit 1 }
Write-Ok "تم النسخ"

# 5) pm2 reload (zero-downtime)
Write-Step "pm2 reload $PROD_PM2_NAME"
Invoke-VpsSsh "pm2 reload $PROD_PM2_NAME --update-env 2>&1 | tail -5"

# 6) health check + auto-rollback
Write-Step "انتظار /health على prod (auto-rollback لو فشل)..."
$ok = $false
for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Seconds 3
    if (Test-VpsHealth -RemoteUrl "http://localhost:$PROD_PORT/health") { $ok = $true; break }
    Write-Info "محاولة $($i+1)/12..."
}

if ($ok) {
    Write-Ok "Production شغّال على :$PROD_PORT"
    if ($bkLocal) {
        Invoke-VpsSsh "rm -f $remoteBk" | Out-Null
        Write-Info "backup الإنتاج موجود محلياً: $bkLocal (احتفظ به 7 أيام لأي rollback يدوي)"
    }
} else {
    Write-Err "Production فشل /health — جاري الـ ROLLBACK التلقائي"
    if ($bkLocal) {
        # rollback الملفات الموجودة سابقاً
        Invoke-VpsSsh "cd $VPS_PROD_DIR && tar xzf $remoteBk && pm2 reload $PROD_PM2_NAME --update-env"
    }
    # احذف الملفات الجديدة (لو فُشل الـ deploy ولا backup لها)
    foreach ($nf in $newFiles) {
        Invoke-VpsSsh "rm -f $VPS_PROD_DIR/$nf" | Out-Null
    }
    if ($newFiles.Count -gt 0) {
        Invoke-VpsSsh "pm2 reload $PROD_PM2_NAME --update-env 2>&1 | tail -3"
    }
    Start-Sleep -Seconds 8
    if (Test-VpsHealth -RemoteUrl "http://localhost:$PROD_PORT/health") {
        Write-Ok "rollback نجح — الإنتاج رجع للإصدار السابق"
    } else {
        Write-Err "rollback فشل أيضاً — تدخّل يدوي مطلوب!"
        Write-Info "ssh ... 'pm2 logs $PROD_PM2_NAME --lines 50'"
    }
    exit 1
}
