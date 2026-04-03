# CCS QB Relay

A thin Windows Service that proxies qbXML requests from the CCS ERP to QuickBooks Enterprise Desktop via the QBSDK COM object.

## Architecture

```
CCS ERP (Laravel)  ──HTTP/JSON──►  This Service  ──COM──►  QuickBooks Desktop
                   ◄──────────────  (Windows)    ◄───────  Enterprise
```

The relay is a simple pipe. All business logic (building qbXML, parsing responses, entity mapping) lives in the Laravel app. This service just:

1. Accepts HTTP requests with qbXML payloads
2. Passes them to QuickBooks via the QBSDK COM object
3. Returns the qbXML response

## Prerequisites

- Windows 10/11 or Windows Server 2016+
- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
- QuickBooks Enterprise Desktop installed
- QuickBooks SDK (usually installed with QB Enterprise)

## Quick Deploy

1. Copy this `relay/` folder to the Windows machine running QuickBooks
2. Edit `CcsQbRelay/appsettings.json`:
   - `QbFilePath`: Full path to your `.QBW` company file
   - `ApiKey`: A strong secret key (shared with the Laravel app)
   - `AllowedIPs`: IP addresses allowed to connect (your ERP server)
3. Run PowerShell as Administrator:
   ```powershell
   cd relay
   .\deploy.ps1
   ```
4. Open QuickBooks Desktop
5. When prompted, approve "CCS ERP Relay" with **"Allow access even if QuickBooks is not running"**
6. Test the health endpoint:
   ```powershell
   Invoke-RestMethod http://localhost:9123/qb/health
   ```

## API Endpoints

### `GET /qb/health`

Returns the connection status.

```json
{
  "connected": true,
  "lastError": null,
  "lastRequestTime": "2026-04-03T12:00:00Z",
  "uptime": 3600.5
}
```

### `POST /qb/request`

Send a qbXML request to QuickBooks.

**Headers:**
- `X-Api-Key: your-secret-key`
- `Content-Type: application/json`

**Request body:**
```json
{
  "qbxml": "<?xml version=\"1.0\"?><?qbxml version=\"16.0\"?><QBXML><QBXMLMsgsRq onError=\"stopOnError\"><CustomerQueryRq><MaxReturned>5</MaxReturned></CustomerQueryRq></QBXMLMsgsRq></QBXML>"
}
```

**Response:**
```json
{
  "response": "<?xml version=\"1.0\"?>...<CustomerQueryRs statusCode=\"0\" statusMessage=\"Status OK\">...</CustomerQueryRs>...",
  "error": null
}
```

**Error responses:**
- `401` — Invalid API key
- `403` — IP not in allowlist
- `502` — QB request failed (COM error)
- `503` — QB not connected
- `504` — QB request timed out (30s limit)

## Configuration

Edit `appsettings.json` in the install directory (default: `C:\Services\CcsQbRelay\appsettings.json`):

```json
{
  "Relay": {
    "Port": 9123,
    "ApiKey": "your-strong-secret-key",
    "AllowedIPs": ["10.0.0.5", "192.168.1.100"],
    "QbFilePath": "C:\\QuickBooks\\MyCompany.QBW",
    "AppName": "CCS ERP Relay",
    "AppID": "CCSRelay"
  }
}
```

After editing, restart the service:
```powershell
Restart-Service CcsQbRelay
```

## Service Management

```powershell
# Check status
Get-Service CcsQbRelay

# Start/stop/restart
Start-Service CcsQbRelay
Stop-Service CcsQbRelay
Restart-Service CcsQbRelay

# View logs (Event Viewer → Windows Logs → Application, source: CcsQbRelay)
Get-EventLog -LogName Application -Source "CcsQbRelay" -Newest 20

# Uninstall
Stop-Service CcsQbRelay
sc.exe delete CcsQbRelay
```

## Troubleshooting

**"QB not connected" on health check:**
- Verify `QbFilePath` in appsettings.json points to the correct `.QBW` file
- Ensure QuickBooks Database Server Manager service is running
- On first run, QB Desktop must be open to approve the app authorization

**"QBXMLRP2 COM object not found":**
- QuickBooks Desktop or the QB SDK is not installed on this machine
- Try reinstalling QuickBooks or installing the QB SDK separately

**Service won't start:**
- Check Event Viewer for error details
- Ensure port 9123 is not in use: `netstat -an | findstr 9123`
- Try running the exe directly to see console output: `C:\Services\CcsQbRelay\CcsQbRelay.exe`

**"Access denied" from Laravel:**
- Verify the API key matches between Laravel's `.env` and the relay's `appsettings.json`
- Verify the ERP server's IP is in the `AllowedIPs` list
