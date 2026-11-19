terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.10"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 8.10"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region

  default_labels = local.labels
}

provider "google-beta" {
  project = var.project_id
  region  = var.region

  default_labels = local.labels
}
