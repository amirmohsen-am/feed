-- Database-level HNSW settings for the read path (apps/web vector-search.ts).
-- Previously applied out-of-band; asserted here so a bsky-db rebuild/restore
-- can't silently lose them (feeds with selective filters would degrade to
-- near-empty results, no errors).
--
-- ef_search: recall knob — database-level so the pooled one-shot read path
-- needs no SET LOCAL.
--
-- iterative_scan + max_scan_tuples: fix filtered-KNN starvation. The default
-- scan stops after ef_search candidates and post-filters, so selective filter
-- combos (e.g. 24h + en + top-level + min likes ≈ 0.5% of indexed rows) yield
-- ~1 hit regardless of LIMIT. Iterative scan resumes the graph walk until the
-- LIMIT fills, bounded at max_scan_tuples visited — never a full scan.
-- relaxed_order is safe: searchPosts unions per-subquery results and the
-- reranker reorders anyway.
--
-- Settings apply to NEW connections only; existing pooled connections keep
-- old values until they recycle.

-- Load vector.so in this session: until then hnsw.* are unknown placeholder
-- GUCs and ALTER DATABASE fails with "permission denied to set parameter".
SELECT '[1,2,3]'::vector;

-- ALTER DATABASE needs the database name literally; resolve it at runtime so
-- the migration works against any clone/rename of the database.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET hnsw.ef_search = 250', current_database());
  EXECUTE format('ALTER DATABASE %I SET hnsw.iterative_scan = ''relaxed_order''', current_database());
  EXECUTE format('ALTER DATABASE %I SET hnsw.max_scan_tuples = 40000', current_database());
  EXECUTE format('ALTER DATABASE %I SET effective_cache_size = ''12GB''', current_database());
END
$$;
