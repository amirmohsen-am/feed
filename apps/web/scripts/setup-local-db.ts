/**
 * Bootstrap a LOCAL feed-db — no Cloud SQL, no Secret Manager.
 *
 * Creates the full feed-db schema: the base tables that historically only
 * existed in prod (users, feeds, chat_messages, feed_result_cache,
 * subscribers) plus every sql/*.sql migration in order, against
 * LOCAL_DATABASE_URL.
 *
 * Usage:
 *   1. Start Postgres (pgvector NOT required for feed-db), e.g.:
 *        docker run --name feed-local -e POSTGRES_PASSWORD=postgres \
 *          -e POSTGRES_DB=feed_curator -p 5432:5432 -d postgres:16
 *   2. export LOCAL_DATABASE_URL=postgres://postgres:postgres@localhost:5432/feed_curator
 *   3. npx tsx scripts/setup-local-db.ts
 *
 * Idempotent (everything is IF NOT EXISTS / guarded). Refuses to run without
 * LOCAL_DATABASE_URL, so it can never touch prod.
 */

import { readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";

// Base tables. These were created by hand in prod (no migration file owns
// them), so a fresh local DB needs them spelled out. Columns mirror the
// current shape the data-access layer expects (see src/lib/db/*).
const BASE_SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid      text UNIQUE,
  session_id        text,
  name              text NOT NULL DEFAULT '',
  email             text NOT NULL DEFAULT '',
  photo_url         text,
  bluesky_handle    text,
  bluesky_did       text,
  bsky_app_password text,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feeds (
  id                      serial PRIMARY KEY,
  user_id                 uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                    text NOT NULL DEFAULT 'Untitled',
  mechanical_filters      jsonb NOT NULL DEFAULT '{}'::jsonb,
  subqueries              jsonb NOT NULL DEFAULT '[]'::jsonb,
  candidate_budget        int NOT NULL DEFAULT 150,
  rerank_prompt           text DEFAULT '',
  rerank_model            text NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
  rerank_thinking_enabled boolean NOT NULL DEFAULT false,
  published_rkey          text,
  is_active               boolean DEFAULT true,
  color                   text,
  parent_feed_id          int REFERENCES feeds(id) ON DELETE SET NULL,
  source_post_uri         text,
  -- Legacy derived chip label (migration 002); unused by code, kept to match prod.
  retrieval_query         text NOT NULL DEFAULT '',
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         serial PRIMARY KEY,
  feed_id    int NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  role       text NOT NULL,
  content    text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feed_result_cache (
  feed_id     int PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,
  config_hash text NOT NULL,
  posts       jsonb NOT NULL DEFAULT '[]'::jsonb,
  cached_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscribers (
  id         serial PRIMARY KEY,
  email      text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now()
);
`;

async function main() {
  const url = process.env.LOCAL_DATABASE_URL;
  if (!url) {
    console.error(
      "LOCAL_DATABASE_URL is not set — refusing to run (this script is local-only and must never touch prod)."
    );
    process.exit(1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const sqlDir = join(here, "..", "sql");
  const files = readdirSync(sqlDir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // 001_… → 009_… numeric/lexical order

  const pool = new Pool({ connectionString: url });
  console.log(
    `Bootstrapping local feed-db at ${url.replace(/:[^:@/]+@/, ":****@")}`
  );
  console.log("→ base schema");
  await pool.query(BASE_SCHEMA);
  for (const f of files) {
    console.log(`→ ${f}`);
    await pool.query(readFileSync(join(sqlDir, f), "utf8"));
  }
  console.log("✓ local feed-db ready");
  await pool.end();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("✗ setup failed:", e?.message ?? e);
    process.exit(1);
  });
