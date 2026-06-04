-- Drop the dead Vertex reconciler state.
--
-- The vertexReconciler loop (which pushed engagement numeric_restricts to the
-- Vertex Vector Search index) was removed when search migrated to pgvector
-- (PR #20), and the Vertex index/endpoint were deleted. The reconciler's
-- bookkeeping on bsky.post_engagement is now unused: engagement counters are
-- read live by the read-side KNN join, with no separate push step.
--
-- 0001_bsky.sql is left intact as historical record (already applied
-- everywhere); this forward migration drops the leftovers idempotently.

DROP INDEX IF EXISTS bsky.post_engagement_dirty_idx;

ALTER TABLE bsky.post_engagement
  DROP COLUMN IF EXISTS last_pushed_to_vertex_at;
