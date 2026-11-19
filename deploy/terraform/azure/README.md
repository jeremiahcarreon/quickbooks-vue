# QuickBooks Vue on Azure (Terraform)

Root module that provisions everything the app needs on Azure. The containers
themselves (api, worker, sync, web, migrate) are deployed by the Helm chart in
`deploy/helm/quickbooks-vue`. The Windows QuickBooks relay stays outside Azure
and is reached over a private tunnel ([Reaching the relay](#reaching-the-relay)).

## What it creates

| Area     | Resources                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base     | Resource group `rg-<name>-<env>`, random 5-char suffix for globally unique names                                                                                                                                                                                                                                                                                             |
| Network  | VNet (`10.40.0.0/16` by default): `snet-aks` /22, `snet-postgres` /24 (delegated), `snet-endpoints` /24; NSGs that only let the AKS subnet reach the database and private endpoints; private DNS zones linked to the VNet                                                                                                                                                    |
| AKS      | `aks-<name>-<env>`: system node pool in the VNet (autoscaling, zones), Azure CNI overlay with Cilium, OIDC issuer + workload identity, Entra ID with Azure RBAC for Kubernetes, local accounts disabled, optional API server authorized IP ranges, AcrPull for the kubelet identity, auto patch + node-image upgrades in a Sunday window, Azure Policy add-on, image cleaner |
| Postgres | PostgreSQL Flexible Server 16, private access only (VNet integration), `require_secure_transport=ON`, TLS 1.2+, backups (14 days by default, optional geo-redundant), optional zone-redundant HA, random password, database `qbv`                                                                                                                                            |
| Redis    | Azure Managed Redis (default) or Azure Cache for Redis Standard/Premium. TLS only, `noeviction`, public network access disabled, private endpoint                                                                                                                                                                                                                            |
| Registry | ACR (Standard by default, Premium optional), admin user and anonymous pull disabled, weekly `acr purge` task; Premium adds a private endpoint, untagged-manifest retention and IP rules                                                                                                                                                                                      |
| Secrets  | Key Vault (RBAC mode, purge protection) with secret `<name>-<env>-app`; the principal running Terraform gets Key Vault Secrets Officer                                                                                                                                                                                                                                       |
| CI/CD    | Two user-assigned managed identities with GitHub OIDC federated credentials: `push` (AcrPush) and `deploy` (AKS RBAC role + Cluster User role + Key Vault Secrets User)                                                                                                                                                                                                      |
| Safety   | `deletion_protection` (default `true`): CanNotDelete locks on Postgres, Redis, ACR and Key Vault, plus a Terraform destroy guard                                                                                                                                                                                                                                             |

Images go to `<acr>.azurecr.io/<name>/<svc>` for `api`, `worker`, `sync`,
`web`, `migrate` and `relay-mock`. The images contain Intuit's qbXML schemas,
so they must only ever live in this private registry. Never push them to a
public registry, and never make this one anonymous.

The app secret is one JSON document:

```json
{
  "DATABASE_URL": "postgres://qbvadmin:<password>@psql-qbv-prod-xxxxx.postgres.database.azure.com:5432/qbv",
  "DATABASE_SSL": "true",
  "REDIS_URL": "rediss://:<url-encoded key>@redis-qbv-prod-xxxxx.<region>.redis.azure.net:10000",
  "SESSION_SECRET": "<64 random characters>",
  "RELAY_API_KEY": "<relay_api_key>"
}
```

`DATABASE_SSL=true` makes `pg` use TLS without verifying the certificate.
`REDIS_URL` uses `rediss://` (TLS). The port is 10000 for Azure Managed Redis
and 6380 for Azure Cache for Redis.

## Prerequisites

- Terraform >= 1.6 (validated with 1.9.8), Azure CLI, `kubectl` and
  [`kubelogin`](https://azure.github.io/kubelogin/). Local accounts are off,
  so every kubeconfig needs kubelogin (`az aks install-cli` installs both).
- An identity with **Owner**, or **Contributor + User Access Administrator**
  (or Role Based Access Control Administrator), on the subscription. Terraform
  creates role assignments.
- Resource providers registered (once per subscription):
  ```bash
  for p in Microsoft.ContainerService Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL \
           Microsoft.Cache Microsoft.KeyVault Microsoft.Network Microsoft.ManagedIdentity \
           Microsoft.PolicyInsights; do
    az provider register --namespace "$p"
  done
  ```
- Quota for the node VM family (`Standard DDSv5 Family vCPUs`) in the region.
- For remote state: a storage account outside this module (see `backend.tf.example`).

## Apply

```bash
cd deploy/terraform/azure
az login
az account set --subscription <subscription-id>

cp terraform.tfvars.example terraform.tfvars        # edit: location at least
cp backend.tf.example backend.tf                    # optional but recommended; edit
export TF_VAR_relay_api_key='<the relay ApiKey>'    # keeps it out of tfvars

terraform init
terraform plan -out tfplan
terraform apply tfplan
```

The first apply takes about 20-30 minutes (AKS, Postgres and Managed Redis are
the slow ones). It waits 60-90 seconds in two places for role assignments to
propagate before using them.

Then:

```bash
eval "$(terraform output -raw kubeconfig_command)"
kubectl get nodes
terraform output github_variables
```

With more than one entry in `github_environments`, run the first apply with
`terraform apply -parallelism=1`: Azure rejects concurrent federated credential
writes on one managed identity.

To change `RELAY_API_KEY` later, set `TF_VAR_relay_api_key` and apply again.
Editing the secret by hand works, but the next apply reverts it.

## GitHub repository variables

Set these under **Settings > Secrets and variables > Actions > Variables**.
None of them is secret; `terraform output github_variables` prints them all.

| GitHub variable          | Terraform output                       |
| ------------------------ | -------------------------------------- |
| `AZURE_TENANT_ID`        | `azure_tenant_id`                      |
| `AZURE_SUBSCRIPTION_ID`  | `azure_subscription_id`                |
| `AZURE_PUSH_CLIENT_ID`   | `github_push_client_id`                |
| `AZURE_DEPLOY_CLIENT_ID` | `github_deploy_client_id`              |
| `AZURE_ACR_NAME`         | `acr_name`                             |
| `AZURE_IMAGE_PREFIX`     | `image_prefix`                         |
| `AZURE_RESOURCE_GROUP`   | `resource_group_name`                  |
| `AZURE_CLUSTER_NAME`     | `cluster_name`                         |
| `AZURE_KEY_VAULT`        | `key_vault_name`                       |
| `AZURE_APP_SECRET_NAME`  | `app_secret_name` (`<name>-<env>-app`) |

`app_secret_id` is the versionless secret URI, for tools that want one ID.

How the identities are scoped (`permissions: id-token: write` in the workflow,
then `azure/login@v2` with `client-id`, `tenant-id`, `subscription-id`):

- **push**: federated subject `repo:<repo>:ref:refs/heads/master`. The job
  that builds and pushes must run on `master` and must **not** declare an
  `environment:`. With one, GitHub sends an environment subject and login fails.
  Push with `az acr login --name $AZURE_ACR_NAME`.
- **deploy**: federated subject `repo:<repo>:environment:<env>` for each entry
  in `github_environments`. The job must declare `environment: prod` (or
  another listed environment). It gets Azure Kubernetes Service Cluster User
  Role (to fetch the kubeconfig), `github_deploy_cluster_role` (default RBAC
  Cluster Admin, so Helm can create the namespace) and Key Vault Secrets User.

The deploy job builds `qbv-env` from the vault secret like this:

```bash
az aks get-credentials -g "$AZURE_RESOURCE_GROUP" -n "$AZURE_CLUSTER_NAME" --overwrite-existing
kubelogin convert-kubeconfig -l azurecli
az keyvault secret show --vault-name "$AZURE_KEY_VAULT" --name "$AZURE_APP_SECRET_NAME" \
    --query value -o tsv \
  | jq -r 'to_entries[] | "\(.key)=\(.value)"' > qbv.env
kubectl -n qbv create secret generic qbv-env --from-env-file=qbv.env \
    --dry-run=client -o yaml | kubectl apply -f -
rm -f qbv.env
```

## Reaching the relay

The relay (Windows host running QuickBooks, plain HTTP on 9123) is **not**
provisioned here and must never be reachable from the internet. Read
[docs/ops/private-networking.md](../../../docs/ops/private-networking.md) first.
Only the `worker` (and optionally the `api`, for `/api/health`) calls it.
Pick one way to bring the tunnel into Azure:

### A. Tailscale Kubernetes operator (recommended)

No extra Azure resources. Install the
[Tailscale operator](https://tailscale.com/kb/1236/kubernetes-operator) with
Helm, using an OAuth client whose tag owns `tag:k8s`. Then add an egress
Service that points at the relay's tailnet IP:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: qb-relay
  namespace: qbv
  annotations:
    tailscale.com/tailnet-ip: '100.x.y.z' # tailscale ip -4 on the Windows host
spec:
  type: ExternalName
  externalName: placeholder # the operator rewrites this
  ports:
    - name: http
      port: 9123
      protocol: TCP
```

- App: `RELAY_URL=http://qb-relay.qbv.svc.cluster.local:9123` (Helm values, not the secret).
- Tailnet ACL: allow `tag:k8s` (or a dedicated tag such as `tag:qbv-app` set
  through a ProxyClass) to `tag:qbv-relay:9123` only.
- Relay `AllowedIPs`: the egress proxy's tailnet IP. The proxy keeps its
  identity in a Kubernetes Secret, so the IP stays the same across restarts.
- Restrict pod egress to the proxy with a NetworkPolicy (Cilium enforces it).

### B. Tailscale subnet router VM

Add a small Linux VM in a new subnet of this VNet (address space is free from
`10.40.10.0/24` up), run `tailscale up --advertise-tags=tag:qbv-app`, enable IP
forwarding on its NIC, and add a route table on `snet-aks` sending
`100.64.0.0/10` to the VM. Tailscale SNATs the traffic, so the relay sees the
VM's tailnet IP. More moving parts than option A, and the VM is yours to patch.

### C. Site-to-site VPN Gateway

If the QuickBooks host sits in an office with a VPN-capable firewall, add a
`GatewaySubnet`, a VPN gateway (VpnGw1AZ or higher, about USD 140+/month) and
a local network gateway for the office range. With the CNI overlay, pod traffic
leaves through node IPs, so the relay's `AllowedIPs` and the office firewall
should list the `snet-aks` CIDR (`10.40.0.0/22` by default) and port 9123 only.

Whatever you choose, keep the three layers from the private-networking doc:
tunnel ACL, Windows Firewall and the relay's `AllowedIPs` plus `ApiKey`.

## Redis: Managed Redis vs Cache for Redis

Microsoft is retiring **Azure Cache for Redis** (Basic, Standard, Premium) in
favour of **Azure Managed Redis** (Redis Enterprise based, GA since May 2025).
The announced schedule retires Cache for Redis on 30 September 2028 and stops
creation of new caches for new and then existing customers during 2026. Check
the current notice on Microsoft Learn before choosing.

This module defaults to `redis_service = "managed"` (`azurerm_managed_redis`):

- `clustering_policy = "NoCluster"`: one non-clustered endpoint, which is what
  ioredis/BullMQ expect. NoCluster is limited to the smaller SKUs (25 GB and
  below), which is far more than this app needs.
- `eviction_policy = "NoEviction"`, `client_protocol = "Encrypted"` (TLS, port
  10000), access-key auth on, public network access disabled, private endpoint
  in `privatelink.redis.azure.net`.
- `redis_high_availability` (default on) and optional persistence
  (`redis_persistence` = `aof`/`rdb`). Command state lives in Postgres;
  persistence only shortens the window of queued jobs lost if Redis is lost
  entirely.

`redis_service = "cache"` still builds Azure Cache for Redis (Standard or
Premium via `redis_cache_sku`, non-TLS port off, TLS 1.2, `maxmemory_policy =
noeviction`, private endpoint, public access off) for subscriptions that can
still create one. Switching between them replaces Redis; drain the queues
first.

## Registry retention

- A weekly ACR task (`purge-old-images`, Sundays 04:00 UTC) runs
  `acr purge --filter '<name>/.*:.*' --ago 30d --keep 15 --untagged`: tags older
  than 30 days are removed except the newest 15 per repository, and untagged
  manifests go too. Tune it with `acr_purge_keep` and `acr_purge_older_than`,
  or turn it off with `acr_purge_enabled = false`. ACR Tasks are not available
  on some free-credit subscriptions; disable the task there.
- Premium also deletes untagged manifests after 7 days (`retention_policy_in_days`).
- Deploy by immutable tags (git SHA) so the purge never removes something running.

## Cost (rough, USD per month, East US 2, defaults)

| Item                                           | Approx.  |
| ---------------------------------------------- | -------- |
| AKS Standard tier (uptime SLA)                 | 73       |
| 2 x Standard_D2ds_v5 nodes + OS disks          | 160      |
| Load balancer + public IP                      | 25       |
| PostgreSQL GP_Standard_D2ds_v5, 32 GB, backups | 140      |
| Azure Managed Redis Balanced_B1 with HA        | 100-130  |
| ACR Standard                                   | 20       |
| Private endpoints, DNS zones, Key Vault        | 10       |
| **Total**                                      | **~550** |

Cheaper non-production setups: `aks_sku_tier = "Free"`, `node_count = 1` with
autoscaling off, `postgres_sku_name = "B_Standard_B2s"`,
`redis_managed_sku_name = "Balanced_B0"` with `redis_high_availability =
false`. Postgres HA roughly doubles the database line, Premium ACR is about 50,
Container Insights is billed per GB ingested. Check the Azure pricing
calculator for your region.

## Teardown

```bash
terraform apply -var deletion_protection=false   # removes locks and disarms the destroy guard
terraform destroy -var deletion_protection=false
```

- With `deletion_protection = true`, `terraform destroy` (and any plan that
  would replace Postgres, Redis, ACR or the vault) fails on the
  `terraform_data.destroy_guard` resource before touching them, and the
  management locks block deletion from the portal or CLI.
- The Key Vault is soft-deleted and, with purge protection on, cannot be
  purged for `key_vault_soft_delete_retention_days`. The random suffix gives a
  new deployment a new vault name.
- The AKS node resource group (`rg-<name>-<env>-aks-nodes`) goes with the cluster.
- Destroy deletes the database and its backups. Take a `pg_dump` first.

## Verification done on this module

```bash
D="docker run --rm --user $(id -u):$(id -g) -e HOME=/tmp -v $PWD:/w -w /w hashicorp/terraform:1.9.8"
$D fmt -check -recursive
$D init -backend=false
$D validate
$D providers lock -platform=linux_amd64 -platform=darwin_arm64 -platform=linux_arm64 -platform=darwin_amd64
# tflint with the terraform (preset all) and azurerm rulesets: no findings
# trivy config: no HIGH/CRITICAL left (see below)
```

`.terraform.lock.hcl` is committed. It pins azurerm 4.81.0, random 3.9.1 and
time 0.14.2 for linux/darwin on amd64/arm64.

### Accepted scanner findings

| Finding                                                                                                                              | Why it stays                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API server open to any IP (trivy AZU-0041, checkov CKV_AZURE_115 private cluster)                                                    | GitHub-hosted runners run Helm and have no fixed IPs. Auth is Entra ID only (local accounts off). Set `api_server_authorized_ip_ranges` when deploys come from fixed addresses; a private cluster needs self-hosted runners in the VNet. |
| Key Vault public, default allow (AZU-0013, CKV_AZURE_109/189, CKV2_AZURE_32)                                                         | Only Terraform and the deploy job read it, from outside the VNet; the cluster never talks to the vault. RBAC is the gate. `key_vault_allowed_ip_ranges` turns on deny-by-default.                                                        |
| ACR public network access, no data endpoints, zone redundancy, geo-replication, trust/quarantine (CKV_AZURE_139/164/165/166/233/237) | GitHub-hosted runners push over the public endpoint (Entra ID auth, no admin user, no anonymous pull). Premium + `acr_allowed_ip_ranges` locks it to CIDRs. Single-region app.                                                           |
| Secret without expiry (AZU-0017, CKV_AZURE_41)                                                                                       | An expiry would break deploys silently; the secret is rotated by re-applying.                                                                                                                                                            |
| No Container Insights (AZU-0040, CKV_AZURE_4)                                                                                        | Billed per GB; enable the monitoring add-on when you want it.                                                                                                                                                                            |
| No disk encryption set / host encryption / ephemeral OS disks (AZU-0067, CKV_AZURE_117/227/226)                                      | Platform-managed encryption at rest is on. Host encryption needs a subscription feature flag; CMK needs a Key Vault key lifecycle. Ephemeral OS disks are a variable (`node_os_disk_type`) since they depend on VM size.                 |
| App pods on the system pool (CKV_AZURE_232)                                                                                          | A small install with one pool. Add a user pool and set `only_critical_addons_enabled` when it grows.                                                                                                                                     |
| No Secrets Store CSI driver (CKV_AZURE_172)                                                                                          | The deploy workflow materialises `qbv-env`; the driver is not used.                                                                                                                                                                      |
| No NSG on `snet-aks` (CKV2_AZURE_31)                                                                                                 | AKS manages the NSG on its node NICs; a subnet NSG would also need the LoadBalancer service rules AKS does not maintain there.                                                                                                           |
| Postgres "private endpoint" and geo-redundant backup (CKV2_AZURE_57, CKV_AZURE_136)                                                  | VNet integration (delegated subnet, no public access) is the private option used; geo-redundant backup is `postgres_geo_redundant_backup`.                                                                                               |

## Caveats

- **State holds secrets**: the Postgres password, Redis key, session secret and
  relay key are in state (and in the Key Vault secret). Use the remote backend
  with restricted access. `administrator_password_wo` (write-only) needs
  Terraform 1.11+; this module keeps `>= 1.6` and the classic attribute.
- The app connects as the Flexible Server administrator (not a superuser on
  Azure). Create a narrower role later if you want separation.
- `kubernetes_version = null` takes the region default at create time. Pin a
  minor version for reproducibility; patches are applied automatically in the
  maintenance window.
- Managed Redis SKU names and region availability change; check the portal or
  Microsoft Learn for what your region offers before picking `redis_managed_sku_name`.
- The module creates no ingress controller, DNS records or TLS certificates.
  The Helm chart or a cluster add-on (for example the AKS application routing
  add-on) handles exposing `web`. Set `PUBLIC_URL` accordingly.
