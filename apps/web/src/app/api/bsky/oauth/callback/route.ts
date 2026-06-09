import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { handleBskyOAuthCallback } from "@/lib/bsky-oauth";
import { linkBlueskyAccount } from "@/lib/link-bluesky";
import { SESSION_COOKIE } from "@/lib/session";

/**
 * POST /api/bsky/oauth/callback
 * Body: { params: string } — the full query string from the OAuth redirect
 *
 * Exchanges the authorization code for tokens and links the Bluesky DID
 * to the Willow user for this browser session.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();

  const { params } = await req.json();
  if (!params || typeof params !== "string") {
    return NextResponse.json({ error: "params required" }, { status: 400 });
  }

  const sessionId = req.cookies.get(SESSION_COOKIE)?.value;
  if (!sessionId) {
    return NextResponse.json({ error: "Missing session" }, { status: 400 });
  }

  try {
    const { did } = await handleBskyOAuthCallback(new URLSearchParams(params));

    // Resolve the handle from the DID via the PLC directory
    let handle: string | undefined;
    try {
      const res = await fetch(`https://plc.directory/${did}`);
      if (res.ok) {
        const doc = await res.json();
        const aka = doc?.alsoKnownAs?.[0];
        if (aka && aka.startsWith("at://")) {
          handle = aka.replace("at://", "");
        }
      }
    } catch { /* non-fatal */ }

    const { userId } = await linkBlueskyAccount({
      sessionId,
      oauthUserId: auth.userId,
      did,
      handle: handle ?? null,
    });

    return NextResponse.json({ ok: true, did, handle, userId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[bsky/oauth/callback] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
