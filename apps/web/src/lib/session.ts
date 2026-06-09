import { cookies } from "next/headers";
import { query } from "./pg";
import { ensureSessionUser } from "./link-bluesky";

const SESSION_COOKIE = "sid";

export interface SessionUser {
  userId: string;
  blueskyDid: string | null;
  blueskyHandle: string | null;
}

export { SESSION_COOKIE };

/**
 * Read the session cookie and look up (or create) the anonymous user.
 * Never returns null — every request gets a user.
 */
export async function getSession(): Promise<SessionUser> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;

  if (!sessionId) {
    // Middleware should always set this, but handle edge case
    throw new Error("No session cookie — middleware may not be running");
  }

  const userId = await ensureSessionUser(sessionId);

  const user = await query(
    "SELECT bluesky_did, bluesky_handle FROM users WHERE id = $1",
    [userId]
  );

  return {
    userId,
    blueskyDid: user.rows[0]?.bluesky_did ?? null,
    blueskyHandle: user.rows[0]?.bluesky_handle ?? null,
  };
}
