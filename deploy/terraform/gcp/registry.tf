# Private Docker repository. The images contain Intuit-derived material (qbXML
# schemas), so the repository must never be made public: no allUsers /
# allAuthenticatedUsers bindings, here or by hand.
resource "google_artifact_registry_repository" "images" {
  #checkov:skip=CKV_GCP_84:Google-managed encryption at rest; add kms_key_name if CMEK is required.

  repository_id = var.name
  location      = var.region
  format        = "DOCKER"
  description   = "QuickBooks Vue images (${join(", ", local.services)}). Private."

  docker_config {
    immutable_tags = false # the deploy workflow may move tags such as "latest"
  }

  cleanup_policy_dry_run = false

  cleanup_policies {
    id     = "delete-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "${var.registry_untagged_max_age_days * 86400}s"
    }
  }

  cleanup_policies {
    id     = "delete-old-tagged"
    action = "DELETE"
    condition {
      tag_state  = "TAGGED"
      older_than = "${90 * 86400}s"
    }
  }

  # KEEP wins over DELETE: the newest N versions of each image always survive.
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = var.registry_keep_recent
    }
  }

  depends_on = [google_project_service.this]
}
