-- /search route — reranker prompts (with versions) + search run log.
-- Apply against the feed-db Postgres instance (database: feed_curator).
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS rerank_prompts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               text NOT NULL,
  current_version_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rerank_prompts_user_idx ON rerank_prompts(user_id);

CREATE TABLE IF NOT EXISTS rerank_prompt_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id     uuid NOT NULL REFERENCES rerank_prompts(id) ON DELETE CASCADE,
  version       int  NOT NULL,
  system_prompt text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prompt_id, version)
);

ALTER TABLE rerank_prompts
  DROP CONSTRAINT IF EXISTS rerank_prompts_current_version_fk;
ALTER TABLE rerank_prompts
  ADD CONSTRAINT rerank_prompts_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES rerank_prompt_versions(id)
  ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS search_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query             text NOT NULL,
  vector_k          int  NOT NULL,
  rerank_k          int  NOT NULL,
  rerank_enabled    boolean NOT NULL DEFAULT true,
  prompt_version_id uuid REFERENCES rerank_prompt_versions(id) ON DELETE SET NULL,
  filters_json      jsonb,
  vector_hit_uris   text[] NOT NULL,
  rerank_kept       jsonb,           -- [{i, uri, score, reason}] | null when reranker disabled
  ms_embed          int,
  ms_find           int,
  ms_hydrate        int,
  ms_rerank         int,
  ms_total          int,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS search_runs_user_created_idx
  ON search_runs(user_id, created_at DESC);
