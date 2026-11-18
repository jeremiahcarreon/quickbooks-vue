# QuickBooks Vue Relay

A thin Windows program that forwards qbXML requests from any application to QuickBooks Desktop through the QBSDK COM object (QBXMLRP2).

## Architecture

```
Your app (any language)  ──HTTP/JSON──►  This relay   ──COM──►  QuickBooks Desktop
                         ◄──────────────  (Windows)    ◄───────
```

The relay is a pipe. Building qbXML, parsing responses and mapping entities all happen in the calling app (in QuickBooks Vue, that is the `worker` service). The relay:

1. Accepts HTTP requests that carry qbXML.
2. Checks the caller (IP allowlist, API key) and the request size.
3. Optionally validates the qbXML against the Intuit XSD ([XSD validation](#xsd-validation)).
4. Passes the request to QuickBooks on one STA thread, one request at a time.
5. Returns QuickBooks' qbXML response.

The relay must run in an interactive Windows session. QBXMLRP2 cannot reach QuickBooks from Session 0, so `deploy.ps1` installs it as a startup program, not a Windows service. The relay must never be reachable from the internet; see [docs/ops/private-networking.md](../docs/ops/private-networking.md).

## Layout

| Path | What |
|---|---|
| `QuickBooksVueRelay/` | The Windows program: COM worker thread (`QbWorker.cs`), host (`Program.cs`, `RelayHostedService.cs`), `appsettings.json` |
| `QuickBooksVueRelay.Core/` | Code with no COM or Windows dependency: HTTP routing, auth, IP allowlist, XSD validation, HostQuery, options |
| `QuickBooksVueRelay.Tests/` | xunit tests for the Core library, runnable on Linux |
| `deploy.ps1` | Build and install on the QuickBooks machine |

## Prerequisites

- Windows 10/11 or Windows Server 2016+
- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) (to build)
- QuickBooks Enterprise Desktop installed
- QuickBooks SDK (usually installed with QB Enterprise)
- Optional, recommended: the qbXML 17.0 XSDs, for [XSD validation](#xsd-validation)

## Quick deploy

1. Copy the `server/` folder to the Windows machine running QuickBooks. If you have the XSDs, also copy them (see [XSD validation](#xsd-validation)).
2. Run PowerShell as Administrator:
   ```powershell
   cd server
   .\deploy.ps1                                   # or: .\deploy.ps1 -SchemaSource D:\qbxml-xsd\17.0
   ```
3. Edit `C:\Services\QuickBooksVueRelay\appsettings.json`:
   - `ApiKey`: a long random secret. Callers send it in the `X-Api-Key` header. Generate one with
     `[Convert]::ToBase64String((1..32 | % { Get-Random -Max 256 }))`, or `openssl rand -base64 32`.
   - `AllowedIPs`: the address or private range of the Docker host (for example its Tailscale IP or `100.64.0.0/10`).
   - `QbFilePath`: full path to the `.QBW` company file (used only when `AttachToOpenFile` is `false`).
4. Restart the relay: end the `QuickBooksVueRelay` process and start `C:\Services\QuickBooksVueRelay\QuickBooksVueRelay.exe`, or sign out and back in.
5. Open QuickBooks Desktop as an admin user. When prompted, authorize "QuickBooks Vue Relay" and choose **"Yes, always; allow access even if QuickBooks is not running"**. Pick the QuickBooks user the relay should log in as. Every SDK write is attributed to that user.
6. Check health:
   ```powershell
   Invoke-RestMethod http://localhost:9123/qb/health -Headers @{ 'X-Api-Key' = '<ApiKey>' }
   ```

Re-running `deploy.ps1` upgrades the binaries and keeps the existing `appsettings.json`. The full deployment, including the Docker side, is in [docs/ops/deployment.md](../docs/ops/deployment.md).

## API

Every route checks the IP allowlist (403) and then `X-Api-Key` (401) when `ApiKey` is set. Every response carries an `X-Request-Id` header. The relay uses the caller's `X-Request-Id` when it is 1–128 characters of `A-Z a-z 0-9 . _ : -`, and generates one otherwise. The id appears in every log line and in `qb-errors.log` for that request.

### `POST /qb/request`

Send a qbXML request to QuickBooks.

Headers: `X-Api-Key: <key>`, `Content-Type: application/json`, optionally `X-Request-Id: <id>`.

```json
{
  "qbxml": "<?xml version=\"1.0\"?><?qbxml version=\"16.0\"?><QBXML><QBXMLMsgsRq onError=\"stopOnError\"><CustomerQueryRq><MaxReturned>5</MaxReturned></CustomerQueryRq></QBXMLMsgsRq></QBXML>"
}
```

Success (`200`). QuickBooks' own status codes, such as 3200 or 3100, are in `response`. A 200 only means QuickBooks answered.

```json
{ "response": "<?xml version=\"1.0\" ?><QBXML>...<CustomerQueryRs statusCode=\"0\" ...>...</QBXML>", "error": null }
```

| Status | Meaning | Body |
|---|---|---|
| `400` | Missing `qbxml`, body is not JSON, or (`ValidateSchema=enforce`) the qbXML failed XSD validation. Nothing was sent to QuickBooks. | `{ "error": "...", "validationErrors": [{ "line", "column", "message" }] }` (`validationErrors` only for XSD failures) |
| `401` | Wrong or missing `X-Api-Key` | `{ "error": "Invalid API key" }` |
| `403` | Caller's IP is not in `AllowedIPs` | `{ "error": "IP not allowed" }` |
| `404` | Unknown route | `{ "error": "Not found. Routes: ..." }` |
| `413` | Body larger than `MaxRequestBodyBytes`. Nothing was sent. | `{ "error": "..." }` |
| `500` | `ValidateSchema=enforce` but the XSD could not be loaded (see `/qb/health` `validation.error`). Nothing was sent. | `{ "error": "..." }` |
| `502` | QuickBooks or COM raised an error for this request (including QuickBooks' own qbXML parse rejection) | `{ "error": "<COM message>" }` |
| `503` | The QuickBooks worker thread is not running (e.g. the SDK COM object is missing). The relay tries a restart at most every 15 s. Nothing was sent. | `{ "error": "..." }` |
| `504` | No answer from QuickBooks within `RequestTimeout` (usually a modal dialog on the QuickBooks machine). The worker thread is restarted. The request **may still have executed**. | `{ "error": "QB request timed out (120s) — worker restarted" }` |

### `GET /qb/health`

The first four fields are unchanged from earlier versions. The rest are additions.

```json
{
  "connected": true,
  "lastError": null,
  "lastRequestTime": "2026-11-17T12:00:00.0000000Z",
  "uptime": 3600.5,
  "version": "1.1.0",
  "workerRunning": true,
  "busy": false,
  "queueDepth": 0,
  "restarts": 0,
  "lastErrorTime": null,
  "qbxmlVersion": "16.0",
  "qb": {
    "productName": "QuickBooks Enterprise Solutions 24.0",
    "majorVersion": "34", "minorVersion": "0", "country": "US",
    "supportedQbxmlVersions": ["1.0", "...", "16.0"],
    "qbFileMode": "MultiUser", "isAutomaticLogin": true,
    "fetchedAt": "2026-11-17T11:00:00.0000000Z"
  },
  "validation": { "mode": "log", "schemaLoaded": true, "schemaFile": "QBUqbxmlops170.xsd", "error": null },
  "requests": { "total": 120, "succeeded": 118, "failed": 1, "timedOut": 0, "schemaInvalid": 1, "schemaRejected": 0, "tooLarge": 0, "unauthorized": 0 },
  "lastFailure": { "at": "...", "status": 502, "requestId": "…", "message": "…" },
  "limits": { "maxRequestBodyBytes": 16777216, "requestTimeoutSeconds": 120 }
}
```

- `queueDepth`: requests waiting behind the one QuickBooks is processing (`busy`).
- `qb` and `qbxmlVersion` come from a single `HostQuery` that the relay sends after each `BeginSession`. The result is cached for the session. They are `null` until it succeeds, or when `HostQueryOnConnect` is `false`.
- Counters reset when the relay restarts.

### `POST /qb/restart`

Restarts the COM worker thread (`{ "restarted": true }`). Requests still waiting in the queue fail with 502 and were not sent.

### `GET /qb/errors`

Plain-text tail (last 20 KB) of `qb-errors.log` in the install folder: COM errors, QuickBooks parse rejections, reconnects and restarts, each with the request id and the first 500 characters of the request.

## Configuration

`appsettings.json` in the install directory (default `C:\Services\QuickBooksVueRelay\appsettings.json`). Any key can also be set as an environment variable with a double underscore, e.g. `Relay__ValidateSchema=enforce`. Restart the relay after changing it.

| Key | Default | Notes |
|---|---|---|
| `Port` | `9123` | HTTP port. `deploy.ps1 -Port` registers the URL ACL for it. |
| `ApiKey` | (placeholder) | Required `X-Api-Key` value, compared in constant time. If empty, no key is required (a warning is logged). Any value starting `CHANGE-ME` also logs a warning. |
| `AllowedIPs` | `["127.0.0.1"]` | Addresses (`10.0.0.5`) or CIDR ranges (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). Loopback is always allowed. An empty list allows everyone, which is not recommended. Also accepts a comma-separated string (handy for env vars). |
| `QbFilePath` | | Company file. Used only when `AttachToOpenFile` is `false`. |
| `AttachToOpenFile` | `true` | `true`: attach to the file QuickBooks already has open, in its current mode (multi-user friendly). `false`: open `QbFilePath` (single-user, unattended machines). |
| `OpenMode` | `0` | BeginSession mode: 0 DoNotCare, 1 SingleUser, 2 MultiUser. Use `2` if attaching to a multi-user file fails with a mode mismatch. |
| `AppName` / `AppID` | `QuickBooks Vue Relay` / `QuickBooksVue` | Name shown in QuickBooks' Integrated Applications list. Changing it requires authorizing again. |
| `RequestTimeout` | `120` | Seconds to wait for QuickBooks before returning 504 and restarting the worker. Keep the caller's timeout above this (`RELAY_TIMEOUT_MS`, default 130000). |
| `MaxRequestBodyBytes` | `16777216` (16 MiB) | Larger bodies get 413 without being read. |
| `ValidateSchema` | `enforce` | `enforce`, `log` or `off`. See below. |
| `SchemaDir` | `schemas` | Folder with the XSDs. A relative path is resolved against the install folder. |
| `SchemaFile` | `QBUqbxmlops170.xsd` | Entry-point XSD inside `SchemaDir`. |
| `HostQueryOnConnect` | `true` | Send one HostQuery per session to fill `qb` / `qbxmlVersion` in health. |
| `HostQueryVersion` | `13.0` | qbXML version header of that HostQuery. |

## XSD validation

QuickBooks can drop the SDK session, or show a modal dialog that blocks every later request, when it gets qbXML it cannot parse. QuickBooks Vue validates every request against the Intuit XSD before it leaves the Docker host. The relay can check again at the last hop, which protects against any other client.

| `ValidateSchema` | Behaviour |
|---|---|
| `off` | Only checks that the XML is well-formed (as before). |
| `log` | Validates each request. Failures are logged as warnings with the request id and counted in `requests.schemaInvalid`, and the request is still sent. If the XSDs are missing, the relay logs this once and forwards requests unvalidated. |
| `enforce` (default) | Invalid requests get `400` with `validationErrors` (line, column, message) and never reach QuickBooks. If the XSDs are missing, every request gets `500` until they are installed (fail closed). |

The validator is .NET `System.Xml.Schema`. DTDs and external entities are refused, `xsd:include` can only resolve to files inside `SchemaDir`, and elements the schema does not declare are errors.

**The XSDs are not shipped.** They are Intuit-confidential (qbXML Developer Agreement) and are never committed to this repository. To enable validation:

1. Get the qbXML 17.0 schema files from the QuickBooks SDK or the copy used by the Docker host (`schemas/qbxml/17.0/` in the repository checkout). You need all four files: `QBUqbxmlops170.xsd`, `QBUqbxml170.xsd`, `QBUqbxmlso170.xsd` and `qbxmltypes170.xsd`.
2. Do one of the following:
   - Put them in `server\QuickBooksVueRelay\schemas\` before running `deploy.ps1`. The build copies them next to the exe. `server/.gitignore` keeps them out of git.
   - Run `deploy.ps1 -SchemaSource <folder>`. When the script runs from a full checkout that has `schemas\qbxml\17.0\`, it picks that folder up automatically.
   - Copy them to `C:\Services\QuickBooksVueRelay\schemas\` yourself, or set `SchemaDir` to their folder.
3. Restart the relay and check that `/qb/health` shows `"validation": { "schemaLoaded": true }`.

`enforce` is the default (in the shipped `appsettings.json`, and when the key is unset or not recognised), so the relay refuses invalid qbXML from any client, not only QuickBooks Vue. Besides the XSD, a request must carry exactly one `<?qbxml version="N.N"?>` instruction before `<QBXML>` with a version QuickBooks has shipped; the XSD cannot express that, and QuickBooks cannot parse a request without it. The HostQuery the relay sends on connect goes through the same check. Install the XSDs before starting the relay: in `enforce` mode without them every request gets `500`. `log` (validate, report, forward anyway) and `off` are explicit opt-outs, for example to diagnose a client while the XSDs are being installed.

## Building and testing without Windows

The relay targets `win-x64`, but it builds on Linux or macOS (`EnableWindowsTargeting`; COM is late-bound). The Core library and the tests are platform-neutral. With Docker:

```bash
# build the relay
docker run --rm -v "$PWD/server:/src" -w /src mcr.microsoft.com/dotnet/sdk:8.0 dotnet build QuickBooksVueRelay

# run the tests. Mounting the XSDs at /schemas (or setting QBXML_SCHEMA_DIR) enables
# the tests against the real schema; without them those tests are skipped.
docker run --rm -v "$PWD/server:/src" -v "$PWD/schemas/qbxml/17.0:/schemas:ro" -w /src \
  mcr.microsoft.com/dotnet/sdk:8.0 dotnet test QuickBooksVueRelay.Tests

# single-file Windows build, as deploy.ps1 does it
docker run --rm -v "$PWD/server:/src" -w /src mcr.microsoft.com/dotnet/sdk:8.0 \
  dotnet publish QuickBooksVueRelay -c Release -r win-x64 --self-contained -o /src/out /p:PublishSingleFile=true
```

(The container runs as root, so the `bin/` and `obj/` folders it creates are root-owned. Add `--user "$(id -u):$(id -g)" -e HOME=/tmp -e DOTNET_CLI_HOME=/tmp`, or `chown` afterwards.)

The tests cover XSD validation (a stand-in schema plus the real one when present), the validation modes, constant-time key comparison, the IP allowlist with CIDR, options parsing, request ids, the body-size limit, HostQuery building and parsing, the classification of request-level vs. session errors, and the HTTP routes end to end on a real `HttpListener` with a fake QuickBooks processor.

The COM path (`QbWorker`) can only be exercised on a Windows machine with QuickBooks. After an upgrade, check `/qb/health` and send one query; see [docs/ops/upgrade.md](../docs/ops/upgrade.md).

## Running it

```powershell
# Is it running?
Get-Process QuickBooksVueRelay

# Stop / start
Stop-Process -Name QuickBooksVueRelay
Start-Process C:\Services\QuickBooksVueRelay\QuickBooksVueRelay.exe -WorkingDirectory C:\Services\QuickBooksVueRelay -WindowStyle Minimized

# Logs: the console window, the Windows Application event log (warnings and above;
# source QuickBooksVueRelay or .NET Runtime), and qb-errors.log
Get-EventLog -LogName Application -Newest 50 | Where-Object Source -match 'QuickBooksVueRelay|\.NET Runtime'
Get-Content C:\Services\QuickBooksVueRelay\qb-errors.log -Tail 50

# Remove the legacy Windows service, if an old install created one
sc.exe delete QuickBooksVueRelay
```

`deploy.ps1` creates a shortcut in the user's Startup folder, so the relay starts at logon. For unattended restarts, enable automatic logon for that Windows user.

## Troubleshooting

See [docs/ops/troubleshooting.md](../docs/ops/troubleshooting.md) for modal dialogs, multi-user mode, 3200 conflicts and sync gaps. Quick checks:

- **`connected: false`**: look at `lastError` and `/qb/errors`. Check that the app is authorized in QuickBooks (Edit > Preferences > Integrated Applications > Company Preferences), and that, with `AttachToOpenFile=true`, QuickBooks has the company file open.
- **"QBXMLRP2 COM object not found" / 503 `worker is not running`**: QuickBooks Desktop or the SDK is not installed for this Windows user.
- **Relay won't start / no listener**: check the console window or Event Viewer. Make sure port 9123 is free (`netstat -an | findstr 9123`) and that the URL ACL exists (`netsh http show urlacl url=http://+:9123/`).
- **401 / 403**: the API key differs between the relay and `RELAY_API_KEY` on the Docker host, or the Docker host's address is not in `AllowedIPs`. Remember that with Tailscale or WireGuard, the address the relay sees is the tunnel address.
- **504 and a restart**: QuickBooks is showing a dialog. Someone has to dismiss it on the QuickBooks machine.
