-- Add is_home flag to feeds. Each user has at most one home feed.
ALTER TABLE feeds ADD COLUMN IF NOT EXISTS is_home boolean NOT NULL DEFAULT false;

-- Partial unique index: at most one home feed per user.
CREATE UNIQUE INDEX IF NOT EXISTS feeds_user_home_unique
  ON feeds (user_id)
  WHERE is_home = true;
