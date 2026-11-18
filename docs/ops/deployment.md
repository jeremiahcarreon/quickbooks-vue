# Deployment

A production install has two machines (they can be the same physical box if Windows runs Docker, but two is the normal shape):

- **Windows host**: QuickBooks Desktop Enterprise, the company file (or a connection to the machine hosting it), and the relay.
- **Docker host**: Linux with Docker Engine, running `postgres`, `redis`, `migrate` (one-shot), `api`, `worker`, `sync` and `web`.

They are joined by a private network ([private-networking.md](private-networking.md)). Users reach the web app through a TLS reverse proxy ([tls-reverse-proxy.md](tls-reverse-proxy.md)).

Do the steps in this order: Windows host, private network, Docker host, TLS, first sync.

## 1. Windows host

### 1.1 Machine and account

- Windows 10/11 Pro or Windows Server 2016+, always on. Turn off sleep and hibernation: `powercfg /change standby-timeout-ac 0` and `powercfg /hibernate off`.
- Create a **dedicated local Windows user** for the relay, e.g. `qbrelay`. The relay runs in that user's interactive session, because QBXMLRP2 cannot talk to QuickBooks from a Windows service (Session 0).
- Configure **automatic logon** for that user (`netplwiz`, or Sysinternals Autologon, which stores the password encrypted), so the session and the relay come back after a reboot. Lock the screen rather than signing out. Signing out ends the relay.
- Set Windows Update active hours, and schedule restarts outside business hours. After an unattended restart, auto-logon brings the relay back.

### 1.2 QuickBooks

