resource "google_compute_network" "vpc" {
  name                            = "${local.prefix}-vpc"
  auto_create_subnetworks         = false
  routing_mode                    = "REGIONAL"
  delete_default_routes_on_create = false

  depends_on = [google_project_service.this]
}

resource "google_compute_subnetwork" "gke" {
  name                     = "${local.prefix}-gke"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.pods_cidr
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = var.services_cidr
  }

  log_config {
    aggregation_interval = "INTERVAL_5_MIN"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

# Explicit low-priority deny for ingress. GKE adds its own higher-priority
# allow rules (control plane -> nodes, health checks) as it needs them.
resource "google_compute_firewall" "deny_all_ingress" {
  name      = "${local.prefix}-deny-all-ingress"
  network   = google_compute_network.vpc.id
  direction = "INGRESS"
  priority  = 65534

  source_ranges = ["0.0.0.0/0"]

  deny {
    protocol = "all"
  }

  log_config {
    metadata = "EXCLUDE_ALL_METADATA"
  }
}

# Private nodes have no external IPs; Cloud NAT gives them (and pods) outbound
# internet access, e.g. for the Tailscale coordination server or OS updates.
resource "google_compute_router" "this" {
  name    = "${local.prefix}-router"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_router_nat" "this" {
  name                               = "${local.prefix}-nat"
  router                             = google_compute_router.this.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# Private Service Access: one peered range shared by Cloud SQL and Memorystore.
resource "google_compute_global_address" "private_services" {
  name          = "${local.prefix}-psa"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = var.private_service_access_prefix_length
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]

  # Cloud SQL keeps the peering "in use" for a while after the instance is gone,
  # which makes a plain delete fail during terraform destroy.
  deletion_policy = "ABANDON"
}
