-- Recsys: deterministic ranking-bias weights + per-user "seen" tracking.
--
-- 1. Ranking-bias knobs on `feeds`. All four participate in the feed config
--    hash (computed app-side in lib/db/preview.ts), so editing a weight
--    invalidates the cached snapshot and forces a recompute. Nullable-with-
--    default so existing rows inherit the defaults without a backfill.
--
--    The blend is applied DETERMINISTICALLY at bake time, AFTER the LLM
--    reranker, re-sorting the kept pool by:
--        final = w_q·(rerank/100) + w_e·engagement + w_r·recency
--    where w_q = 1 - w_e - w_r. See lib/db/blend.ts.
ALTER TABLE feeds
  ADD COLUMN IF NOT EXISTS engagement_weight   real    NOT NULL DEFAULT 0.20,
  ADD COLUMN IF NOT EXISTS recency_weight      real    NOT NULL DEFAULT 0.10,
  ADD COLUMN IF NOT EXISTS recency_halflife_h  real    NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS seen_filter_enabled boolean NOT NULL DEFAULT false;

-- The candidate budget default was bumped 150 -> 200 (see lib/defaults.ts
-- DEFAULT_CANDIDATE_BUDGET) to give the reranker a wider net and leave headroom
-- once serve-time seen filtering removes posts from the snapshot. The column
-- (000_base.sql) still defaulted to 150, so the bump never reached new feeds.
-- New feeds only; existing rows keep their stored value (an explicit user
-- choice of 150 is preserved).
ALTER TABLE feeds ALTER COLUMN candidate_budget SET DEFAULT 200;

-- 2. Per-user, per-feed "seen" set. Scoped per feed so a post seen in one feed
--    does not suppress it in another. Recorded from real on-screen impressions
--    (viewport + dwell), matching the Bluesky client: the curator preview posts
--    to /api/seen, the published feed reports app.bsky.feed.sendInteractions
--    #interactionSeen events. Pruned to the post retention window (see
--    lib/db/seen.ts pruneSeen / the refresh cron).
--
--    feed_id is bigint to match the existing convention in 003_feedback.sql
--    (feeds.id is SERIAL/int4; Postgres allows the wider FK type).
CREATE TABLE IF NOT EXISTS seen_posts (
  user_id  uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feed_id  bigint      NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  post_uri text        NOT NULL,
  seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feed_id, post_uri)
);

-- Prune scans by age across all users.
CREATE INDEX IF NOT EXISTS seen_posts_seen_at_idx ON seen_posts (seen_at);
