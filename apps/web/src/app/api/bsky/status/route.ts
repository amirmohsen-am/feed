import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { canRestoreBskySession } from "@/lib/bsky-oauth";
import { getUserById } from "@/lib/pg";

/**
 * GET /api/bsky/status
 *
 * Whether the current user has Bluesky linked and a live OAuth session
 * for authenticated repo writes (publish feed, like, etc.).
 */
export async function GET() {
  const auth = await requireAuth();
  const user = await getUserById(auth.userId);

  const linked = !!(user?.bluesky_handle || user?.bluesky_did);
  let oauthReady = false;
  if (user?.bluesky_did) {
    oauthReady = await canRestoreBskySession(user.bluesky_did);
  }

  return NextResponse.json({
    linked,
    oauthReady,
    handle: user?.bluesky_handle ?? null,
    did: user?.bluesky_did ?? null,
  });
}
