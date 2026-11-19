# GitHub Actions -> Azure without stored secrets: two user-assigned managed
# identities with federated identity credentials (azure/login@v2 with client-id,
# tenant-id, subscription-id). No Entra app registrations, no azuread provider.
#
#   push:   AcrPush on the registry. Subject repo:<repo>:ref:refs/heads/<branch>.
#   deploy: AKS data-plane role + Cluster User (get-credentials), Key Vault
#           Secrets User on the vault. Subject repo:<repo>:environment:<env>.

locals {
  github_issuer   = "https://token.actions.githubusercontent.com"
  github_audience = ["api://AzureADTokenExchange"]
}

resource "azurerm_user_assigned_identity" "github_push" {
  name                = "id-${local.prefix}-github-push"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "github_push" {
  name                      = "github-${var.github_push_branch}"
  user_assigned_identity_id = azurerm_user_assigned_identity.github_push.id
  issuer                    = local.github_issuer
  audience                  = local.github_audience
  subject                   = "repo:${var.github_repository}:ref:refs/heads/${var.github_push_branch}"
}

resource "azurerm_role_assignment" "github_push_acr" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPush"
  principal_id         = azurerm_user_assigned_identity.github_push.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_user_assigned_identity" "github_deploy" {
  name                = "id-${local.prefix}-github-deploy"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

# Azure rejects concurrent federated-credential writes on one identity; with
# several environments, run the first apply with -parallelism=1.
resource "azurerm_federated_identity_credential" "github_deploy" {
  for_each                  = toset(var.github_environments)
  name                      = "github-env-${replace(each.value, ".", "-")}"
  user_assigned_identity_id = azurerm_user_assigned_identity.github_deploy.id
  issuer                    = local.github_issuer
  audience                  = local.github_audience
  subject                   = "repo:${var.github_repository}:environment:${each.value}"
}

resource "azurerm_role_assignment" "github_deploy_cluster_user" {
  scope                = azurerm_kubernetes_cluster.main.id
  role_definition_name = "Azure Kubernetes Service Cluster User Role"
  principal_id         = azurerm_user_assigned_identity.github_deploy.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "github_deploy_cluster_rbac" {
  scope                = azurerm_kubernetes_cluster.main.id
  role_definition_name = var.github_deploy_cluster_role
  principal_id         = azurerm_user_assigned_identity.github_deploy.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "github_deploy_kv" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.github_deploy.principal_id
  principal_type       = "ServicePrincipal"
}
