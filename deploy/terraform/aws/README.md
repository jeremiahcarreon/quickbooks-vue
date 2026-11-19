# QuickBooks Vue on AWS (Terraform)

This root module provisions everything the app needs on AWS. The Helm chart in
`deploy/helm/quickbooks-vue` deploys the workloads (api, worker, sync, web and
the migrate job) onto it.

| Piece    | What gets created                                                                                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network  | VPC with private subnets for nodes, plus isolated database and cache subnets. NAT gateway(s). Public subnets hold only NAT and load balancers. Flow logs go to CloudWatch.                                      |
| Cluster  | EKS with a managed node group in the private subnets. Uses access entries (API auth mode, no aws-auth ConfigMap). Addons: vpc-cni, coredns, kube-proxy, pod identity agent, EBS CSI. Secrets are KMS-encrypted. |
| Postgres | RDS PostgreSQL 16, private, encrypted. A parameter group forces TLS. Backups, optional Multi-AZ, deletion protection.                                                                                           |
| Redis    | ElastiCache Redis 7 replication group with TLS in transit, an AUTH token, encryption at rest and `maxmemory-policy noeviction` (BullMQ needs it).                                                               |
| Registry | Private ECR repos `<name>/{api,worker,sync,web,migrate,relay-mock}`: scan on push, immutable release tags, lifecycle policy.                                                                                    |
| Secret   | Secrets Manager `<name>-<environment>-app`, JSON with `DATABASE_URL`, `DATABASE_SSL`, `REDIS_URL`, `SESSION_SECRET`, `RELAY_API_KEY`.                                                                           |
| CI/CD    | GitHub Actions OIDC provider, a `push` role (ECR push, `master` branch only) and a `deploy` role (EKS + secret read, GitHub environments only).                                                                 |

