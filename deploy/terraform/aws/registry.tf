# Private ECR repositories, one per image, under the <name>/ namespace:
#   <account>.dkr.ecr.<region>.amazonaws.com/<name>/<service>
#
# The images embed Intuit-derived qbXML material, so they must never be
# public. ECR repositories are private by default and no repository policy
# grants access outside this account; pulls come from the node role
# (AmazonEC2ContainerRegistryReadOnly, attached by the EKS module) and the
# GitHub deploy role.
#
# Tag mutability: IMMUTABLE_WITH_EXCLUSION. Release tags (git SHAs) can never
# be overwritten, so a deployed tag always means the same bytes and a
# rollback is exact. Only the patterns in ecr_mutable_tags (e.g. "latest",
# "master", "buildcache*") stay movable for convenience tags and BuildKit
# registry cache. Set ecr_mutable_tags = [] for fully IMMUTABLE.

locals {
  services = ["api", "worker", "sync", "web", "migrate", "relay-mock"]
}

# Trivy AVD-AWS-0031 does not understand IMMUTABLE_WITH_EXCLUSION: every tag
# except the ecr_mutable_tags patterns is immutable.
#trivy:ignore:AVD-AWS-0031
resource "aws_ecr_repository" "app" {
  for_each = toset(local.services)

  name                 = "${var.name}/${each.key}"
  image_tag_mutability = length(var.ecr_mutable_tags) > 0 ? "IMMUTABLE_WITH_EXCLUSION" : "IMMUTABLE"
  force_delete         = !var.deletion_protection

  dynamic "image_tag_mutability_exclusion_filter" {
    for_each = var.ecr_mutable_tags
    content {
      filter      = image_tag_mutability_exclusion_filter.value
      filter_type = "WILDCARD"
    }
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  for_each = aws_ecr_repository.app

  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images (superseded layers, failed pushes) after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the newest ${var.ecr_keep_tagged_images} images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.ecr_keep_tagged_images
        }
        action = { type = "expire" }
      },
    ]
  })
}
