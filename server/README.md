# QuickBooks Vue Relay

A thin Windows service that forwards qbXML requests from any application to QuickBooks Desktop via the QBSDK COM object.

## Architecture

```
Your app (any language)  ──HTTP/JSON──►  This service  ──COM──►  QuickBooks Desktop
                         ◄──────────────  (Windows)    ◄───────
```

The relay is a simple pipe. All business logic (building qbXML, parsing responses, entity mapping) lives in the calling app. This service just:

1. Accepts HTTP requests with qbXML payloads
2. Passes them to QuickBooks via the QBSDK COM object
3. Returns the qbXML response

## Prerequisites

- Windows 10/11 or Windows Server 2016+
- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
- QuickBooks Enterprise Desktop installed
- QuickBooks SDK (usually installed with QB Enterprise)

## Quick Deploy

1. Copy this `server/` folder to the Windows machine running QuickBooks
2. Edit `QuickBooksVueRelay/appsettings.json`:
   - `QbFilePath`: Full path to your `.QBW` company file
   - `ApiKey`: A strong secret key (the calling app sends it in the `X-Api-Key` header)
   - `AllowedIPs`: IP addresses allowed to connect (the machines that call the relay)
3. Run PowerShell as Administrator:
   ```powershell
   cd server
   .\deploy.ps1
   ```
4. Open QuickBooks Desktop
5. When prompted, approve "QuickBooks Vue Relay" with **"Allow access even if QuickBooks is not running"**
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

Edit `appsettings.json` in the install directory (default: `C:\Services\QuickBooksVueRelay\appsettings.json`):

```json
{
  "Relay": {
    "Port": 9123,
    "ApiKey": "your-strong-secret-key",
    "AllowedIPs": ["10.0.0.5", "192.168.1.100"],
    "QbFilePath": "C:\\QuickBooks\\MyCompany.QBW",
    "AppName": "QuickBooks Vue Relay",
    "AppID": "QuickBooksVue"
  }
}
```

After editing, restart the service:
```powershell
Restart-Service QuickBooksVueRelay
```

## Service Management

```powershell
# Check status
Get-Service QuickBooksVueRelay

# Start/stop/restart
Start-Service QuickBooksVueRelay
Stop-Service QuickBooksVueRelay
Restart-Service QuickBooksVueRelay

# View logs (Event Viewer → Windows Logs → Application, source: QuickBooksVueRelay)
Get-EventLog -LogName Application -Source "QuickBooksVueRelay" -Newest 20

# Uninstall
Stop-Service QuickBooksVueRelay
sc.exe delete QuickBooksVueRelay
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
- Try running the exe directly to see console output: `C:\Services\QuickBooksVueRelay\QuickBooksVueRelay.exe`

**"Access denied" from the calling app:**
- Verify the API key matches between the calling app and the relay's `appsettings.json`
- Verify the calling machine's IP is in the `AllowedIPs` list
