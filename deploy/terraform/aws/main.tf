data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_availability_zones" "available" {
  state = "available"

  # Skip Local Zones / Wavelength zones.
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  prefix     = "${var.name}-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  azs        = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  tags = merge(
    {
      Project     = var.name
      Environment = var.environment
      ManagedBy   = "terraform"
    },
    var.tags,
  )
}
