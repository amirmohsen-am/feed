-- Base feed-db tables. These were originally hand-created in prod before the
-- numbered migrations existed, so no later migration "owns" them. This file
-- gives them a home: it creates them in their PRE-migration shape, and the
-- 001+ migrations evolve them from here (002 renames feeds.description ->
-- retrieval_query, 004/006 add user columns, 009 adds feeds.is_home, ...).
--
-- Running 000 -> 009 in order against an empty database reproduces prod.
--
-- Apply against feed-db (database: feed_curator). Idempotent: safe to re-run.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid   text UNIQUE NOT NULL,          -- 006 drops NOT NULL
  name           text NOT NULL DEFAULT '',
  email          text NOT NULL DEFAULT '',
  photo_url      text,
  bluesky_handle text,
  bluesky_did    text,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
  -- 004 adds bsky_app_password; 006 adds session_id
);

CREATE TABLE IF NOT EXISTS feeds (
  id                      serial PRIMARY KEY,
  user_id                 uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                    text NOT NULL DEFAULT 'Untitled',
  mechanical_filters      jsonb NOT NULL DEFAULT '{}'::jsonb,
  subqueries              jsonb NOT NULL DEFAULT '[]'::jsonb,
  candidate_budget        int NOT NULL DEFAULT 150,
  rerank_model            text NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
  rerank_thinking_enabled boolean NOT NULL DEFAULT false,
  published_rkey          text,
  is_active               boolean DEFAULT true,
  color                   text,
  parent_feed_id          int REFERENCES feeds(id) ON DELETE SET NULL,
  source_post_uri         text,
  description             text NOT NULL DEFAULT '',  -- 002 renames -> retrieval_query
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now()
  -- 002 adds rerank_prompt; 009 adds is_home
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
