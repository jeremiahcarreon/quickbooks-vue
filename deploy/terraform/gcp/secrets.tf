# App secret <name>-<environment>-app: one JSON document. The deploy workflow
# reads the latest version and turns it into the Kubernetes Secret "qbv-env".

resource "random_password" "session" {
  length  = 64
  special = false
}

locals {
  database_url = format(
    "postgres://%s:%s@%s:5432/%s",
    google_sql_user.app.name,
    random_password.db.result,
    google_sql_database_instance.postgres.private_ip_address,
    google_sql_database.app.name,
  )

  redis_url = format(
    "redis://:%s@%s:%d/0",
    google_redis_instance.this.auth_string,
    google_redis_instance.this.host,
    google_redis_instance.this.port,
  )

  app_secret = {
    DATABASE_URL   = local.database_url
    DATABASE_SSL   = "true"
    REDIS_URL      = local.redis_url
    SESSION_SECRET = random_password.session.result
    RELAY_API_KEY  = var.relay_api_key
  }
}

resource "google_secret_manager_secret" "app" {
  secret_id = "${local.prefix}-app"

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.this]
}

resource "google_secret_manager_secret_version" "app" {
  secret      = google_secret_manager_secret.app.id
  secret_data = jsonencode(local.app_secret)
}
