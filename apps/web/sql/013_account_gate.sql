-- Account gate: per-user nudge bookkeeping for the "connect Bluesky" flow.
-- Nudges recur (every N feeds/posts/refinements/days, see
-- src/lib/account-gate.ts); after GATE_WALL_NUDGES popups the next threshold
-- crossing raises a hard wall instead.
--
-- Shape: jsonb map, e.g.
--   {"feeds": 3, "posts": 200, "count": 2, "wall": "2026-07-02T..."}
-- Per-metric keys hold the usage level at which that metric last nudged (so
-- reloads never re-trigger, the next interval does). "count" is total nudge
-- popups shown. "wall" is a sticky marker so the wall never reopens once hit
-- (derived counts can shrink — seen_posts is pruned to a retention window).
-- Per-USER (not per-session): user_sessions maps many sessions to one user,
-- and the grace period follows the person, not the browser tab.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS gate_nudges_shown jsonb NOT NULL DEFAULT '{}'::jsonb;
