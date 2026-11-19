# ---------------------------------------------------------------------------
# Identity and placement
# ---------------------------------------------------------------------------

variable "name" {
  description = "Short application name. Prefixes every resource and is the image path prefix (<acr>.azurecr.io/<name>/<svc>)."
  type        = string
  default     = "qbv"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,9}$", var.name))
    error_message = "name must be 2-10 lowercase letters/digits, starting with a letter (it ends up in globally unique, length-limited Azure names)."
  }
}

variable "environment" {
  description = "Environment name (prod, staging, ...). Part of resource names and of the Key Vault secret name <name>-<environment>-app."
  type        = string
  default     = "prod"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,7}$", var.environment))
    error_message = "environment must be 2-8 lowercase letters/digits, starting with a letter."
  }
}

variable "location" {
  description = "Azure region, e.g. eastus2, westeurope. Must offer AKS, PostgreSQL Flexible Server and the chosen Redis service (with availability zones if you use zone redundancy)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9]+$", var.location))
    error_message = "location must be an Azure region name such as eastus2 (lowercase, no spaces)."
  }
}

variable "subscription_id" {
  description = "Azure subscription to deploy into. null uses ARM_SUBSCRIPTION_ID or the Azure CLI's current subscription."
  type        = string
  default     = null

  validation {
    condition     = var.subscription_id == null || can(regex("^[0-9a-fA-F-]{36}$", var.subscription_id))
    error_message = "subscription_id must be a subscription GUID or null."
  }
}

variable "tags" {
  description = "Extra tags merged onto every taggable resource."
  type        = map(string)
  default     = {}
}

variable "deletion_protection" {
  description = "Put CanNotDelete management locks on the stateful resources (PostgreSQL, Redis, ACR, Key Vault). Set false and apply before terraform destroy."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# GitHub Actions OIDC
# ---------------------------------------------------------------------------

variable "github_repository" {
  description = "GitHub repository (owner/name) allowed to assume the push and deploy identities."
  type        = string
  default     = "jeremiahcarreon/quickbooks-vue"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must look like owner/name."
  }
}

variable "github_push_branch" {
  description = "Branch whose workflows may push images (federated subject repo:<repo>:ref:refs/heads/<branch>)."
  type        = string
  default     = "master"

  validation {
    condition     = length(var.github_push_branch) > 0
    error_message = "github_push_branch must not be empty."
  }
}

variable "github_environments" {
  description = "GitHub environments whose jobs may deploy (federated subject repo:<repo>:environment:<env>). More than one needs `terraform apply -parallelism=1` on first create (see README)."
  type        = list(string)
  default     = ["prod"]

  validation {
    condition     = length(var.github_environments) > 0 && alltrue([for e in var.github_environments : can(regex("^[A-Za-z0-9_.-]+$", e))])
    error_message = "github_environments must be a non-empty list of environment names (letters, digits, _ . -)."
  }
}

variable "github_deploy_cluster_role" {
  description = "AKS data-plane role given to the deploy identity at cluster scope. Writer cannot create namespaces or RBAC objects."
  type        = string
  default     = "Azure Kubernetes Service RBAC Cluster Admin"

  validation {
    condition = contains([
      "Azure Kubernetes Service RBAC Cluster Admin",
      "Azure Kubernetes Service RBAC Admin",
      "Azure Kubernetes Service RBAC Writer",
    ], var.github_deploy_cluster_role)
    error_message = "github_deploy_cluster_role must be one of the AKS RBAC Cluster Admin / Admin / Writer built-in roles."
  }
}

# ---------------------------------------------------------------------------
# Application secrets
# ---------------------------------------------------------------------------

variable "relay_api_key" {
  description = "X-Api-Key of the Windows relay (its appsettings.json ApiKey). Stored in the app secret as RELAY_API_KEY. Empty is allowed and can be filled in later."
  type        = string
  default     = ""
  sensitive   = true
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

variable "vnet_cidr" {
  description = "VNet address space. Must not overlap the tailnet (100.64.0.0/10), WireGuard tunnel (10.88.0.0/24), pod_cidr or service_cidr. Needs at least a /20."
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition     = can(cidrhost(var.vnet_cidr, 0)) && tonumber(split("/", var.vnet_cidr)[1]) <= 20
    error_message = "vnet_cidr must be a valid IPv4 CIDR of /20 or larger."
  }
}

