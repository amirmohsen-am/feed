-- Bluesky OAuth state + session storage for AT Protocol OAuth 2.0 (DPoP).
-- Apply against the feed-db Postgres instance (database: feed_curator).
--
-- Idempotent: safe to re-run.

-- Ephemeral state during the authorize → callback round-trip.
CREATE TABLE IF NOT EXISTS bsky_oauth_state (
  key         text PRIMARY KEY,
  data        jsonb NOT NULL,
  expires_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS bsky_oauth_state_expires_idx
  ON bsky_oauth_state(expires_at);

-- user_id + session_id are stored alongside the state so the callback can
-- attribute the OAuth flow back to the right user / browser session (see
-- bsky-oauth.ts). Added via ALTER (idempotent) — prod already has these, so
-- this is a no-op there and just keeps a fresh DB faithful to prod.
ALTER TABLE bsky_oauth_state ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE bsky_oauth_state ADD COLUMN IF NOT EXISTS session_id text;

-- Long-lived session tokens keyed by DID.
CREATE TABLE IF NOT EXISTS bsky_oauth_session (
  did         text PRIMARY KEY,
  data        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