- Install QuickBooks Desktop Enterprise and apply the latest release (Help > Update QuickBooks Desktop). The SDK runtime (QBXMLRP2) ships with QuickBooks. Install the QuickBooks SDK separately only if `deploy.ps1` reports that QBXMLRP2 is missing.
- In QuickBooks, create a QuickBooks user for integrations, e.g. `QB Vue`, with the roles it needs (usually full access to lists and transactions, plus sensitive accounting activities for reports). Every SDK write is attributed to this user inside QuickBooks. The app's `audit_log` records the real person.
- **Multi-user:** if people also use QuickBooks on other machines, host the company file with QuickBooks Database Server Manager and keep the relay's `AttachToOpenFile: true` (the default). The relay then attaches to whatever file QuickBooks has open on this machine, in that file's mode. See [troubleshooting.md](troubleshooting.md#multi-user-mode).
- Turn off what can pop up unattended: automatic update prompts, backup reminders ("Remind me" in the Backup options), and "What's new" tips. Any modal dialog blocks the SDK; see [troubleshooting.md](troubleshooting.md#quickbooks-modal-dialogs).

### 1.3 The relay

Follow [server/README.md](../../server/README.md#quick-deploy). In short:

1. Copy `server/` to the Windows host. To enable relay-side XSD validation, also bring the four qbXML 17.0 XSDs (from `schemas/qbxml/17.0/` on the Docker host or from the SDK). Never commit them anywhere.
2. Run `.\deploy.ps1 -SchemaSource <folder with the XSDs>` in an elevated PowerShell **while signed in as the relay user**. The startup shortcut goes into that user's Startup folder.
3. Edit `C:\Services\QuickBooksVueRelay\appsettings.json`:
   ```json
   {
     "Relay": {
       "Port": 9123,
       "ApiKey": "<long random secret, the same value as RELAY_API_KEY on the Docker host>",
       "AllowedIPs": ["<Docker host's private-network address, e.g. 100.101.102.103 or 10.88.0.2>"],
       "AttachToOpenFile": true,
       "ValidateSchema": "enforce"
     }
   }
   ```
4. Restart the relay. Open QuickBooks as an admin, sign in to the company file, and approve **QuickBooks Vue Relay**: "Yes, always; allow access even if QuickBooks is not running", logging in as the integration user. Check under Edit > Preferences > Integrated Applications > Company Preferences that it is listed and allowed to log in automatically.
5. Check it locally:
   ```powershell
   Invoke-RestMethod http://localhost:9123/qb/health -Headers @{ 'X-Api-Key' = '<ApiKey>' }
   ```
   Expect `connected: true`, `qb.productName` set, `qbxmlVersion` at least `16.0`, and `validation.schemaLoaded: true` if you installed the XSDs.

### 1.4 Firewall

Allow TCP 9123 inbound **only from the Docker host's private-network address**. [private-networking.md](private-networking.md#windows-firewall) has the exact rules. The relay speaks plain HTTP; the tunnel provides the encryption.

## 2. Private network

Set up Tailscale or WireGuard between the two hosts. Follow [private-networking.md](private-networking.md), then from the Docker host:

```bash
curl -s -H "X-Api-Key: $RELAY_API_KEY" http://<relay-private-address>:9123/qb/health | jq .
```

## 3. Docker host

### 3.1 Requirements

- Linux x86_64 with 2+ vCPU and 4 GB RAM (more for large company files: the read model stores every list and transaction as JSONB).
- Docker Engine 24+ with the Compose plugin **2.20 or newer** (the root `compose.yaml` uses `include:`). Check with `docker compose version`.
- Disk: Postgres grows to roughly 2–4x the size of the `.QBW` file. Keep room for backups.

### 3.2 Get the code and the XSDs

```bash
git clone <your repository URL> /opt/quickbooks-vue
cd /opt/quickbooks-vue
mkdir -p schemas/qbxml/17.0
# copy QBUqbxmlops170.xsd, QBUqbxml170.xsd, QBUqbxmlso170.xsd, qbxmltypes170.xsd here
ls schemas/qbxml/17.0
```

The images run code generation from the XSDs at build time and validate every qbXML request against them at run time. The build fails without them. They stay out of git (`.gitignore`), but they **are inside the built images**. Use a private registry, or none at all (build on the host).

### 3.3 Settings

Compose reads variables from the environment of the shell that runs `docker compose`, or from an env file that you create and maintain next to `compose.yaml`. Every variable is described in [configuration.md](../configuration.md). The ones that must be set for production:

| Variable                        | Value                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`             | Strong random password. Set it before the first start. Changing it later also requires `ALTER USER` inside Postgres. |
| `SESSION_SECRET`                | 32+ random characters (`openssl rand -base64 48`)                                                                    |
| `PUBLIC_URL`                    | `https://qb.example.com`, the URL users type                                                                         |
| `RELAY_URL`                     | `http://<relay-private-address>:9123`                                                                                |
| `RELAY_API_KEY`                 | The relay's `ApiKey`                                                                                                 |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First admin account, created on first start (password 12+ characters). Unset them after the first login.             |
| `WEB_BIND` / `WEB_PORT`         | Leave `127.0.0.1` / `8180` when the TLS proxy runs on the same host                                                  |

Leave `TRUST_PROXY` at `true` (the Compose default) and `COOKIE_SECURE` at `true`.

### 3.4 Start

```bash
cd /opt/quickbooks-vue
docker compose up -d --build
docker compose ps                     # migrate: exited (0); others: running/healthy
docker compose logs migrate           # migrations applied, roles seeded, admin created
docker compose logs -f worker sync    # relay health, initial sync progress
curl -s http://127.0.0.1:8180/api/health | jq .
```

`/api/health` reports the api, database, Redis and relay status. Do not add `compose.dev.yaml` in production: it publishes Postgres and Redis, replaces the relay with the mock, and turns secure cookies off.

## 4. TLS

Put Caddy or nginx in front of `127.0.0.1:8180`. See [tls-reverse-proxy.md](tls-reverse-proxy.md). Then sign in at `PUBLIC_URL` with the admin account and create the real users, roles and API tokens.

## 5. First sync

The `sync` service starts the initial load by itself: every entity with a query, using iterators with 500 records per page, at the lowest queue priority. Interactive writes still go first. Watch progress under Admin > Sync in the UI, or:

```bash
docker compose exec postgres psql -U qbv -d qbv -c \
  "select type, status, row_count, last_full_sync_at, error from sync_state order by type;"
```

A company file with a few hundred thousand transactions can take hours on the first load. QuickBooks processes one request at a time, and Desktop users share it. Run the first load outside business hours if you can.

## 6. After go-live

- Schedule backups ([backup-restore.md](backup-restore.md)) and test a restore.
- The relay ships with `ValidateSchema: "enforce"`: it refuses qbXML that fails the XSD or lacks a valid `<?qbxml version?>` instruction, whichever client sent it. It needs the XSDs in its `schemas` folder (every request gets `500` without them); `log` is an explicit opt-out.
- Monitor: `/api/health` (relay `connected`, queue), relay `/qb/health` `lastFailure` and `restarts`, the `command` table for `failed`/`conflict` rows, and `sync_state.error`.
- Record the QuickBooks version, relay version and app commit somewhere. [upgrade.md](upgrade.md) starts from them.
