-- Cache for Hive AI-generated image classification, keyed by image URL.
-- Apply against the feed-db Postgres instance (database: feed_curator).
--
-- Bluesky image URLs are content-addressed (the blob CID is in the path), so a
-- given URL's classification is stable forever — there is no TTL. Each unique
-- image therefore hits the paid Hive API at most once, ever, across all users.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS ai_image_labels (
  image_url     text PRIMARY KEY,
  ai_generated  boolean NOT NULL,
  score         real NOT NULL,
  checked_at    timestamptz NOT NULL DEFAULT now()
);
