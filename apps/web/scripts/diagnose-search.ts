/**
 * End-to-end vector-search diagnostic for one feed. Replays the EXACT
 * production read path (same feed-config load, same filter derivation, same
 * KNN_SQL + params) so latency regressions can be localized without
 * hand-writing ad-hoc queries.
 *
 * Usage (from apps/web/, needs local ADC):
 *   npx tsx scripts/diagnose-search.ts <feedId> [--explain] [--full]
 *
 *   default    feed config + live bsky-db settings + per-subquery KNN timings,
 *              each run twice (cold + warm) and A/B'd against
 *              hnsw.iterative_scan = off
 *   --explain  also print EXPLAIN (ANALYZE, BUFFERS) for each subquery
 *   --full     also run the real searchPosts() (adds the AppView/profiles
 *              phase — watch its [timing] log line for the knn/appview split)
 *
 * What "slow" looks like:
 *   - KNN slow + EXPLAIN shows "Index Scan using …hnsw…" with huge
 *     `Buffers: shared read=N` → index doesn't fit in RAM, graph walk is
 *     hitting disk (iterative scan amplifies this up to hnsw.max_scan_tuples).
 *   - KNN slow + EXPLAIN shows no hnsw index at all → partial-index predicate
 *     mismatch (INDEX_INGEST_CUTOFF_US drift) → exact scan.
 *   - KNN fine but searchPosts slow → the AppView phase (getPosts/getProfiles
 *     fan-out) or the reranker, not pgvector.
 */
import { query } from "../src/lib/db/connection";
import { rowToFeed } from "../src/lib/db/feeds";
import { mechanicalToSearchFilter } from "../src/lib/db/filters";
import { bskyQuery, withBskyClient } from "../src/lib/bsky-pg";
import {
  searchPosts,
  embedQuery,
  buildKnnParams,
  knnQuery,
  KNN_SQL,
} from "../src/lib/vector-search";

const feedId = Number(process.argv[2]);
const wantExplain = process.argv.includes("--explain");
const wantFull = process.argv.includes("--full");

if (!Number.isFinite(feedId)) {
  console.error("usage: npx tsx scripts/diagnose-search.ts <feedId> [--explain] [--full]");
  process.exit(1);
}

function ms(t0: number): string {
  return `${(performance.now() - t0).toFixed(0)}ms`;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const out = await fn();
  console.log(`  ${label}: ${ms(t0)}`);
  return out;
}

