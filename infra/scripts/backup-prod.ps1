# backup-prod.ps1 — نسخة احتياطية كاملة من الإنتاج
# يأخذ: data/* + ملفات السورس الحالية. لا يأخذ node_modules.
. "$PSScriptRoot\_config.ps1"

$stamp   = Get-Date -Format "yyyyMMdd-HHmmss"
$bkName  = "prod-backup-$stamp"
$bkLocal = Join-Path $BACKUPS_DIR "$bkName.tar.gz"

Write-Step "نسخة احتياطية من VPS — $bkName"
Write-Info "هذا يأخذ: data/* + src/ + public/ + package.json + .env (sensitive!)"

# تأكد من الاتصال
$pong = Invoke-VpsSsh "echo pong"
if ($pong -ne "pong") { Write-Err "فشل SSH للـ VPS"; exit 1 }

# اصنع الـ tar على VPS ثم اسحبه (أسرع من scp -r)
$remoteTar = "/tmp/$bkName.tar.gz"
Write-Info "creating tar on VPS..."
Invoke-VpsSsh "cd $VPS_PROD_DIR && tar czf $remoteTar --exclude='node_modules' --exclude='*.log' --exclude='data/sessions/*/store_*/auth_info*' data src public package.json package-lock.json .env 2>/dev/null && ls -lh $remoteTar"
if ($LASTEXITCODE -ne 0) { Write-Err "فشل إنشاء tar على VPS"; exit 1 }

Write-Info "downloading..."
& scp -o BatchMode=yes -o StrictHostKeyChecking=no -i $SSH_KEY "${VPS_USER}@${VPS_IP}:$remoteTar" $bkLocal
if ($LASTEXITCODE -ne 0) { Write-Err "فشل scp"; exit 1 }

# نظف ملف tar من VPS
Invoke-VpsSsh "rm -f $remoteTar" | Out-Null

$size = (Get-Item $bkLocal).Length / 1MB
Write-Ok "Backup → $bkLocal ($([math]::Round($size, 2)) MB)"

# نظف backups أقدم من 30 يوم
$old = Get-ChildItem $BACKUPS_DIR -Filter "prod-backup-*.tar.gz" | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) }
if ($old) {
    Write-Info "حذف $($old.Count) نسخة احتياطية أقدم من 30 يوم"
    $old | Remove-Item -Force
}

Write-Ok "تمت العملية"
