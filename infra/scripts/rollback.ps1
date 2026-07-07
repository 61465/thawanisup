# rollback.ps1 — يرجّع الإنتاج لآخر backup من infra/backups/
# Usage: ./rollback.ps1 [backup-name.tar.gz]   (افتراضي: أحدث pre-promote-*)
. "$PSScriptRoot\_config.ps1"

# اختر الـ backup
if ($args.Count -gt 0) {
    $bkFile = Join-Path $BACKUPS_DIR $args[0]
} else {
    $latest = Get-ChildItem $BACKUPS_DIR -Filter "pre-promote-*.tar.gz" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) { Write-Err "لا يوجد pre-promote-* backups"; exit 1 }
    $bkFile = $latest.FullName
}

if (-not (Test-Path $bkFile)) { Write-Err "Backup غير موجود: $bkFile"; exit 1 }
$bkName = Split-Path $bkFile -Leaf

Write-Warn "ROLLBACK: سيُستبدل الإنتاج بـ $bkName"
Write-Info "محتوى الـ backup:"
& tar tzf $bkFile | ForEach-Object { Write-Info "  $_" }
$ans = Read-Host "متابعة؟ (y/N)"
if ($ans -ne "y") { Write-Info "إلغاء"; exit 0 }

# 1) ارفع الـ tar للـ VPS
$remoteTar = "/tmp/rollback-$(Get-Date -Format 'HHmmss').tar.gz"
Write-Step "رفع $bkName للـ VPS..."
& scp -o BatchMode=yes -o StrictHostKeyChecking=no -i $SSH_KEY $bkFile "${VPS_USER}@${VPS_IP}:$remoteTar" | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Err "فشل scp"; exit 1 }

# 2) safety backup من الإصدار الحالي قبل الـ rollback
$safetyName = "pre-rollback-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$safetyRemote = "/tmp/$safetyName.tar.gz"
$safetyLocal  = Join-Path $BACKUPS_DIR "$safetyName.tar.gz"
$files = & tar tzf $bkFile
$filesStr = ($files -join " ")
Write-Step "حفظ snapshot قبل الـ rollback ($safetyName)"
Invoke-VpsSsh "cd $VPS_PROD_DIR && tar czf $safetyRemote $filesStr 2>/dev/null"
& scp -o BatchMode=yes -o StrictHostKeyChecking=no -i $SSH_KEY "${VPS_USER}@${VPS_IP}:$safetyRemote" $safetyLocal | Out-Null
Invoke-VpsSsh "rm -f $safetyRemote" | Out-Null

# 3) extract + reload
Write-Step "استبدال الملفات + reload"
Invoke-VpsSsh "cd $VPS_PROD_DIR && tar xzf $remoteTar && pm2 reload $PROD_PM2_NAME --update-env 2>&1 | tail -3 && rm -f $remoteTar"

# 4) health check
Write-Step "تحقق /health..."
Start-Sleep -Seconds 6
$ok = $false
for ($i = 0; $i -lt 10; $i++) {
    if (Test-VpsHealth -RemoteUrl "http://localhost:$PROD_PORT/health") { $ok = $true; break }
    Start-Sleep -Seconds 3
}

if ($ok) {
    Write-Ok "Rollback نجح — Production شغّال"
    Write-Info "Safety snapshot: $safetyLocal"
} else {
    Write-Err "Production لا يرد — تدخل يدوي مطلوب"
    Write-Info "ssh ... 'pm2 logs $PROD_PM2_NAME --lines 50'"
    exit 1
}
