import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { quotePost, replyToPost } from "@/lib/bsky-write";
import { jsonError } from "@/lib/api";

/**
 * POST /api/bsky/compose
 * Body: { uri: string, kind: "reply" | "quote", text: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();

  const { uri, kind, text } = (await req.json()) as {
    uri?: string;
    kind?: "reply" | "quote";
    text?: string;
  };

  if (!uri || !kind || (kind !== "reply" && kind !== "quote")) {
    return NextResponse.json(
      { error: "uri and kind (reply|quote) required" },
      { status: 400 }
    );
  }
  if (typeof text !== "string") {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }

  try {
    const result =
      kind === "reply"
        ? await replyToPost(auth.userId, uri, text)
        : await quotePost(auth.userId, uri, text);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return jsonError(e, "bsky/compose");
  }
}
