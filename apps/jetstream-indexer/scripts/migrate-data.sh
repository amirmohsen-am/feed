#!/usr/bin/env bash
# Copy parquet posts/embeddings + Jetstream cursor from the old amir-experimental
# bucket into the new timelines-492720 bucket. Idempotent (gcloud storage cp -r).

set -euo pipefail

SRC="${SRC:-gs://happy-feed-data}"
DST="${DST:-gs://happy-feed-data-timelines}"

echo ">>> source: $SRC"
echo ">>> dest:   $DST"

gcloud storage du --summarize "$SRC" || true
gcloud storage du --summarize "$DST" || true

echo ">>> copying ..."
gcloud storage cp --recursive "$SRC/*" "$DST/"

echo ">>> done. final size:"
gcloud storage du --summarize "$DST"
