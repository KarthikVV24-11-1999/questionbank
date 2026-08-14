# One deployable: the API on ECS Fargate, its RDS PostgreSQL instance,
# security groups, and the ECR repository. No secret value appears anywhere
# in this file — every credential is a reference into AWS Secrets Manager
# (TECH-STACK §10), never a literal.

terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Non-local state (TECH-STACK's own IaC selection implies a shared,
  # durable backend — a local statefile is a one-laptop deployment).
  backend "s3" {
    bucket = "questionbank-terraform-state"
    key    = "staging/terraform.tfstate"
    region = "ap-south-1"
  }
}

provider "aws" {
  region = var.region
}

locals {
  tags = {
    Environment = var.environment
    Project     = "questionbank"
    ManagedBy   = "terraform"
  }
}

resource "aws_ecr_repository" "api" {
  name                 = "questionbank-api-${var.environment}"
  image_tag_mutability = "IMMUTABLE"

  tags = local.tags
}

resource "aws_security_group" "api" {
  name        = "questionbank-api-${var.environment}"
  description = "The API service's ECS Fargate tasks."
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

resource "aws_security_group" "db" {
  name        = "questionbank-db-${var.environment}"
  description = "The staging RDS instance — reachable only from the API's security group."
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.api.id]
  }

  tags = local.tags
}

# The database password is a reference, never a value — AWS Secrets Manager
# owns rotation and audit (TECH-STACK §10, "interface-wrapped").
resource "aws_secretsmanager_secret" "db_password" {
  name = "questionbank/${var.environment}/db-password"
  tags = local.tags
}

resource "aws_db_instance" "main" {
  identifier     = "questionbank-${var.environment}"
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class
  db_name        = var.db_name

  allocated_storage = 20
  storage_encrypted = true

  username                    = "questionbank"
  manage_master_user_password = true

  vpc_security_group_ids = [aws_security_group.db.id]

  skip_final_snapshot = false
  deletion_protection = true

  tags = local.tags
}

resource "aws_ecs_cluster" "main" {
  name = "questionbank-${var.environment}"
  tags = local.tags
}

resource "aws_ecs_task_definition" "api" {
  family                   = "questionbank-api-${var.environment}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"

  container_definitions = jsonencode([
    {
      name  = "api"
      image = "${aws_ecr_repository.api.repository_url}:latest"
      portMappings = [
        { containerPort = 3000, protocol = "tcp" }
      ]
      secrets = [
        {
          name      = "AUTH_SIGNING_KEY"
          valueFrom = "questionbank/${var.environment}/auth-signing-key"
        },
        {
          name      = "DATABASE_URL"
          valueFrom = aws_secretsmanager_secret.db_password.arn
        }
      ]
    }
  ])

  tags = local.tags
}

resource "aws_ecs_service" "api" {
  name            = "questionbank-api-${var.environment}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = var.private_subnet_ids
    security_groups = [aws_security_group.api.id]
  }

  tags = local.tags
}
