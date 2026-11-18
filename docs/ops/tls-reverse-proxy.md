# TLS reverse proxy

The `web` container (nginx) serves the SPA and proxies `/api` to the `api` service, including the SSE stream at `/api/events`. It speaks plain HTTP on `${WEB_BIND:-127.0.0.1}:${WEB_PORT:-8180}`. Put a TLS-terminating proxy in front of it on the same host.

App settings that go with TLS:

| Variable        | Value                    | Why                                                                                      |
| --------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| `PUBLIC_URL`    | `https://qb.example.com` | Cookies, CORS and links use it                                                           |
| `COOKIE_SECURE` | `true` (default)         | Session cookie is only sent over HTTPS                                                   |
| `TRUST_PROXY`   | `true` (Compose default) | The api reads the client IP and scheme from `X-Forwarded-*` (rate limits, audit log IPs) |
| `WEB_BIND`      | `127.0.0.1` (default)    | Only the local proxy can reach the web container                                         |

Proxy requirements:

- **SSE:** `/api/events` is a long-lived `text/event-stream` response. Disable response buffering for it and allow idle reads of at least an hour. The app sends keep-alive comments, but proxies with a 60-second read timeout still cut quiet streams.
- **Body size:** raw qbXML posts can be several MB. The inner nginx allows 10 MB. Allow at least that much.
- **Forwarded headers:** pass `Host`, `X-Forwarded-For` and `X-Forwarded-Proto`.
- **Exposure:** if only staff on the tailnet or VPN should reach the app, bind the proxy to that interface, or use `tailscale serve` (below) instead of the public internet.

## Caddy (automatic certificates)

`/etc/caddy/Caddyfile`:

```caddyfile
qb.example.com {
	encode zstd gzip

	# SSE: stream immediately, never buffer
	@events path /api/events
	reverse_proxy @events 127.0.0.1:8180 {
		flush_interval -1
		transport http {
			read_timeout 0
		}
	}

	reverse_proxy 127.0.0.1:8180 {
		header_up X-Forwarded-Proto {scheme}
	}

	request_body {
		max_size 12MB
	}

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		-Server
	}

	log {
		output file /var/log/caddy/qbv-access.log
	}
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy gets and renews a Let's Encrypt certificate by itself. Ports 80 and 443 must be reachable for the ACME challenge, or use the DNS challenge with a Caddy DNS plugin when the host is internal-only. Caddy sets `X-Forwarded-For` and `X-Forwarded-Proto` by default. The explicit `header_up` above is only for clarity.

## nginx

`/etc/nginx/sites-available/qbv.conf` (certificates from certbot, `certbot --nginx -d qb.example.com`, or your own CA):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name qb.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name qb.example.com;

    ssl_certificate     /etc/letsencrypt/live/qb.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/qb.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    server_tokens off;

    client_max_body_size 12m;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;

    # Server-Sent Events
    location = /api/events {
        proxy_pass http://127.0.0.1:8180;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        chunked_transfer_encoding on;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8180;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 90s;   # ?wait=true can hold a request for up to COMMAND_WAIT_TIMEOUT (30s)
    }

    location / {
        proxy_pass http://127.0.0.1:8180;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/qbv.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

(`http2 on;` needs nginx 1.25.1+. On older versions, use `listen 443 ssl http2;` instead.)

## Internal-only alternative: Tailscale Serve

If users are all on the tailnet, Tailscale can terminate TLS with a `*.ts.net` certificate, and no public port is needed:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:8180
tailscale serve status
```

Set `PUBLIC_URL=https://<machine>.<tailnet>.ts.net`. Restrict who can reach the Docker host's port 443 with the tailnet ACL. This is the web app's port, not the relay's: the relay stays as described in [private-networking.md](private-networking.md).

## Verify

```bash
curl -sI https://qb.example.com/ | head -5                       # 200, strict-transport-security present
curl -s https://qb.example.com/api/health | jq .status
# SSE: should print an event or keep-alive within seconds and stay open (needs a session cookie or token)
curl -N -H "Authorization: Bearer <api token>" https://qb.example.com/api/events
```

In the browser, the session cookie must show `Secure` and `HttpOnly`, and the relay health indicator should update live. If it only updates on reload, SSE is being buffered.
