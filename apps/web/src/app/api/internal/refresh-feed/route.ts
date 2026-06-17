import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSecret } from "@/lib/secrets";
import { query, getFeedPreviewPosts, SNAPSHOT_LIMIT } from "@/lib/pg";

/**
 * Recomputes ONE feed's snapshot (~30s: vector search + rerank). Called by
 * the dispatcher (/api/internal/refresh-feeds) as a fan-out of separate
 * requests so each feed gets its own request CPU and failure isolation,
 * and no single request approaches Cloud Run's timeout.
 *
 * Auth: same `internal-refresh-secret` bearer token as the dispatcher.
 */

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

  const feedId = Number(req.nextUrl.searchParams.get("feedId"));
  if (!Number.isInteger(feedId) || feedId <= 0) {
    return NextResponse.json({ error: "feedId required" }, { status: 400 });
  }

  // Only published feeds are cron-refreshed; reject anything else so the
  // endpoint can't be used to spend tokens on arbitrary feeds.
  const pub = await query(
    `SELECT 1 FROM feeds f JOIN users u ON u.id = f.user_id
     WHERE f.id = $1 AND f.published_rkey IS NOT NULL AND u.bluesky_did IS NOT NULL`,
    [feedId]
  );
  if (pub.rows.length === 0) {
    return NextResponse.json({ error: "not a published feed" }, { status: 404 });
  }

  try {
    const posts = await getFeedPreviewPosts(feedId, SNAPSHOT_LIMIT, undefined, {
      forceFresh: true,
    });
    console.log(`[feed-refresh] refreshed feedId=${feedId} posts=${posts.length}`);
    return NextResponse.json({ ok: true, feedId, posts: posts.length });
  } catch (e) {
    // Includes RerankUnavailableError: the previous good snapshot stays in
    // place; the next scheduled pass retries.
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[feed-refresh] feedId=${feedId} failed:`, msg);
    return NextResponse.json({ error: msg, feedId }, { status: 500 });
  }
}
