import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthError } from "@/lib/auth";
import { getFeedForUser, getFeedPreviewPosts } from "@/lib/pg";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const feedId = Number(req.nextUrl.searchParams.get("feedId"));

  if (!feedId) {
    return NextResponse.json({ total_stored: 0, posts: [] });
  }

  const feed = await getFeedForUser(feedId, auth.userId);
  if (!feed) {
    return NextResponse.json({ error: "Feed not found" }, { status: 404 });
  }

  const posts = await getFeedPreviewPosts(feedId, 50);

  return NextResponse.json({
    total_stored: posts.length,
    mechanical_filters: feed.mechanical_filters,
    semantic_config: feed.semantic_config,
    posts,
  });
}
