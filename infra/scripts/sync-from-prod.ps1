# sync-from-prod.ps1 — يجلب بيانات الإنتاج للاب لاختبار scenario حقيقي
# ⚠️  يحذف بيانات اللاب الحالية + يلغي WhatsApp sessions (لا يتصل بأرقام حقيقية)
. "$PSScriptRoot\_config.ps1"

Write-Warn "هذا يحذف بيانات اللاب الحالية ويستبدلها بنسخة من الإنتاج"
Write-Info "أرقام الواتساب لن تتصل (sessions ستُمسح)"
$ans = Read-Host "متابعة؟ (y/N)"
if ($ans -ne "y") { Write-Info "إلغاء"; exit 0 }

# 1) backup للبيانات الحالية في اللاب
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$labBackup = Join-Path $BACKUPS_DIR "lab-data-pre-sync-$stamp.tar.gz"
Write-Step "backup بيانات اللاب الحالية: $labBackup"
Push-Location $LAB_DIR
try {
    if (Test-Path "data") { & tar czf $labBackup data 2>$null }
} finally { Pop-Location }
Write-Ok "تم الـ backup"

# 2) اجلب data/* من الإنتاج (بدون sessions الفعلية)
$remoteTar = "/tmp/prod-data-$stamp.tar.gz"
Write-Step "تحميل data/ من الإنتاج (بدون auth_info)..."
Invoke-VpsSsh "cd $VPS_PROD_DIR && tar czf $remoteTar --exclude='data/sessions/*/auth_info*' --exclude='data/sessions/*/store_*/auth_info*' --exclude='*.log' data"
$tarLocal = Join-Path $env:TEMP "prod-data-$stamp.tar.gz"
& scp -o BatchMode=yes -o StrictHostKeyChecking=no -i $SSH_KEY "${VPS_USER}@${VPS_IP}:$remoteTar" $tarLocal
Invoke-VpsSsh "rm -f $remoteTar" | Out-Null

# 3) امسح بيانات اللاب القديمة واستبدل
Write-Step "استبدال بيانات اللاب"
Remove-Item "$LAB_DIR\data" -Recurse -Force -ErrorAction SilentlyContinue
Push-Location $LAB_DIR
try { & tar xzf $tarLocal } finally { Pop-Location }
Remove-Item $tarLocal -Force

# 4) امسح أي WhatsApp creds متبقية (احتياط إضافي)
Get-ChildItem "$LAB_DIR\data\sessions" -Recurse -Filter "auth_info*" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem "$LAB_DIR\data\sessions" -Recurse -Filter "creds.json" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

# 5) عدّل stores.json — اقطع subscriptionNextPayment للمستقبل البعيد عشان enforcer لا يطفي كل شيء
$storesPath = "$LAB_DIR\data\stores.json"
if (Test-Path $storesPath) {
    $data = Get-Content $storesPath -Raw | ConvertFrom-Json
    foreach ($s in $data.stores) {
        $s.subscriptionNextPayment = "2099-12-31"
        # امسح tokens/credentials حساسة
        if ($s.PSObject.Properties.Match("token").Count) { $s.token = "" }
        if ($s.PSObject.Properties.Match("verifyToken").Count) { $s.verifyToken = "" }
    }
    $data | ConvertTo-Json -Depth 20 | Set-Content $storesPath -Encoding UTF8
    Write-Info "subscriptionNextPayment → 2099-12-31 لكل المتاجر، tokens مُمسحة"
}

Write-Ok "اللاب الآن يحتوي نسخة آمنة من بيانات الإنتاج"
Write-Info "شغّل اللاب: ./start-lab.ps1"
Write-Info "للرجوع للبيانات الوهمية: استعد من $labBackup"
