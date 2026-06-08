import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { BskyWriteError, likePostWrite, unlikePostWrite } from "@/lib/bsky-write";

/**
 * POST /api/bsky/like
 * Body: { uri: string, action: "like" | "unlike", likeUri?: string }
 *
 * Tries OAuth session first, falls back to app password.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();

  const body = await req.json();
  const { uri, action, likeUri } = body as {
    uri: string;
    action: "like" | "unlike";
    likeUri?: string;
  };

  if (!uri || !action) {
    return NextResponse.json(
      { error: "uri and action required" },
      { status: 400 }
    );
  }

  try {
    if (action === "like") {
      const result = await likePostWrite(auth.userId, uri);
      return NextResponse.json({ ok: true, likeUri: result.likeUri });
    }

    if (action === "unlike") {
      if (!likeUri) {
        return NextResponse.json(
          { error: "For unlike, likeUri is required" },
          { status: 400 }
        );
      }
      await unlikePostWrite(auth.userId, likeUri);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (e) {
    if (e instanceof BskyWriteError) {
      console.warn("[bsky/like] error:", e.message);
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[bsky/like] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
