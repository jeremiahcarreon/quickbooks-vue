# Private registry for the Intuit-derived images (qbXML XSDs are baked in), so
# they are never published anywhere public: admin user off, anonymous pull off,
# pushes only via the GitHub OIDC identity (AcrPush), pulls via the AKS kubelet
# identity (AcrPull).

locals {
  acr_premium = var.acr_sku == "Premium"
}

resource "azurerm_container_registry" "main" {
  name                = "acr${var.name}${var.environment}${local.suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = var.acr_sku
  tags                = local.tags

  admin_enabled          = false
  anonymous_pull_enabled = false

  # GitHub-hosted runners push over the public endpoint (Entra ID auth only).
  # With Premium + acr_allowed_ip_ranges it is restricted to those CIDRs.
  public_network_access_enabled = true
  network_rule_bypass_option    = "AzureServices"

  # Premium only: drop untagged manifests (left behind by re-pushed tags) after 7 days.
  retention_policy_in_days = local.acr_premium ? 7 : null

  dynamic "network_rule_set" {
    for_each = local.acr_premium && length(var.acr_allowed_ip_ranges) > 0 ? [1] : []
    content {
      default_action = "Deny"
      dynamic "ip_rule" {
        for_each = var.acr_allowed_ip_ranges
        content {
          action   = "Allow"
          ip_range = ip_rule.value
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = local.acr_premium || length(var.acr_allowed_ip_ranges) == 0
      error_message = "acr_allowed_ip_ranges needs acr_sku = \"Premium\"."
    }
  }
}

# Premium: AKS pulls over a private endpoint inside the VNet.
resource "azurerm_private_endpoint" "acr" {
  count               = local.acr_premium ? 1 : 0
  name                = "pe-${local.prefix}-acr"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  subnet_id           = azurerm_subnet.endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "psc-${local.prefix}-acr"
    private_connection_resource_id = azurerm_container_registry.main.id
    subresource_names              = ["registry"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "acr"
    private_dns_zone_ids = [azurerm_private_dns_zone.zones["acr"].id]
  }

  depends_on = [azurerm_subnet_network_security_group_association.endpoints]
}

# Weekly purge of old tags under <name>/ (any tier). Keeps the newest
# acr_purge_keep tags per repository and anything younger than acr_purge_older_than.
resource "azurerm_container_registry_task" "purge" {
  count                 = var.acr_purge_enabled ? 1 : 0
  name                  = "purge-old-images"
  container_registry_id = azurerm_container_registry.main.id
  tags                  = local.tags

  platform {
    os = "Linux"
  }

  encoded_step {
    task_content = base64encode(<<-YAML
      version: v1.1.0
      steps:
        - cmd: acr purge --filter '${var.name}/.*:.*' --ago ${var.acr_purge_older_than} --keep ${var.acr_purge_keep} --untagged
          disableWorkingDirectoryOverride: true
          timeout: 3600
    YAML
    )
  }

  timer_trigger {
    name     = "weekly"
    schedule = "0 4 * * 0"
    enabled  = true
  }
}
