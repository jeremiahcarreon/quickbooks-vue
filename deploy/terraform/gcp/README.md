# QuickBooks Vue on Google Cloud (Terraform)

Root module that provisions everything the app needs on GCP. The workloads
themselves (api, worker, sync, web, migrate) are installed by the Helm chart at
`deploy/helm/quickbooks-vue`; this module only builds the platform under it.

| Piece       | Resource                                                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| APIs        | `google_project_service` for compute, container, sqladmin, redis, servicenetworking, artifactregistry, secretmanager, iam, iamcredentials, sts, ...                   |
| Network     | VPC, one subnet with `pods` / `services` secondary ranges, flow logs, Cloud Router + Cloud NAT, Private Service Access range + peering, low-priority deny-all ingress |
| Kubernetes  | GKE **Autopilot** (default) or Standard regional + autoscaling pool; private nodes, Workload Identity, Dataplane V2, release channel                                  |
| PostgreSQL  | Cloud SQL for PostgreSQL 16, private IP only, TLS required, daily backups + PITR, optional HA                                                                         |
| Redis       | Memorystore for Redis 7.2, private service access, AUTH, `maxmemory-policy=noeviction`, RDB snapshots                                                                 |
| Images      | Private Artifact Registry Docker repo `<name>` with cleanup policies                                                                                                  |
| App secret  | Secret Manager `<name>-<environment>-app` (JSON: `DATABASE_URL`, `DATABASE_SSL`, `REDIS_URL`, `SESSION_SECRET`, `RELAY_API_KEY`)                                      |
| CI identity | Workload Identity Federation pool + GitHub OIDC provider, `push` and `deploy` service accounts                                                                        |

