# Staging deployable (M0-22). Tier 2 (ADR-0013): authored and lint-scanned by
# terraform-rules.spec.ts, never validated — there is no HCL parser and no
# provider plugin in this environment's offline store. The Tier-3 successor,
# run on a machine with network and AWS credentials:
#
#   terraform init && terraform validate && terraform plan -var-file=staging.tfvars

variable "region" {
  description = "AWS region (TECH-STACK §10 — ap-south-1, Mumbai, for latency and DPDP data residency)."
  type        = string
  default     = "ap-south-1"
}

variable "environment" {
  description = "Deployment environment tag, applied to every resource."
  type        = string
  default     = "staging"
}

variable "db_instance_class" {
  description = "RDS instance class for the staging PostgreSQL 16 database."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_name" {
  description = "The staging database name."
  type        = string
  default     = "questionbank"
}

variable "vpc_id" {
  description = "The VPC the staging deployable lives in."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnets for the Fargate service and the RDS instance."
  type        = list(string)
}
