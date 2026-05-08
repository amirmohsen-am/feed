// Env-driven config. Defaults match the timelines-492720 GCP project.
// All values can be overridden by Cloud Run env vars at deploy time.

export const config = {
  gcpProject: process.env.GCP_PROJECT ?? 'timelines-492720',
  gcpLocation: process.env.GCP_LOCATION ?? 'us-central1',
  gcsBucket: process.env.GCS_BUCKET ?? 'happy-feed-data-timelines',

  embedModel: process.env.EMBED_MODEL ?? 'gemini-embedding-001',
  embedDim: parseInt(process.env.EMBED_DIM ?? '768', 10),

  jetstreamHost: process.env.JETSTREAM_HOST ?? 'jetstream2.us-west.bsky.network',
  batchMax: parseInt(process.env.BATCH_MAX ?? '200', 10),
  flushMs: parseInt(process.env.FLUSH_MS ?? '5000', 10),

  vertexIndexId: process.env.VERTEX_INDEX_ID ?? '',
  vertexIndexEndpointId: process.env.VERTEX_INDEX_ENDPOINT_ID ?? '',
  vertexIndexEndpointHost: process.env.VERTEX_INDEX_ENDPOINT_HOST ?? '',
  vertexDeployedIndexId: process.env.VERTEX_DEPLOYED_INDEX_ID ?? 'happy_feed_deployed',
} as const

export type Config = typeof config
