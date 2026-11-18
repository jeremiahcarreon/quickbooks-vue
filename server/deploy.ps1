#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Deploy the QuickBooks Vue Relay to this Windows machine.

.DESCRIPTION
    Builds and installs the QuickBooks Vue Relay as a startup application on the machine
    running QuickBooks Desktop. The relay runs in the interactive desktop session
    so it can access QuickBooks via the QBSDK COM object and Database Server Manager.

    NOTE: This does NOT install a Windows Service. QB's QBXMLRP2 COM object requires
    an interactive session - Windows Services run in Session 0 which cannot launch QB.

.PARAMETER InstallDir
    Target installation directory. Default: C:\Services\QuickBooksVueRelay

.PARAMETER Port
    HTTP port for the relay. Default: 9123

.EXAMPLE
    .\deploy.ps1
    .\deploy.ps1 -InstallDir "D:\QuickBooksVueRelay" -Port 9200
#>

param(
    [string]$InstallDir = "C:\Services\QuickBooksVueRelay",
    [int]$Port = 9123
)

$ProjectDir = Join-Path $PSScriptRoot "QuickBooksVueRelay"
$ErrorActionPreference = "Stop"

Write-Host "=== QuickBooks Vue Relay Deployment ===" -ForegroundColor Cyan
Write-Host ""

# Step 1: Check prerequisites
Write-Host "[1/6] Checking prerequisites..." -ForegroundColor Yellow

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
Write-Host "[2/6] Building project..." -ForegroundColor Yellow
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

# Step 3: Stop existing relay process (if running)
Write-Host ""
Write-Host "[3/6] Stopping existing relay (if running)..." -ForegroundColor Yellow
$existingProcess = Get-Process -Name "QuickBooksVueRelay" -ErrorAction SilentlyContinue
if ($existingProcess) {
    Stop-Process -Name "QuickBooksVueRelay" -Force
    Start-Sleep -Seconds 2
    Write-Host "  Relay process stopped."
} else {
    Write-Host "  No existing relay process found."
}

# Remove legacy Windows Service if it exists
$existingService = Get-Service -Name "QuickBooksVueRelay" -ErrorAction SilentlyContinue
if ($existingService) {
    if ($existingService.Status -eq "Running") {
        Stop-Service -Name "QuickBooksVueRelay" -Force
        Start-Sleep -Seconds 2
    }
    sc.exe delete "QuickBooksVueRelay" | Out-Null
    Write-Host "  Removed legacy Windows Service (no longer needed)."
}

# Step 4: Copy files
Write-Host ""
Write-Host "[4/6] Copying files to $InstallDir..." -ForegroundColor Yellow
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# Copy published files
Copy-Item -Path "$publishDir\*" -Destination $InstallDir -Recurse -Force

# Copy appsettings.json if not already present (don't overwrite existing config)
$targetSettings = Join-Path $InstallDir "appsettings.json"
if (-not (Test-Path $targetSettings)) {
    $sourceSettings = Join-Path $PSScriptRoot "appsettings.json"
    Copy-Item -Path $sourceSettings -Destination $targetSettings
    Write-Host "  Copied default appsettings.json - EDIT THIS before starting the relay!"
    Write-Host "  Set QbFilePath, ApiKey, and AllowedIPs in: $targetSettings" -ForegroundColor Red
} else {
    Write-Host "  appsettings.json already exists - preserved existing config."
}

Write-Host "  Files copied."

# Step 5: Register URL ACL (allow non-admin to bind to port)
Write-Host ""
Write-Host "[5/6] Registering URL ACL for port $Port..." -ForegroundColor Yellow
netsh http delete urlacl url="http://+:$Port/" >$null 2>&1
netsh http add urlacl url="http://+:$Port/" user=Everyone >$null 2>&1
Write-Host "  URL ACL registered."

# Step 6: Create startup shortcut
Write-Host ""
Write-Host "[6/6] Creating startup shortcut..." -ForegroundColor Yellow
$exePath = Join-Path $InstallDir "QuickBooksVueRelay.exe"
$startup = [Environment]::GetFolderPath("Startup")
$ws = New-Object -ComObject WScript.Shell
$shortcut = $ws.CreateShortcut("$startup\QuickBooksVueRelay.lnk")
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = $InstallDir
$shortcut.WindowStyle = 7  # minimized
$shortcut.Description = "QuickBooks Vue relay for QuickBooks Desktop"
$shortcut.Save()
Write-Host "  Startup shortcut created at: $startup\QuickBooksVueRelay.lnk"
Write-Host "  The relay will start automatically when this user logs in."

# Start the relay now
Write-Host ""
Write-Host "Starting relay..." -ForegroundColor Yellow
Start-Process -FilePath $exePath -WorkingDirectory $InstallDir -WindowStyle Minimized
Start-Sleep -Seconds 3

# Health check
Write-Host ""
Write-Host "=== Deployment Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Health check:" -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri "http://localhost:$Port/qb/health" -TimeoutSec 5
    Write-Host "  Connected: $($health.connected)" -ForegroundColor $(if ($health.connected) { "Green" } else { "Yellow" })
    if ($health.lastError) {
        Write-Host "  Last Error: $($health.lastError)" -ForegroundColor Yellow
    }
} catch {
    Write-Warning "  Health check failed: $($_.Exception.Message)"
    Write-Host "  The relay may still be starting up. Try: Invoke-RestMethod http://localhost:$Port/qb/health"
}

Write-Host ""
Write-Host "FIRST-TIME SETUP:" -ForegroundColor Yellow
Write-Host "  1. Edit $targetSettings - set QbFilePath, ApiKey, and AllowedIPs"
Write-Host "  2. Stop and restart the relay (kill the process, it will restart on next login)"
Write-Host "  3. Open QuickBooks Desktop and approve the 'QuickBooks Vue Relay' application"
Write-Host "     (Edit > Preferences > Integrated Applications > Company Preferences)"
Write-Host "     Check: 'Allow this application to log in automatically'"
Write-Host "     Check: 'Allow access even if QuickBooks is not running'"
Write-Host "  4. Close QuickBooks - the relay connects via DB Server Manager, QB doesn't need to be open"
Write-Host "  5. Test: Invoke-RestMethod http://localhost:${Port}/qb/health"
Write-Host ""
Write-Host "AUTO-START:" -ForegroundColor Yellow
Write-Host "  The relay starts automatically when this Windows user logs in."
Write-Host "  For unattended restarts, enable auto-login: run 'netplwiz' and uncheck"
Write-Host "  'Users must enter a user name and password to use this computer'."
Write-Host ""
