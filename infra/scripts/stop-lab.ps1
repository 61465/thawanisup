# stop-lab.ps1 — يوقف اللاب المحلي
. "$PSScriptRoot\_config.ps1"

$conn = Get-NetTCPConnection -LocalPort $LAB_PORT -ErrorAction SilentlyContinue
if (-not $conn) { Write-Info "اللاب ليس قيد التشغيل"; exit 0 }

$procId = $conn[0].OwningProcess
$proc   = Get-Process -Id $procId -ErrorAction SilentlyContinue
Write-Step "إيقاف اللاب (PID=$procId, name=$($proc.Name))"
Stop-Process -Id $procId -Force
Start-Sleep -Seconds 1
Write-Ok "اللاب توقف"
