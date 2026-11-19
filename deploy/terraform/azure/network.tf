# VNet layout (default 10.40.0.0/16):
#   snet-aks        /22  AKS nodes (pods use the overlay pod_cidr, SNAT to node IPs)
#   snet-postgres   /24  delegated to PostgreSQL Flexible Server
#   snet-endpoints  /24  private endpoints (Redis, ACR when Premium)
# Room is left for a GatewaySubnet / Tailscale subnet router if you add one.

locals {
  subnet_aks       = cidrsubnet(var.vnet_cidr, 22 - tonumber(split("/", var.vnet_cidr)[1]), 0)
  subnet_postgres  = cidrsubnet(var.vnet_cidr, 24 - tonumber(split("/", var.vnet_cidr)[1]), 8)
  subnet_endpoints = cidrsubnet(var.vnet_cidr, 24 - tonumber(split("/", var.vnet_cidr)[1]), 9)
}

resource "azurerm_virtual_network" "main" {
  name                = "vnet-${local.prefix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = [var.vnet_cidr]
  tags                = local.tags
}

resource "azurerm_subnet" "aks" {
  name                 = "snet-aks"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [local.subnet_aks]
}

resource "azurerm_subnet" "postgres" {
  name                 = "snet-postgres"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [local.subnet_postgres]

  delegation {
    name = "postgres-flexible"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "endpoints" {
  name                              = "snet-endpoints"
  resource_group_name               = azurerm_resource_group.main.name
  virtual_network_name              = azurerm_virtual_network.main.name
  address_prefixes                  = [local.subnet_endpoints]
  private_endpoint_network_policies = "Enabled" # make the NSG below apply to private endpoints
}

# ---------------------------------------------------------------------------
# NSGs: only the AKS subnet may reach the database and the private endpoints.
# (AKS manages the NSG on its own node NICs.)
# ---------------------------------------------------------------------------

resource "azurerm_network_security_group" "postgres" {
  name                = "nsg-${local.prefix}-postgres"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags

  security_rule {
    name                       = "allow-aks-postgres"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_address_prefix      = local.subnet_aks
    source_port_range          = "*"
    destination_address_prefix = local.subnet_postgres
    destination_port_range     = "5432"
  }

  # HA standby replication within the delegated subnet.
  security_rule {
    name                       = "allow-postgres-intra-subnet"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "*"
    source_address_prefix      = local.subnet_postgres
    source_port_range          = "*"
    destination_address_prefix = local.subnet_postgres
    destination_port_range     = "*"
  }

  security_rule {
    name                       = "deny-vnet-inbound"
    priority                   = 4000
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_address_prefix      = "VirtualNetwork"
    source_port_range          = "*"
    destination_address_prefix = "*"
    destination_port_range     = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "postgres" {
  subnet_id                 = azurerm_subnet.postgres.id
  network_security_group_id = azurerm_network_security_group.postgres.id
}

resource "azurerm_network_security_group" "endpoints" {
  name                = "nsg-${local.prefix}-endpoints"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags

  # 10000 = Azure Managed Redis, 6380 = Azure Cache for Redis (TLS), 443 = ACR.
  security_rule {
    name                       = "allow-aks-endpoints"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_address_prefix      = local.subnet_aks
    source_port_range          = "*"
    destination_address_prefix = local.subnet_endpoints
    destination_port_ranges    = ["443", "6380", "10000"]
  }

  security_rule {
    name                       = "deny-vnet-inbound"
    priority                   = 4000
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_address_prefix      = "VirtualNetwork"
    source_port_range          = "*"
    destination_address_prefix = "*"
    destination_port_range     = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "endpoints" {
  subnet_id                 = azurerm_subnet.endpoints.id
  network_security_group_id = azurerm_network_security_group.endpoints.id
}

# ---------------------------------------------------------------------------
# Private DNS zones, linked to the VNet so AKS resolves the private addresses.
# ---------------------------------------------------------------------------

locals {
  private_dns_zones = merge(
    {
      # Flexible Server VNet integration needs a zone ending in .postgres.database.azure.com.
      postgres = "${local.prefix}.private.postgres.database.azure.com"
      redis    = var.redis_service == "managed" ? "privatelink.redis.azure.net" : "privatelink.redis.cache.windows.net"
    },
    var.acr_sku == "Premium" ? { acr = "privatelink.azurecr.io" } : {},
  )
}

resource "azurerm_private_dns_zone" "zones" {
  for_each            = local.private_dns_zones
  name                = each.value
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "zones" {
  for_each              = local.private_dns_zones
  name                  = "link-${each.key}-${local.prefix}"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.zones[each.key].name
  virtual_network_id    = azurerm_virtual_network.main.id
  registration_enabled  = false
  tags                  = local.tags
}
