# Control-plane identity: user-assigned so it can be granted Network Contributor
# on the node subnet before the cluster exists (needed for a BYO VNet).
resource "azurerm_user_assigned_identity" "aks" {
  name                = "id-${local.prefix}-aks"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_role_assignment" "aks_subnet" {
  scope                = azurerm_subnet.aks.id
  role_definition_name = "Network Contributor"
  principal_id         = azurerm_user_assigned_identity.aks.principal_id
  principal_type       = "ServicePrincipal"
}

# Role assignments take a moment to propagate; AKS validates subnet access at create.
resource "time_sleep" "aks_rbac" {
  create_duration = "60s"
  depends_on      = [azurerm_role_assignment.aks_subnet]
}

# API server: public endpoint, Entra ID auth only (no local accounts). Narrow it
# with api_server_authorized_ip_ranges; it stays open by default because
# GitHub-hosted runners deploy with helm and have no fixed addresses.
#trivy:ignore:AZU-0041
resource "azurerm_kubernetes_cluster" "main" {
  name                = "aks-${local.prefix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  node_resource_group = "rg-${local.prefix}-aks-nodes"
  dns_prefix          = local.prefix
  kubernetes_version  = var.kubernetes_version
  sku_tier            = var.aks_sku_tier
  tags                = local.tags

  # Workload identity (OIDC issuer) for future pod -> Azure access.
  oidc_issuer_enabled       = true
  workload_identity_enabled = true

  # Entra ID only: Azure RBAC for Kubernetes authorization, no static admin kubeconfig.
  local_account_disabled            = true
  role_based_access_control_enabled = true
  azure_active_directory_role_based_access_control {
    azure_rbac_enabled = true
    tenant_id          = data.azurerm_client_config.current.tenant_id
  }

  dynamic "api_server_access_profile" {
    for_each = length(var.api_server_authorized_ip_ranges) > 0 ? [1] : []
    content {
      authorized_ip_ranges = var.api_server_authorized_ip_ranges
    }
  }

  automatic_upgrade_channel    = "patch"
  node_os_upgrade_channel      = "NodeImage"
  azure_policy_enabled         = true
  image_cleaner_enabled        = true
  image_cleaner_interval_hours = 48

  maintenance_window_auto_upgrade {
    frequency   = "Weekly"
    interval    = 1
    day_of_week = "Sunday"
    start_time  = "03:00"
    utc_offset  = "+00:00"
    duration    = 4
  }

  maintenance_window_node_os {
    frequency   = "Weekly"
    interval    = 1
    day_of_week = "Sunday"
    start_time  = "03:00"
    utc_offset  = "+00:00"
    duration    = 4
  }

  default_node_pool {
    name                         = "system"
    vm_size                      = var.node_vm_size
    vnet_subnet_id               = azurerm_subnet.aks.id
    zones                        = length(var.availability_zones) > 0 ? var.availability_zones : null
    auto_scaling_enabled         = var.node_autoscaling
    node_count                   = var.node_count
    min_count                    = var.node_autoscaling ? var.node_min_count : null
    max_count                    = var.node_autoscaling ? var.node_max_count : null
    max_pods                     = 110
    os_disk_size_gb              = var.node_os_disk_size_gb
    os_disk_type                 = var.node_os_disk_type
    os_sku                       = "AzureLinux"
    only_critical_addons_enabled = false # small install: the app shares the system pool
    temporary_name_for_rotation  = "systemtmp"
    tags                         = local.tags

    upgrade_settings {
      max_surge = "33%"
    }
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.aks.id]
  }

  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay"
    network_data_plane  = "cilium"
    network_policy      = "cilium"
    pod_cidr            = var.pod_cidr
    service_cidr        = var.service_cidr
    dns_service_ip      = cidrhost(var.service_cidr, 10)
    load_balancer_sku   = "standard"
    outbound_type       = "loadBalancer"
  }

  lifecycle {
    # The autoscaler owns node_count; patch upgrades move the exact version.
    ignore_changes = [default_node_pool[0].node_count]

    precondition {
      condition     = !var.node_autoscaling || (var.node_min_count <= var.node_count && var.node_count <= var.node_max_count)
      error_message = "With node_autoscaling, node_min_count <= node_count <= node_max_count must hold."
    }
  }

  depends_on = [time_sleep.aks_rbac]
}

# Kubelet pulls from the private registry with its managed identity.
resource "azurerm_role_assignment" "aks_acr_pull" {
  scope                            = azurerm_container_registry.main.id
  role_definition_name             = "AcrPull"
  principal_id                     = azurerm_kubernetes_cluster.main.kubelet_identity[0].object_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

# Local accounts are off, so give the person/SP running terraform a way in.
resource "azurerm_role_assignment" "deployer_cluster_admin" {
  count                = var.grant_deployer_cluster_admin ? 1 : 0
  scope                = azurerm_kubernetes_cluster.main.id
  role_definition_name = "Azure Kubernetes Service RBAC Cluster Admin"
  principal_id         = data.azurerm_client_config.current.object_id
}
