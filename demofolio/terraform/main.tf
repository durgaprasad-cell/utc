# Starter: an AWS ECR repo to hold the image. Extend with ECS/EKS as you practice.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}
variable "region" { default = "ap-south-1" }
provider "aws" { region = var.region }

resource "aws_ecr_repository" "demofolio" {
  name                 = "demofolio"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
}
output "repository_url" { value = aws_ecr_repository.demofolio.repository_url }
