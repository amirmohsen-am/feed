import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSecret } from "@/lib/secrets";
import { query } from "@/lib/pg";

/**
 * Dispatcher for the published-feed snapshot refresh. Called by the Cloud
 * Scheduler job `refresh-published-feeds` (every 6h) with
 * `Authorization: Bearer <internal-refresh-secret>`.
 *
 * Lists stale published feeds (snapshot missing or >24h old) and fans out
 * one self-request per feed to /api/internal/refresh-feed, with bounded
 * concurrency. Each per-feed request is its own ~30s Cloud Run request, so
 * no single request approaches the service timeout and one feed's failure
 * doesn't abort the batch. Each feed is still recomputed at most once per
 * 24h — the staleness filter governs; the 6h cadence bounds worst-case
 * staleness and drains backlogs.
 */

// 25 feeds / 4 concurrent × ~30s ≈ 190s — inside the 300s service timeout
// with margin. Concurrency stays low to bound parallel KNN load on bsky-db.
const MAX_FEEDS_PER_RUN = 25;
const CONCURRENCY = 4;
const PER_FEED_TIMEOUT_MS = 120_000;

function tokenMatches(header: string | null, secret: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

export async function POST(req: NextRequest) {
  const secret = await getSecret("internal-refresh-secret");
  if (!tokenMatches(req.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const stale = await query(
    `SELECT f.id
     FROM feeds f
     JOIN users u ON u.id = f.user_id
     LEFT JOIN feed_result_cache c ON c.feed_id = f.id
     WHERE f.published_rkey IS NOT NULL
       AND u.bluesky_did IS NOT NULL
       AND (c.feed_id IS NULL OR c.cached_at < now() - interval '24 hours')
     ORDER BY c.cached_at ASC NULLS FIRST
     LIMIT ${MAX_FEEDS_PER_RUN}`
  );
  const feedIds = stale.rows.map((r) => r.id as number);
  if (feedIds.length === 0) {
    return NextResponse.json({ ok: true, stale: 0, refreshed: [], failed: [] });
  }

  // Fan out to our own public origin so each feed runs in its own request
  // (full CPU, isolated failure). req.nextUrl.origin reflects the forwarded
  // host on Cloud Run and localhost in dev.
  const base = req.nextUrl.origin;
  const refreshed: { feedId: number; posts: number }[] = [];
  const failed: number[] = [];

  const queue = [...feedIds];
  async function worker() {
    for (let feedId = queue.shift(); feedId !== undefined; feedId = queue.shift()) {
      try {
        const res = await fetch(`${base}/api/internal/refresh-feed?feedId=${feedId}`, {
          method: "POST",
          headers: { authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(PER_FEED_TIMEOUT_MS),
        });
        const body = (await res.json()) as { posts?: number };
        if (res.ok) {
          refreshed.push({ feedId, posts: body.posts ?? 0 });
        } else {
          failed.push(feedId);
        }
      } catch (e) {
        failed.push(feedId);
        console.warn(
          `[feed-refresh] dispatch feedId=${feedId} failed:`,
          e instanceof Error ? e.message : String(e)
        );
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, feedIds.length) }, worker)
  );

  console.log(
    `[feed-refresh] stale=${feedIds.length} refreshed=${refreshed.length} failed=${failed.length}`
  );
  return NextResponse.json({
    ok: true,
    stale: feedIds.length,
    refreshed,
    failed,
  });
}
