#!/usr/bin/env bash
# Build feed-web locally (linux/amd64 via buildx) and deploy to Cloud Run.
# Replaces `gcloud builds submit`: builds on this machine, pushes only changed
# layers, skips Cloud Build's upload + worker-provisioning overhead.
#
# Usage: ./deploy.sh [full|push-only|deploy-only]   (default: full)
#   full         build + push + deploy
#   push-only    build + push, no deploy
#   deploy-only  skip build/push, deploy the :latest image already in the registry
set -euo pipefail
cd "$(dirname "$0")"

GREEN='\033[0;32m'; NC='\033[0m'
MODE="${1:-full}"

PROJECT=timelines-492720
REGION=us-central1
SERVICE=feed-web
IMAGE="${REGION}-docker.pkg.dev/$PROJECT/cloud-run-source-deploy/feed-web"
TAG="$(git rev-parse --short HEAD)"
DEPLOY_TAG="$TAG"

if [ "$MODE" != "deploy-only" ]; then
  echo -e "\n${GREEN}Configuring Docker auth for Artifact Registry...${NC}"
  gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

  echo -e "\n${GREEN}Building + pushing $SERVICE (linux/amd64, tag: $TAG)...${NC}"
  docker buildx build \
    --platform=linux/amd64 \
    -t "$IMAGE:$TAG" \
    -t "$IMAGE:latest" \
    --push \
    .

  if [ "$MODE" = "push-only" ]; then
    echo -e "\n${GREEN}Done (push only): $IMAGE:$TAG${NC}"
    exit 0
  fi
else
  DEPLOY_TAG="latest"
fi

echo -e "\n${GREEN}Deploying to Cloud Run (image swap preserves existing config)...${NC}"
gcloud run deploy "$SERVICE" \
  --image="$IMAGE:$DEPLOY_TAG" \
  --region="$REGION" \
  --project="$PROJECT"

echo -e "\n${GREEN}Done: $SERVICE @ $DEPLOY_TAG${NC}"
