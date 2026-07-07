# deploy-staging.ps1 — ينشر ملفات محددة إلى staging على VPS
# Usage: ./deploy-staging.ps1 src/file1.js public/file2.html ...
. "$PSScriptRoot\_config.ps1"

if ($args.Count -eq 0) {
    Write-Err "حدد ملفات للنشر. مثال: ./deploy-staging.ps1 src/store-router.js public/master.html"
    exit 1
}

# 1) syntax check للملفات .js
$jsFiles = $args | Where-Object { $_ -like "*.js" }
foreach ($f in $jsFiles) {
    $full = Join-Path $ROOT_DIR $f
    if (-not (Test-Path $full)) { Write-Err "ملف غير موجود: $f"; exit 1 }
    Write-Step "syntax check: $f"
    $null = & node --check $full 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Err "syntax error في $f"; exit 1 }
}
Write-Ok "كل الملفات syntax OK"

# 2) رفع للـ staging — استخدم tar محلي (Win10+) + pipe لـ ssh مباشرة
Push-Location $ROOT_DIR
try {
    Write-Step "رفع $($args.Count) ملف للـ staging ($VPS_STAGE_DIR)"
    $tmpTar = Join-Path $env:TEMP "deploy-stage-$(Get-Random).tar.gz"
    & tar czf $tmpTar @args
    if ($LASTEXITCODE -ne 0) { Write-Err "فشل إنشاء tar"; exit 1 }

    # ارفع وفك على VPS
    Get-Content $tmpTar -Raw -AsByteStream | & ssh -o BatchMode=yes -o StrictHostKeyChecking=no -i $SSH_KEY "$VPS_USER@$VPS_IP" "cd $VPS_STAGE_DIR && tar xzf - && echo files-applied"
    $sshExit = $LASTEXITCODE
    Remove-Item $tmpTar -Force -ErrorAction SilentlyContinue
    if ($sshExit -ne 0) { Write-Err "فشل رفع الملفات (ssh exit=$sshExit)"; exit 1 }
    Write-Ok "تم الرفع"
} finally {
    Pop-Location
}

# 3) reload staging
Write-Step "pm2 reload $STAGE_PM2_NAME"
Invoke-VpsSsh "pm2 reload $STAGE_PM2_NAME --update-env 2>&1 | tail -5"
if ($LASTEXITCODE -ne 0) { Write-Err "فشل reload"; exit 1 }

# 4) health check (ينتظر حتى 30 ثانية)
Write-Step "انتظار /health على staging..."
$ok = $false
for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 3
    if (Test-VpsHealth -RemoteUrl "http://localhost:$STAGE_PORT/health") { $ok = $true; break }
    Write-Info "محاولة $($i+1)/10..."
}

if ($ok) {
    Write-Ok "Staging شغّال على :$STAGE_PORT"
    Write-Info "اختبر من VPS: ssh ... 'curl localhost:$STAGE_PORT/master.html | head'"
    Write-Info "إذا OK: ./promote-prod.ps1 لرفعه للإنتاج"
} else {
    Write-Err "Staging لا يرد على /health — تحقق من اللوج:"
    Write-Info "ssh ... 'pm2 logs $STAGE_PM2_NAME --lines 30 --nostream'"
    exit 1
}
