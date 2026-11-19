# Key Vault (RBAC mode, purge protection) holding the app's runtime env as one
# JSON secret. The deploy workflow reads it and creates the k8s Secret qbv-env.

resource "random_password" "session_secret" {
  length  = 64
  special = false
}

resource "azurerm_key_vault" "main" {
  name                = "kv-${local.prefix}-${local.suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"
  tags                = local.tags

  rbac_authorization_enabled = true
  purge_protection_enabled   = true
  soft_delete_retention_days = var.key_vault_soft_delete_retention_days

  # Terraform and GitHub-hosted runners reach the vault over its public endpoint
  # (Entra ID + RBAC). Restrict with key_vault_allowed_ip_ranges when the callers
  # have fixed addresses.
  public_network_access_enabled = true

  #trivy:ignore:AZU-0013 open by default for GitHub-hosted runners; see key_vault_allowed_ip_ranges
  network_acls {
    bypass         = "AzureServices"
    default_action = length(var.key_vault_allowed_ip_ranges) > 0 ? "Deny" : "Allow"
    ip_rules       = var.key_vault_allowed_ip_ranges
  }
}

# The principal running terraform writes the secret.
resource "azurerm_role_assignment" "deployer_kv_secrets_officer" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

# Data-plane RBAC takes up to a few minutes to propagate.
resource "time_sleep" "kv_rbac" {
  create_duration = "90s"
  depends_on      = [azurerm_role_assignment.deployer_kv_secrets_officer]
}

resource "azurerm_key_vault_secret" "app" {
  name         = local.app_secret_name
  key_vault_id = azurerm_key_vault.main.id
  content_type = "application/json"
  tags         = local.tags

  value = jsonencode({
    DATABASE_URL   = local.database_url
    DATABASE_SSL   = "true"
    REDIS_URL      = local.redis_url
    SESSION_SECRET = random_password.session_secret.result
    RELAY_API_KEY  = var.relay_api_key
  })

  depends_on = [time_sleep.kv_rbac]
}
