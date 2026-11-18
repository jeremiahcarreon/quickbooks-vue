# Operations

How to run QuickBooks Vue in production.

| Guide                                          | Covers                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [deployment.md](deployment.md)                 | First install: the Windows relay and the Docker host                                                                         |
| [private-networking.md](private-networking.md) | Connecting the Docker host to the relay with Tailscale or WireGuard, and firewall rules. The relay is never internet-facing. |
| [tls-reverse-proxy.md](tls-reverse-proxy.md)   | HTTPS in front of the web app, with Caddy or nginx                                                                           |
| [backup-restore.md](backup-restore.md)         | Postgres backup and restore, and rebuilding the read model from QuickBooks                                                   |
| [upgrade.md](upgrade.md)                       | Upgrading the stack, the relay and QuickBooks itself                                                                         |
| [troubleshooting.md](troubleshooting.md)       | QuickBooks modal dialogs, multi-user mode, 3200 conflicts, sync gaps, relay connectivity                                     |

Related reference:

- [../configuration.md](../configuration.md): every environment variable of the Docker services
- [../../server/README.md](../../server/README.md): the relay's API, `appsettings.json` keys and XSD validation
- [../DESIGN.md](../DESIGN.md): architecture

## The system at a glance

```
             Internet / office LAN
                     │ HTTPS 443
             ┌───────▼────────┐
             │ reverse proxy  │  Caddy or nginx, TLS
             └───────┬────────┘
                     │ http://127.0.0.1:8180
 Docker host ┌───────▼────────┐    ┌──────────┐   ┌──────────┐
             │ web (nginx)    │──► │ api      │──►│ postgres │
             └────────────────┘    └────┬─────┘   └──────────┘
                                        │ redis (queue, pub/sub)
                         ┌──────────────┼──────────────┐
                    ┌────▼───┐                    ┌────▼───┐
                    │ sync   │ ── enqueue ──►     │ worker │  (the only relay client)
                    └────────┘                    └────┬───┘
                                                       │ HTTP + X-Api-Key
                                       private tunnel  │ (Tailscale / WireGuard)
 Windows host                                    ┌─────▼──────┐   COM   ┌────────────┐
                                                 │ relay :9123│ ──────► │ QuickBooks │
                                                 └────────────┘         └────────────┘
```

Rules that every guide assumes:

1. **QuickBooks is the source of truth.** Postgres holds a read model that can be rebuilt from QuickBooks at any time, plus users, tokens, the audit log and command history, which cannot be rebuilt.
2. **The relay is reachable only over the private network**, from the Docker host only. Never port-forward 9123.
3. **Only the web container is published**, on 127.0.0.1, behind the TLS proxy. Postgres and Redis have no host ports in production.
4. **The Intuit XSDs are confidential.** They are needed to build the images and to validate on the relay, but they are never committed and never pushed to a public registry. Images built from `docker/node.Dockerfile` contain them.
5. **`.env*` files belong to the owner.** These guides list values to set. Where they go (your shell, a secrets manager, or an env file you maintain yourself) is your choice.
