import { getPool } from "../src/lib/pg";

const SQL = `
ALTER TABLE feeds ADD COLUMN IF NOT EXISTS subqueries JSONB NOT NULL DEFAULT '[]';
ALTER TABLE feeds ADD COLUMN IF NOT EXISTS candidate_budget INT NOT NULL DEFAULT 150;
ALTER TABLE feeds ADD COLUMN IF NOT EXISTS rerank_prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE feeds ADD COLUMN IF NOT EXISTS rerank_model TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001';
ALTER TABLE feeds ADD COLUMN IF NOT EXISTS rerank_thinking_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE feeds DROP COLUMN IF EXISTS semantic_config;
ALTER TABLE feeds DROP COLUMN IF EXISTS description;
ALTER TABLE feeds DROP COLUMN IF EXISTS rerank_prompt_id;
`;

(async () => {
  const pool = await getPool();
  console.log("Applying migration...");
  await pool.query(SQL);
  const cols = await pool.query(`
    SELECT column_name, data_type, column_default
      FROM information_schema.columns
     WHERE table_name = 'feeds'
     ORDER BY ordinal_position`);
  console.log("\nfeeds columns:");
  for (const r of cols.rows) {
    console.log(
      `  ${r.column_name.padEnd(22)} ${String(r.data_type).padEnd(28)} default=${r.column_default ?? ""}`
    );
  }
  await pool.end();
})().catch((e) => {
  console.error("ERR:", e?.message ?? e);
  process.exit(1);
});
