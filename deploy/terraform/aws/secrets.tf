# Application secret consumed by the deploy workflow:
#   aws secretsmanager get-secret-value --secret-id <app_secret_id>
# The JSON keys become the Kubernetes Secret qbv-env.
#
# The values are also in Terraform state; keep the state backend encrypted
# and access-controlled (see backend.tf.example).

resource "random_password" "session_secret" {
  length  = 64
  special = false
}

locals {
  database_url = format(
    "postgres://%s:%s@%s:%d/%s",
    var.db_username,
    random_password.db.result,
    aws_db_instance.postgres.address,
    aws_db_instance.postgres.port,
    var.db_name,
  )

  redis_url = format(
    "rediss://:%s@%s:%d",
    random_password.redis.result,
    aws_elasticache_replication_group.redis.primary_endpoint_address,
    aws_elasticache_replication_group.redis.port,
  )
}

resource "aws_secretsmanager_secret" "app" {
  name        = "${local.prefix}-app"
  description = "QuickBooks Vue ${var.environment} app environment (k8s Secret qbv-env)"

  # With deletion protection the secret is recoverable for 30 days after a
  # destroy; without it, it is deleted immediately so the name can be reused.
  recovery_window_in_days = var.deletion_protection ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    DATABASE_URL   = local.database_url
    DATABASE_SSL   = "true"
    REDIS_URL      = local.redis_url
    SESSION_SECRET = random_password.session_secret.result
    RELAY_API_KEY  = var.relay_api_key
  })
}
