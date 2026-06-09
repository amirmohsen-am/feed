/**
 * Apply sql/007_user_sessions.sql to the feed-db Postgres instance.
 *
 * Run with: `npx tsx scripts/apply-user-sessions-migration.ts`
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getPool } from "../src/lib/pg";

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sqlPath = join(here, "..", "sql", "007_user_sessions.sql");
  const sql = readFileSync(sqlPath, "utf8");

  console.log(`Applying ${sqlPath} to feed-db…`);
  const pool = await getPool();
  await pool.query(sql);

  const sessions = await pool.query(
    "SELECT COUNT(*)::int AS n FROM user_sessions"
  );
  const dupes = await pool.query(`
    SELECT COUNT(*)::int AS n FROM (
      SELECT bluesky_did FROM users
      WHERE bluesky_did IS NOT NULL
      GROUP BY bluesky_did HAVING COUNT(*) > 1
    ) d
  `);
  const idx = await pool.query(
    "SELECT indexname FROM pg_indexes WHERE indexname = 'users_bluesky_did_unique'"
  );
  const col = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'bsky_oauth_state' AND column_name = 'session_id'`
  );

  console.log(`user_sessions rows: ${sessions.rows[0].n}`);
  console.log(`remaining duplicate dids: ${dupes.rows[0].n}`);
  console.log(
    `users_bluesky_did_unique index: ${idx.rows.length ? "present" : "missing"}`
  );
  console.log(
    `bsky_oauth_state.session_id column: ${col.rows.length ? "present" : "missing"}`
  );
  console.log("\n✓ migration applied");

  await pool.end();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("✗ migration failed:", err.message ?? err);
    process.exit(1);
  });
