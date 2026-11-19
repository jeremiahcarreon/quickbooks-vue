terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.72.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.1"
    }
    # Required by the EKS module and its submodules; pinned here so every
    # provider version is explicit, not only recorded in the lock file.
    cloudinit = {
      source  = "hashicorp/cloudinit"
      version = "2.4.1"
    }
    null = {
      source  = "hashicorp/null"
      version = "3.3.2"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "4.4.2"
    }
    time = {
      source  = "hashicorp/time"
      version = "0.14.2"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}
