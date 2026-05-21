-- Curator reranker — rename feed.description (a UI label, never read by the
-- vector path) to feed.retrieval_query for clarity, and add feed.rerank_prompt
-- as the per-feed system prompt for the Claude reranker.
--
-- The actual text sent to Vertex still comes from buildSearchQuery(feed) over
-- semantic_config at read time; the renamed column stays a derived chip label.
--
-- Apply against feed-db (database: feed_curator).
-- Idempotent: safe to re-run.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'feeds'
      AND column_name = 'description'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'feeds'
      AND column_name = 'retrieval_query'
  ) THEN
    ALTER TABLE feeds RENAME COLUMN description TO retrieval_query;
  END IF;
END$$;

ALTER TABLE feeds
  ADD COLUMN IF NOT EXISTS rerank_prompt text;
