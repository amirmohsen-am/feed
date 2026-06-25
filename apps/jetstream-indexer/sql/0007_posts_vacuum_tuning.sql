-- Keep bsky.posts dead-tuple bloat (and therefore HNSW read latency + disk
-- usage) bounded.
--
-- Background: bsky.posts is high-churn (continuous Jetstream inserts + a daily
-- retention prune that DELETEs ~2M+ rows/day). At the default
-- autovacuum_vacuum_scale_factor = 0.2 with the default cost throttle
-- (cost_delay = 2ms, cost_limit = 200), a single autovacuum pass over the
-- 330GB relation (279GB heap + a 38GB HNSW index it must also scan) runs for
-- hours and never catches up: observed 14.4M dead vs 6.7M live (68% dead).
--
-- The dead tuples are the dominant read-latency cause: the HNSW graph carries
-- entries for not-yet-vacuumed dead rows, so a cold KNN graph walk traverses
-- dead nodes and does heap visibility checks against the bloated heap, turning
-- a ~150ms warm query into 5-8s cold. Bloat also grows the on-disk footprint
-- unboundedly toward a disk-full read-only event.
--
-- Fix: vacuum far more often and without the I/O throttle. This is a dedicated
-- instance on SSD, so unthrottled vacuum is the right trade (vacuum I/O is
-- cheaper than serving cold KNN walks over a bloated graph).
--   scale_factor 0.2 -> 0.05  : trigger at ~5% dead instead of ~20%
--   cost_delay      2 -> 0     : remove the per-page sleep (no throttle)
--   cost_limit    200 -> 2000  : moot at cost_delay=0, set for safety if a
--                                delay is ever reintroduced
-- Companion to 0006 (which tuned only ANALYZE, not VACUUM).
ALTER TABLE bsky.posts SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_vacuum_cost_delay   = 0,
  autovacuum_vacuum_cost_limit   = 2000
);

-- effective_cache_size is a planner hint for how much data is likely resident
-- (shared_buffers + OS page cache). 0005 set it to 12GB, far too low for this
-- db-custom-8-53248 instance (52GB RAM, shared_buffers ~17GB). Too low a value
-- makes the planner overestimate index-scan random-I/O cost and biases it away
-- from the HNSW index (toward the created_at btree + exact sort plan-flip the
-- read path otherwise has to defend against with SET LOCAL enable_sort = off).
-- Set to ~75% of RAM.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET effective_cache_size = ''38GB''', current_database());
END
$$;
