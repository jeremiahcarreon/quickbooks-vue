# Private networking: Docker host ⇄ relay

The relay is a plain-HTTP service guarded by an IP allowlist and an API key. That is enough **inside** a private, encrypted network, and not enough anywhere else. Rules:

1. **The relay is never internet-facing.** No router port-forward, no cloud load balancer, no public DNS name, no "temporary" exposure.
2. Only the Docker host (the `worker`, and the `api` for health) talks to it.
3. Three layers, all required: tunnel ACL (who can route to 9123), Windows Firewall (who can connect to 9123), and the relay's `AllowedIPs` plus `ApiKey` (who is served).
4. The relay's HTTP traffic is cleartext. The tunnel (WireGuard or Tailscale, which uses WireGuard) encrypts it.

Pick one option:

|                | Tailscale                                               | WireGuard                                                      | Same LAN / site-to-site VPN |
| -------------- | ------------------------------------------------------- | -------------------------------------------------------------- | --------------------------- |
| Setup          | Minutes; NAT traversal built in                         | Manual keys and endpoints; one side needs a reachable UDP port | Nothing new                 |
| Access control | Tailnet ACL policy, by tag                              | `AllowedIPs` + firewall                                        | VLAN/firewall               |
| Third party    | Tailscale coordination server (data stays peer-to-peer) | None                                                           | None                        |
| Good for       | Most installs, roaming hosts, cloud Docker host         | Self-hosted purists; both hosts on fixed networks              | Both machines in one office |

## Option A: Tailscale

### Install

- **Windows host:** install Tailscale for Windows. Sign in with an admin-controlled account. In the admin console, open the machine's menu and choose **Disable key expiry**, so the relay link does not lapse. Set **Run unattended** (Tailscale tray > Preferences) so the tunnel is up before anyone signs in.
- **Docker host:**
  ```bash
  curl -fsSL https://tailscale.com/install.sh | sh
  sudo tailscale up --advertise-tags=tag:qbv-app --ssh=false
  ```
- Tag the Windows machine `tag:qbv-relay` (admin console > machine > Edit ACL tags, or `tailscale up --advertise-tags=tag:qbv-relay` in an elevated prompt).

Find the addresses with `tailscale ip -4` on each machine (they are in `100.64.0.0/10`).

### ACL policy

Allow only the app host to reach the relay port. Add to the tailnet policy file (Access controls):

```jsonc
{
  "tagOwners": {
    "tag:qbv-app": ["autogroup:admin"],
    "tag:qbv-relay": ["autogroup:admin"],
  },
  "acls": [
    // the Docker host may call the relay, on 9123 only
    { "action": "accept", "src": ["tag:qbv-app"], "dst": ["tag:qbv-relay:9123"] },
    // admins may RDP to the QuickBooks machine to clear dialogs
    { "action": "accept", "src": ["autogroup:admin"], "dst": ["tag:qbv-relay:3389"] },
    // ...your other rules; nothing else should list tag:qbv-relay as a destination
  ],
}
```

With tags in place, the default "allow everything" rule must not remain, or it overrides this intent. Use the policy's `tests` section to assert that `tag:qbv-relay:9123` is denied to everything except `tag:qbv-app`.

### Relay and app settings

- Relay `appsettings.json`: `"AllowedIPs": ["<Docker host Tailscale IP>"]`. A single address is better than the whole `100.64.0.0/10`.
- Docker host: `RELAY_URL=http://<Windows host Tailscale IP>:9123`. You can use the MagicDNS name (`http://qb-relay:9123`) if the containers can resolve it. By default they use Docker's resolver, so the IP is the safer choice.

Containers reach the tailnet through the host. Docker NATs outbound traffic, so the relay sees the **Docker host's Tailscale IP** as the source, which is what `AllowedIPs` lists.

### Do not use

- Tailscale **Funnel** on the relay: that publishes it to the internet.
- Tailscale **Serve** for the relay: it is not needed. The worker calls the relay's own port directly, and the ACL above scopes who can reach it.

## Option B: WireGuard

A point-to-point tunnel. Below, the Windows host listens on UDP 51820 and the Docker host connects to it. Reverse the roles if only the Docker host has a reachable address. Tunnel subnet: `10.88.0.0/24`, relay `10.88.0.1`, Docker host `10.88.0.2`.

### Keys

On each machine, generate a key pair. On Linux use `wg genkey | tee privatekey | wg pubkey > publickey`. On Windows, the WireGuard app generates one when you add an empty tunnel. Never copy private keys between machines.

### Windows host (relay side): WireGuard for Windows, "Add empty tunnel"

