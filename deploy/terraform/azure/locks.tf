# deletion_protection, two layers:
#
# 1. CanNotDelete management locks on the stateful resources. They stop deletion
#    from the portal / CLI / other tooling. Locks are control-plane only, so they
#    do not block image pushes, secret reads/writes or database traffic.
#
# 2. A destroy guard. Terraform would happily delete a lock right before the
#    resource it protects (on `terraform destroy` or a forced replacement), and
#    `prevent_destroy` cannot be driven by a variable. The guard depends on every
#    stateful resource and its lock, is replaced whenever one of them is, and
#    refuses to be destroyed while deletion_protection is true, so Terraform
#    stops before touching any of them.
#
# To tear down: set deletion_protection = false, apply, then destroy.

locals {
  stateful_resources = {
    postgres  = azurerm_postgresql_flexible_server.main.id
    redis     = local.redis_id
    acr       = azurerm_container_registry.main.id
    key_vault = azurerm_key_vault.main.id
  }
}

resource "azurerm_management_lock" "stateful" {
  for_each   = var.deletion_protection ? local.stateful_resources : {}
  name       = "lock-${local.prefix}-${each.key}"
  scope      = each.value
  lock_level = "CanNotDelete"
  notes      = "deletion_protection = true in the ${var.name} Terraform module. Set it false and apply before destroying."
}

resource "terraform_data" "destroy_guard" {
  input            = var.deletion_protection
  triggers_replace = values(local.stateful_resources)

  provisioner "local-exec" {
    when    = destroy
    command = self.input ? "echo deletion_protection is true: set it to false and apply before destroying or replacing PostgreSQL, Redis, ACR or Key Vault && exit 1" : "echo deletion_protection is off"
  }

  depends_on = [azurerm_management_lock.stateful]
}
