/**
 * Apply sql/001_search.sql to the feed-db Postgres instance.
 *
 * Uses the same Cloud SQL Connector path as the running app, so the
 * connection string is fetched from Secret Manager via getSecret() —
 * never printed.
 *
 * Run with: `npx tsx scripts/apply-search-migration.ts`
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getPool } from "../src/lib/pg";

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sqlPath = join(here, "..", "sql", "001_search.sql");
  const sql = readFileSync(sqlPath, "utf8");

  console.log(`Applying ${sqlPath} to feed-db…`);
  const pool = await getPool();
  await pool.query(sql);
  console.log("✓ migration applied");

  await pool.end();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("✗ migration failed:", err.message ?? err);
    process.exit(1);
  });
