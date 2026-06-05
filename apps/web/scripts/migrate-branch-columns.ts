// One-off migration: add branch-lineage columns to feed-db `feeds`.
// Idempotent + additive. Reuses the app's getPool() (cloud-sql-connector +
// ADC + database-url secret), so it runs the same way locally and in CI.
//
//   npx tsx scripts/migrate-branch-columns.ts
import { query, getPool } from "../src/lib/pg";

const STATEMENTS = [
  `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS parent_feed_id INT REFERENCES feeds(id) ON DELETE SET NULL`,
  `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS source_post_uri TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_feeds_parent ON feeds(parent_feed_id) WHERE parent_feed_id IS NOT NULL`,
];

async function main() {
  for (const sql of STATEMENTS) {
    process.stdout.write(`> ${sql}\n`);
    await query(sql);
  }
  const cols = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'feeds' AND column_name IN ('parent_feed_id','source_post_uri')
     ORDER BY column_name`
  );
  console.log(
    "feeds now has:",
    cols.rows.map((r: { column_name: string }) => r.column_name).join(", ")
  );
  await (await getPool()).end();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("Migration failed:", err?.message ?? err);
    process.exit(1);
  }
);
