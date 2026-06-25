/**
 * One-shot online maintenance to reclaim bsky.posts bloat and shrink the HNSW
 * index so cold KNN walks stop hitting disk (5-8s -> ~150ms). See
 * sql/0007_posts_vacuum_tuning.sql for the durable settings; this performs the
 * one-time catch-up the settings alone can't do retroactively.
 *
 * Steps (all online, no exclusive locks on reads/writes):
 *   1. Apply the per-table autovacuum + effective_cache_size settings live so
 *      they take effect before the indexer redeploys with 0007.
 *   2. REINDEX INDEX CONCURRENTLY the HNSW index: rebuilds from live tuples
 *      only, dropping ~38GB -> ~14GB so it fits in RAM. The big latency win.
 *   3. VACUUM the table unthrottled to return dead-tuple space to the FSM
 *      (halts disk growth) and set the visibility map.
 *
 * REINDEX CONCURRENTLY / VACUUM cannot run inside a transaction, so each is a
 * bare autocommit statement (no BEGIN). Pins one connection, disables the
 * statement timeout, and raises maintenance_work_mem for the rebuild.
 *
 * Long runs (the REINDEX can take >1h) survive a dropped client socket: the
 * server backend runs autonomously (client_connection_check_interval=0), so a
 * transient ECONNRESET doesn't abort the work. The client 'error' handler keeps
 * such a blip from hard-crashing the driver process; if it does die, the ops
 * still complete server-side — poll pg_stat_progress_{create_index,vacuum}.
 *
 *   cd apps/web && npx tsx scripts/reclaim-posts-bloat.ts
 */
import { withBskyClient } from "../src/lib/bsky-pg";

function mins(t0: number): string {
  return `${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`;
}

async function main() {
  await withBskyClient(async (c) => {
    c.on("error", (e) => console.error("[reclaim] client error (ignored):", e.message));
    await c.query("SET statement_timeout = 0");
    await c.query("SET maintenance_work_mem = '8GB'");
    await c.query("SET max_parallel_maintenance_workers = 4");
    // Unthrottle this session's manual VACUUM.
    await c.query("SET vacuum_cost_delay = 0");

    console.log("[reclaim] applying live settings …");
    await c.query(
      `ALTER TABLE bsky.posts SET (
         autovacuum_vacuum_scale_factor = 0.05,
         autovacuum_vacuum_cost_delay   = 0,
         autovacuum_vacuum_cost_limit   = 2000
       )`
    );
    const db = (await c.query<{ d: string }>("SELECT current_database() AS d")).rows[0].d;
    await c.query(`ALTER DATABASE "${db}" SET effective_cache_size = '38GB'`);
    console.log("[reclaim] settings applied (autovacuum + effective_cache_size=38GB)");

    const before = (
      await c.query<{ s: string }>(
        "SELECT pg_size_pretty(pg_relation_size('bsky.idx_posts_embedding_hnsw')) AS s"
      )
    ).rows[0].s;
    console.log(`[reclaim] HNSW index before: ${before}`);

    const t1 = Date.now();
    console.log("[reclaim] REINDEX INDEX CONCURRENTLY idx_posts_embedding_hnsw …");
    await c.query("REINDEX INDEX CONCURRENTLY bsky.idx_posts_embedding_hnsw");
    console.log(`[reclaim] REINDEX done in ${mins(t1)}`);

    const after = (
      await c.query<{ s: string }>(
        "SELECT pg_size_pretty(pg_relation_size('bsky.idx_posts_embedding_hnsw')) AS s"
      )
    ).rows[0].s;
    console.log(`[reclaim] HNSW index after: ${after}`);

    const t2 = Date.now();
    console.log("[reclaim] VACUUM (VERBOSE) bsky.posts (unthrottled) …");
    await c.query("VACUUM (VERBOSE) bsky.posts");
    console.log(`[reclaim] VACUUM done in ${mins(t2)}`);
  });
  console.log("[reclaim] ALL DONE");
  process.exit(0);
}

main().catch((e) => {
  console.error("[reclaim] failed:", e?.message ?? e);
  process.exit(1);
});
