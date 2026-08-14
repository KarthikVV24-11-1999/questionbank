resource "aws_ecr_repository" "planted" {
  name = "planted"
  tags = local.tags
}

# Planted violation: a literal secret value.
locals {
  password = "sk-live-not-a-placeholder-value"
}
