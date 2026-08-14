output "ecr_repository_url" {
  description = "Where the API image is pushed."
  value       = aws_ecr_repository.api.repository_url
}

output "db_endpoint" {
  description = "The staging RDS instance's connection endpoint."
  value       = aws_db_instance.main.endpoint
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}
