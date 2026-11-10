#!/usr/bin/env bash
# Pull the Nova Assistant image from ECR and (re)start the container.
# Runs ON the EC2 instance. Credentials come from the instance's IAM role.
# Usage: ./deploy-nova.sh [tag]      (default tag: latest)
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
IMAGE="${REGISTRY}/nova-assistant:${1:-latest}"
NAME="nova"

echo "==> Checking instance role credentials"
aws sts get-caller-identity --query Arn --output text

echo "==> Logging in to ECR"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

echo "==> Pulling $IMAGE"
docker pull "$IMAGE"

echo "==> (Re)starting container '$NAME'"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  --restart unless-stopped \
  -p 80:8000 \
  -v nova-data:/data \
  -e AWS_REGION="$REGION" \
  "$IMAGE"

echo "==> Waiting for health check"
for _ in $(seq 1 20); do
  if curl -fs http://localhost/healthz >/dev/null; then break; fi
  sleep 2
done
curl -s http://localhost/healthz; echo   # /api/health requires login since auth was added
docker image prune -f >/dev/null
docker ps --filter "name=$NAME" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
