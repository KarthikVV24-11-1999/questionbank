resource "aws_rds_cluster" "planted" {
  engine = "aurora-postgresql"
  tags   = local.tags
}
