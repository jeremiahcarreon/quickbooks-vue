###############################################################################
# Shared contract (same names in the aws, gcp and azure modules)
###############################################################################

variable "name" {
  description = "Short name prefix for every resource. Also the ECR namespace: images live at <account>.dkr.ecr.<region>.amazonaws.com/<name>/<service>."
  type        = string
  default     = "qbv"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,14}[a-z0-9]$", var.name))
    error_message = "name must be 3-16 characters: lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen."
  }
}

variable "environment" {
  description = "Environment name (prod, staging, ...). Used in resource names and the app secret name <name>-<environment>-app."
  type        = string
  default     = "prod"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,14}[a-z0-9]$", var.environment))
    error_message = "environment must be 2-16 characters: lowercase letters, digits and hyphens."
  }
}

variable "region" {
  description = "AWS region to deploy into, e.g. us-east-1."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$", var.region))
    error_message = "region must be an AWS region code such as us-east-1 or eu-west-2."
  }
}

variable "github_repository" {
  description = "GitHub repository (owner/name) whose Actions workflows may assume the push and deploy roles."
  type        = string
  default     = "jeremiahcarreon/quickbooks-vue"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must look like owner/repo."
  }
}

variable "github_environments" {
  description = "GitHub deployment environments allowed to assume the deploy role (OIDC subject repo:<repo>:environment:<env>)."
  type        = list(string)
  default     = ["prod"]

  validation {
    condition     = length(var.github_environments) > 0 && alltrue([for e in var.github_environments : can(regex("^[A-Za-z0-9_.-]+$", e))])
    error_message = "github_environments must be a non-empty list of environment names (letters, digits, _ . -)."
  }
}

variable "relay_api_key" {
  description = "API key for the Windows QuickBooks relay (sent as X-Api-Key). Stored in the app secret as RELAY_API_KEY. Pass it with TF_VAR_relay_api_key rather than editing the secret by hand, because Terraform owns the secret value."
  type        = string
  default     = ""
  sensitive   = true
}

variable "kubernetes_version" {
  description = "EKS Kubernetes version (major.minor)."
  type        = string
  default     = "1.36"

  validation {
    condition     = can(regex("^1\\.[0-9]{2}$", var.kubernetes_version))
    error_message = "kubernetes_version must look like 1.36."
  }
}

variable "deletion_protection" {
  description = "Protect the database, cluster, registry and secret from deletion. Set to false and apply before terraform destroy."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Extra tags applied to every resource (merged with Project, Environment and ManagedBy)."
  type        = map(string)
  default     = {}
}

###############################################################################
# Network
###############################################################################

variable "vpc_cidr" {
  description = "VPC CIDR. Must be a /16 or larger: private node subnets are /20s, public, database and cache subnets are /24s."
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) <= 16
    error_message = "vpc_cidr must be a valid IPv4 CIDR with a prefix of /16 or shorter."
  }
}

variable "az_count" {
  description = "Number of availability zones to spread subnets across (2 or 3)."
  type        = number
  default     = 2

  validation {
    condition     = contains([2, 3], var.az_count)
    error_message = "az_count must be 2 or 3."
  }
}

variable "single_nat_gateway" {
  description = "Use one shared NAT gateway (cheaper) instead of one per AZ (survives an AZ outage)."
  type        = bool
  default     = true
}

variable "enable_vpc_flow_logs" {
  description = "Send VPC flow logs to CloudWatch Logs."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "CloudWatch retention for VPC flow logs and EKS control-plane logs."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a CloudWatch Logs retention value (1, 3, 5, 7, 14, 30, 60, 90, ...)."
  }
}

###############################################################################
# EKS
###############################################################################

variable "cluster_endpoint_public_access" {
  description = "Expose the EKS API endpoint publicly (needed for GitHub-hosted runners unless you use self-hosted runners inside the VPC). The private endpoint is always on."
  type        = bool
  default     = true
}

