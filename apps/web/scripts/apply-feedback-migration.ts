/**
 * Apply sql/003_feedback.sql to the feed-db Postgres instance.
 *
 * Uses the same Cloud SQL Connector path as the running app, so the
 * connection string is fetched from Secret Manager via getSecret() —
 * never printed.
 *
 * Run with: `npx tsx scripts/apply-feedback-migration.ts`
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getPool } from "../src/lib/pg";

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sqlPath = join(here, "..", "sql", "003_feedback.sql");
  const sql = readFileSync(sqlPath, "utf8");

  console.log(`Applying ${sqlPath} to feed-db…`);
  const pool = await getPool();
  await pool.query(sql);

  const cols = await pool.query(`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name = 'feedback'
     ORDER BY ordinal_position`);
  console.log("\nfeedback columns:");
  for (const r of cols.rows) {
    console.log(
      `  ${String(r.column_name).padEnd(14)} ${String(r.data_type).padEnd(28)} ` +
        `null=${r.is_nullable} default=${r.column_default ?? ""}`
    );
  }
  console.log("\n✓ migration applied");

  await pool.end();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("✗ migration failed:", err.message ?? err);
    process.exit(1);
  });
