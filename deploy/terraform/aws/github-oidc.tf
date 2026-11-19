# GitHub Actions OIDC federation: no long-lived AWS keys in GitHub.
#
#   push   role: build and push images to ECR. Trusted only for pushes to
#                refs/heads/<github_push_branch> (default master).
#   deploy role: read the app secret, describe the cluster, and act on it
#                through an EKS access entry. Trusted only for jobs that run
#                in one of github_environments (protect those environments
#                with required reviewers in GitHub).

locals {
  github_oidc_url = "token.actions.githubusercontent.com"

  github_oidc_provider_arn = (
    var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn :
    var.github_oidc_provider_arn != "" ? var.github_oidc_provider_arn :
    data.aws_iam_openid_connect_provider.github[0].arn
  )

  github_push_subjects   = ["repo:${var.github_repository}:ref:refs/heads/${var.github_push_branch}"]
  github_deploy_subjects = [for e in var.github_environments : "repo:${var.github_repository}:environment:${e}"]

  ecr_repository_arns = [for r in aws_ecr_repository.app : r.arn]
  cluster_arn         = "arn:${local.partition}:eks:${var.region}:${local.account_id}:cluster/${local.cluster_name}"
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 1 : 0

  url            = "https://${local.github_oidc_url}"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = !var.create_github_oidc_provider && var.github_oidc_provider_arn == "" ? 1 : 0

  url = "https://${local.github_oidc_url}"
}

###############################################################################
# push role
###############################################################################

data "aws_iam_policy_document" "github_push_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_url}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_url}:sub"
      values   = local.github_push_subjects
    }
  }
}

resource "aws_iam_role" "github_push" {
  name                 = "${local.prefix}-github-push"
  description          = "GitHub Actions (${var.github_repository} @ ${var.github_push_branch}): push images to ECR"
  assume_role_policy   = data.aws_iam_policy_document.github_push_trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_push" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # GetAuthorizationToken does not support resource scoping
  }

  statement {
    sid = "EcrPushPull"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:DescribeImageScanFindings",
      "ecr:DescribeRepositories",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:ListImages",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = local.ecr_repository_arns
  }
}

resource "aws_iam_role_policy" "github_push" {
  name   = "ecr-push"
  role   = aws_iam_role.github_push.id
  policy = data.aws_iam_policy_document.github_push.json
}

###############################################################################
# deploy role
###############################################################################

data "aws_iam_policy_document" "github_deploy_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_url}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_url}:sub"
      values   = local.github_deploy_subjects
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name                 = "${local.prefix}-github-deploy"
  description          = "GitHub Actions (${var.github_repository} environments ${join(",", var.github_environments)}): deploy to EKS"
  assume_role_policy   = data.aws_iam_policy_document.github_deploy_trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid       = "EksDescribe"
    actions   = ["eks:DescribeCluster"]
    resources = [local.cluster_arn]
  }

  statement {
    sid       = "AppSecretRead"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [aws_secretsmanager_secret.app.arn]
  }

  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # GetAuthorizationToken does not support resource scoping
  }

  statement {
    sid = "EcrRead"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
      "ecr:DescribeImageScanFindings",
      "ecr:DescribeRepositories",
      "ecr:GetDownloadUrlForLayer",
      "ecr:ListImages",
    ]
    resources = local.ecr_repository_arns
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "eks-deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}
