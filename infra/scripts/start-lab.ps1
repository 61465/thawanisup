# start-lab.ps1 — يشغّل اللاب المحلي على port 3004 (يفصل عن أي إنتاج)
. "$PSScriptRoot\_config.ps1"

Write-Step "بدء اللاب المحلي على port $LAB_PORT"

if (-not (Test-Path "$LAB_DIR\.env"))     { Write-Err ".env مفقود في اللاب"; exit 1 }
if (-not (Test-Path "$LAB_DIR\src\server.js")) { Write-Err "junction src مكسور"; exit 1 }

# تحقق إذا هناك عملية على نفس البورت
$inUse = Get-NetTCPConnection -LocalPort $LAB_PORT -ErrorAction SilentlyContinue
if ($inUse) {
    Write-Warn "Port $LAB_PORT مستخدم بالفعل (PID: $($inUse[0].OwningProcess))"
    $ans = Read-Host "هل تريد إنهاء العملية وإعادة التشغيل؟ (y/N)"
    if ($ans -eq "y") {
        Stop-Process -Id $inUse[0].OwningProcess -Force
        Start-Sleep -Seconds 2
        Write-Ok "تم إنهاء العملية القديمة"
    } else { Write-Info "إلغاء"; exit 0 }
}

Push-Location $LAB_DIR
try {
    Write-Info "PORT=$LAB_PORT — http://localhost:$LAB_PORT/master.html"
    Write-Info "Master password: lab12345 (من .env)"
    Write-Info "اضغط Ctrl+C لإيقاف اللاب"
    Write-Host ""
    # حمّل env vars من .env قبل تشغيل node
    Get-Content "$LAB_DIR\.env" | Where-Object { $_ -match "^[A-Z_]+=" } | ForEach-Object {
        $kv = $_ -split "=", 2
        [System.Environment]::SetEnvironmentVariable($kv[0], $kv[1], "Process")
    }
    node src\server.js
} finally {
    Pop-Location
}
