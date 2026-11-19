locals {
  prefix = "${var.name}-${var.environment}"

  labels = merge(
    {
      app         = "quickbooks-vue"
      name        = var.name
      environment = var.environment
      managed-by  = "terraform"
    },
    var.labels,
  )

  # Images: <region>-docker.pkg.dev/<project>/<name>/<service>
  image_prefix = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
  services     = ["api", "worker", "sync", "web", "migrate", "relay-mock"]
}
