# BullMQ requires maxmemory-policy noeviction. Two implementations:
#   managed (default): Azure Managed Redis, TLS on port 10000, NoCluster policy so
#                      ioredis/BullMQ talk to a single non-clustered endpoint.
#   cache:             Azure Cache for Redis Standard/Premium, TLS on port 6380.
# Both: TLS only, access-key auth, public network access disabled, private endpoint.

locals {
  redis_managed = var.redis_service == "managed"
}

resource "azurerm_managed_redis" "main" {
  count               = local.redis_managed ? 1 : 0
  name                = "redis-${local.prefix}-${local.suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku_name            = var.redis_managed_sku_name

  high_availability_enabled = var.redis_high_availability
  public_network_access     = "Disabled"
  tags                      = local.tags

  default_database {
    client_protocol                    = "Encrypted"
    clustering_policy                  = "NoCluster"
    eviction_policy                    = "NoEviction"
    access_keys_authentication_enabled = true

    persistence_append_only_file_backup_frequency = var.redis_persistence == "aof" ? "1s" : null
    persistence_redis_database_backup_frequency   = var.redis_persistence == "rdb" ? "1h" : null
  }
}

resource "azurerm_redis_cache" "main" {
  count               = local.redis_managed ? 0 : 1
  name                = "redis-${local.prefix}-${local.suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku_name            = var.redis_cache_sku
  family              = var.redis_cache_sku == "Premium" ? "P" : "C"
  capacity            = var.redis_cache_capacity
  redis_version       = "6"
  tags                = local.tags

  non_ssl_port_enabled               = false
  minimum_tls_version                = "1.2"
  public_network_access_enabled      = false
  access_keys_authentication_enabled = true

  redis_configuration {
    maxmemory_policy = "noeviction"
  }

  lifecycle {
    precondition {
      condition     = var.redis_cache_sku == "Standard" || var.redis_cache_capacity >= 1
      error_message = "Premium Azure Cache for Redis capacity must be 1-5 (P1-P5)."
    }
  }
}

locals {
  redis_hostname = local.redis_managed ? azurerm_managed_redis.main[0].hostname : azurerm_redis_cache.main[0].hostname
  redis_port     = local.redis_managed ? azurerm_managed_redis.main[0].default_database[0].port : azurerm_redis_cache.main[0].ssl_port
  redis_key      = local.redis_managed ? azurerm_managed_redis.main[0].default_database[0].primary_access_key : azurerm_redis_cache.main[0].primary_access_key
  redis_id       = local.redis_managed ? azurerm_managed_redis.main[0].id : azurerm_redis_cache.main[0].id

  # ioredis: rediss:// = TLS. The key is base64 (+ / =), so it must be escaped.
  redis_url = format("rediss://:%s@%s:%d", urlencode(local.redis_key), local.redis_hostname, local.redis_port)
}

resource "azurerm_private_endpoint" "redis" {
  name                = "pe-${local.prefix}-redis"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  subnet_id           = azurerm_subnet.endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "psc-${local.prefix}-redis"
    private_connection_resource_id = local.redis_id
    subresource_names              = [local.redis_managed ? "redisEnterprise" : "redisCache"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "redis"
    private_dns_zone_ids = [azurerm_private_dns_zone.zones["redis"].id]
  }

  depends_on = [azurerm_subnet_network_security_group_association.endpoints]
}
