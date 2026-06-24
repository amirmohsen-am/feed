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

  // Per-subscriber seen filtering when the requesting VIEWER opted in
  // (users.seen_filter_enabled, default on). We identify the requester only
  // when an auth header is present — anonymous/third-party clients send none
  // and keep the fast path. The DID resolver caches signing keys, so the JWT
  // verify is cheap on repeat requests.
  let viewer: { userId: string } | undefined;
  if (req.headers.get("authorization")) {
    const did = await verifyFeedRequesterDid(req.headers.get("authorization"));
    if (did) {
      const user = await getUserByBlueskyDid(did);
      if (user?.seen_filter_enabled) viewer = { userId: user.id };
    }
  }

  const page = await getFeedSkeletonPage(feed.id, limit, cursor, viewer);

  return NextResponse.json({
    feed: page.uris.map((uri) => ({ post: uri })),
    cursor: page.cursor,
  });
}
