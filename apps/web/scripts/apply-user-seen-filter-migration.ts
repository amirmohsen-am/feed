/**
 * Apply sql/011_user_seen_filter.sql to the feed-db Postgres instance.
 *
 * Run with: `npx tsx scripts/apply-user-seen-filter-migration.ts`
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getPool } from "../src/lib/pg";

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sqlPath = join(here, "..", "sql", "011_user_seen_filter.sql");
  const sql = readFileSync(sqlPath, "utf8");

  console.log(`Applying ${sqlPath} to feed-db…`);
  const pool = await getPool();
  await pool.query(sql);

  const col = await pool.query(
    `SELECT column_default, is_nullable FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'seen_filter_enabled'`
  );
  const on = await pool.query(
    `SELECT count(*)::int AS n FROM users WHERE seen_filter_enabled = true`
  );
  console.log("users.seen_filter_enabled:", col.rows[0] ?? "(missing!)");
  console.log(`users with seen filtering on: ${on.rows[0].n}`);
  await pool.end();
}

main().catch((e) => {
  console.error("ERR:", e?.message ?? e);
  process.exit(1);
});
