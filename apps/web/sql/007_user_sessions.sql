-- Many browser sessions → one Willow user (cross-device Bluesky login).
-- Apply against feed-db (database: feed_curator). Idempotent.

CREATE TABLE IF NOT EXISTS user_sessions (
  session_id text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx ON user_sessions(user_id);

-- Backfill from the legacy single session_id column on users.
INSERT INTO user_sessions (session_id, user_id)
SELECT session_id, id FROM users
WHERE session_id IS NOT NULL
ON CONFLICT (session_id) DO NOTHING;

-- Merge rows that share a bluesky_did (cross-device re-logins before this
-- migration). Keep the oldest user row as canonical; move feeds + sessions.
WITH dup_groups AS (
  SELECT bluesky_did,
         (array_agg(id ORDER BY created_at, id))[1] AS canonical_id
  FROM users
  WHERE bluesky_did IS NOT NULL
  GROUP BY bluesky_did
  HAVING COUNT(*) > 1
),
dup_users AS (
  SELECT u.id AS user_id, dg.canonical_id
  FROM users u
  JOIN dup_groups dg ON u.bluesky_did = dg.bluesky_did
  WHERE u.id <> dg.canonical_id
)
UPDATE feeds f
SET user_id = du.canonical_id
FROM dup_users du
WHERE f.user_id = du.user_id;

WITH dup_groups AS (
  SELECT bluesky_did,
         (array_agg(id ORDER BY created_at, id))[1] AS canonical_id
  FROM users
  WHERE bluesky_did IS NOT NULL
  GROUP BY bluesky_did
  HAVING COUNT(*) > 1
)
INSERT INTO user_sessions (session_id, user_id)
SELECT u.session_id, dg.canonical_id
FROM users u
JOIN dup_groups dg ON u.bluesky_did = dg.bluesky_did
WHERE u.session_id IS NOT NULL
ON CONFLICT (session_id) DO UPDATE SET user_id = EXCLUDED.user_id;

WITH dup_groups AS (
  SELECT bluesky_did,
         (array_agg(id ORDER BY created_at, id))[1] AS canonical_id
  FROM users
  WHERE bluesky_did IS NOT NULL
  GROUP BY bluesky_did
  HAVING COUNT(*) > 1
)
UPDATE users u
SET bluesky_did = NULL, bluesky_handle = NULL, updated_at = now()
FROM dup_groups dg
WHERE u.bluesky_did = dg.bluesky_did AND u.id <> dg.canonical_id;

-- One Bluesky account maps to one Willow user row.
CREATE UNIQUE INDEX IF NOT EXISTS users_bluesky_did_unique
  ON users(bluesky_did) WHERE bluesky_did IS NOT NULL;

-- Remember which browser session started each OAuth flow (for cookie restore).
ALTER TABLE bsky_oauth_state ADD COLUMN IF NOT EXISTS session_id text;
