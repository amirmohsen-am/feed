import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthError } from "@/lib/auth";
import { getFeedForUser, getFeedPreviewPosts } from "@/lib/pg";

export async function GET(req: NextRequest) {
  const t0 = performance.now();
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const tAuth = performance.now();

  const feedId = Number(req.nextUrl.searchParams.get("feedId"));

  if (!feedId) {
    return NextResponse.json({ total_stored: 0, posts: [] });
  }

  const feed = await getFeedForUser(feedId, auth.userId);
  if (!feed) {
    return NextResponse.json({ error: "Feed not found" }, { status: 404 });
  }
  const tFeed = performance.now();

  const posts = await getFeedPreviewPosts(feedId, 50);
  const tPosts = performance.now();

  console.log(
    `[timing] GET /api/feed-preview auth=${(tAuth - t0).toFixed(0)}ms ` +
      `feed-lookup=${(tFeed - tAuth).toFixed(0)}ms ` +
      `posts=${(tPosts - tFeed).toFixed(0)}ms ` +
      `total=${(tPosts - t0).toFixed(0)}ms feedId=${feedId}`
  );

  return NextResponse.json({
    total_stored: posts.length,
    mechanical_filters: feed.mechanical_filters,
    semantic_config: feed.semantic_config,
    posts,
  });
}
