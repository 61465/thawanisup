# ═══════════════════════════════════════════════════════════════════════════
# Shared config لكل سكربتات infra — لا تشغّل هذا الملف وحده
# ═══════════════════════════════════════════════════════════════════════════

# المسارات الجذرية
$Script:ROOT_DIR     = (Resolve-Path "$PSScriptRoot\..\..").Path
$Script:INFRA_DIR    = (Resolve-Path "$PSScriptRoot\..").Path
$Script:LAB_DIR      = Join-Path $INFRA_DIR "lab"
$Script:BACKUPS_DIR  = Join-Path $INFRA_DIR "backups"

# VPS
$Script:VPS_IP       = "139.84.167.201"
$Script:VPS_USER     = "root"
$Script:SSH_KEY      = "$env:USERPROFILE\.ssh\id_ed25519"
$Script:VPS_PROD_DIR = "/opt/bothatim"
$Script:VPS_STAGE_DIR = "/opt/bothatim-staging"
$Script:PROD_PM2_NAME = "whatsapp-bot"
$Script:STAGE_PM2_NAME = "whatsapp-bot-staging"
$Script:PROD_PORT    = 3003
$Script:STAGE_PORT   = 3004

# Tailscale URLs (للـ health check خارجياً — اختياري)
$Script:PROD_URL     = "https://bothatim-vps.tail19ddab.ts.net"
# اللاب
$Script:LAB_PORT     = 3004
$Script:LAB_URL      = "http://localhost:3004"

# ─── Helpers ────────────────────────────────────────────────────────────────
function Invoke-VpsSsh {
    param([string]$Command, [int]$TimeoutSec = 30)
    & ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=$TimeoutSec `
        -i $SSH_KEY "$VPS_USER@$VPS_IP" $Command
}

function Test-VpsHealth {
    param([string]$RemoteUrl = "http://localhost:$PROD_PORT/health")
    $r = Invoke-VpsSsh "curl -sf -o /dev/null -w '%{http_code}' $RemoteUrl 2>/dev/null"
    return ($r -eq "200")
}

function Write-Step  { param($Msg) Write-Host "▶ $Msg" -ForegroundColor Cyan }
function Write-Ok    { param($Msg) Write-Host "✅ $Msg" -ForegroundColor Green }
function Write-Warn  { param($Msg) Write-Host "⚠️  $Msg" -ForegroundColor Yellow }
function Write-Err   { param($Msg) Write-Host "❌ $Msg" -ForegroundColor Red }
function Write-Info  { param($Msg) Write-Host "   $Msg" -ForegroundColor Gray }

# تأكد المجلد موجود
function Ensure-Dir { param($Path) if (-not (Test-Path $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null } }

Ensure-Dir $BACKUPS_DIR
