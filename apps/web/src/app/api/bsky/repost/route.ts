import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { repostPost, unrepostPostWrite } from "@/lib/bsky-write";
import { jsonError } from "@/lib/api";

/**
 * POST /api/bsky/repost
 * Body: { uri: string, action?: "repost" | "unrepost", repostUri?: string }
 *
 * Tries OAuth session first, falls back to app password.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();

  const body = await req.json();
  const { uri, action = "repost", repostUri } = body as {
    uri?: string;
    action?: "repost" | "unrepost";
    repostUri?: string;
  };

  if (!uri) {
    return NextResponse.json({ error: "uri required" }, { status: 400 });
  }

  try {
    if (action === "repost") {
      const result = await repostPost(auth.userId, uri);
      return NextResponse.json({ ok: true, ...result });
    }

    if (action === "unrepost") {
      if (!repostUri) {
        return NextResponse.json(
          { error: "For unrepost, repostUri is required" },
          { status: 400 }
        );
      }
      await unrepostPostWrite(auth.userId, repostUri);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (e) {
    return jsonError(e, "bsky/repost");
  }
}
