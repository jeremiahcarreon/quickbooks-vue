# GKE: Autopilot by default (var.enable_autopilot), Standard regional with an
# autoscaling node pool otherwise. Private nodes, Workload Identity, VPC-native.

resource "google_service_account" "nodes" {
  account_id   = "${local.prefix}-nodes"
  display_name = "GKE nodes (${local.prefix})"
}

# Minimal node identity: logs, metrics, and pulling images from our registry.
resource "google_project_iam_member" "nodes_default" {
  project = var.project_id
  role    = "roles/container.defaultNodeServiceAccount"
  member  = google_service_account.nodes.member
}

resource "google_artifact_registry_repository_iam_member" "nodes_pull" {
  project    = google_artifact_registry_repository.images.project
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = google_service_account.nodes.member
}

resource "google_container_cluster" "this" {
  #checkov:skip=CKV_GCP_66:Binary Authorization needs an attestor pipeline; images come only from the private repo via the push SA.
  #checkov:skip=CKV_GCP_65:Google Groups for RBAC needs a Workspace/Cloud Identity domain; IAM roles are used instead.
  #checkov:skip=CKV_GCP_12:Dataplane V2 (ADVANCED_DATAPATH) enforces NetworkPolicy; the legacy network_policy block conflicts with it.
  #checkov:skip=CKV_GCP_61:Intranode visibility is not supported on Autopilot and adds log cost; subnet flow logs are on.
  #checkov:skip=CKV_GCP_13:Client certificates are disabled by default on every supported GKE version.
  #checkov:skip=CKV_GCP_21:resource_labels is set from local.labels (checkov cannot resolve the local).

  name     = "${local.prefix}-gke"
  location = var.region

  enable_autopilot    = var.enable_autopilot ? true : null
  deletion_protection = var.deletion_protection

  network         = google_compute_network.vpc.id
  subnetwork      = google_compute_subnetwork.gke.id
  networking_mode = "VPC_NATIVE"

  # Dataplane V2 (eBPF, NetworkPolicy enforcement). Autopilot always uses it.
  datapath_provider = "ADVANCED_DATAPATH"

  min_master_version = var.kubernetes_version

  release_channel {
    channel = var.release_channel
  }

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
  }

  # The IP endpoint only accepts the listed CIDRs (none by default).
  master_authorized_networks_config {
    gcp_public_cidrs_access_enabled = false

    dynamic "cidr_blocks" {
      for_each = var.master_authorized_networks
      content {
        cidr_block   = cidr_blocks.value.cidr_block
        display_name = cidr_blocks.value.display_name
      }
    }
  }

  # DNS endpoint: reachable from anywhere but every request is IAM-checked, so
  # GitHub-hosted runners (deploy SA) can reach the cluster without an IP allowlist.
  control_plane_endpoints_config {
    dns_endpoint_config {
      allow_external_traffic = var.enable_dns_endpoint
    }
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  resource_labels = local.labels

  maintenance_policy {
    recurring_window {
      start_time = "2026-01-04T04:00:00Z"
      end_time   = "2026-01-04T12:00:00Z"
      recurrence = "FREQ=WEEKLY;BYDAY=SA,SU"
    }
  }

  # --- Autopilot: node identity for auto-provisioned nodes -------------------
  dynamic "cluster_autoscaling" {
    for_each = var.enable_autopilot ? [1] : []
    content {
      auto_provisioning_defaults {
        service_account = google_service_account.nodes.email
        oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
      }
    }
  }

  # --- Standard: the default pool is replaced by google_container_node_pool ---
  remove_default_node_pool = var.enable_autopilot ? null : true
  initial_node_count       = var.enable_autopilot ? null : 1
  # Autopilot always runs Shielded GKE Nodes and rejects this field, so it is
  # only set for Standard; shielded nodes are on in both modes.
  #trivy:ignore:GCP-0055
  enable_shielded_nodes = var.enable_autopilot ? null : true

  dynamic "node_config" {
    for_each = var.enable_autopilot ? [] : [1]
    content {
      service_account = google_service_account.nodes.email
      oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]

      workload_metadata_config {
        mode = "GKE_METADATA"
      }

      shielded_instance_config {
        enable_secure_boot          = true
        enable_integrity_monitoring = true
      }
    }
  }

  lifecycle {
    # The default pool is deleted right after creation (Standard mode).
    ignore_changes = [node_config, initial_node_count]
  }

  depends_on = [
    google_project_service.this,
    google_project_iam_member.nodes_default,
  ]
}

resource "google_container_node_pool" "default" {
  count = var.enable_autopilot ? 0 : 1

  name           = "${local.prefix}-pool"
  location       = var.region
  cluster        = google_container_cluster.this.name
  node_locations = length(var.node_zones) > 0 ? var.node_zones : null

  initial_node_count = var.node_min_count

  autoscaling {
    min_node_count = var.node_min_count
    max_node_count = var.node_max_count
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  upgrade_settings {
    max_surge       = 1
    max_unavailable = 0
  }

  node_config {
    machine_type    = var.node_machine_type
    disk_size_gb    = var.node_disk_size_gb
    disk_type       = "pd-balanced"
    image_type      = "COS_CONTAINERD"
    service_account = google_service_account.nodes.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    labels          = local.labels

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }
  }

  lifecycle {
    ignore_changes = [initial_node_count]
  }
}
