# Private network: nodes, RDS and ElastiCache live in private subnets with no
# public IPs. Public subnets hold only the NAT gateway(s) and internet-facing
# load balancers created by Kubernetes.
#
# Layout for a /16 (example 10.40.0.0/16, 3 AZs):
#   private (nodes/pods)  10.40.0.0/20,  10.40.16.0/20, 10.40.32.0/20
#   public  (LB, NAT)     10.40.48.0/24, 10.40.49.0/24, 10.40.50.0/24
#   database (RDS)        10.40.64.0/24, ...
#   elasticache           10.40.80.0/24, ...
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "6.7.0"

  name = local.prefix
  cidr = var.vpc_cidr
  azs  = local.azs

  private_subnets     = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i)]
  public_subnets      = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, 48 + i)]
  database_subnets    = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, 64 + i)]
  elasticache_subnets = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, 80 + i)]

  create_database_subnet_group       = true
  create_database_subnet_route_table = true
  create_elasticache_subnet_group    = true

  # Data subnets never get a route to the internet.
  create_database_internet_gateway_route = false
  create_database_nat_gateway_route      = false

  enable_nat_gateway     = true
  single_nat_gateway     = var.single_nat_gateway
  one_nat_gateway_per_az = !var.single_nat_gateway

  enable_dns_hostnames = true
  enable_dns_support   = true

  map_public_ip_on_launch = false

  # Lock down the default security group (no rules).
  manage_default_security_group  = true
  default_security_group_ingress = []
  default_security_group_egress  = []

  enable_flow_log                                 = var.enable_vpc_flow_logs
  create_flow_log_cloudwatch_log_group            = var.enable_vpc_flow_logs
  create_flow_log_cloudwatch_iam_role             = var.enable_vpc_flow_logs
  flow_log_cloudwatch_log_group_retention_in_days = var.log_retention_days
  flow_log_max_aggregation_interval               = 60

  # Subnet discovery for the AWS Load Balancer Controller / in-tree service LB.
  public_subnet_tags = {
    "kubernetes.io/role/elb" = "1"
  }
  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = "1"
  }

  tags = local.tags
}