(async () => {
  // ---- 1. Feed config (feed-db), same load path as getFeedPreviewPosts ----
  const feedRes = await query("SELECT * FROM feeds WHERE id = $1", [feedId]);
  if (feedRes.rows.length === 0) {
    console.error(`feed ${feedId} not found`);
    process.exit(1);
  }
  const feed = rowToFeed(feedRes.rows[0]);
  const filter = mechanicalToSearchFilter(feed.mechanical_filters);
  const perK = Math.max(1, Math.floor(feed.candidate_budget / Math.max(1, feed.subqueries.length)));

  console.log(`feed ${feedId}: "${feed.name}"`);
  console.log(`  subqueries (${feed.subqueries.length}, k=${perK} each):`);
  for (const s of feed.subqueries) console.log(`    - ${s}`);
  console.log(`  candidate_budget: ${feed.candidate_budget}`);
  console.log(`  rerank: ${feed.rerank_prompt?.trim() ? `${feed.rerank_model} (thinking=${feed.rerank_thinking_enabled})` : "off"}`);
  console.log(`  mechanical_filters: ${JSON.stringify(feed.mechanical_filters)}`);
  console.log(`  derived SearchFilter: ${JSON.stringify(filter)}`);

  // ---- 2. Live bsky-db settings + sizes ----
  console.log("\nbsky-db database-level settings (pg_db_role_setting):");
  const settings = await bskyQuery(
    `SELECT unnest(s.setconfig) AS setting
     FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
     WHERE d.datname = current_database()`
  );
  for (const r of settings.rows) console.log(`  ${r.setting}`);

  const mem = await bskyQuery(
    `SELECT current_setting('shared_buffers') AS shared_buffers,
            current_setting('work_mem') AS work_mem,
            current_setting('effective_cache_size') AS effective_cache_size`
  );
  console.log(`  shared_buffers=${mem.rows[0].shared_buffers} work_mem=${mem.rows[0].work_mem} effective_cache_size=${mem.rows[0].effective_cache_size}`);

  console.log("\nsizes:");
  const sizes = await bskyQuery(
    `SELECT c.relname, pg_size_pretty(pg_relation_size(c.oid)) AS size,
            pg_relation_size(c.oid) AS bytes
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'bsky' AND c.relname IN (
       SELECT indexname FROM pg_indexes WHERE schemaname='bsky' AND tablename='posts'
       UNION SELECT 'posts')
     ORDER BY bytes DESC`
  );
  for (const r of sizes.rows) console.log(`  ${r.relname}: ${r.size}`);

  const counts = await bskyQuery(
    `SELECT count(*) AS indexed_rows
     FROM bsky.posts WHERE ingested_at_us >= 1780253847390000 AND embedding IS NOT NULL`
  );
  console.log(`  rows under partial-index cutoff: ${Number(counts.rows[0].indexed_rows).toLocaleString()}`);

  // ---- 3. Per-subquery embed + KNN timing, A/B iterative_scan ----
  console.log("\nper-subquery (sequential here; prod runs them in parallel):");
  for (const sq of feed.subqueries) {
    console.log(`  "${sq}"`);
    const vec = await timed("embed (Gemini)", () => embedQuery(sq));
    const params = buildKnnParams(vec, perK, filter);

    // Production path (knnQuery = enable_sort=off transaction), cold then warm.
    const r1 = await timed("KNN prod path run 1", () => knnQuery(vec, perK, filter));
    await timed(`KNN prod path run 2 (warm) rows=${r1.length}`, () => knnQuery(vec, perK, filter));

    // A/B 1: planner's own choice (no enable_sort pin) — if this is much
    // slower, the planner is flipping off the HNSW index for this filter.
    await timed("KNN planner default", () => bskyQuery(KNN_SQL, params));

    // A/B 2: iterative scan off (pre-iterative-scan behaviour; expect fewer
    // rows under selective filters, not slower).
    await withBskyClient(async (c) => {
      await c.query("BEGIN");
      await c.query("SET LOCAL hnsw.iterative_scan = off");
      const t0 = performance.now();
      const r = await c.query(KNN_SQL, params);
      console.log(`  KNN iterative_scan=off: ${ms(t0)} rows=${r.rows.length}`);
      await c.query("ROLLBACK");
    });

    if (wantExplain) {
      // EXPLAIN the production configuration (enable_sort=off).
      await withBskyClient(async (c) => {
        await c.query("BEGIN");
        await c.query("SET LOCAL enable_sort = off");
        const ex = await c.query(`EXPLAIN (ANALYZE, BUFFERS) ${KNN_SQL}`, params);
        for (const r of ex.rows) console.log(`    ${r["QUERY PLAN"]}`);
        await c.query("ROLLBACK");
      });
    }
  }

  // ---- 4. Full searchPosts (KNN + AppView + profiles), optional ----
  if (wantFull) {
    console.log("\nfull searchPosts() (see its [timing] line for knn/appview split):");
    const t0 = performance.now();
    const hits = await searchPosts({
      subqueries: feed.subqueries,
      totalBudget: feed.candidate_budget,
      filter,
      withImages: true,
    });
    console.log(`  total=${ms(t0)} hits=${hits.length}`);
  }

  process.exit(0);
})().catch((e) => {
  console.error("ERR:", e?.message ?? e);
  process.exit(1);
});
