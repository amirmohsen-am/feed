import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getUserById, setUserSeenFilterEnabled } from "@/lib/pg";

export async function GET(req: NextRequest) {
  const auth = await requireAuth();

  const user = await getUserById(auth.userId);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Deliberately NO OAuth-session check here: restoring the Bluesky session
  // can hit the PDS over the network (token refresh), and this endpoint gates
  // the whole app boot. Clients that need live OAuth status (the profile
  // dialog dot, publish/like flows) use /api/bsky/status instead.
  return NextResponse.json({
    user,
    linked: !!(user.bluesky_handle || user.bluesky_did),
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
