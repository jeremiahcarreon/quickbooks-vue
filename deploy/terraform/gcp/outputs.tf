output "image_prefix" {
  description = "Image prefix; images are <image_prefix>/<service>:<tag> (services: api, worker, sync, web, migrate, relay-mock). GitHub variable GCP_IMAGE_PREFIX."
  value       = local.image_prefix
}

output "cluster_name" {
  description = "GKE cluster name. GitHub variable GCP_CLUSTER_NAME."
  value       = google_container_cluster.this.name
}

output "region" {
  description = "Region of the cluster and every regional resource. GitHub variable GCP_REGION."
  value       = var.region
}

output "project_id" {
  description = "GCP project id. GitHub variable GCP_PROJECT_ID."
  value       = var.project_id
}

output "kubeconfig_command" {
  description = "Fetches cluster credentials for kubectl/helm."
  value = format(
    "gcloud container clusters get-credentials %s --region %s --project %s%s",
    google_container_cluster.this.name,
    var.region,
    var.project_id,
    var.enable_dns_endpoint ? " --dns-endpoint" : "",
  )
}

output "app_secret_id" {
  description = "Secret Manager secret id holding the app env JSON. GitHub variable GCP_APP_SECRET_ID."
  value       = google_secret_manager_secret.app.secret_id
}

output "workload_identity_provider" {
  description = "Full resource name of the GitHub OIDC provider (google-github-actions/auth workload_identity_provider). GitHub variable GCP_WIF_PROVIDER."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "github_push_service_account" {
  description = "Service account used to push images. GitHub variable GCP_PUSH_SA."
  value       = google_service_account.github_push.email
}

output "github_deploy_service_account" {
  description = "Service account used to deploy. GitHub variable GCP_DEPLOY_SA."
  value       = google_service_account.github_deploy.email
}

output "database_private_ip" {
  description = "Private IP of the Cloud SQL instance."
  value       = google_sql_database_instance.postgres.private_ip_address
}

output "redis_host" {
  description = "Private IP of the Memorystore instance (port 6379)."
  value       = google_redis_instance.this.host
}
