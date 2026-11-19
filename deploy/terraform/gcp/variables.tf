# ---------------------------------------------------------------------------
# Identity / placement
# ---------------------------------------------------------------------------

variable "name" {
  description = "Short name used as a prefix for every resource and as the Artifact Registry repository id. 3-12 chars so derived service account ids stay within GCP's 30-char limit."
  type        = string
  default     = "qbv"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,10}[a-z0-9]$", var.name))
    error_message = "name must be 3-12 chars: lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen."
  }
}

variable "environment" {
  description = "Environment name (prod, staging, ...). Part of resource names and the app secret id."
  type        = string
  default     = "prod"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,7}$", var.environment))
    error_message = "environment must be 2-8 lowercase letters/digits, starting with a letter."
  }
}

variable "project_id" {
  description = "Existing GCP project id to deploy into."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a valid GCP project id (6-30 chars, lowercase letters, digits, hyphens)."
  }
}

variable "region" {
  description = "GCP region for every regional resource (GKE, Cloud SQL, Memorystore, Artifact Registry, subnet)."
  type        = string
  default     = "us-central1"

  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]+$", var.region))
    error_message = "region must look like us-central1, europe-west4, ..."
  }
}

variable "labels" {
  description = "Extra labels merged into the default labels of every resource that supports them."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for k, v in var.labels : can(regex("^[a-z][a-z0-9_-]{0,62}$", k)) && can(regex("^[a-z0-9_-]{0,63}$", v))
    ])
    error_message = "Label keys must match ^[a-z][a-z0-9_-]{0,62}$ and values ^[a-z0-9_-]{0,63}$."
  }
}

variable "deletion_protection" {
  description = "Protect the GKE cluster and the Cloud SQL instance from deletion. Set false (and apply) before terraform destroy."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# GitHub Actions (Workload Identity Federation)
# ---------------------------------------------------------------------------

variable "github_repository" {
  description = "GitHub repository (owner/name) allowed to federate into this project."
  type        = string
  default     = "jeremiahcarreon/quickbooks-vue"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must be owner/name."
  }
}

variable "github_environments" {
  description = "GitHub Actions environments whose jobs may impersonate the deploy service account."
  type        = list(string)
  default     = ["prod"]

  validation {
    condition     = length(var.github_environments) > 0 && alltrue([for e in var.github_environments : can(regex("^[A-Za-z0-9_.-]+$", e))])
    error_message = "github_environments must be a non-empty list of environment names."
  }
}

variable "github_push_ref" {
  description = "Git ref whose workflow runs may impersonate the image push service account."
  type        = string
  default     = "refs/heads/master"

  validation {
    condition     = startswith(var.github_push_ref, "refs/")
    error_message = "github_push_ref must be a full ref, e.g. refs/heads/master."
  }
}

# ---------------------------------------------------------------------------
# App secret
# ---------------------------------------------------------------------------

