# EKS cluster with one managed node group in the private subnets.
#
# Authentication uses EKS access entries only (authentication_mode = "API");
# the aws-auth ConfigMap is not used. The identity running Terraform gets
# cluster-admin, as do cluster_admin_principal_arns, and the GitHub deploy
# role gets cluster or namespace admin depending on deploy_access_scope.

locals {
  cluster_name = local.prefix

  admin_access_entries = {
    for i, arn in var.cluster_admin_principal_arns : "admin-${i}" => {
      principal_arn = arn
      policy_associations = {
        admin = {
          policy_arn   = "arn:${local.partition}:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
          access_scope = { type = "cluster" }
        }
      }
    }
  }

  deploy_access_entry = {
    github-deploy = {
      principal_arn = aws_iam_role.github_deploy.arn
      policy_associations = {
        deploy = var.deploy_access_scope == "cluster" ? {
          policy_arn   = "arn:${local.partition}:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
          access_scope = { type = "cluster", namespaces = null }
          } : {
          policy_arn   = "arn:${local.partition}:eks::aws:cluster-access-policy/AmazonEKSAdminPolicy"
          access_scope = { type = "namespace", namespaces = [var.kubernetes_namespace] }
        }
      }
    }
  }

  ebs_csi_addon = var.enable_ebs_csi_driver ? {
    aws-ebs-csi-driver = {
      pod_identity_association = [{
        role_arn        = aws_iam_role.ebs_csi[0].arn
        service_account = "ebs-csi-controller-sa"
      }]
    }
  } : {}
}

# Accepted scanner findings, all deliberate:
#   AVD-AWS-0040/0041 public API endpoint, open by default: GitHub-hosted
#     runners need it. Narrow cluster_endpoint_public_access_cidrs or set
#     cluster_endpoint_public_access = false (with in-VPC runners).
#   AVD-AWS-0104 node egress to 0.0.0.0/0: nodes pull images, reach AWS APIs
#     through the NAT gateway, and the worker reaches the relay network.
#trivy:ignore:AVD-AWS-0040
#trivy:ignore:AVD-AWS-0041
#trivy:ignore:AVD-AWS-0104
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "21.29.0"

  name               = local.cluster_name
  kubernetes_version = var.kubernetes_version

  vpc_id                   = module.vpc.vpc_id
  subnet_ids               = module.vpc.private_subnets
  control_plane_subnet_ids = module.vpc.private_subnets

  endpoint_private_access      = true
  endpoint_public_access       = var.cluster_endpoint_public_access
  endpoint_public_access_cidrs = var.cluster_endpoint_public_access_cidrs

  authentication_mode                      = "API"
  enable_cluster_creator_admin_permissions = true
  access_entries                           = merge(local.admin_access_entries, local.deploy_access_entry)

  deletion_protection = var.deletion_protection

  # Envelope-encrypt Kubernetes Secrets (qbv-env holds DB and Redis credentials)
  # with a module-managed KMS key.
  encryption_config = {
    resources = ["secrets"]
  }

  enabled_log_types                      = ["api", "audit", "authenticator", "controllerManager", "scheduler"]
  cloudwatch_log_group_retention_in_days = var.log_retention_days

  addons = merge(
    {
      coredns    = {}
      kube-proxy = {}
      eks-pod-identity-agent = {
        before_compute = true
      }
      vpc-cni = {
        before_compute = true
      }
    },
    local.ebs_csi_addon,
  )

  eks_managed_node_groups = {
    default = {
      name = "${local.prefix}-default"

      ami_type       = var.node_ami_type
      instance_types = var.node_instance_types
      capacity_type  = var.node_capacity_type

      min_size     = var.node_min_size
      max_size     = var.node_max_size
      desired_size = var.node_desired_size

      subnet_ids = module.vpc.private_subnets

      block_device_mappings = {
        root = {
          device_name = "/dev/xvda"
          ebs = {
            volume_size           = var.node_disk_size_gb
            volume_type           = "gp3"
            encrypted             = true
            delete_on_termination = true
          }
        }
      }

      # IMDSv2 only, hop limit 1: pods cannot borrow the node role.
      # Workloads that need AWS APIs use EKS Pod Identity instead.
      metadata_options = {
        http_endpoint               = "enabled"
        http_tokens                 = "required"
        http_put_response_hop_limit = 1
      }

      update_config = {
        max_unavailable = 1
      }

      labels = {
        "qbv/pool" = "default"
      }
    }
  }

  tags = local.tags
}

# IAM role for the EBS CSI controller, bound through EKS Pod Identity.
data "aws_iam_policy_document" "pod_identity_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ebs_csi" {
  count = var.enable_ebs_csi_driver ? 1 : 0

  name               = "${local.prefix}-ebs-csi"
  assume_role_policy = data.aws_iam_policy_document.pod_identity_trust.json
}

resource "aws_iam_role_policy_attachment" "ebs_csi" {
  count = var.enable_ebs_csi_driver ? 1 : 0

  role       = aws_iam_role.ebs_csi[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}
