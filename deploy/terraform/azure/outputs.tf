# Contract outputs (same names in the aws/gcp/azure modules).

output "image_prefix" {
  description = "Image prefix: images are <image_prefix>/<svc>:<tag> (svc = api, worker, sync, web, migrate, relay-mock). GitHub variable AZURE_IMAGE_PREFIX."
  value       = "${azurerm_container_registry.main.login_server}/${var.name}"
}

output "cluster_name" {
  description = "AKS cluster name. GitHub variable AZURE_CLUSTER_NAME."
  value       = azurerm_kubernetes_cluster.main.name
}

output "resource_group_name" {
  description = "Resource group holding everything. GitHub variable AZURE_RESOURCE_GROUP."
  value       = azurerm_resource_group.main.name
}

output "location" {
  description = "Azure region."
  value       = azurerm_resource_group.main.location
}

output "kubeconfig_command" {
  description = "Fetch credentials (Entra ID; needs kubelogin)."
  value       = "az aks get-credentials --resource-group ${azurerm_resource_group.main.name} --name ${azurerm_kubernetes_cluster.main.name} --overwrite-existing && kubelogin convert-kubeconfig -l azurecli"
}

output "app_secret_id" {
  description = "Versionless Key Vault secret ID of the app env JSON (DATABASE_URL, DATABASE_SSL, REDIS_URL, SESSION_SECRET, RELAY_API_KEY)."
  value       = azurerm_key_vault_secret.app.versionless_id
}

output "key_vault_name" {
  description = "Key Vault name. GitHub variable AZURE_KEY_VAULT."
  value       = azurerm_key_vault.main.name
}

output "app_secret_name" {
  description = "Secret name inside the vault (<name>-<environment>-app). GitHub variable AZURE_APP_SECRET_NAME."
  value       = azurerm_key_vault_secret.app.name
}

output "azure_tenant_id" {
  description = "Entra ID tenant. GitHub variable AZURE_TENANT_ID."
  value       = data.azurerm_client_config.current.tenant_id
}

output "azure_subscription_id" {
  description = "Subscription. GitHub variable AZURE_SUBSCRIPTION_ID."
  value       = data.azurerm_client_config.current.subscription_id
}

output "github_push_client_id" {
  description = "Client ID of the push identity (AcrPush). GitHub variable AZURE_PUSH_CLIENT_ID."
  value       = azurerm_user_assigned_identity.github_push.client_id
}

output "github_deploy_client_id" {
  description = "Client ID of the deploy identity (AKS + Key Vault Secrets User). GitHub variable AZURE_DEPLOY_CLIENT_ID."
  value       = azurerm_user_assigned_identity.github_deploy.client_id
}

output "acr_name" {
  description = "Registry name (for az acr login --name). GitHub variable AZURE_ACR_NAME."
  value       = azurerm_container_registry.main.name
}

output "database_fqdn" {
  description = "Private FQDN of the PostgreSQL Flexible Server (resolves only inside the VNet)."
  value       = azurerm_postgresql_flexible_server.main.fqdn
}

output "redis_hostname" {
  description = "Redis hostname (reached through the private endpoint)."
  value       = local.redis_hostname
}

# Extras.

output "oidc_issuer_url" {
  description = "AKS OIDC issuer, for workload identity federated credentials."
  value       = azurerm_kubernetes_cluster.main.oidc_issuer_url
}

output "images" {
  description = "Full image repositories per service."
  value       = { for s in local.services : s => "${azurerm_container_registry.main.login_server}/${var.name}/${s}" }
}

output "github_variables" {
  description = "Repository variables to set in GitHub (Settings > Secrets and variables > Actions > Variables). None of them is secret."
  value = {
    AZURE_TENANT_ID        = data.azurerm_client_config.current.tenant_id
    AZURE_SUBSCRIPTION_ID  = data.azurerm_client_config.current.subscription_id
    AZURE_PUSH_CLIENT_ID   = azurerm_user_assigned_identity.github_push.client_id
    AZURE_DEPLOY_CLIENT_ID = azurerm_user_assigned_identity.github_deploy.client_id
    AZURE_ACR_NAME         = azurerm_container_registry.main.name
    AZURE_IMAGE_PREFIX     = "${azurerm_container_registry.main.login_server}/${var.name}"
    AZURE_RESOURCE_GROUP   = azurerm_resource_group.main.name
    AZURE_CLUSTER_NAME     = azurerm_kubernetes_cluster.main.name
    AZURE_KEY_VAULT        = azurerm_key_vault.main.name
    AZURE_APP_SECRET_NAME  = azurerm_key_vault_secret.app.name
  }
}