The QuickBooks relay (Windows host) is **not** provisioned. See
[Reaching the relay](#reaching-the-relay).

## Design choices

**Autopilot by default.** The app is five small Deployments/Jobs with one
single-replica worker; there is nothing node-specific to tune. Autopilot removes
node pools, upgrades, bin-packing and node security hardening from the
operator's plate, bills per pod request, and is always regional with Shielded
Nodes and Dataplane V2. Set `enable_autopilot = false` to get a Standard
regional cluster with an autoscaling pool (`node_machine_type`,
`node_min_count` / `node_max_count` per zone, `node_disk_size_gb`,
`node_zones`): choose it if you need privileged DaemonSets (for example a
Tailscale proxy that wants `NET_ADMIN` / `/dev/net/tun`) or want to run on a
fixed, cheaper node footprint.

**Control plane access.** Nodes are private (no external IPs, egress through
Cloud NAT). The control plane's IP endpoint accepts only
`master_authorized_networks` (empty by default). The **DNS endpoint**
(`enable_dns_endpoint`, default true) is reachable from anywhere but every
request is authorised by IAM, which is how GitHub-hosted runners, whose IPs are
not stable, reach the cluster. `kubeconfig_command` adds `--dns-endpoint`
accordingly.

**Cloud SQL TLS.** `ssl_mode = ENCRYPTED_ONLY`: plaintext connections are
refused, no client certificates needed. The app's `DATABASE_SSL=true` uses TLS
without verifying the server certificate (`rejectUnauthorized: false`), which
matches. The password is 40 alphanumerics, so `DATABASE_URL` needs no escaping.

**Redis TLS (transit encryption DISABLED, AUTH on).** Memorystore's
`SERVER_AUTHENTICATION` mode signs the server certificate with a per-instance
private CA. The app creates ioredis clients straight from `REDIS_URL` with no TLS
options; with `rediss://` ioredis verifies against Node's public CA bundle and
the handshake fails. Making it work needs the instance CA
(`google_redis_instance.server_ca_certs`) mounted in every pod with
`NODE_EXTRA_CA_CERTS`, and a certificate that matches the address the app dials.
That is not verified to work, so this module does not claim it. Instead:
Redis has only a private IP reachable through the VPC peering (never
internet-routed), AUTH is required (the AUTH string is in `REDIS_URL`), and only
workloads in this VPC can route to it. If you need encryption in transit, set
`transit_encryption_mode = "SERVER_AUTHENTICATION"` in `data.tf`, switch the
secret to `rediss://`, and teach the chart to ship the CA; test before relying on it.

**Workload Identity Federation.** The OIDC provider's `attribute_condition`
rejects every token not issued for `github_repository`. Within that repository:

- `push` SA: only runs on `github_push_ref` (default `refs/heads/master`) can
  impersonate it; it holds `artifactregistry.writer` on the repository only.
- `deploy` SA: only jobs that declare one of `github_environments`
  (`environment: prod`) can impersonate it; it holds `deploy_cluster_role`
  (default `roles/container.developer`, project-wide because GKE IAM has no
  per-cluster bindings), `secretmanager.secretAccessor` on the app secret only,
  and `artifactregistry.reader` on the repository. Put branch restrictions and
  required reviewers on the GitHub environment itself. If the Helm chart creates
  `Role`/`RoleBinding` objects, set `deploy_cluster_role = "roles/container.admin"`
  (container.developer cannot manage RBAC).

**Private registry.** The images carry Intuit-derived qbXML schemas, so the
Artifact Registry repository must stay private. This module grants only the
node, push and deploy service accounts. Never add `allUsers` or
`allAuthenticatedUsers`.

**Accepted scanner findings.** `checkov` skips are written inline as
`#checkov:skip=<id>:<reason>` in the resource they apply to (Binary
Authorization, Google Groups RBAC, CMEK on the registry, pgAudit, verbose
Postgres logging flags, Redis transit encryption, the OIDC `sub` heuristic).
`trivy` has one inline ignore: `enable_shielded_nodes` is unset on Autopilot
because Autopilot always uses Shielded Nodes and rejects the field.

## Prerequisites

- An existing GCP project with billing enabled, and `gcloud` authenticated as
  someone with Owner (or Editor + Project IAM Admin + Service Networking Admin)
  on it: `gcloud auth application-default login`.
- Terraform >= 1.6 (the lock file was produced with 1.9.8).
- A GCS bucket for state (see `backend.tf.example`). The state holds the DB
  password, the Redis AUTH string, the session secret and the relay key: keep
  the bucket private.
- Optional: the relay API key in `TF_VAR_relay_api_key` (it can also be added
  later as a new secret version).

## Apply

```bash
cd deploy/terraform/gcp
cp backend.tf.example backend.tf            # set bucket / prefix
cp terraform.tfvars.example terraform.tfvars # set project_id, region, sizing
export TF_VAR_relay_api_key='...'           # optional

terraform init
terraform plan -out tfplan
terraform apply tfplan
terraform output
```

The first apply takes 15-25 minutes (Cloud SQL and Memorystore dominate).
Enabling APIs on a brand-new project can take a few minutes to propagate; if an
apply fails with "API has not been used in project", re-run it.

Check the cluster:

```bash
$(terraform output -raw kubeconfig_command)
kubectl get nodes
```

## GitHub repository variables

Set these as **repository variables** (Settings > Secrets and variables >
Actions > Variables). None of them are secrets.

| GitHub variable     | Terraform output                |
| ------------------- | ------------------------------- |
| `GCP_PROJECT_ID`    | `project_id`                    |
| `GCP_REGION`        | `region`                        |
| `GCP_WIF_PROVIDER`  | `workload_identity_provider`    |
| `GCP_PUSH_SA`       | `github_push_service_account`   |
| `GCP_DEPLOY_SA`     | `github_deploy_service_account` |
| `GCP_IMAGE_PREFIX`  | `image_prefix`                  |
| `GCP_CLUSTER_NAME`  | `cluster_name`                  |
| `GCP_APP_SECRET_ID` | `app_secret_id`                 |

With the `gh` CLI:

```bash
for pair in GCP_PROJECT_ID:project_id GCP_REGION:region \
  GCP_WIF_PROVIDER:workload_identity_provider GCP_PUSH_SA:github_push_service_account \
  GCP_DEPLOY_SA:github_deploy_service_account GCP_IMAGE_PREFIX:image_prefix \
  GCP_CLUSTER_NAME:cluster_name GCP_APP_SECRET_ID:app_secret_id; do
  gh variable set "${pair%%:*}" --body "$(terraform output -raw "${pair##*:}")"
done
```

Workflows authenticate with `google-github-actions/auth` (`workload_identity_provider:
${{ vars.GCP_WIF_PROVIDER }}`, `service_account: ${{ vars.GCP_PUSH_SA }}` or
`GCP_DEPLOY_SA`) and need `permissions: id-token: write`. Images are pushed to
`${GCP_IMAGE_PREFIX}/<service>` for `api`, `worker`, `sync`, `web`, `migrate`
and `relay-mock`. The deploy job reads the secret with
`gcloud secrets versions access latest --secret "$GCP_APP_SECRET_ID"` and
creates the Kubernetes Secret `qbv-env` from its JSON keys, then installs the
chart. Values the secret does not carry (`RELAY_URL`, `PUBLIC_URL`, `ADMIN_*`
for the first seed, ...) come from chart values.

Rotating a value (for example `RELAY_API_KEY`): add a new secret version with
the full JSON, then redeploy. Terraform owns the version it created; a later
`terraform apply` that changes any input of the JSON writes a new version again.

## Reaching the relay

The worker (and optionally the api, for `/api/health`) must reach the Windows
relay at `http://<relay tailnet/VPN IP>:9123`. The rules from
[docs/ops/private-networking.md](../../../docs/ops/private-networking.md) still
apply: the relay is never internet-facing, no load balancer or public DNS
points at it, and the relay's `AllowedIPs` lists only the address the cluster's
traffic arrives from. Pick one:

### A. Tailscale subnet router VM in the VPC (works with Autopilot)

1. Create a small VM (e2-micro is enough) in the GKE subnet with
   `can_ip_forward = true`, no external IP (egress goes through Cloud NAT),
   and Tailscale installed: `tailscale up --advertise-tags=tag:qbv-app`.
2. Masquerade traffic forwarded into the tailnet so the relay sees one stable
   source, the VM's Tailscale IP:
   `iptables -t nat -A POSTROUTING -o tailscale0 -j MASQUERADE`
   (and `net.ipv4.ip_forward=1`).
3. Add a VPC route `relay-ip/32` (or `100.64.0.0/10`) with the VM as next hop,
   and a firewall rule allowing TCP 9123 from the pod and node ranges to the VM
   (this module adds a deny-all ingress rule at priority 65534, so an explicit
   allow is required).
4. Tailnet ACL: `tag:qbv-app` -> `tag:qbv-relay:9123` only. Relay
   `AllowedIPs`: the VM's Tailscale IP. `RELAY_URL=http://<relay 100.x IP>:9123`.

Run two routers behind the same route priority if a single VM is a concern.

### B. Tailscale Kubernetes operator (egress proxy)

Install the operator with Helm, then create an egress `Service`
(`tailscale.com/tailnet-ip: <relay 100.x IP>`, `type: ExternalName`) and point
`RELAY_URL` at that Service on port 9123. The proxy pod's Tailscale IP is what
the relay sees. The proxy wants `NET_ADMIN` and `/dev/net/tun`; check
Tailscale's current GKE Autopilot guidance before choosing this, or use a
Standard cluster (`enable_autopilot = false`) where it is known to work.

### C. Cloud VPN (site with a VPN-capable firewall)

HA VPN + Cloud Router (BGP) to the office/site network where the Windows host
lives, advertising only the relay's address. GKE does not masquerade traffic to
RFC 1918 destinations, so the relay sees **pod IPs**: either allow the pod range
in `AllowedIPs` and the site firewall, or configure `ip-masq-agent` so traffic
to the relay is SNATed to node IPs. The relay link is still cleartext HTTP
inside the IPsec tunnel, which is the encryption layer.

## Cost (rough, us-central1, list prices, before discounts)

| Item                                                       | Approx. per month                              |
| ---------------------------------------------------------- | ---------------------------------------------- |
| GKE Autopilot cluster fee                                  | ~$73 (the free tier credit covers one cluster) |
| Autopilot pods (about 1.5 vCPU / 3 GiB requested in total) | ~$60-90                                        |
| Cloud SQL db-custom-1-3840, 20 GB SSD, zonal               | ~$55 (HA: about double)                        |
| Memorystore 1 GB Standard HA                               | ~$70 (BASIC ~$35)                              |
| Cloud NAT gateway + data                                   | ~$35+                                          |
| Artifact Registry, Secret Manager, logs                    | a few dollars                                  |

Expect roughly $200-300/month at the defaults. Cheapest knobs: `redis_tier =
"BASIC"`, `db_high_availability = false` (default), fewer/lower Autopilot pod
requests in the chart. Check the GCP pricing calculator for current numbers.

## Teardown

```bash
# 1. Allow deletion of the cluster and the database.
terraform apply -var deletion_protection=false
# 2. Destroy (uninstall the Helm release first so GKE-created load balancers
#    and NEGs are removed with it).
terraform destroy
```

Notes:

- The Private Service Access peering uses `deletion_policy = "ABANDON"`,
  because Cloud SQL keeps it "in use" for a while after the instance is gone.
  If deleting the VPC then fails, remove the peering once it frees up:
  `gcloud services vpc-peerings delete --service=servicenetworking.googleapis.com --network=<name>-<env>-vpc`
  and re-run `terraform destroy`.
- Cloud SQL instance names are blocked for about a week after deletion; the
  module adds a random suffix so a re-create does not collide.
- Workload Identity pools are soft-deleted for 30 days and their ids cannot be
  reused meanwhile. Undelete it (`gcloud iam workload-identity-pools undelete`)
  and import it, or change `name`/`environment`, when re-creating within that window.
- Project APIs are left enabled.
- Automated Cloud SQL backups are deleted with the instance; take an export
  first if you need the data.
