#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Deploy the CCS QB Relay service to this Windows machine.

.DESCRIPTION
    Builds, installs, and starts the CCS QB Relay Windows Service.
    Run this script as Administrator on the machine running QuickBooks Desktop.

.PARAMETER InstallDir
    Target installation directory. Default: C:\Services\CcsQbRelay

.PARAMETER Port
    HTTP port for the relay. Default: 9123

.EXAMPLE
    .\deploy.ps1
    .\deploy.ps1 -InstallDir "D:\CcsQbRelay" -Port 9200
#>

param(
    [string]$InstallDir = "C:\Services\CcsQbRelay",
    [int]$Port = 9123
)

$ServiceName = "CcsQbRelay"
$ProjectDir = Join-Path $PSScriptRoot "CcsQbRelay"
$ErrorActionPreference = "Stop"

Write-Host "=== CCS QB Relay Deployment ===" -ForegroundColor Cyan
Write-Host ""

# Step 1: Check prerequisites
Write-Host "[1/7] Checking prerequisites..." -ForegroundColor Yellow

# Check .NET SDK
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Error ".NET SDK not found. Install .NET 8 SDK from https://dotnet.microsoft.com/download"
    exit 1
}
$sdkVersion = dotnet --version
Write-Host "  .NET SDK: $sdkVersion"

# Check QB SDK COM object
$qbxmlrp2 = Get-ItemProperty -Path "HKLM:\SOFTWARE\Classes\QBXMLRP2.RequestProcessor" -ErrorAction SilentlyContinue
if (-not $qbxmlrp2) {
    $qbxmlrp2 = Get-ItemProperty -Path "HKLM:\SOFTWARE\WOW6432Node\Classes\QBXMLRP2.RequestProcessor" -ErrorAction SilentlyContinue
}
if ($qbxmlrp2) {
    Write-Host "  QBXMLRP2 COM: Found"
} else {
    Write-Warning "  QBXMLRP2 COM not found. QuickBooks Desktop or QB SDK may not be installed."
    Write-Warning "  The relay will still build but won't connect to QB until the SDK is available."
}

# Step 2: Build
Write-Host ""
Write-Host "[2/7] Building project..." -ForegroundColor Yellow
$publishDir = Join-Path $ProjectDir "bin\publish"

dotnet publish $ProjectDir `
    -c Release `
    -r win-x64 `
    --self-contained `
    -o $publishDir `
    /p:PublishSingleFile=true

if ($LASTEXITCODE -ne 0) {
    Write-Error "Build failed."
    exit 1
}
Write-Host "  Build successful: $publishDir"

# Step 3: Stop existing service
Write-Host ""
Write-Host "[3/7] Stopping existing service (if running)..." -ForegroundColor Yellow
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
    if ($existingService.Status -eq "Running") {
        Stop-Service -Name $ServiceName -Force
        Start-Sleep -Seconds 2
        Write-Host "  Service stopped."
    } else {
        Write-Host "  Service exists but not running."
    }
} else {
    Write-Host "  No existing service found."
}

# Step 4: Copy files
Write-Host ""
Write-Host "[4/7] Copying files to $InstallDir..." -ForegroundColor Yellow
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# Copy published files
Copy-Item -Path "$publishDir\*" -Destination $InstallDir -Recurse -Force

# Copy appsettings.json if not already present (don't overwrite existing config)
$targetSettings = Join-Path $InstallDir "appsettings.json"
if (-not (Test-Path $targetSettings)) {
    $sourceSettings = Join-Path $ProjectDir "appsettings.json"
    Copy-Item -Path $sourceSettings -Destination $targetSettings
    Write-Host "  Copied default appsettings.json — EDIT THIS before starting the service!"
    Write-Host "  Set QbFilePath, ApiKey, and AllowedIPs in: $targetSettings" -ForegroundColor Red
} else {
    Write-Host "  appsettings.json already exists — preserved existing config."
}

Write-Host "  Files copied."

# Step 5: Register URL ACL (allow non-admin to bind to port)
Write-Host ""
Write-Host "[5/7] Registering URL ACL for port $Port..." -ForegroundColor Yellow
netsh http delete urlacl url="http://+:$Port/" >$null 2>&1
netsh http add urlacl url="http://+:$Port/" user=Everyone >$null 2>&1
Write-Host "  URL ACL registered."

# Step 6: Install/update Windows Service
Write-Host ""
Write-Host "[6/7] Installing Windows Service..." -ForegroundColor Yellow
$exePath = Join-Path $InstallDir "CcsQbRelay.exe"

if ($existingService) {
    # Update the binary path if it changed
    sc.exe config $ServiceName binPath= "`"$exePath`"" | Out-Null
    Write-Host "  Service binary path updated."
} else {
    sc.exe create $ServiceName binPath= "`"$exePath`"" start= auto displayname= "CCS QB Relay" | Out-Null
    sc.exe description $ServiceName "CCS ERP QuickBooks Desktop relay service — proxies qbXML requests from the ERP to QuickBooks via QBSDK" | Out-Null
    sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
    Write-Host "  Service installed with auto-start and auto-restart on failure."
}

# Step 7: Start service
Write-Host ""
Write-Host "[7/7] Starting service..." -ForegroundColor Yellow
Start-Service -Name $ServiceName
Start-Sleep -Seconds 3

$svc = Get-Service -Name $ServiceName
if ($svc.Status -eq "Running") {
    Write-Host "  Service is RUNNING." -ForegroundColor Green
} else {
    Write-Warning "  Service status: $($svc.Status). Check Event Viewer for errors."
}

# Health check
Write-Host ""
Write-Host "=== Deployment Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Health check:" -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri "http://localhost:$Port/qb/health" -TimeoutSec 5
    Write-Host "  Connected: $($health.connected)"
    if ($health.lastError) {
        Write-Host "  Last Error: $($health.lastError)" -ForegroundColor Yellow
    }
} catch {
    Write-Warning "  Health check failed: $($_.Exception.Message)"
    Write-Host "  The service may still be starting up. Try: Invoke-RestMethod http://localhost:$Port/qb/health"
}

Write-Host ""
Write-Host "NEXT STEPS:" -ForegroundColor Yellow
Write-Host "  1. Edit $targetSettings — set QbFilePath, ApiKey, AllowedIPs"
Write-Host "  2. Restart the service: Restart-Service $ServiceName"
Write-Host "  3. Open QuickBooks Desktop and approve the 'CCS ERP Relay' application"
Write-Host "     (Edit > Preferences > Integrated Applications > select 'Allow access even if QB is not running')"
Write-Host "  4. Test: Invoke-RestMethod http://localhost:${Port}/qb/health"
Write-Host ""
