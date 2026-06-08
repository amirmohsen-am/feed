import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { BskyWriteError, repostPost } from "@/lib/bsky-write";

/**
 * POST /api/bsky/repost
 * Body: { uri: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();

  const { uri } = (await req.json()) as { uri?: string };
  if (!uri) {
    return NextResponse.json({ error: "uri required" }, { status: 400 });
  }

  try {
    const result = await repostPost(auth.userId, uri);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof BskyWriteError) {
      console.warn("[bsky/repost] error:", e.message);
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[bsky/repost] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
