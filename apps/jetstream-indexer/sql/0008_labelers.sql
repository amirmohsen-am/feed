-- Labeler directory.
--
-- `bsky.labelers` is the source of truth for the *set* of known labeler DIDs.
-- It is seeded once from a public directory (scripts/seed-labelers.ts) and then
-- kept fresh going forward by the Jetstream `app.bsky.labeler.service` consumer
-- (Phase 2). AT Protocol has no "list all labelers" endpoint, so this discovery
-- set is the only way to enumerate them.
--
-- The profile + like_count columns are a cache of the AppView's
-- `app.bsky.labeler.getServices?detailed=true` response. The web app refreshes
-- them on read (see apps/web/src/lib/labelers.ts); like counts are the true
-- on-protocol aggregate and are never computed here.

CREATE TABLE IF NOT EXISTS bsky.labelers (
  did           text PRIMARY KEY,
  handle        text,
  display_name  text,
  description   text,
  avatar_url    text,
  like_count    integer,
  -- when the DID first entered the directory (seed or Jetstream discovery)
  discovered_at timestamptz NOT NULL DEFAULT now(),
  -- last successful AppView enrichment; NULL until first enriched
  enriched_at   timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The directory is served ordered by like count.
CREATE INDEX IF NOT EXISTS labelers_like_count_idx
  ON bsky.labelers (like_count DESC NULLS LAST);
