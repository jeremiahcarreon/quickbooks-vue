# Alphanumeric only: it is embedded in DATABASE_URL without escaping surprises.
resource "random_password" "postgres" {
  length  = 40
  special = false
}

resource "azurerm_postgresql_flexible_server" "main" {
  name                = "psql-${local.prefix}-${local.suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  version             = "16"
  sku_name            = var.postgres_sku_name
  storage_mb          = var.postgres_storage_mb
  auto_grow_enabled   = true
  zone                = var.postgres_zone
  tags                = local.tags

  # Private access (VNet integration): no public endpoint at all.
  delegated_subnet_id           = azurerm_subnet.postgres.id
  private_dns_zone_id           = azurerm_private_dns_zone.zones["postgres"].id
  public_network_access_enabled = false

  administrator_login    = var.postgres_admin_login
  administrator_password = random_password.postgres.result

  authentication {
    password_auth_enabled         = true
    active_directory_auth_enabled = false
  }

  backup_retention_days        = var.postgres_backup_retention_days
  geo_redundant_backup_enabled = var.postgres_geo_redundant_backup

  dynamic "high_availability" {
    for_each = var.postgres_high_availability ? [1] : []
    content {
      mode = "ZoneRedundant"
    }
  }

  maintenance_window {
    day_of_week  = 0 # Sunday
    start_hour   = 4
    start_minute = 0
  }

  lifecycle {
    # Azure may swap primary/standby zones after a failover.
    ignore_changes = [zone, high_availability[0].standby_availability_zone]

    precondition {
      condition     = !(var.postgres_high_availability && startswith(var.postgres_sku_name, "B_"))
      error_message = "High availability is not supported on burstable (B_) PostgreSQL SKUs."
    }
  }

  depends_on = [
    azurerm_private_dns_zone_virtual_network_link.zones,
    azurerm_subnet_network_security_group_association.postgres,
  ]
}

resource "azurerm_postgresql_flexible_server_database" "app" {
  name      = var.postgres_database_name
  server_id = azurerm_postgresql_flexible_server.main.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# TLS required for every connection (the app sets DATABASE_SSL=true).
resource "azurerm_postgresql_flexible_server_configuration" "require_secure_transport" {
  name      = "require_secure_transport"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "ON"
}

resource "azurerm_postgresql_flexible_server_configuration" "min_tls" {
  name      = "ssl_min_protocol_version"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "TLSv1.2"
}

resource "azurerm_postgresql_flexible_server_configuration" "log_connections" {
  name      = "log_connections"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "on"
}

resource "azurerm_postgresql_flexible_server_configuration" "log_disconnections" {
  name      = "log_disconnections"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "on"
}

resource "azurerm_postgresql_flexible_server_configuration" "log_checkpoints" {
  name      = "log_checkpoints"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "on"
}

resource "azurerm_postgresql_flexible_server_configuration" "connection_throttling" {
  name      = "connection_throttle.enable"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "on"
}

locals {
  database_url = format(
    "postgres://%s:%s@%s:5432/%s",
    urlencode(var.postgres_admin_login),
    urlencode(random_password.postgres.result),
    azurerm_postgresql_flexible_server.main.fqdn,
    var.postgres_database_name,
  )
}
