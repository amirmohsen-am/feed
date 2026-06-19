/**
 * Bootstrap a LOCAL feed-db — no Cloud SQL, no Secret Manager.
 *
 * Runs every sql/*.sql migration in order against LOCAL_DATABASE_URL. The
 * migrations are self-contained: 000_base.sql creates the base tables and
 * 001+ evolve the schema, so this reproduces prod from an empty database.
 *
 * Usage:
 *   1. Start Postgres (pgvector NOT required for feed-db), e.g.:
 *        docker run --name feed-local -e POSTGRES_PASSWORD=postgres \
 *          -e POSTGRES_DB=feed_curator -p 5432:5432 -d postgres:16
 *   2. export LOCAL_DATABASE_URL=postgres://postgres:postgres@localhost:5432/feed_curator
 *   3. npx tsx scripts/setup-local-db.ts
 *
 * Idempotent (every migration is IF NOT EXISTS / guarded). Refuses to run
 * without LOCAL_DATABASE_URL, so it can never touch prod.
 */

import { readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";

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
    .sort(); // 000_… → 009_… numeric/lexical order

  const pool = new Pool({ connectionString: url });
  console.log(
    `Bootstrapping local feed-db at ${url.replace(/:[^:@/]+@/, ":****@")}`
  );
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
