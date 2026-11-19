# PostgreSQL 16 (RDS) and Redis 7 (ElastiCache), both private and reachable
# only from the EKS nodes (pods use the node security groups with the VPC CNI).

locals {
  # Security groups attached to EKS nodes: the module's node SG and the
  # cluster primary SG (used by EKS-managed ENIs).
  app_source_security_group_ids = {
    node    = module.eks.node_security_group_id
    primary = module.eks.cluster_primary_security_group_id
  }
}

###############################################################################
# PostgreSQL
###############################################################################

# Alphanumeric only, so it is safe inside DATABASE_URL without escaping.
resource "random_password" "db" {
  length  = 40
  special = false
}

resource "aws_security_group" "db" {
  name        = "${local.prefix}-db"
  description = "PostgreSQL: allow 5432 from EKS nodes only"
  vpc_id      = module.vpc.vpc_id

  tags = { Name = "${local.prefix}-db" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_nodes" {
  for_each = local.app_source_security_group_ids

  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from EKS ${each.key} security group"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = each.value
}

resource "aws_db_parameter_group" "postgres" {
  name_prefix = "${local.prefix}-pg16-"
  family      = "postgres16"
  description = "QuickBooks Vue PostgreSQL 16: TLS required"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# The app authenticates with a password from DATABASE_URL (node-postgres has no
# IAM token refresh); IAM database auth would be unused attack surface.
#trivy:ignore:AVD-AWS-0176
resource "aws_db_instance" "postgres" {
  identifier = "${local.prefix}-pg"

  engine                     = "postgres"
  engine_version             = var.db_engine_version
  auto_minor_version_upgrade = true
  instance_class             = var.db_instance_class

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db.result
  port     = 5432

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_max_allocated_storage_gb > 0 ? var.db_max_allocated_storage_gb : null
  storage_type          = "gp3"
  storage_encrypted     = true

  multi_az               = var.db_multi_az
  db_subnet_group_name   = module.vpc.database_subnet_group_name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.postgres.name

  backup_retention_period  = var.db_backup_retention_days
  backup_window            = "07:00-08:00"
  maintenance_window       = "sun:08:30-sun:09:30"
  copy_tags_to_snapshot    = true
  delete_automated_backups = !var.deletion_protection

  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = !var.deletion_protection
  final_snapshot_identifier = "${local.prefix}-pg-final"

  performance_insights_enabled          = true
  performance_insights_retention_period = 7
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]

  iam_database_authentication_enabled = false
  apply_immediately                   = false

  tags = { Name = "${local.prefix}-pg" }
}

###############################################################################
# Redis
###############################################################################

# ElastiCache AUTH tokens allow printable ASCII except @ " /; alphanumeric keeps
# REDIS_URL valid without escaping.
resource "random_password" "redis" {
  length  = 64
  special = false
}

resource "aws_security_group" "redis" {
  name        = "${local.prefix}-redis"
  description = "Redis: allow 6379 from EKS nodes only"
  vpc_id      = module.vpc.vpc_id

  tags = { Name = "${local.prefix}-redis" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_nodes" {
  for_each = local.app_source_security_group_ids

  security_group_id            = aws_security_group.redis.id
  description                  = "Redis from EKS ${each.key} security group"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = each.value
}

resource "aws_elasticache_parameter_group" "redis" {
  name        = "${local.prefix}-redis7"
  family      = "redis7"
  description = "QuickBooks Vue Redis 7: noeviction for BullMQ"

  # BullMQ stores jobs as keys; eviction would silently drop queued commands.
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "${local.prefix}-redis"
  description          = "QuickBooks Vue BullMQ queue and pub/sub"

  engine               = "redis"
  engine_version       = var.redis_engine_version
  node_type            = var.redis_node_type
  port                 = 6379
  parameter_group_name = aws_elasticache_parameter_group.redis.name

  # Cluster mode disabled: BullMQ needs multi-key operations on one shard.
  num_cache_clusters         = var.redis_num_cache_clusters
  automatic_failover_enabled = var.redis_num_cache_clusters > 1
  multi_az_enabled           = var.redis_num_cache_clusters > 1

  subnet_group_name  = module.vpc.elasticache_subnet_group_name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  auth_token                 = random_password.redis.result
  auth_token_update_strategy = "ROTATE"

  snapshot_retention_limit = var.redis_snapshot_retention_days
  snapshot_window          = "06:00-07:00"
  maintenance_window       = "sun:09:30-sun:10:30"

  auto_minor_version_upgrade = true
  apply_immediately          = false

  final_snapshot_identifier = var.deletion_protection ? "${local.prefix}-redis-final" : null

  tags = { Name = "${local.prefix}-redis" }
}