variable "pod_cidr" {
  description = "Azure CNI overlay pod CIDR (not routable in the VNet)."
  type        = string
  default     = "10.244.0.0/16"

  validation {
    condition     = can(cidrhost(var.pod_cidr, 0))
    error_message = "pod_cidr must be a valid IPv4 CIDR."
  }
}

variable "service_cidr" {
  description = "Kubernetes service CIDR. The cluster DNS service uses its 10th address."
  type        = string
  default     = "172.16.0.0/16"

  validation {
    condition     = can(cidrhost(var.service_cidr, 10))
    error_message = "service_cidr must be a valid IPv4 CIDR with at least 16 addresses."
  }
}

# ---------------------------------------------------------------------------
# AKS
# ---------------------------------------------------------------------------

variable "kubernetes_version" {
  description = "AKS Kubernetes version (e.g. \"1.33\"). null takes the region's current default. Patch upgrades are automatic."
  type        = string
  default     = null

  validation {
    condition     = var.kubernetes_version == null || can(regex("^1\\.[0-9]+(\\.[0-9]+)?$", var.kubernetes_version))
    error_message = "kubernetes_version must look like 1.33 or 1.33.2, or be null."
  }
}

variable "aks_sku_tier" {
  description = "AKS control plane tier. Standard carries the uptime SLA (paid); Free has none."
  type        = string
  default     = "Standard"

  validation {
    condition     = contains(["Free", "Standard", "Premium"], var.aks_sku_tier)
    error_message = "aks_sku_tier must be Free, Standard or Premium."
  }
}

variable "api_server_authorized_ip_ranges" {
  description = "CIDRs allowed to reach the AKS API server. Empty = any address (still Entra ID authenticated). GitHub-hosted runners have no fixed IPs, so restrict only with self-hosted runners or a published runner range."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.api_server_authorized_ip_ranges : can(cidrhost(c, 0))])
    error_message = "api_server_authorized_ip_ranges must contain IPv4 CIDRs."
  }
}

variable "node_vm_size" {
  description = "VM size of the system node pool (which also runs the app)."
  type        = string
  default     = "Standard_D2ds_v5"
}

variable "node_count" {
  description = "Initial node count (and the fixed count when autoscaling is off)."
  type        = number
  default     = 2

  validation {
    condition     = var.node_count >= 1 && var.node_count <= 100
    error_message = "node_count must be between 1 and 100."
  }
}

variable "node_autoscaling" {
  description = "Enable the cluster autoscaler on the system node pool."
  type        = bool
  default     = true
}

variable "node_min_count" {
  description = "Autoscaler minimum."
  type        = number
  default     = 2

  validation {
    condition     = var.node_min_count >= 1
    error_message = "node_min_count must be at least 1."
  }
}

variable "node_max_count" {
  description = "Autoscaler maximum."
  type        = number
  default     = 4

  validation {
    condition     = var.node_max_count >= 1 && var.node_max_count <= 100
    error_message = "node_max_count must be between 1 and 100."
  }
}

variable "node_os_disk_size_gb" {
  description = "OS disk size per node (GB)."
  type        = number
  default     = 64

  validation {
    condition     = var.node_os_disk_size_gb >= 30
    error_message = "node_os_disk_size_gb must be at least 30."
  }
}

variable "node_os_disk_type" {
  description = "Node OS disk type. Ephemeral is faster and free but needs a VM size whose cache/temp disk holds node_os_disk_size_gb (e.g. Standard_D4ds_v5 with 64-100 GB)."
  type        = string
  default     = "Managed"

  validation {
    condition     = contains(["Managed", "Ephemeral"], var.node_os_disk_type)
    error_message = "node_os_disk_type must be Managed or Ephemeral."
  }
}