The Windows QuickBooks relay is **not** provisioned here. It stays on its own
Windows host and the cluster reaches it over a private tunnel (see
[Reaching the relay](#reaching-the-relay)).

The images include Intuit-derived qbXML material, so they go only to these
private ECR repositories. Never push them to a public registry, and never add
a repository policy that grants access outside the account.

## Prerequisites

- Terraform >= 1.6 (tested with 1.9.8). Use >= 1.10 if you want S3-native state locking.
- AWS CLI v2, `kubectl` and `helm`.
- AWS credentials allowed to create VPC, EKS, IAM, RDS, ElastiCache, ECR, KMS, CloudWatch Logs and Secrets Manager resources (in practice, an admin role in the target account).
- An S3 bucket for remote state (see `backend.tf.example`). The state contains the database password, the Redis token and the session secret.

No local Terraform? Run it through Docker:

```bash
alias terraform='docker run --rm -it --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e AWS_PROFILE -e AWS_REGION -e TF_VAR_relay_api_key \
  -v "$HOME/.aws:/tmp/.aws:ro" -v "$PWD":/w -w /w hashicorp/terraform:1.9.8'
```

## Apply

```bash
cd deploy/terraform/aws
cp backend.tf.example backend.tf                 # set bucket, key, region
cp terraform.tfvars.example terraform.tfvars     # set region and sizing (git-ignored)
export TF_VAR_relay_api_key='<the relay ApiKey>' # keeps the key out of files

terraform init
terraform plan -out tfplan
terraform apply tfplan                           # about 20-25 minutes; EKS and RDS take the longest

$(terraform output -raw kubeconfig_command)
kubectl get nodes
```

If the account already has the GitHub OIDC provider
(`token.actions.githubusercontent.com`), set `create_github_oidc_provider = false`.
The module then looks the provider up, or you can pass `github_oidc_provider_arn`.

The identity that runs the first apply gets cluster-admin through an access
entry. To give other people or roles cluster-admin, add their ARNs to
`cluster_admin_principal_arns`.

## GitHub repository variables

Set these under **Settings > Secrets and variables > Actions > Variables**.
They are not secrets: the roles can only be assumed from this repository.
`terraform output github_variables` prints all of them at once.

| GitHub variable       | Terraform output         |
| --------------------- | ------------------------ |
| `AWS_REGION`          | `region`                 |
| `AWS_PUSH_ROLE_ARN`   | `github_push_role_arn`   |
| `AWS_DEPLOY_ROLE_ARN` | `github_deploy_role_arn` |
| `AWS_IMAGE_PREFIX`    | `image_prefix`           |
| `AWS_CLUSTER_NAME`    | `cluster_name`           |
| `AWS_APP_SECRET_ID`   | `app_secret_id`          |

```bash
terraform output -json github_variables | jq -r 'to_entries[] | "\(.key) \(.value)"' |
  while read -r k v; do gh variable set "$k" --body "$v"; done
```

Create GitHub **environments** named as in `github_environments` (default
`prod`) and add required reviewers. The deploy role trusts only
`repo:<repo>:environment:<env>`. The push role trusts only
`repo:<repo>:ref:refs/heads/master`, so pull requests and forks cannot push
images.

The deploy role can:

- call `eks:DescribeCluster` and act inside the cluster as cluster-admin (`deploy_access_scope = "cluster"`, the default). With `"namespace"`, it is admin of `kubernetes_namespace` only, so the namespace must already exist and `helm --create-namespace` will not work.
- read the app secret (`secretsmanager:GetSecretValue`).
- read from ECR.

## The app secret

`app_secret_id` holds:

```json
{
  "DATABASE_URL": "postgres://qbv:...@<rds>:5432/qbv",
  "DATABASE_SSL": "true",
  "REDIS_URL": "rediss://:<token>@<elasticache>:6379",
  "SESSION_SECRET": "<64 random characters>",
  "RELAY_API_KEY": "<TF_VAR_relay_api_key>"
}
```

The deploy workflow turns it into the Kubernetes Secret `qbv-env`. RDS enforces
TLS (`rds.force_ssl = 1`), and `DATABASE_SSL=true` makes `pg` connect over TLS.
Redis needs TLS, which is why the URL uses `rediss://`.

Terraform owns this secret. Change `RELAY_API_KEY` by re-applying with a new
`TF_VAR_relay_api_key`, not by editing the secret in the console. A console
edit is overwritten, or causes drift, on the next apply. Non-secret settings
such as `RELAY_URL`, `PUBLIC_URL` and `QBXML_VERSION` belong in the Helm values.

## Reaching the relay

The worker is the only process that calls the relay. The api may call it too,
for `/api/health`. The relay stays off the internet: no public IP, no load
balancer, no port-forward. Read `docs/ops/private-networking.md` first; the
rules there (tunnel ACL, Windows Firewall, relay `AllowedIPs` and `ApiKey`)
all still apply. From EKS, use one of these options:

**A. Tailscale Kubernetes operator (recommended).** Install the operator with
Helm, using an OAuth client whose tag is allowed to reach `tag:qbv-relay:9123`.
Then create an egress Service in the app namespace:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: qb-relay
  annotations:
    tailscale.com/tailnet-ip: 100.x.y.z # the Windows host's Tailscale IP
spec:
  type: ExternalName
  externalName: placeholder # the operator rewrites this
```

Set `RELAY_URL=http://qb-relay:9123` in the Helm values. Put the egress proxy's
tailnet IP (shown in the Tailscale admin console) in the relay's `AllowedIPs`
and in the Windows Firewall rule. Nothing in AWS changes.

**B. Tailscale subnet router in the VPC.** Run a small EC2 instance (or a pod
with `hostNetwork`) in a private subnet with `tailscale up --advertise-tags=tag:qbv-app`,
and turn off source/destination check on it. In `private_route_table_ids`, add
a route for the relay's `100.x.y.z/32` to the instance's ENI. Tailscale SNATs
the traffic, so the relay sees the router's tailnet IP. Put that IP in
`AllowedIPs`.

**C. AWS Site-to-Site VPN.** Use this if the Windows host's site has a VPN
appliance. Create `aws_customer_gateway`, `aws_vpn_gateway` (attached to
`vpc_id`) and `aws_vpn_connection` with a static route to the relay's LAN,
then enable route propagation on `private_route_table_ids`. The VPC CNI SNATs
pod traffic to the node's IP, so in the relay's `AllowedIPs` and the Windows
Firewall rule, allow `private_subnet_cidrs`, the node subnets only. Do not
allow the whole VPC.

With every option, the traffic between the cluster and the relay is encrypted
(WireGuard or IPsec), and the relay's own HTTP stays cleartext inside the tunnel.

## Ingress

Terraform installs no ingress controller. The public subnets are tagged
`kubernetes.io/role/elb` and the private subnets `kubernetes.io/role/internal-elb`,
so either the AWS Load Balancer Controller (it needs its own IAM role through
Pod Identity) or ingress-nginx behind an NLB works. Only `web` should be
exposed. Terminate TLS at the load balancer or the ingress, and point
`PUBLIC_URL` at that hostname.

## Design notes

- **Modules:** `terraform-aws-modules/vpc` 6.7.0 and `terraform-aws-modules/eks` 21.29.0, pinned to exact versions. All providers are pinned exactly in `versions.tf`, and `.terraform.lock.hcl` covers linux/darwin on amd64 and arm64.
- **Node security:** IMDSv2 only, with a hop limit of 1, so pods cannot use the node role. Root volumes are encrypted gp3. Workloads that need AWS APIs (such as the EBS CSI driver) use EKS Pod Identity.
- **Data access:** RDS and Redis accept connections only from the EKS node and cluster security groups. Their subnets have no route to the internet.
- **ECR tags:** `IMMUTABLE_WITH_EXCLUSION`. Release tags (git SHAs) can never be overwritten, so a deployed tag always means the same image and rollbacks are exact. Only the `ecr_mutable_tags` patterns (`latest`, `master`, `buildcache*`) can move, for convenience tags and the BuildKit registry cache. Set `ecr_mutable_tags = []` for fully `IMMUTABLE`. The lifecycle policy expires untagged images after 7 days and keeps the newest `ecr_keep_tagged_images` (50).
- **Worker:** run one replica, and give it a `terminationGracePeriodSeconds` of at least 150, because a relay call can take up to 130 s. Keep `node_capacity_type = "ON_DEMAND"`: Spot interruptions would cut calls off mid-flight.
- **Redis:** cluster mode is disabled, because BullMQ needs multi-key operations on a single shard. With `redis_num_cache_clusters >= 2` you get a replica, automatic failover and Multi-AZ.
- **Accepted scanner findings** (annotated inline with `#trivy:ignore`):
  - Public EKS endpoint open to `0.0.0.0/0` by default. GitHub-hosted runners need it. Narrow it with `cluster_endpoint_public_access_cidrs`, or turn it off and use runners inside the VPC.
  - Unrestricted node egress. Image pulls, AWS APIs and the relay tunnel need it.
  - RDS IAM authentication is off. The app uses a password.
  - Trivy does not recognise `IMMUTABLE_WITH_EXCLUSION` as immutable.
  - LOW: ECR, Secrets Manager and Performance Insights use AWS-managed KMS keys rather than customer-managed keys.

## Cost (rough, us-east-1, on-demand, defaults)

| Item                                       | ~USD / month                       |
| ------------------------------------------ | ---------------------------------- |
| EKS control plane                          | 73                                 |
| 2 x t3.medium nodes + 2 x 40 GiB gp3       | 67                                 |
| NAT gateway (single) + light traffic       | 35                                 |
| RDS db.t4g.small, 20 GiB gp3, single-AZ    | 27 (Multi-AZ about doubles it)     |
| ElastiCache cache.t4g.small, 1 node        | 23 (each extra node adds the same) |
| CloudWatch logs, Secrets Manager, ECR, KMS | 5-15                               |
| **Total**                                  | **about 230-245**                  |

The biggest levers are `single_nat_gateway` (one NAT gateway per AZ adds about
$33 each), `db_multi_az`, `redis_num_cache_clusters` and node size and count.
Data transfer and any load balancer (about $16-20 per month) are extra.

## Teardown

Deletion protection (`deletion_protection = true`) blocks destroying the EKS
cluster and the RDS instance. It also keeps a final RDS snapshot and a final
Redis snapshot, refuses to delete ECR repositories that still hold images, and
keeps the secret recoverable for 30 days.

```bash
# 1. Remove Kubernetes-created load balancers and volumes first, or they will block VPC deletion
helm uninstall quickbooks-vue -n qbv
kubectl get svc -A | grep LoadBalancer   # should be empty
kubectl get pvc -A                       # delete any left over

# 2. Turn protection off (this also skips the final snapshots and force-deletes ECR images)
terraform apply -var deletion_protection=false

# 3. Destroy
terraform destroy -var deletion_protection=false
```

To keep the data, take a manual RDS snapshot before step 2. If you destroy with
`deletion_protection = true` after turning only the RDS flag off by hand, the
final snapshot `<name>-<environment>-pg-final` is created. Delete or rename it
before you rebuild the environment under the same name.
