import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const SCHEMA = `
-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  photo_url TEXT,
  bluesky_handle TEXT,
  bluesky_did TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_firebase ON users(firebase_uid);

-- Feeds (user-scoped, stores full config as JSONB)
CREATE TABLE IF NOT EXISTS feeds (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Untitled',
  description TEXT NOT NULL DEFAULT '',
  mechanical_filters JSONB NOT NULL DEFAULT '{}',
  semantic_config JSONB NOT NULL DEFAULT '{}',
  published_rkey TEXT,
  is_active BOOLEAN DEFAULT true,
  color TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feeds_user ON feeds(user_id);
CREATE INDEX IF NOT EXISTS idx_feeds_active ON feeds(is_active) WHERE is_active = true;

-- Chat messages (per-feed)
CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY,
  feed_id INT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Mailing list subscribers
CREATE TABLE IF NOT EXISTS subscribers (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
`;

async function main() {
  console.log("Setting up PostgreSQL schema...");
  console.log(`Database: ${process.env.DATABASE_URL?.replace(/:[^@]+@/, ":***@")}`);

  try {
    await pool.query(SCHEMA);
    console.log("Schema created successfully.");

    // Verify tables
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
    );
    console.log(
      "Tables:",
      tables.rows.map((r: { table_name: string }) => r.table_name).join(", ")
    );
  } catch (err: any) {
    console.error("Setup failed:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
