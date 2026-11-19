# ---------------------------------------------------------------------------
# Cloud SQL for PostgreSQL 16: private IP only, TLS required, backups + PITR.
# The app connects with DATABASE_SSL=true (TLS, server cert not verified), so
# ssl_mode ENCRYPTED_ONLY is the right setting: TLS mandatory, no client certs.
# ---------------------------------------------------------------------------

resource "random_id" "db_suffix" {
  # Cloud SQL instance names cannot be reused for about a week after deletion.
  byte_length = 3
}

resource "random_password" "db" {
  length  = 40
  special = false # keeps DATABASE_URL free of characters that need escaping
}

resource "google_sql_database_instance" "postgres" {
  #checkov:skip=CKV_GCP_6:ssl_mode = ENCRYPTED_ONLY rejects non-TLS connections; checkov only recognises the deprecated require_ssl / client-cert modes.
  #checkov:skip=CKV_GCP_79:The app targets PostgreSQL 16 (matches compose.yaml); bump deliberately.
  #checkov:skip=CKV_GCP_110:pgAudit is optional; enable cloudsql.enable_pgaudit if your compliance needs it.
  #checkov:skip=CKV_GCP_108:log_hostname makes Postgres do a reverse DNS lookup per connection; private IPs only.
  #checkov:skip=CKV_GCP_109:log_min_messages left at the Postgres default (warning).
  #checkov:skip=CKV2_GCP_13:log_duration logs every statement; too noisy for the sync workload.

  name                = "${local.prefix}-pg-${random_id.db_suffix.hex}"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = var.deletion_protection

  settings {
    edition                     = "ENTERPRISE"
    tier                        = var.db_tier
    availability_type           = var.db_high_availability ? "REGIONAL" : "ZONAL"
    disk_type                   = "PD_SSD"
    disk_size                   = var.db_disk_size_gb
    disk_autoresize             = true
    deletion_protection_enabled = var.deletion_protection
    user_labels                 = local.labels

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.vpc.id
      allocated_ip_range                            = google_compute_global_address.private_services.name
      ssl_mode                                      = "ENCRYPTED_ONLY"
      enable_private_path_for_google_cloud_services = false
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "03:00"
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = var.db_pitr_days

      backup_retention_settings {
        retained_backups = var.db_backup_retention_count
        retention_unit   = "COUNT"
      }
    }

    maintenance_window {
      day          = 7 # Sunday
      hour         = 5
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled  = true
      record_application_tags = false
      record_client_address   = false
    }

    database_flags {
      name  = "log_checkpoints"
      value = "on"
    }
    database_flags {
      name  = "log_connections"
      value = "on"
    }
    database_flags {
      name  = "log_disconnections"
      value = "on"
    }
    database_flags {
      name  = "log_lock_waits"
      value = "on"
    }
    database_flags {
      name  = "log_statement"
      value = "ddl"
    }
    database_flags {
      name  = "log_temp_files"
      value = "0"
    }
    database_flags {
      name  = "log_min_duration_statement"
      value = "-1"
    }
  }

  depends_on = [google_service_networking_connection.private_services]
}

resource "google_sql_database" "app" {
  name     = var.db_name
  instance = google_sql_database_instance.postgres.name
}

resource "google_sql_user" "app" {
  name     = var.db_user
  instance = google_sql_database_instance.postgres.name
  password = random_password.db.result
}

# ---------------------------------------------------------------------------
# Memorystore for Redis 7 (BullMQ): AUTH on, noeviction, private service access.
#
# Transit encryption is DISABLED on purpose. With SERVER_AUTHENTICATION,
# Memorystore presents a certificate signed by a per-instance private CA.
# The app builds ioredis from REDIS_URL with no TLS options, so rediss://
# verifies against Node's public CA bundle and the handshake fails. Making it
# work needs the instance CA (server_ca_certs) mounted into every pod plus
# NODE_EXTRA_CA_CERTS, and the cert's name must match the address used. Until
# the chart does that, traffic stays on the private VPC peering (never
# internet-routed) and AUTH guards access. See README "Redis TLS".
# ---------------------------------------------------------------------------

resource "google_redis_instance" "this" {
  #checkov:skip=CKV_GCP_97:Transit encryption needs a custom CA in the app's Redis client; see the comment above.

  name           = "${local.prefix}-redis"
  region         = var.region
  tier           = var.redis_tier
  memory_size_gb = var.redis_memory_size_gb
  redis_version  = var.redis_version

  connect_mode       = "PRIVATE_SERVICE_ACCESS"
  authorized_network = google_compute_network.vpc.id
  reserved_ip_range  = google_compute_global_address.private_services.name

  auth_enabled            = true
  transit_encryption_mode = "DISABLED" # see the comment above

  redis_configs = {
    "maxmemory-policy" = "noeviction"
  }

  persistence_config {
    persistence_mode    = "RDB"
    rdb_snapshot_period = "ONE_HOUR"
  }

  maintenance_policy {
    weekly_maintenance_window {
      day = "SUNDAY"
      start_time {
        hours   = 6
        minutes = 0
      }
    }
  }

  depends_on = [google_service_networking_connection.private_services]
}