variable "relay_api_key" {
  description = "API key of the Windows QuickBooks relay (X-Api-Key). Stored in the app secret as RELAY_API_KEY. May be left empty and set later by adding a secret version."
  type        = string
  default     = ""
  sensitive   = true
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

variable "subnet_cidr" {
  description = "Primary range of the GKE subnet (nodes)."
  type        = string
  default     = "10.20.0.0/20"

  validation {
    condition     = can(cidrhost(var.subnet_cidr, 0))
    error_message = "subnet_cidr must be a valid CIDR."
  }
}

variable "pods_cidr" {
  description = "Secondary range for GKE pods. Autopilot needs a large range (/17 or bigger is recommended)."
  type        = string
  default     = "10.24.0.0/14"

  validation {
    condition     = can(cidrhost(var.pods_cidr, 0))
    error_message = "pods_cidr must be a valid CIDR."
  }
}

variable "services_cidr" {
  description = "Secondary range for GKE services."
  type        = string
  default     = "10.28.0.0/20"

  validation {
    condition     = can(cidrhost(var.services_cidr, 0))
    error_message = "services_cidr must be a valid CIDR."
  }
}

variable "private_service_access_prefix_length" {
  description = "Prefix length of the range reserved for Private Service Access (Cloud SQL + Memorystore). Google picks the address."
  type        = number
  default     = 16

  validation {
    condition     = var.private_service_access_prefix_length >= 8 && var.private_service_access_prefix_length <= 24
    error_message = "private_service_access_prefix_length must be between 8 and 24."
  }
}

# ---------------------------------------------------------------------------
# GKE
# ---------------------------------------------------------------------------

variable "enable_autopilot" {
  description = "true: GKE Autopilot (default, no node management). false: GKE Standard regional cluster with an autoscaling node pool sized by the node_* variables."
  type        = bool
  default     = true
}

variable "kubernetes_version" {
  description = "Minimum control plane version (e.g. \"1.33\"). null lets the release channel choose."
  type        = string
  default     = null

  validation {
    condition     = var.kubernetes_version == null || can(regex("^1\\.[0-9]+", var.kubernetes_version))
    error_message = "kubernetes_version must look like 1.33 or 1.33.5-gke.1000000."
  }
}

variable "release_channel" {
  description = "GKE release channel."
  type        = string
  default     = "REGULAR"

  validation {
    condition     = contains(["RAPID", "REGULAR", "STABLE", "EXTENDED"], var.release_channel)
    error_message = "release_channel must be RAPID, REGULAR, STABLE or EXTENDED."
  }
}

variable "master_authorized_networks" {
  description = "CIDRs allowed to reach the control plane's public IP endpoint. Empty = nobody via IP (use the IAM-gated DNS endpoint instead)."
  type = list(object({
    cidr_block   = string
    display_name = string
  }))
  default = []

  validation {
    condition     = alltrue([for n in var.master_authorized_networks : can(cidrhost(n.cidr_block, 0))])
    error_message = "Every master_authorized_networks entry needs a valid cidr_block."
  }
}

variable "enable_dns_endpoint" {
  description = "Expose the control plane's DNS-based endpoint (access is IAM-checked, no IP allowlist). Lets GitHub-hosted runners reach a cluster whose IP endpoint is locked down."
  type        = bool
  default     = true
}

variable "node_machine_type" {
  description = "Standard mode only: machine type of the node pool."
  type        = string
  default     = "e2-standard-2"
}

variable "node_min_count" {
  description = "Standard mode only: minimum nodes PER ZONE in the regional node pool."
  type        = number
  default     = 1

  validation {
    condition     = var.node_min_count >= 0
    error_message = "node_min_count must be >= 0."
  }
}

variable "node_max_count" {
  description = "Standard mode only: maximum nodes PER ZONE in the regional node pool."
  type        = number
  default     = 2

  validation {
    condition     = var.node_max_count >= 1
    error_message = "node_max_count must be >= 1."
  }
}

variable "node_disk_size_gb" {
  description = "Standard mode only: boot disk size per node."
  type        = number
  default     = 50

  validation {
    condition     = var.node_disk_size_gb >= 20
    error_message = "node_disk_size_gb must be at least 20."
  }
}

variable "node_zones" {
  description = "Standard mode only: zones for the regional node pool. Empty = GKE default (3 zones)."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------
# Cloud SQL (PostgreSQL 16)
# ---------------------------------------------------------------------------

variable "db_tier" {
  description = "Cloud SQL machine tier (Enterprise edition), e.g. db-custom-1-3840, db-custom-2-7680."
  type        = string
  default     = "db-custom-1-3840"

  validation {
    condition     = can(regex("^db-", var.db_tier))
    error_message = "db_tier must be a Cloud SQL tier such as db-custom-2-7680."
  }
}

variable "db_disk_size_gb" {
  description = "Initial Cloud SQL disk size (auto-resize is on)."
  type        = number
  default     = 20

  validation {
    condition     = var.db_disk_size_gb >= 10
    error_message = "db_disk_size_gb must be at least 10."
  }
}

variable "db_high_availability" {
  description = "Regional (HA, synchronous standby in a second zone) Cloud SQL instance. Roughly doubles the database cost."
  type        = bool
  default     = false
}

variable "db_backup_retention_count" {
  description = "Number of daily automated backups kept."
  type        = number
  default     = 14

  validation {
    condition     = var.db_backup_retention_count >= 1 && var.db_backup_retention_count <= 365
    error_message = "db_backup_retention_count must be between 1 and 365."
  }
}

variable "db_pitr_days" {
  description = "Days of write-ahead log kept for point-in-time recovery."
  type        = number
  default     = 7

  validation {
    condition     = var.db_pitr_days >= 1 && var.db_pitr_days <= 7
    error_message = "db_pitr_days must be between 1 and 7 (Enterprise edition)."
  }
}

variable "db_name" {
  description = "Application database name."
  type        = string
  default     = "qbv"
}

variable "db_user" {
  description = "Application database user."
  type        = string
  default     = "qbv"
}

# ---------------------------------------------------------------------------
# Memorystore (Redis 7)
# ---------------------------------------------------------------------------

variable "redis_tier" {
  description = "Memorystore tier: BASIC (single node) or STANDARD_HA (replica + automatic failover)."
  type        = string
  default     = "STANDARD_HA"

  validation {
    condition     = contains(["BASIC", "STANDARD_HA"], var.redis_tier)
    error_message = "redis_tier must be BASIC or STANDARD_HA."
  }
}

variable "redis_memory_size_gb" {
  description = "Memorystore capacity in GiB."
  type        = number
  default     = 1

  validation {
    condition     = var.redis_memory_size_gb >= 1 && var.redis_memory_size_gb <= 300
    error_message = "redis_memory_size_gb must be between 1 and 300."
  }
}

variable "redis_version" {
  description = "Memorystore Redis version (7.x)."
  type        = string
  default     = "REDIS_7_2"

  validation {
    condition     = can(regex("^REDIS_7_[0-9]+$", var.redis_version))
    error_message = "redis_version must be a 7.x version such as REDIS_7_2."
  }
}

# ---------------------------------------------------------------------------
# Artifact Registry
# ---------------------------------------------------------------------------

variable "registry_keep_recent" {
  description = "Image versions kept per package regardless of age by the cleanup policy."
  type        = number
  default     = 20

  validation {
    condition     = var.registry_keep_recent >= 1
    error_message = "registry_keep_recent must be >= 1."
  }
}

variable "registry_untagged_max_age_days" {
  description = "Untagged images older than this are deleted by the cleanup policy."
  type        = number
  default     = 14

  validation {
    condition     = var.registry_untagged_max_age_days >= 1
    error_message = "registry_untagged_max_age_days must be >= 1."
  }
}

variable "deploy_cluster_role" {
  description = "Project role granting the deploy service account Kubernetes API access. container.developer cannot manage RBAC objects; use container.admin if the Helm chart creates Roles/RoleBindings."
  type        = string
  default     = "roles/container.developer"

  validation {
    condition     = contains(["roles/container.developer", "roles/container.admin"], var.deploy_cluster_role)
    error_message = "deploy_cluster_role must be roles/container.developer or roles/container.admin."
  }
}