```ini
[Interface]
PrivateKey = <relay private key>
Address    = 10.88.0.1/24
ListenPort = 51820

[Peer]
# Docker host
PublicKey  = <docker host public key>
AllowedIPs = 10.88.0.2/32
```

Install it as a tunnel service so it is up before logon: in the WireGuard app choose Activate, or run `wireguard.exe /installtunnelservice C:\path\qbv.conf`. If the Windows host is behind NAT, forward **UDP 51820 only** to it, never TCP 9123.

### Docker host (`/etc/wireguard/qbv.conf`)

```ini
[Interface]
PrivateKey = <docker host private key>
Address    = 10.88.0.2/24

[Peer]
# Windows relay
PublicKey           = <relay public key>
Endpoint            = <relay public IP or DNS>:51820
AllowedIPs          = 10.88.0.1/32
PersistentKeepalive = 25
```

```bash
sudo chmod 600 /etc/wireguard/qbv.conf
sudo systemctl enable --now wg-quick@qbv
sudo wg show qbv              # latest handshake should be recent
ping -c3 10.88.0.1
```

Settings: relay `"AllowedIPs": ["10.88.0.2"]`; Docker host `RELAY_URL=http://10.88.0.1:9123`. Containers' traffic leaves through the host and is NATed to `10.88.0.2`, assuming default Docker bridge networking and `net.ipv4.ip_forward=1`, which Docker enables.

`AllowedIPs = 10.88.0.1/32` on the Docker host routes only the relay through the tunnel, not all traffic.

## Option C: same LAN or an existing site-to-site VPN

If both machines are on one trusted network segment, no tunnel is needed. Use the LAN addresses, keep the firewall rule below, and make sure the segment is not reachable from guest Wi-Fi or the internet. Traffic is cleartext on that segment. Prefer a tunnel if the LAN is shared with untrusted devices.

## Windows Firewall

Allow 9123 only from the Docker host's address, and only on the tunnel or LAN profile. In an elevated PowerShell:

```powershell
# Remove any broad rule an earlier install may have created
Get-NetFirewallRule -DisplayName "QuickBooks Vue Relay*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule

# Tailscale: the Docker host's 100.x address
New-NetFirewallRule -DisplayName "QuickBooks Vue Relay (app host only)" `
  -Direction Inbound -Protocol TCP -LocalPort 9123 `
  -RemoteAddress 100.101.102.103 -Action Allow -Profile Any

# WireGuard instead: -RemoteAddress 10.88.0.2

# WireGuard listener (only for Option B)
New-NetFirewallRule -DisplayName "WireGuard qbv" -Direction Inbound -Protocol UDP -LocalPort 51820 -Action Allow
```

Windows Firewall blocks inbound by default, so the allow rule is the only way in. Check that no other rule opens 9123: `Get-NetFirewallPortFilter | ? LocalPort -eq 9123 | Get-NetFirewallRule`.

The relay binds `http://+:9123/` (all interfaces), which is why the firewall rule and `AllowedIPs` matter. The URL ACL that `deploy.ps1` registers only lets a non-admin process bind the port. It is not an access control.

## Docker host firewall

Nothing on the Docker host needs to accept connections from the relay. Production Compose publishes only `web` on `127.0.0.1:8180`. Postgres and Redis have no host ports. If you use `ufw`, remember that ports published by Docker bypass ufw rules. Keep `WEB_BIND=127.0.0.1` so only the local reverse proxy can reach it.

## Verify

From the Docker host:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://<relay-addr>:9123/qb/health                       # 401 (no key)
curl -s -H "X-Api-Key: $RELAY_API_KEY" http://<relay-addr>:9123/qb/health | jq .connected        # true
docker compose exec worker sh -c 'wget -qO- --header "X-Api-Key: $RELAY_API_KEY" "$RELAY_URL/qb/health"'
```

From **outside** (a phone hotspot, or a cloud VM that is not on the tailnet):

```bash
nmap -Pn -p 9123 <office public IP>      # filtered/closed, never open
```

From another tailnet device that is not tagged `tag:qbv-app`: the connection to `:9123` must time out (blocked by the ACL). If it returns 403, the ACL is too broad and only `AllowedIPs` stopped it.

## Rotating the relay API key

1. Pick a new key. Set it in the relay's `appsettings.json` and restart the relay. Requests from the Docker host now get 401.
2. Immediately set `RELAY_API_KEY` on the Docker host and run `docker compose up -d worker api` so they pick it up.
3. The worker does not retry a 401 (only 503, 504 and network errors). Commands sent during the gap show as `failed` in the command tray and must be resubmitted. Sync queries are simply repeated on the next pass.

To avoid the gap, do both within a minute, at a quiet time.
