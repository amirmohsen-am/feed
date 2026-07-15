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

  bskyCloudSqlInstance:
    process.env.BSKY_CLOUDSQL_CONNECTION_NAME ?? 'timelines-492720:us-central1:bsky-db',

  // Per-consumer flush tuning. Engagement is high-volume; posts are richer; profiles trickle.
  postFlushMs: parseInt(process.env.POST_FLUSH_MS ?? '5000', 10),
  postBatchMax: parseInt(process.env.POST_BATCH_MAX ?? '200', 10),
  engagementFlushMs: parseInt(process.env.ENGAGEMENT_FLUSH_MS ?? '2000', 10),
  engagementBatchMax: parseInt(process.env.ENGAGEMENT_BATCH_MAX ?? '2000', 10),
  profileFlushMs: parseInt(process.env.PROFILE_FLUSH_MS ?? '10000', 10),
  profileBatchMax: parseInt(process.env.PROFILE_BATCH_MAX ?? '50', 10),
  // Labelers are extremely rare (a few records network-wide per day); flush slowly.
  labelerFlushMs: parseInt(process.env.LABELER_FLUSH_MS ?? '15000', 10),
  labelerBatchMax: parseInt(process.env.LABELER_BATCH_MAX ?? '50', 10),

  // Retention prune (caps the pgvector HNSW index). Supported feed windows
  // are capped at retentionDays — keep them in sync (web app TimeWindow).
  // 7d (down from 14d, 2026-07-14): feed windows max out at 3d, so longer
  // retention only grew the HNSW index past what the instance's RAM can hold
  // (autovacuum index passes then starve ingest inserts). The GCS parquet
  // archive keeps everything; longer retention can be re-backfilled.
  retentionDays: parseInt(process.env.RETENTION_DAYS ?? '7', 10),
  pruneIntervalMs: parseInt(process.env.PRUNE_INTERVAL_MS ?? String(24 * 60 * 60 * 1000), 10),
} as const

export type Config = typeof config
