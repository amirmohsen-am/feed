import { NextRequest, NextResponse } from "next/server";
import { parseFeedGeneratorUri } from "@/lib/feedgen";
import { getFeedSkeletonPage, getPublishedFeed } from "@/lib/pg";

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

  const page = await getFeedSkeletonPage(feed.id, limit, cursor);

  return NextResponse.json({
    feed: page.uris.map((uri) => ({ post: uri })),
    cursor: page.cursor,
  });
}
