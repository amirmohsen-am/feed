#!/usr/bin/env bash
# One-shot Vertex AI Vector Search provisioning (PROJECT-overridable).
# Resources: Index (STREAM_UPDATE, 768d, DOT_PRODUCT, tree-AH) → Endpoint (public) → DeployedIndex
# Wall time: ~30–60 min (deploy step is slow).

set -euo pipefail

PROJECT="${PROJECT:-timelines-492720}"
LOCATION="${LOCATION:-us-central1}"
INDEX_DISPLAY_NAME="${INDEX_DISPLAY_NAME:-happy-feed-index}"
ENDPOINT_DISPLAY_NAME="${ENDPOINT_DISPLAY_NAME:-happy-feed-endpoint}"
DEPLOYED_INDEX_ID="${DEPLOYED_INDEX_ID:-happy_feed_deployed}"
DEPLOYED_DISPLAY_NAME="${DEPLOYED_DISPLAY_NAME:-happy-feed-deployed}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-standard-2}"
METADATA_FILE="${METADATA_FILE:-$(dirname "$0")/vertex-index-metadata.json}"

echo ">>> using project=$PROJECT location=$LOCATION"

# STREAM_UPDATE indexes don't require contentsDeltaUri — population happens
# via upsertDatapoints from the worker.

echo ">>> creating index..."
gcloud ai indexes create \
  --project="$PROJECT" \
  --region="$LOCATION" \
  --display-name="$INDEX_DISPLAY_NAME" \
  --metadata-file="$METADATA_FILE" \
  --index-update-method=STREAM_UPDATE

INDEX_ID=$(gcloud ai indexes list --project="$PROJECT" --region="$LOCATION" \
  --filter="displayName=$INDEX_DISPLAY_NAME" \
  --format="value(name.basename())" | head -1)
echo "INDEX_ID=$INDEX_ID"

echo ">>> creating index endpoint..."
gcloud ai index-endpoints create \
  --project="$PROJECT" \
  --region="$LOCATION" \
  --display-name="$ENDPOINT_DISPLAY_NAME" \
  --public-endpoint-enabled

ENDPOINT_ID=$(gcloud ai index-endpoints list --project="$PROJECT" --region="$LOCATION" \
  --filter="displayName=$ENDPOINT_DISPLAY_NAME" \
  --format="value(name.basename())" | head -1)
echo "ENDPOINT_ID=$ENDPOINT_ID"

echo ">>> deploying index to endpoint (this takes 20–60 min)..."
gcloud ai index-endpoints deploy-index "$ENDPOINT_ID" \
  --project="$PROJECT" \
  --region="$LOCATION" \
  --index="$INDEX_ID" \
  --deployed-index-id="$DEPLOYED_INDEX_ID" \
  --display-name="$DEPLOYED_DISPLAY_NAME" \
  --machine-type="$MACHINE_TYPE" \
  --min-replica-count=1 \
  --max-replica-count=1

echo ">>> fetching public endpoint domain..."
ENDPOINT_HOST=$(gcloud ai index-endpoints describe "$ENDPOINT_ID" \
  --project="$PROJECT" \
  --region="$LOCATION" \
  --format="value(publicEndpointDomainName)")
echo "ENDPOINT_HOST=$ENDPOINT_HOST"

cat <<EOF

==========================================================================
DONE.

  vertexIndexId:           '$INDEX_ID'
  vertexIndexEndpointId:   '$ENDPOINT_ID'
  vertexIndexEndpointHost: '$ENDPOINT_HOST'
  vertexDeployedIndexId:   '$DEPLOYED_INDEX_ID'

==========================================================================
EOF
