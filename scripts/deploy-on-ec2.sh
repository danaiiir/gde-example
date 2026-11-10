#!/usr/bin/env bash
# Pull the Nova Assistant image from ECR and (re)start the container.
# Runs ON the EC2 instance (by hand, or by GitHub Actions via SSM Run Command).
# Credentials come from the instance's IAM role.
#
# Usage: ./deploy-nova.sh [tag]      (default tag: latest)
#
# If the new container does not become healthy, the previous image is restarted
# automatically and the script exits non-zero (so CI marks the deploy as failed).
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
IMAGE="${REGISTRY}/nova-assistant:${1:-latest}"
NAME="nova"
HEALTH_TIMEOUT=90   # seconds

run_container() {
  docker run -d --name "$NAME" \
    --restart unless-stopped \
    -p 80:8000 \
    -v nova-data:/data \
    -e AWS_REGION="$REGION" \
    "$1" >/dev/null
}

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while (( SECONDS < deadline )); do
    if curl -fs -m 3 http://localhost/healthz >/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}

echo "==> Instance role: $(aws sts get-caller-identity --query Arn --output text)"

echo "==> Logging in to ECR"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

echo "==> Pulling $IMAGE"
docker pull -q "$IMAGE"

PREVIOUS_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$NAME" 2>/dev/null || true)"
echo "==> Previous image: ${PREVIOUS_IMAGE:-<none>}"

echo "==> Starting new container"
docker rm -f "$NAME" >/dev/null 2>&1 || true
run_container "$IMAGE"

if wait_healthy; then
  echo "==> Healthy: $(curl -s http://localhost/healthz)"
  docker image prune -af --filter "until=168h" >/dev/null || true   # drop images unused for 7 days
  docker ps --filter "name=$NAME" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
  exit 0
fi

echo "!! New container failed its health check. Last log lines:"
docker logs --tail 40 "$NAME" 2>&1 || true
if [[ -n "$PREVIOUS_IMAGE" && "$PREVIOUS_IMAGE" != "$IMAGE" ]]; then
  echo "==> Rolling back to $PREVIOUS_IMAGE"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  run_container "$PREVIOUS_IMAGE"
  if wait_healthy; then echo "==> Rollback succeeded"; else echo "!! Rollback is unhealthy too"; fi
fi
exit 1
