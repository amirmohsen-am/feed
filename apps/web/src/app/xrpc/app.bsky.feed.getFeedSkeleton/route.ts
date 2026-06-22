import { NextRequest, NextResponse } from "next/server";
import { parseFeedGeneratorUri } from "@/lib/feedgen";
import { verifyFeedRequesterDid } from "@/lib/feed-auth";
import {
  getFeedSkeletonPage,
  getPublishedFeed,
  getUserByBlueskyDid,
} from "@/lib/pg";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const limit = Math.min(Math.max(Number(params.get("limit")) || 50, 1), 100);
  const cursor = params.get("cursor") || undefined;
  const feedUri = params.get("feed") || "";

  const parsed = parseFeedGeneratorUri(feedUri);
  const feed = parsed
    ? await getPublishedFeed(parsed.rkey, parsed.publisherDid)
    : null;

  if (!feed) {
    return NextResponse.json({ feed: [] });
  }

  // Per-subscriber seen filtering only when the feed opted in. Identifying the
  // requester (verify the service-auth JWT → DID → Ripple user) is skipped
  // otherwise, so anonymous/third-party clients keep the existing fast path.
  let viewer: { userId: string } | undefined;
  if (feed.seen_filter_enabled) {
    const did = await verifyFeedRequesterDid(req.headers.get("authorization"));
    if (did) {
      const user = await getUserByBlueskyDid(did);
      if (user) viewer = { userId: user.id };
    }
  }

  const page = await getFeedSkeletonPage(feed.id, limit, cursor, viewer);

  return NextResponse.json({
    feed: page.uris.map((uri) => ({ post: uri })),
    cursor: page.cursor,
  });
}