variable "availability_zones" {
  description = "Availability zones for the node pool. Empty for regions without zones."
  type        = list(string)
  default     = ["1", "2", "3"]

  validation {
    condition     = alltrue([for z in var.availability_zones : contains(["1", "2", "3"], z)])
    error_message = "availability_zones entries must be \"1\", \"2\" or \"3\"."
  }
}

variable "grant_deployer_cluster_admin" {
  description = "Give the principal running terraform the AKS RBAC Cluster Admin role (local accounts are disabled, so someone needs a data-plane role)."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# PostgreSQL Flexible Server
# ---------------------------------------------------------------------------

variable "postgres_sku_name" {
  description = "Flexible Server SKU, e.g. B_Standard_B2s (burstable, no HA), GP_Standard_D2ds_v5."
  type        = string
  default     = "GP_Standard_D2ds_v5"

  validation {
    condition     = can(regex("^(B|GP|MO)_Standard_", var.postgres_sku_name))
    error_message = "postgres_sku_name must start with B_Standard_, GP_Standard_ or MO_Standard_."
  }
}

variable "postgres_storage_mb" {
  description = "Allocated storage in MB (auto-grow is on)."
  type        = number
  default     = 32768

  validation {
    condition     = contains([32768, 65536, 131072, 262144, 524288, 1048576, 2097152, 4193280, 4194304, 8388608, 16777216, 33553408], var.postgres_storage_mb)
    error_message = "postgres_storage_mb must be one of the Flexible Server storage sizes (32768, 65536, 131072, ...)."
  }
}

variable "postgres_backup_retention_days" {
  description = "Point-in-time backup retention (7-35 days)."
  type        = number
  default     = 14

  validation {
    condition     = var.postgres_backup_retention_days >= 7 && var.postgres_backup_retention_days <= 35
    error_message = "postgres_backup_retention_days must be between 7 and 35."
  }
}

variable "postgres_geo_redundant_backup" {
  description = "Geo-redundant backups (only settable at create time)."
  type        = bool
  default     = false
}

variable "postgres_high_availability" {
  description = "Zone-redundant HA standby. Not available on burstable (B_) SKUs; roughly doubles database cost."
  type        = bool
  default     = false
}

variable "postgres_zone" {
  description = "Availability zone of the primary server; null lets Azure choose."
  type        = string
  default     = "1"
}

variable "postgres_database_name" {
  description = "Application database name."
  type        = string
  default     = "qbv"

  validation {
    condition     = can(regex("^[a-z_][a-z0-9_]{0,62}$", var.postgres_database_name))
    error_message = "postgres_database_name must be a lowercase Postgres identifier."
  }
}

variable "postgres_admin_login" {
  description = "Administrator login (also the app's login; the Flexible Server admin is not a superuser)."
  type        = string
  default     = "qbvadmin"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{2,62}$", var.postgres_admin_login)) && !contains(["admin", "administrator", "root", "postgres", "azure_superuser", "azure_pg_admin", "guest", "public"], var.postgres_admin_login)
    error_message = "postgres_admin_login must be a lowercase identifier and not a reserved name (admin, root, postgres, ...)."
  }
}

# ---------------------------------------------------------------------------
# Redis
# ---------------------------------------------------------------------------

variable "redis_service" {
  description = "\"managed\" = Azure Managed Redis (successor service, port 10000). \"cache\" = Azure Cache for Redis (Standard/Premium, port 6380; being retired, see README)."
  type        = string
  default     = "managed"

  validation {
    condition     = contains(["managed", "cache"], var.redis_service)
    error_message = "redis_service must be \"managed\" or \"cache\"."
  }
}

variable "redis_managed_sku_name" {
  description = "Azure Managed Redis SKU (redis_service = managed), e.g. Balanced_B0, Balanced_B1, Balanced_B3, MemoryOptimized_M10. Must be small enough for the NoCluster policy (<= 25 GB)."
  type        = string
  default     = "Balanced_B1"

  validation {
    condition     = can(regex("^(Balanced_B|MemoryOptimized_M|ComputeOptimized_X)[0-9]+$", var.redis_managed_sku_name))
    error_message = "redis_managed_sku_name must be a Balanced_B*, MemoryOptimized_M* or ComputeOptimized_X* SKU (Flash SKUs do not support noeviction workloads well)."
  }
}

