# GitHub Actions -> GCP without keys (Workload Identity Federation).
#
#   push   : builds and pushes images; only runs on var.github_push_ref.
#   deploy : helm upgrade into GKE + reads the app secret; only jobs that
#            target one of var.github_environments (use environment
#            protection rules in GitHub for approvals).
#
# The provider's attribute_condition rejects every token that does not come
# from var.github_repository, so the ref/environment principal sets below
# cannot be matched by another repository.

locals {
  github_principal_set = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}"
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "${local.prefix}-github"
  display_name              = "GitHub Actions (${local.prefix})"
  description               = "GitHub Actions OIDC for ${var.github_repository}"

  depends_on = [google_project_service.this]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  #checkov:skip=CKV_GCP_125:Trust is scoped by attribute_condition on assertion.repository plus ref/environment principal sets, not by sub.

  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
    # Jobs without an environment carry no "environment" claim.
    "attribute.environment" = "has(assertion.environment) ? assertion.environment : 'none'"
    "attribute.actor"       = "assertion.actor"
  }

  attribute_condition = "assertion.repository == \"${var.github_repository}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# --- push -------------------------------------------------------------------

resource "google_service_account" "github_push" {
  account_id   = "${local.prefix}-push"
  display_name = "GitHub Actions image push (${local.prefix})"
}

resource "google_service_account_iam_member" "github_push_wif" {
  service_account_id = google_service_account.github_push.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.github_principal_set}/attribute.ref/${var.github_push_ref}"
}

resource "google_artifact_registry_repository_iam_member" "github_push_writer" {
  project    = google_artifact_registry_repository.images.project
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = google_service_account.github_push.member
}

# --- deploy -----------------------------------------------------------------

resource "google_service_account" "github_deploy" {
  account_id   = "${local.prefix}-deploy"
  display_name = "GitHub Actions deploy (${local.prefix})"
}

resource "google_service_account_iam_member" "github_deploy_wif" {
  for_each = toset(var.github_environments)

  service_account_id = google_service_account.github_deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.github_principal_set}/attribute.environment/${each.value}"
}

# Kubernetes API access. container.developer covers namespaces, Deployments,
# Jobs, Secrets, Services, Ingress... but not RBAC objects; use
# roles/container.admin via var.deploy_cluster_role if the chart creates
# Roles/RoleBindings. GKE IAM is project-wide (no per-cluster binding).
resource "google_project_iam_member" "github_deploy_cluster" {
  project = var.project_id
  role    = var.deploy_cluster_role
  member  = google_service_account.github_deploy.member
}

resource "google_secret_manager_secret_iam_member" "github_deploy_secret" {
  secret_id = google_secret_manager_secret.app.id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.github_deploy.member
}

resource "google_artifact_registry_repository_iam_member" "github_deploy_reader" {
  project    = google_artifact_registry_repository.images.project
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = google_service_account.github_deploy.member
}