variable "cluster_endpoint_public_access_cidrs" {
  description = "CIDRs allowed to reach the public EKS API endpoint. Narrow this to your office/VPN and runner ranges when you can."
  type        = list(string)
  default     = ["0.0.0.0/0"]

  validation {
    condition     = alltrue([for c in var.cluster_endpoint_public_access_cidrs : can(cidrhost(c, 0))])
    error_message = "cluster_endpoint_public_access_cidrs must be a list of valid IPv4 CIDRs."
  }
}

variable "cluster_admin_principal_arns" {
  description = "Extra IAM principal ARNs (users or roles) granted cluster-admin through EKS access entries. The identity running Terraform is always granted admin."
  type        = list(string)
  default     = []
}

variable "deploy_access_scope" {
  description = "EKS access granted to the GitHub deploy role: \"cluster\" (AmazonEKSClusterAdminPolicy; works with helm --create-namespace) or \"namespace\" (AmazonEKSAdminPolicy limited to kubernetes_namespace, which must already exist)."
  type        = string
  default     = "cluster"

  validation {
    condition     = contains(["cluster", "namespace"], var.deploy_access_scope)
    error_message = "deploy_access_scope must be \"cluster\" or \"namespace\"."
  }
}

variable "kubernetes_namespace" {
  description = "Namespace the Helm chart is installed into. Used when deploy_access_scope = \"namespace\"."
  type        = string
  default     = "qbv"

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$", var.kubernetes_namespace))
    error_message = "kubernetes_namespace must be a valid Kubernetes namespace name."
  }
}

variable "enable_ebs_csi_driver" {
  description = "Install the aws-ebs-csi-driver addon (with an IAM role via EKS Pod Identity) so PersistentVolumeClaims work. The app itself is stateless; enable it for relay-mock persistence or other stateful add-ons."
  type        = bool
  default     = true
}

variable "node_instance_types" {
  description = "EC2 instance types for the managed node group. Must match node_ami_type's architecture."
  type        = list(string)
  default     = ["t3.medium"]

  validation {
    condition     = length(var.node_instance_types) > 0
    error_message = "node_instance_types must list at least one instance type."
  }
}

variable "node_ami_type" {
  description = "EKS managed node group AMI type, e.g. AL2023_x86_64_STANDARD or AL2023_ARM_64_STANDARD (for Graviton instance types)."
  type        = string
  default     = "AL2023_x86_64_STANDARD"
}

variable "node_capacity_type" {
  description = "ON_DEMAND or SPOT. SPOT interrupts the single worker replica mid relay call; keep ON_DEMAND for prod."
  type        = string
  default     = "ON_DEMAND"

  validation {
    condition     = contains(["ON_DEMAND", "SPOT"], var.node_capacity_type)
    error_message = "node_capacity_type must be ON_DEMAND or SPOT."
  }
}

variable "node_min_size" {
  description = "Minimum nodes in the managed node group."
  type        = number
  default     = 2

  validation {
    condition     = var.node_min_size >= 1
    error_message = "node_min_size must be at least 1."
  }
}

variable "node_desired_size" {
  description = "Initial node count (the module ignores later changes so an autoscaler can own it)."
  type        = number
  default     = 2
}

variable "node_max_size" {
  description = "Maximum nodes in the managed node group."
  type        = number
  default     = 4
}

variable "node_disk_size_gb" {
  description = "Root EBS volume size per node, in GiB (gp3, encrypted)."
  type        = number
  default     = 40

  validation {
    condition     = var.node_disk_size_gb >= 20
    error_message = "node_disk_size_gb must be at least 20."
  }
}

###############################################################################
# PostgreSQL (RDS)
###############################################################################

variable "db_engine_version" {
  description = "RDS PostgreSQL engine version. A major version (\"16\") lets AWS pick and auto-upgrade the minor version."
  type        = string
  default     = "16"

  validation {
    condition     = can(regex("^16(\\.[0-9]+)?$", var.db_engine_version))
    error_message = "db_engine_version must be PostgreSQL 16 (\"16\" or \"16.x\"); the parameter group family is postgres16."
  }
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.small"
}

