# quickbooks-vue Helm chart

Runs QuickBooks Vue on Kubernetes: `web` (nginx + SPA, proxies `/api`), `api`,
`worker` (the only relay client), `sync` and the `migrate` Job. The
**relay stays on the Windows host** next to QuickBooks and is reached over a
private network; it never runs in the cluster in production (see
[Reaching the relay](#reaching-the-relay)).

The chart mirrors `compose.yaml` and `apps/*/compose.yaml`: the same variables,
defaults, health checks and stop grace periods. Every variable is described in
[docs/configuration.md](../../../docs/configuration.md).

| Component    | Kind                       | Notes                                                                                              |
| ------------ | -------------------------- | -------------------------------------------------------------------------------------------------- |
| `web`        | Deployment + Service :80   | nginx as uid 101, read-only root; probes `GET /healthz`; `API_UPSTREAM` = the api Service          |
| `api`        | Deployment + Service :3100 | readiness `GET /api/health` (503 while Postgres/Redis is down); liveness is TCP; optional HPA; PDB |
| `worker`     | Deployment                 | exactly 1 replica, `Recreate`, 150 s grace (finishes the relay call in flight); no probes          |
| `sync`       | Deployment                 | replicas configurable (Redis leader lock), 30 s grace                                              |
| `migrate`    | Job                        | `migrate.js latest && seed.js`; Helm hook or ordinary Job, see [Migrations](#migrations)           |
| `relay-mock` | Deployment + Service :9223 | `relayMock.enabled` only (development / CI)                                                        |
| `postgresql` | StatefulSet                | `postgresql.enabled` only (development / CI): postgres:16-alpine                                   |
| `redis`      | StatefulSet                | `redis.enabled` only (development / CI): redis:7-alpine, `noeviction`                              |

Production uses managed Postgres (RDS, Cloud SQL, Azure Database for
PostgreSQL) and Redis (ElastiCache, Memorystore, Azure Cache for Redis, all
with `maxmemory-policy noeviction`), with `postgresql` and `redis` disabled.

## Images

The image of service `S` is `<image.prefix>/S:<image.tag>` (tag defaults to
the chart `appVersion`), for `S` in `api`, `worker`, `sync`, `web`, `migrate`,
`relay-mock`. Override one with `<service>.image.repository` / `.tag`.

```bash
# from the repo root; schemas/qbxml/17.0/*.xsd must be present
for s in api worker sync migrate relay-mock; do
  docker build -f docker/node.Dockerfile --build-arg SERVICE=$s -t "$PREFIX/$s:$TAG" .
done
docker build -f docker/web.Dockerfile -t "$PREFIX/web:$TAG" .
```

The node images contain the Intuit qbXML XSDs. Push them **only to a private
registry**.

| Cloud | `image.prefix`                              | Pull access                                               |
| ----- | ------------------------------------------- | --------------------------------------------------------- |
| AWS   | `<acct>.dkr.ecr.<region>.amazonaws.com/qbv` | node IAM role with `AmazonEC2ContainerRegistryReadOnly`   |
| GCP   | `<region>-docker.pkg.dev/<project>/qbv`     | node service account with `roles/artifactregistry.reader` |
| Azure | `<name>.azurecr.io/qbv`                     | `az aks update --attach-acr <name>`                       |

Otherwise create a docker-registry Secret and list it in `imagePullSecrets`.

## Secrets

The app needs `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET` (at least 32
characters), `RELAY_API_KEY` and, for the first admin, `ADMIN_EMAIL` /
`ADMIN_PASSWORD` (at least 12 characters; never changes an existing user).

- **Production:** create a Secret with those keys from your secret manager
  (External Secrets Operator, the Secrets Store CSI driver, or the deploy
  pipeline) and pass `secrets.existingSecret=<name>`. The chart then creates
  no Secret. Each container receives only the keys it needs.
- **Otherwise** the chart creates one from `secrets.*`. An empty
  `secrets.sessionSecret` is generated once and read back from the cluster on
  upgrades.

```bash
kubectl -n qbv create secret generic qbv-env \
  --from-literal=DATABASE_URL='postgres://qbv:...@mydb.xxxx.us-east-1.rds.amazonaws.com:5432/qbv' \
  --from-literal=REDIS_URL='rediss://:...@master.qbv.xxxx.use1.cache.amazonaws.com:6379/0' \
  --from-literal=SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=RELAY_API_KEY='<the relay ApiKey>' \
  --from-literal=ADMIN_EMAIL='admin@example.com' \
  --from-literal=ADMIN_PASSWORD='<at least 12 characters>'
```

With `postgresql.enabled` / `redis.enabled`, `DATABASE_URL` / `REDIS_URL` point
at the in-chart services automatically (they override the Secret's keys).

## Migrations

`migrate.mode` (default `auto`):

- **hook** (auto with an external database): a `pre-install,pre-upgrade` hook
  Job (`before-hook-creation,hook-succeeded`), so the schema is migrated before
  new pods start. With `secrets.existingSecret` the Job reads that Secret
  (create it before installing). With a chart-made Secret, the chart also
  renders a hook copy of `DATABASE_URL` / `ADMIN_*` (weight -10, deleted after
  success), because hooks run before the release's own Secret exists on first
  install. The hook pod uses the namespace's default ServiceAccount (with no
  token mounted) for the same reason.
- **job** (auto with `postgresql.enabled`): the in-chart Postgres does not
  exist when pre-install hooks run, so the migration is an ordinary Job named
  `<fullname>-migrate-<revision>` (waits for Postgres), and `api`, `worker` and
  `sync` have a `wait-for-schema` init container that blocks until every
  migration is applied. Migrations are lock-protected, so this is safe.

## Install

```bash
helm upgrade --install qbv deploy/helm/quickbooks-vue -n qbv --create-namespace -f my-values.yaml
```

Common production values:

```yaml
image:
  prefix: 123456789012.dkr.ecr.us-east-1.amazonaws.com/qbv
  tag: '2026.11.18-abc1234'
relay:
  url: http://100.101.102.103:9123 # see "Reaching the relay"
secrets:
  existingSecret: qbv-env
config:
  PUBLIC_URL: https://qbv.example.com
  DATABASE_SSL: 'true' # managed Postgres over TLS
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/proxy-buffering: 'off'
    nginx.ingress.kubernetes.io/proxy-read-timeout: '3600'
    nginx.ingress.kubernetes.io/proxy-send-timeout: '3600'
    nginx.ingress.kubernetes.io/proxy-body-size: '10m'
    cert-manager.io/cluster-issuer: letsencrypt
  hosts:
    - host: qbv.example.com
      paths: [{ path: /, pathType: Prefix }]
  tls:
    - secretName: qbv-tls
      hosts: [qbv.example.com]
```

### AWS (EKS)

```bash
helm upgrade --install qbv deploy/helm/quickbooks-vue -n qbv --create-namespace \
  --set image.prefix=123456789012.dkr.ecr.us-east-1.amazonaws.com/qbv \
  --set image.tag="$TAG" \
  --set secrets.existingSecret=qbv-env \
  --set relay.url=http://100.101.102.103:9123 \
  --set config.PUBLIC_URL=https://qbv.example.com \
  --set config.DATABASE_SSL=true \
  -f ingress-values.yaml
```

RDS for PostgreSQL 16 and ElastiCache for Redis (parameter group with
`maxmemory-policy noeviction`; with in-transit encryption use `rediss://`).
For the AWS Load Balancer Controller use `ingress.className: alb` with
`alb.ingress.kubernetes.io/target-type: ip` and an idle timeout of at least
3600 s (`alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=3600`)
so the SSE stream at `/api/events` is not cut.

### GCP (GKE)

```bash
helm upgrade --install qbv deploy/helm/quickbooks-vue -n qbv --create-namespace \
  --set image.prefix=us-central1-docker.pkg.dev/my-project/qbv \
  --set image.tag="$TAG" \
  --set secrets.existingSecret=qbv-env \
  --set relay.url=http://100.101.102.103:9123 \
  --set config.PUBLIC_URL=https://qbv.example.com \
  -f ingress-values.yaml
```

Cloud SQL for PostgreSQL 16 (private IP; `DATABASE_SSL=true` if SSL is
enforced) and Memorystore for Redis (`maxmemory-policy noeviction`). With the
GKE Ingress, raise the backend timeout for SSE with a `BackendConfig`
(`timeoutSec: 3600`) referenced from `web.service.annotations`
(`cloud.google.com/backend-config: '{"default": "qbv-backend"}'`).

### Azure (AKS)

```bash
helm upgrade --install qbv deploy/helm/quickbooks-vue -n qbv --create-namespace \
  --set image.prefix=myregistry.azurecr.io/qbv \
  --set image.tag="$TAG" \
  --set secrets.existingSecret=qbv-env \
  --set relay.url=http://100.101.102.103:9123 \
  --set config.PUBLIC_URL=https://qbv.example.com \
  --set config.DATABASE_SSL=true \
  -f ingress-values.yaml
```

Azure Database for PostgreSQL flexible server 16 (SSL required by default) and
Azure Cache for Redis (`rediss://:<key>@<name>.redis.cache.windows.net:6380/0`,
`maxmemory-policy noeviction`). With the application routing add-on use
`ingress.className: webapprouting.kubernetes.azure.com` and the same
`nginx.ingress.kubernetes.io/*` annotations.

### Development / CI (kind)

```bash
deploy/helm/ci/build-images.sh qbv          # builds qbv/<svc>:ci and kind-loads them
deploy/helm/ci/kind-smoke.sh                # installs with ci/kind-values.yaml and checks it
```

`ci/kind-values.yaml` enables `postgresql`, `redis` and `relayMock`, sets the
dev admin (`admin@example.com` / `dev-admin-password`), `RELAY_API_KEY=dev-relay-key`,
`COOKIE_SECURE=false`, turns the NetworkPolicies on (kindnet enforces them)
and makes `web` / `relay-mock` NodePorts (30080 / 30923).

`kind-smoke.sh` forwards `localhost:$WEB_PORT` (8180) and
`localhost:$RELAY_MOCK_PORT` (9223) to them through small socat containers on
the `kind` Docker network (`FORWARD_MODE=docker`, chosen automatically). Plain
`kubectl port-forward` (`FORWARD_MODE=kubectl`, supervised and restarted when
it stops answering) works for quick checks but its tunnel breaks under browser
traffic, so the Playwright suite should not run through it. With
`--keep-forwarding` the forwards outlive the script for a following test step;
`kind-smoke.sh --stop-forwarding` removes them. `kind-smoke.sh --help` lists
every variable.

## Server-Sent Events

The web nginx already disables buffering for `/api/events`. Anything in front
of it must too: with ingress-nginx set
`nginx.ingress.kubernetes.io/proxy-buffering: "off"` and
`proxy-read-timeout` / `proxy-send-timeout` of `3600`; with cloud load
balancers raise the idle / backend timeout to at least 3600 s. `/api/*`
requests can take up to 180 s (`?wait=true`, QuickBooks reports).

Behind an ingress terminating TLS, keep `COOKIE_SECURE=true` and
`TRUST_PROXY=true` (the defaults) and set `PUBLIC_URL` to the external URL.

## Reaching the relay

The relay (port 9123 on the Windows host) is never internet-facing; read
[docs/ops/private-networking.md](../../../docs/ops/private-networking.md)
first. Only `worker` (and `api`, for `/api/health`) call it. Set `relay.url`
to an address the pods can route to, then list the **source address the relay
sees** in the relay's `AllowedIPs`.

**Option 1: Tailscale Kubernetes operator, egress Service (recommended).**
Install the operator (`helm install tailscale-operator tailscale/tailscale-operator -n tailscale ...`
with an OAuth client), then create an egress Service for the Windows host:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: qbv-relay
  namespace: qbv
  annotations:
    tailscale.com/tailnet-ip: 100.101.102.103 # the Windows host (or tailscale.com/tailnet-fqdn)
    tailscale.com/tags: tag:qbv-app # so the tailnet ACL lets it reach tag:qbv-relay:9123
spec:
  type: ExternalName
  externalName: placeholder # the operator fills this in
  ports:
    - name: relay
      port: 9123
      protocol: TCP
```

Then `relay.url=http://qbv-relay.qbv.svc.cluster.local:9123`. The relay sees
the egress proxy's tailnet IP (`tailscale status` on any node, or the
proxy's Tailscale machine page): put that in `AllowedIPs`. With
`networkPolicy.enabled`, allow egress to the proxy pods:

```yaml
networkPolicy:
  relay:
    port: 9123
    peers:
      - namespaceSelector:
          matchLabels: { kubernetes.io/metadata.name: tailscale }
```

**Option 2: a subnet router.** Run Tailscale on a small VM (or a node) in the
cluster's VPC/VNet with `--accept-routes`, have the Windows site advertise its
LAN (`tailscale up --advertise-routes=192.168.10.0/24` on a machine there),
and route that prefix from the VPC to the VM. Then
`relay.url=http://<Windows host LAN IP>:9123`; `AllowedIPs` lists the router's
address (Tailscale SNATs by default). For a cloud VPN (AWS Site-to-Site VPN,
Cloud VPN, Azure VPN Gateway) or WireGuard on the nodes, the idea is the same:
make the relay address routable from the pods and allow the NATed source.

With either option, the tailnet ACL should still allow only `tag:qbv-app` to
reach `tag:qbv-relay:9123`.

## NetworkPolicies

`networkPolicy.enabled=true` (needs a CNI that enforces them):

- `web` accepts port 80 from `networkPolicy.webAllowFrom` (any by default;
  set it to the ingress controller's namespace) and may call only `api`.
- `api` accepts 3100 from `web` only.
- `api`, `worker`, `sync`, `migrate` may reach Postgres; `api`, `worker`,
  `sync` Redis; `worker` and `api` the relay. Everything may resolve DNS.
- External services: `networkPolicy.database|redis|relay.peers` (e.g. an
  `ipBlock` of the database subnet). Empty peers allow the port to any
  destination.
- The in-chart Postgres / Redis / relay mock accept only their clients.

## Security defaults

All pods: `runAsNonRoot`, `seccompProfile: RuntimeDefault`, all capabilities
dropped, no privilege escalation, read-only root filesystem with emptyDirs
for `/tmp` (and nginx's `/var/cache/nginx`, `/var/run`, `/etc/nginx/conf.d`).
The node services run `node dist/main.js` directly (no npm, which wants a
writable home). The ServiceAccount has `automountServiceAccountToken: false`;
the app never calls the Kubernetes API. nginx binds port 80 as non-root through
the safe sysctl `net.ipv4.ip_unprivileged_port_start=0`
(`web.unprivilegedPortSysctl`).

## Values

| Key                                                                                                                                                               | Default                     | Description                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `image.prefix`                                                                                                                                                    | `""`                        | **Required.** Registry path in front of every image name                                                             |
| `image.tag`                                                                                                                                                       | chart `appVersion`          | Tag of every image                                                                                                   |
| `image.pullPolicy`                                                                                                                                                | `IfNotPresent`              |                                                                                                                      |
| `imagePullSecrets`                                                                                                                                                | `[]`                        | Names (or `{name}`) of registry Secrets                                                                              |
| `<svc>.image.repository` / `.tag` / `.pullPolicy`                                                                                                                 | `""`                        | Per-service override (`api`, `worker`, `sync`, `web`, `migrate`, `relayMock`)                                        |
| `relay.url`                                                                                                                                                       | `""`                        | `RELAY_URL`. Required unless `relayMock.enabled` (then the mock)                                                     |
| `config.*`                                                                                                                                                        | compose defaults            | Non-secret env (ConfigMap) for api, worker, sync; pods roll on change                                                |
| `config.PUBLIC_URL`                                                                                                                                               | `http://localhost:8180`     | External URL of the app                                                                                              |
| `config.COOKIE_SECURE`                                                                                                                                            | `"true"`                    | `"false"` only for plain-HTTP development                                                                            |
| `config.TRUST_PROXY`                                                                                                                                              | `"true"`                    |                                                                                                                      |
| `config.DATABASE_SSL`                                                                                                                                             | `"false"`                   | TLS to Postgres                                                                                                      |
| `config.QBXML_VERSION`                                                                                                                                            | `"16.0"`                    |                                                                                                                      |
| `config.SYNC_*`, `RATE_LIMIT_*`, `WORKER_*`, `QUEUE_PREFIX`, `LOG_LEVEL`, `TZ`                                                                                    | see values.yaml             |                                                                                                                      |
| `secrets.existingSecret`                                                                                                                                          | `""`                        | Secret with `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `RELAY_API_KEY`, optional `ADMIN_EMAIL`, `ADMIN_PASSWORD` |
| `secrets.databaseUrl` / `redisUrl` / `sessionSecret` / `relayApiKey` / `adminEmail` / `adminPassword`                                                             | `""`                        | Used when `existingSecret` is empty                                                                                  |
| `serviceAccount.create` / `.name` / `.annotations`                                                                                                                | `true` / `""` / `{}`        | Annotations for workload identity                                                                                    |
| `podSecurityContext`, `containerSecurityContext`                                                                                                                  | non-root, read-only         |                                                                                                                      |
| `api.replicaCount`                                                                                                                                                | `2`                         |                                                                                                                      |
| `api.autoscaling.enabled`                                                                                                                                         | `false`                     | HPA (`minReplicas` 2, `maxReplicas` 6, CPU 75 %)                                                                     |
| `api.pdb.enabled` / `.maxUnavailable`                                                                                                                             | `true` / `1`                | Only when more than one replica                                                                                      |
| `api.readinessProbe` / `livenessProbe` / `startupProbe`                                                                                                           | `/api/health` / TCP / TCP   |                                                                                                                      |
| `worker.terminationGracePeriodSeconds`                                                                                                                            | `150`                       | Always 1 replica, `Recreate`                                                                                         |
| `sync.replicaCount`                                                                                                                                               | `1`                         | Safe above 1                                                                                                         |
| `sync.terminationGracePeriodSeconds`                                                                                                                              | `30`                        |                                                                                                                      |
| `web.replicaCount`                                                                                                                                                | `2`                         |                                                                                                                      |
| `web.service.type` / `.port` / `.nodePort`                                                                                                                        | `ClusterIP` / `80` / `null` | Same keys on `api.service` (3100) and `relayMock.service` (9223)                                                     |
| `web.unprivilegedPortSysctl`                                                                                                                                      | `true`                      |                                                                                                                      |
| `<svc>.resources`, `.extraEnv`, `.podAnnotations`, `.podLabels`, `.nodeSelector`, `.tolerations`, `.affinity`, `.topologySpreadConstraints`, `.priorityClassName` |                             | Per component                                                                                                        |
| `migrate.mode`                                                                                                                                                    | `auto`                      | `auto`, `hook` or `job` (see Migrations)                                                                             |
| `migrate.adminName`                                                                                                                                               | `Administrator`             | `ADMIN_NAME`                                                                                                         |
| `migrate.backoffLimit` / `activeDeadlineSeconds` / `ttlSecondsAfterFinished`                                                                                      | `3` / `900` / `86400`       |                                                                                                                      |
| `relayMock.enabled`                                                                                                                                               | `false`                     | Development / CI only                                                                                                |
| `relayMock.seed` / `seedAnchor` / `dataFile`                                                                                                                      | `"1"` / `2026-10-31` / `""` | `SEED`, `MOCK_SEED_ANCHOR`, `MOCK_DATA_FILE` (empty: in memory)                                                      |
| `postgresql.enabled`                                                                                                                                              | `false`                     | Development / CI only                                                                                                |
| `postgresql.auth.username` / `database` / `password`                                                                                                              | `qbv` / `qbv` / generated   |                                                                                                                      |
| `postgresql.persistence.enabled` / `size` / `storageClass`                                                                                                        | `true` / `8Gi` / `""`       | `false`: emptyDir                                                                                                    |
| `redis.enabled`                                                                                                                                                   | `false`                     | Development / CI only                                                                                                |
| `redis.persistence.enabled` / `size`                                                                                                                              | `true` / `1Gi`              |                                                                                                                      |
| `ingress.enabled` / `className` / `annotations` / `hosts` / `tls`                                                                                                 | `false`                     | Routes to `web` only                                                                                                 |
| `networkPolicy.enabled`                                                                                                                                           | `false`                     |                                                                                                                      |
| `networkPolicy.webAllowFrom`                                                                                                                                      | `[]`                        | Peers allowed to reach web (empty: any)                                                                              |
| `networkPolicy.relayMockAllowFrom`                                                                                                                                | `[]`                        | Extra peers allowed to reach the relay mock (test tooling)                                                           |
| `networkPolicy.database` / `redis` / `relay`                                                                                                                      | `{peers: [], port}`         | Egress to external services                                                                                          |
| `networkPolicy.dns`                                                                                                                                               | kube-dns, 53                |                                                                                                                      |

## Uninstall

```bash
helm uninstall qbv -n qbv
```

PVCs of the in-chart Postgres / Redis are kept (delete them with
`kubectl -n qbv delete pvc -l app.kubernetes.io/instance=qbv`). A failed
migrate hook leaves its Job (and, with a chart-made Secret, the
`<fullname>-migrate` hook Secret) for inspection; the next install or upgrade
replaces them.