variable "redis_high_availability" {
  description = "Azure Managed Redis replication/HA (redis_service = managed). Cache for Redis Standard/Premium always have a replica."
  type        = bool
  default     = true
}

variable "redis_persistence" {
  description = "Azure Managed Redis persistence (redis_service = managed): none, aof (every second) or rdb (hourly). The PostgreSQL command table is the system of record; persistence narrows the window of lost queued jobs on a full outage."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "aof", "rdb"], var.redis_persistence)
    error_message = "redis_persistence must be none, aof or rdb."
  }
}

variable "redis_cache_sku" {
  description = "Azure Cache for Redis tier (redis_service = cache): Standard or Premium."
  type        = string
  default     = "Standard"

  validation {
    condition     = contains(["Standard", "Premium"], var.redis_cache_sku)
    error_message = "redis_cache_sku must be Standard or Premium (Basic has no SLA/replica)."
  }
}

variable "redis_cache_capacity" {
  description = "Azure Cache for Redis size (redis_service = cache): C0-C6 for Standard, P1-P5 for Premium."
  type        = number
  default     = 1

  validation {
    condition     = var.redis_cache_capacity >= 0 && var.redis_cache_capacity <= 6
    error_message = "redis_cache_capacity must be between 0 and 6."
  }
}

# ---------------------------------------------------------------------------
# Container registry
# ---------------------------------------------------------------------------

variable "acr_sku" {
  description = "ACR tier. Premium adds a private endpoint for in-VNet pulls, untagged-manifest retention and IP rules; Standard is cheaper. Both are private (auth required, anonymous pull off)."
  type        = string
  default     = "Standard"

  validation {
    condition     = contains(["Standard", "Premium"], var.acr_sku)
    error_message = "acr_sku must be Standard or Premium."
  }
}

variable "acr_allowed_ip_ranges" {
  description = "Premium only: if non-empty, the registry's public endpoint is limited to these CIDRs (GitHub-hosted runners then cannot push). AKS pulls via the private endpoint."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.acr_allowed_ip_ranges : can(cidrhost(c, 0))])
    error_message = "acr_allowed_ip_ranges must contain IPv4 CIDRs."
  }
}

variable "acr_purge_enabled" {
  description = "Create a scheduled ACR task that purges old image tags under <name>/ (keeps the newest acr_purge_keep per repository)."
  type        = bool
  default     = true
}

variable "acr_purge_keep" {
  description = "Tags to keep per repository when purging."
  type        = number
  default     = 15

  validation {
    condition     = var.acr_purge_keep >= 1
    error_message = "acr_purge_keep must be at least 1."
  }
}

variable "acr_purge_older_than" {
  description = "Only purge tags older than this (acr purge --ago syntax, e.g. 30d, 2d3h)."
  type        = string
  default     = "30d"

  validation {
    condition     = can(regex("^([0-9]+d)?([0-9]+h)?([0-9]+m)?$", var.acr_purge_older_than)) && length(var.acr_purge_older_than) > 0
    error_message = "acr_purge_older_than must be a Go-style duration like 30d or 2d3h."
  }
}

# ---------------------------------------------------------------------------
# Key Vault
# ---------------------------------------------------------------------------

variable "key_vault_allowed_ip_ranges" {
  description = "If non-empty, the vault firewall denies everything except these CIDRs (and trusted Azure services). The terraform runner and GitHub runners must then be inside the list."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.key_vault_allowed_ip_ranges : can(cidrhost(c, 0))])
    error_message = "key_vault_allowed_ip_ranges must contain IPv4 CIDRs."
  }
}

variable "key_vault_soft_delete_retention_days" {
  description = "Soft-delete retention for the vault and its secrets (7-90). Purge protection keeps deleted vaults for this long."
  type        = number
  default     = 90

  validation {
    condition     = var.key_vault_soft_delete_retention_days >= 7 && var.key_vault_soft_delete_retention_days <= 90
    error_message = "key_vault_soft_delete_retention_days must be between 7 and 90."
  }
}
