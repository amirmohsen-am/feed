import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthError } from "@/lib/auth";
import { gateGuard } from "@/lib/account-gate";
import { getFeedForUser, addChatMessage } from "@/lib/pg";
import { hydratePostByUri } from "@/lib/vector-search";
import { composeSourcePostText } from "@/lib/branch";
import { jsonError } from "@/lib/api";

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;
  const walled = await gateGuard(auth.userId);
  if (walled) return walled;

  try {
    const { feedId, postUri } = await req.json();
    if (!feedId || typeof postUri !== "string" || !postUri) {
      return NextResponse.json({ error: "feedId and postUri required" }, { status: 400 });
    }

    const [feed, post] = await Promise.all([
      getFeedForUser(feedId, auth.userId),
      hydratePostByUri(postUri),
    ]);

    if (!feed) return NextResponse.json({ error: "Feed not found" }, { status: 404 });
    if (!post) return NextResponse.json({ error: "Post not found" }, { status: 404 });

    const message =
      `⟦swipe:passive:${postUri}⟧ I swiped past this post:\n${composeSourcePostText(post)}\n\n` +
      `This is background context — don't update my feed config based on this alone. ` +
      `If I explicitly ask you to tune the feed, use this as supporting signal.`;

    await addChatMessage(feedId, "user", message);

    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e, "swipe/context");
  }
}
