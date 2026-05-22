import { bskyQuery } from "../src/lib/bsky-pg";

(async () => {
  console.log("=== consumer_state ===");
  const cs = await bskyQuery(`
    SELECT consumer, cursor_us, updated_at,
           now() - updated_at AS age,
           to_timestamp(cursor_us / 1000000.0) AS cursor_time,
           now() - to_timestamp(cursor_us / 1000000.0) AS cursor_lag
      FROM bsky.consumer_state
      ORDER BY consumer`);
  for (const r of cs.rows) {
    console.log(
      `  ${String(r.consumer).padEnd(20)} ` +
        `last_updated=${r.age}  ` +
        `cursor_time=${r.cursor_time && r.cursor_time.toISOString ? r.cursor_time.toISOString() : r.cursor_time}  ` +
        `cursor_lag=${r.cursor_lag}`
    );
  }

  console.log("\n=== posts ingested by hour (last 12h) ===");
  // If there's an indexed_at / inserted_at column use it; otherwise fall back.
  const cols = await bskyQuery(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='bsky' AND table_name='posts'`
  );
  const colNames = cols.rows.map((r) => (r as { column_name: string }).column_name);
  const tcol = colNames.includes("indexed_at")
    ? "indexed_at"
    : colNames.includes("inserted_at")
    ? "inserted_at"
    : null;
  console.log(`(using time column: ${tcol ?? "created_at (fallback)"})`);
  if (tcol) {
    const hours = await bskyQuery(
      `SELECT date_trunc('hour', ${tcol}) AS hour, COUNT(*) AS n
         FROM bsky.posts
        WHERE ${tcol} > now() - interval '12 hours'
        GROUP BY 1 ORDER BY 1 DESC`
    );
    for (const r of hours.rows) {
      console.log(`  ${r.hour.toISOString()}  ${r.n} posts`);
    }
    if (hours.rows.length === 0) {
      const max = await bskyQuery(
        `SELECT MAX(${tcol}) AS max_t, now() - MAX(${tcol}) AS lag FROM bsky.posts`
      );
      console.log(`  (no posts in last 12h; max ${tcol}=${max.rows[0].max_t}, lag=${max.rows[0].lag})`);
    }
  }

  console.log("\n=== engagement push lag ===");
  const eng = await bskyQuery(
    `SELECT MAX(last_pushed_to_vertex_at) AS max_pushed,
            now() - MAX(last_pushed_to_vertex_at) AS lag,
            COUNT(*) AS total_rows,
            SUM(CASE WHEN updated_at > last_pushed_to_vertex_at THEN 1 ELSE 0 END) AS dirty
       FROM bsky.post_engagement`
  );
  console.log(`  max_pushed=${eng.rows[0].max_pushed}  lag=${eng.rows[0].lag}  total=${eng.rows[0].total_rows}  dirty=${eng.rows[0].dirty}`);

  process.exit(0);
})().catch((e) => {
  console.error("ERR:", e?.message ?? e);
  process.exit(1);
});
