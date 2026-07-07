import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "sid";

/**
 * Sets an anonymous session cookie on first visit. Every visitor gets a
 * unique ID — no sign-in required. The cookie persists for 1 year.
 *
 * Skips the OAuth callback path — that route manages its own session
 * restoration to ensure the user stays on their original session after
 * the cross-site redirect from Bluesky.
 */
export function proxy(req: NextRequest) {
  // Canonical host: amadi.social. Permanently redirect www so search
  // engines index a single host instead of flagging duplicates.
  const host = req.headers.get("host");
  if (host === "www.amadi.social") {
    const url = req.nextUrl.clone();
    url.protocol = "https";
    url.host = "amadi.social";
    url.port = "";
    return NextResponse.redirect(url, 301);
  }

  // Don't create new sessions on OAuth callback — the route handler
  // restores the original session cookie on its response.
  if (req.nextUrl.pathname.startsWith("/oauth/callback")) {
    return NextResponse.next();
  }

  const existing = req.cookies.get(SESSION_COOKIE)?.value;
  if (existing) return NextResponse.next();

  const sessionId = crypto.randomUUID();
  const res = NextResponse.next();
  res.cookies.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
