# Cloud deployment and CI/CD

QuickBooks Vue runs on Kubernetes in AWS (EKS), Google Cloud (GKE) or Azure
(AKS). Terraform creates the cloud side, the Helm chart runs the app, and
GitHub Actions tests, builds and deploys it. The relay stays on the Windows
QuickBooks host and is reached over a private network
([private-networking.md](private-networking.md)); it is never deployed to the
cloud.

| Piece                                                                      | What it does                                                                                                                                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`deploy/terraform/aws`](../../deploy/terraform/aws)                       | VPC, EKS, RDS PostgreSQL 16, ElastiCache Redis (TLS, `noeviction`), private ECR, Secrets Manager, GitHub OIDC roles                                                        |
| [`deploy/terraform/gcp`](../../deploy/terraform/gcp)                       | VPC, GKE Autopilot, Cloud SQL PostgreSQL 16, Memorystore Redis, private Artifact Registry, Secret Manager, Workload Identity Federation                                    |
| [`deploy/terraform/azure`](../../deploy/terraform/azure)                   | VNet, AKS, PostgreSQL Flexible Server 16, Azure Managed Redis, private ACR, Key Vault, federated managed identities                                                        |
| [`deploy/helm/quickbooks-vue`](../../deploy/helm/quickbooks-vue/README.md) | web, api, worker (always one replica), sync and the migrate Job; optional ingress, HPA, PDBs, NetworkPolicies; in-chart Postgres, Redis and relay mock for dev and CI only |
| [`.github/workflows`](../../.github/workflows)                             | CI, image release and manual deploy (below)                                                                                                                                |

## Pipelines

| Workflow      | Runs on                                   | Does                                                                                                                                                                                                                                                                                                                        |
| ------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`      | every PR to `master` and every push to it | Prettier, ESLint, typecheck; unit and integration tests on Postgres and Redis; relay (.NET) tests; Playwright end to end on Docker Compose; Playwright end to end on kind with the Helm chart; chart lint and schema checks; Terraform fmt, validate and tflint for all three clouds; actionlint. `CI passed` sums them up. |
| `release.yml` | after CI passes on a push to `master`     | Builds the six images and pushes them, tagged with the commit SHA, to every cloud registry that is configured.                                                                                                                                                                                                              |
| `deploy.yml`  | manual (Actions > Deploy > Run workflow)  | Picks a cloud, environment and SHA; loads the app secret from the cloud's secret store into the `qbv-env` Secret; `helm upgrade --install --atomic`; checks `/api/health` from inside the cluster.                                                                                                                          |

Clouds authenticate with OIDC only: no cloud keys are stored in GitHub.
Release jobs may assume only the push identity, and only from `master`.
Deploy jobs may assume only the deploy identity, and only from a listed
GitHub environment, so required reviewers on that environment gate every
deploy.

## The qbXML schemas in CI

The Intuit XSDs are licensed and never committed. CI restores them from the
`QBXML_SCHEMAS` repository secret:

```bash
tar cf - -C schemas/qbxml 17.0 | xz -9e | base64 -w0 | gh secret set QBXML_SCHEMAS
```

They are never uploaded as artifacts or cached. Pull requests from forks get
no secrets, so the jobs that need the schemas are skipped there and run after
merge. Images contain the schemas, so they go only to the private registries
Terraform creates, never to a public registry.

## Setting up a cloud

1. `cd deploy/terraform/<cloud>`, copy `terraform.tfvars.example` to
   `terraform.tfvars` and `backend.tf.example` to `backend.tf`, then
   `terraform init && terraform apply`. Each README lists prerequisites, cost
   and teardown.
2. Copy the outputs into GitHub repository variables (each README has the
   table, and a `gh variable set` one-liner).
3. Create a GitHub environment (`prod`) with required reviewers, and the
   variables `RELAY_URL`, `PUBLIC_URL` and optionally `HELM_VALUES` (ingress
   and sizing, as values.yaml content).
4. Connect the cluster to the relay (Tailscale operator, subnet router or VPN;
   see the Terraform README) and set the relay's `AllowedIPs` to match.
5. Merge to `master`. After CI passes, `release.yml` pushes the images; then
   run Deploy with that commit's SHA.
