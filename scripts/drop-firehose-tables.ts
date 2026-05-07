import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log(
    `Database: ${process.env.DATABASE_URL?.replace(/:[^@]+@/, ":***@")}`
  );
  await pool.query("DROP TABLE IF EXISTS feed_posts CASCADE");
  console.log("Dropped feed_posts");
  await pool.query("DROP TABLE IF EXISTS posts CASCADE");
  console.log("Dropped posts");
  await pool.query("DROP TABLE IF EXISTS author_post_counts CASCADE");
  console.log("Dropped author_post_counts");

  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
  );
  console.log(
    "Remaining tables:",
    tables.rows.map((r: { table_name: string }) => r.table_name).join(", ")
  );
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
