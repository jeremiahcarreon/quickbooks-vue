data "azurerm_client_config" "current" {}

# Short random suffix for names that must be globally unique (ACR, Key Vault,
# PostgreSQL, Redis). Stable for the life of the state.
resource "random_string" "suffix" {
  length  = 5
  lower   = true
  upper   = false
  numeric = true
  special = false
}

locals {
  prefix = "${var.name}-${var.environment}"
  suffix = random_string.suffix.result

  tags = merge(
    {
      app         = var.name
      environment = var.environment
      managed-by  = "terraform"
      repository  = var.github_repository
    },
    var.tags,
  )

  # Images the Helm chart and CI use: <acr>.azurecr.io/<name>/<svc>
  services = ["api", "worker", "sync", "web", "migrate", "relay-mock"]

  app_secret_name = "${local.prefix}-app"
}

resource "azurerm_resource_group" "main" {
  name     = "rg-${local.prefix}"
  location = var.location
  tags     = local.tags
}
