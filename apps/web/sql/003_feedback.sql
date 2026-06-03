-- In-app feedback button (curator topbar) — stores user-submitted feedback.
-- Apply against the feed-db Postgres instance (database: feed_curator).
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS feedback (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feed_id     bigint REFERENCES feeds(id) ON DELETE SET NULL,
  category    text NOT NULL CHECK (category IN ('bug','idea','feed_quality','other')),
  rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 10),
  body        text,
  page_url    text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_user_created_idx
  ON feedback(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS feedback_feed_idx
  ON feedback(feed_id) WHERE feed_id IS NOT NULL;
