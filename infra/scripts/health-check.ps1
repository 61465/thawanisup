# health-check.ps1 — يفحص حالة الإنتاج والـ staging واللاب
# Usage: ./health-check.ps1 [prod|staging|lab|all]   (افتراضي: all)
. "$PSScriptRoot\_config.ps1"

$target = if ($args[0]) { $args[0] } else { "all" }

function Test-Target {
    param($Name, $RemoteCmd, $PM2Name)
    Write-Step "$Name"
    $code = Invoke-VpsSsh $RemoteCmd
    if ($code -eq "200") {
        Write-Ok "/health → 200"
    } else {
        Write-Err "/health → $code"
    }
    $line = Invoke-VpsSsh "pm2 list 2>/dev/null | grep -E '$PM2Name\s'"
    if ($line) { Write-Info $line.Trim() } else { Write-Warn "PM2 process not found: $PM2Name" }
    Write-Host ""
}

if ($target -in @("prod","all")) {
    Test-Target "Production (port $PROD_PORT)" "curl -sf -o /dev/null -w '%{http_code}' http://localhost:$PROD_PORT/health" $PROD_PM2_NAME
}

if ($target -in @("staging","all")) {
    Test-Target "Staging (port $STAGE_PORT)" "curl -sf -o /dev/null -w '%{http_code}' http://localhost:$STAGE_PORT/health" $STAGE_PM2_NAME
}

if ($target -in @("lab","all")) {
    Write-Step "Local Lab (port $LAB_PORT)"
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$LAB_PORT/health" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        Write-Ok "/health → $($resp.StatusCode)"
    } catch {
        Write-Warn "اللاب غير شغّال (شغّله بـ ./start-lab.ps1)"
    }
    Write-Host ""
}
