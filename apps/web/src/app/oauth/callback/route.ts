import { NextRequest, NextResponse } from "next/server";
import { handleBskyOAuthCallback, getOAuthStateContext } from "@/lib/bsky-oauth";
import { linkBlueskyAccount } from "@/lib/link-bluesky";
import { SESSION_COOKIE } from "@/lib/session";

/**
 * GET /oauth/callback?state=...&iss=...&code=...
 *
 * Bluesky redirects here after the user authorizes. We look up which user
 * started this flow (stored in the OAuth state table, not in cookies),
 * exchange the code for tokens, link the DID, restore the session, and
 * redirect to the curator.
 */
export async function GET(req: NextRequest) {
  const base = process.env.NEXT_PUBLIC_URL || req.nextUrl.origin;

  // Where to send the user after linking. Set by /api/bsky/oauth/authorize
  // (a same-origin relative path); defaults to the curator. The cookie is
  // cleared on the redirect either way.
  const rawReturn = req.cookies.get("bsky_return_to")?.value;
  const returnTo =
    rawReturn && rawReturn.startsWith("/") && !rawReturn.startsWith("//")
      ? rawReturn
      : "/curator";
  const dest = (params: string) =>
    `${base}${returnTo}${returnTo.includes("?") ? "&" : "?"}${params}`;

  try {
    const params = req.nextUrl.searchParams;
    const stateKey = params.get("state");

    if (!stateKey) {
      throw new Error("Missing state parameter");
    }

    const { userId, sessionId: storedSessionId } =
      await getOAuthStateContext(stateKey);
    console.log(
      "[oauth/callback] state:",
      stateKey,
      "userId:",
      userId,
      "sessionId:",
      storedSessionId
    );

    if (!userId) {
      throw new Error("OAuth session expired — please try connecting again.");
    }

    const sessionId =
      storedSessionId ?? req.cookies.get(SESSION_COOKIE)?.value ?? null;
    if (!sessionId) {
      throw new Error("Missing browser session — please try connecting again.");
    }

    // Exchange the authorization code for tokens (this consumes the state)
    const { did } = await handleBskyOAuthCallback(
      new URLSearchParams(params.toString())
    );

    console.log("[oauth/callback] token exchange success, did:", did);

    // Resolve handle from DID
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

    console.log("[oauth/callback] resolved handle:", handle);

    const { userId: canonicalUserId } = await linkBlueskyAccount({
      sessionId,
      oauthUserId: userId,
      did,
      handle: handle ?? null,
    });

    console.log("[oauth/callback] linked user:", canonicalUserId);

    const response = NextResponse.redirect(dest("bsky_connected=1"));
    response.cookies.set(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    response.cookies.set("bsky_return_to", "", { path: "/", maxAge: 0 });
    return response;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[oauth/callback] error:", msg);
    const response = NextResponse.redirect(
      dest(`bsky_error=${encodeURIComponent(msg)}`)
    );
    response.cookies.set("bsky_return_to", "", { path: "/", maxAge: 0 });
    return response;
  }
}
