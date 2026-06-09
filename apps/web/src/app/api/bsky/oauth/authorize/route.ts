import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import {
  startBskyOAuth,
  setPendingOAuthUserId,
  setPendingOAuthSessionId,
} from "@/lib/bsky-oauth";
import { SESSION_COOKIE } from "@/lib/session";

/**
 * POST /api/bsky/oauth/authorize
 * Body: { handle: string }
 *
 * Starts the Bluesky OAuth flow. Stores the userId in the OAuth state
 * row so the callback can link the DID to the correct user — even when
 * cookies don't survive the cross-site redirect (e.g. incognito mode).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();

  const { handle, returnTo } = await req.json();
  if (!handle || typeof handle !== "string") {
    return NextResponse.json({ error: "handle required" }, { status: 400 });
  }

  try {
    // Store userId + browser session so the callback can link the DID and
    // restore the correct cookie after the cross-site redirect.
    setPendingOAuthUserId(auth.userId);
    const sessionId = req.cookies.get(SESSION_COOKIE)?.value;
    if (sessionId) setPendingOAuthSessionId(sessionId);
    const url = await startBskyOAuth(handle.trim().replace(/^@/, ""));
    const res = NextResponse.json({ url });

    // Remember where to send the user after the callback. Only same-origin
    // relative paths are allowed. Always (re)set the cookie so a stale value
    // from an abandoned flow can't hijack a later connect — absent/invalid
    // returnTo clears it, and the callback then defaults to /curator.
    const isSafe =
      typeof returnTo === "string" &&
      returnTo.startsWith("/") &&
      !returnTo.startsWith("//");
    res.cookies.set("bsky_return_to", isSafe ? returnTo : "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: isSafe ? 600 : 0,
    });
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[bsky/oauth/authorize] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
