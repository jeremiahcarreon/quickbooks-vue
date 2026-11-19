###############################################################################
# Shared contract outputs (same names in the aws, gcp and azure modules)
###############################################################################

output "image_prefix" {
  description = "Registry prefix for images: <image_prefix>/<service>:<tag>. GitHub variable AWS_IMAGE_PREFIX."
  value       = "${local.account_id}.dkr.ecr.${var.region}.amazonaws.com/${var.name}"
}

output "cluster_name" {
  description = "EKS cluster name. GitHub variable AWS_CLUSTER_NAME."
  value       = module.eks.cluster_name
}

output "region" {
  description = "AWS region. GitHub variable AWS_REGION."
  value       = var.region
}

output "kubeconfig_command" {
  description = "Command that writes a kubeconfig entry for the cluster."
  value       = "aws eks update-kubeconfig --region ${var.region} --name ${module.eks.cluster_name}"
}

output "app_secret_id" {
  description = "Secrets Manager secret name holding the app env JSON (becomes k8s Secret qbv-env). GitHub variable AWS_APP_SECRET_ID."
  value       = aws_secretsmanager_secret.app.name
}

output "github_push_role_arn" {
  description = "IAM role GitHub Actions assumes to push images (master branch). GitHub variable AWS_PUSH_ROLE_ARN."
  value       = aws_iam_role.github_push.arn
}

output "github_deploy_role_arn" {
  description = "IAM role GitHub Actions assumes to deploy (environment-scoped). GitHub variable AWS_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.github_deploy.arn
}

output "database_endpoint" {
  description = "RDS PostgreSQL hostname (port 5432, TLS required)."
  value       = aws_db_instance.postgres.address
}

output "redis_endpoint" {
  description = "ElastiCache Redis primary endpoint hostname (port 6379, TLS + AUTH: rediss://)."
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

###############################################################################
# Extras
###############################################################################

output "github_variables" {
  description = "Repository variables to set in GitHub (Settings > Secrets and variables > Actions > Variables)."
  value = {
    AWS_REGION          = var.region
    AWS_PUSH_ROLE_ARN   = aws_iam_role.github_push.arn
    AWS_DEPLOY_ROLE_ARN = aws_iam_role.github_deploy.arn
    AWS_IMAGE_PREFIX    = "${local.account_id}.dkr.ecr.${var.region}.amazonaws.com/${var.name}"
    AWS_CLUSTER_NAME    = module.eks.cluster_name
    AWS_APP_SECRET_ID   = aws_secretsmanager_secret.app.name
  }
}

output "app_secret_arn" {
  description = "ARN of the app secret."
  value       = aws_secretsmanager_secret.app.arn
}

output "ecr_repository_urls" {
  description = "ECR repository URL per service."
  value       = { for k, r in aws_ecr_repository.app : k => r.repository_url }
}

output "cluster_endpoint" {
  description = "EKS API server endpoint."
  value       = module.eks.cluster_endpoint
}

output "vpc_id" {
  description = "VPC ID (attach a Site-to-Site VPN or Tailscale subnet router here to reach the relay)."
  value       = module.vpc.vpc_id
}

output "private_subnet_cidrs" {
  description = "Node/pod subnets. With a Site-to-Site VPN the relay sees worker traffic from these ranges."
  value       = module.vpc.private_subnets_cidr_blocks
}

output "private_route_table_ids" {
  description = "Private route tables (add a route to the relay network via a VPN gateway or subnet router)."
  value       = module.vpc.private_route_table_ids
}

output "nat_public_ips" {
  description = "Egress IPs of the NAT gateway(s), for allowlists on external services."
  value       = module.vpc.nat_public_ips
}

output "node_security_group_id" {
  description = "Security group of the EKS nodes."
  value       = module.eks.node_security_group_id
}
