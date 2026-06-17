import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/pg";
import { SESSION_COOKIE } from "@/lib/session";

/**
 * POST /api/auth/logout
 *
 * Detaches this browser session from its Willow user and clears the cookie.
 * The next request gets a fresh anonymous session from the middleware;
 * logging back in with Bluesky re-attaches the canonical account (and its
 * feeds) via the DID-based identity in link-bluesky.ts.
 */
export async function POST(req: NextRequest) {
  const sessionId = req.cookies.get(SESSION_COOKIE)?.value;

  if (sessionId) {
    await query(`DELETE FROM user_sessions WHERE session_id = $1`, [sessionId]);
    // Also clear the legacy single-session column so ensureSessionUser can't
    // re-attach this sid to the old user on a stale cookie.
    await query(`UPDATE users SET session_id = NULL WHERE session_id = $1`, [
      sessionId,
    ]);
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
