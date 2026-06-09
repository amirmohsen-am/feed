import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { canRestoreBskySession } from "@/lib/bsky-oauth";
import { getUserById } from "@/lib/pg";

export async function GET(req: NextRequest) {
  const auth = await requireAuth();

  const user = await getUserById(auth.userId);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  let oauthReady = false;
  if (user.bluesky_did) {
    oauthReady = await canRestoreBskySession(user.bluesky_did);
  }

  return NextResponse.json({
    user,
    oauthReady,
    linked: !!(user.bluesky_handle || user.bluesky_did),
  });
}