variable "db_allocated_storage_gb" {
  description = "Initial RDS storage in GiB (gp3)."
  type        = number
  default     = 20

  validation {
    condition     = var.db_allocated_storage_gb >= 20
    error_message = "db_allocated_storage_gb must be at least 20."
  }
}

variable "db_max_allocated_storage_gb" {
  description = "Upper bound for RDS storage autoscaling in GiB (0 disables autoscaling)."
  type        = number
  default     = 100
}

variable "db_multi_az" {
  description = "Run RDS as Multi-AZ (standby in a second AZ; roughly doubles the DB cost)."
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Days of automated RDS backups (point-in-time recovery window)."
  type        = number
  default     = 7

  validation {
    condition     = var.db_backup_retention_days >= 1 && var.db_backup_retention_days <= 35
    error_message = "db_backup_retention_days must be between 1 and 35."
  }
}

variable "db_name" {
  description = "Database created in the RDS instance."
  type        = string
  default     = "qbv"
}

variable "db_username" {
  description = "Master username for RDS (the app connects as this user)."
  type        = string
  default     = "qbv"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{0,62}$", var.db_username)) && !contains(["admin", "postgres", "rdsadmin"], var.db_username)
    error_message = "db_username must be a lowercase identifier and not a reserved name (admin, postgres, rdsadmin)."
  }
}

###############################################################################
# Redis (ElastiCache)
###############################################################################

variable "redis_engine_version" {
  description = "ElastiCache Redis OSS engine version (7.x; parameter group family redis7)."
  type        = string
  default     = "7.1"

  validation {
    condition     = can(regex("^7\\.[0-9]+$", var.redis_engine_version))
    error_message = "redis_engine_version must be a Redis 7 version such as 7.1."
  }
}

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.small"
}

variable "redis_num_cache_clusters" {
  description = "Nodes in the Redis replication group (1 = primary only; 2+ enables a replica with automatic failover and Multi-AZ)."
  type        = number
  default     = 1

  validation {
    condition     = var.redis_num_cache_clusters >= 1 && var.redis_num_cache_clusters <= 6
    error_message = "redis_num_cache_clusters must be between 1 and 6."
  }
}

variable "redis_snapshot_retention_days" {
  description = "Days of automatic Redis snapshots (0 disables). The queue is rebuildable but in-flight jobs are lost without it."
  type        = number
  default     = 3
}

###############################################################################
# Registry
###############################################################################

variable "ecr_mutable_tags" {
  description = "Tag patterns (ECR wildcard filters) that may be overwritten; every other tag is immutable. Empty list = fully IMMUTABLE."
  type        = list(string)
  default     = ["latest", "master", "buildcache*"]
}

variable "ecr_keep_tagged_images" {
  description = "Tagged images kept per repository; older ones are expired by the lifecycle policy."
  type        = number
  default     = 50

  validation {
    condition     = var.ecr_keep_tagged_images >= 5
    error_message = "ecr_keep_tagged_images must be at least 5 so rollbacks stay possible."
  }
}

###############################################################################
# GitHub Actions OIDC
###############################################################################

variable "create_github_oidc_provider" {
  description = "Create the token.actions.githubusercontent.com IAM OIDC provider. Set false if the account already has one (an account can hold only one per URL)."
  type        = bool
  default     = true
}

variable "github_oidc_provider_arn" {
  description = "ARN of an existing GitHub OIDC provider, used when create_github_oidc_provider = false. Empty = look it up by URL."
  type        = string
  default     = ""
}

variable "github_push_branch" {
  description = "Branch allowed to push images (OIDC subject repo:<repo>:ref:refs/heads/<branch>)."
  type        = string
  default     = "master"
}
