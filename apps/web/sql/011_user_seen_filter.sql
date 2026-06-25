-- Move "seen filtering" from a per-feed flag to a per-USER preference.
--
-- Rationale: "hide posts I've already seen" is a viewer concern, not a feed
-- algorithm choice. Filtering only ever applies to identified Ripple users
-- anyway (the published path resolves the viewer's DID -> users row), so the
-- setting belongs on the viewer. Enabled by default — the unseen experience is
-- the intended default for everyone.
--
-- The seen SET itself stays per-(user, feed) in seen_posts (010_recsys.sql):
-- a post seen in one feed must not vanish from another.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS seen_filter_enabled boolean NOT NULL DEFAULT true;

-- NOTE: feeds.seen_filter_enabled (010_recsys.sql) is now dead — no code reads
-- it after this change. It is intentionally NOT dropped here: the currently
-- deployed web service still references it, so dropping before this branch
-- ships would break its feed-update path. Drop it in a follow-up migration once
-- this is deployed:
--   ALTER TABLE feeds DROP COLUMN IF EXISTS seen_filter_enabled;
