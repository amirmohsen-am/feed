import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { canRestoreBskySession } from "@/lib/bsky-oauth";
import { getAccountGateStatus } from "@/lib/account-gate";
import { getUserById, setUserSeenFilterEnabled } from "@/lib/pg";

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

  const gate = await getAccountGateStatus(auth.userId);

  return NextResponse.json({
    user,
    oauthReady,
    linked: !!(user.bluesky_handle || user.bluesky_did),
    gate,
  });
}

/** Update per-user preferences. Currently only `seen_filter_enabled`. */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth();

  let body: { seen_filter_enabled?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (typeof body.seen_filter_enabled === "boolean") {
    await setUserSeenFilterEnabled(auth.userId, body.seen_filter_enabled);
  }
  return NextResponse.json({ ok: true });
}
