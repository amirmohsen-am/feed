import { NextRequest, NextResponse } from "next/server";
import { getFeedPosts } from "@/lib/db";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const limit = Math.min(Number(params.get("limit")) || 50, 100);
  const cursor = params.get("cursor") || undefined;

  const posts = getFeedPosts(limit, cursor);

  return NextResponse.json({
    feed: posts.map((p) => ({ post: p.uri })),
    cursor: posts.length > 0 ? posts[posts.length - 1].indexed_at : undefined,
  });
}
