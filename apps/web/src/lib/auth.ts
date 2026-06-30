import { getSession, type SessionUser } from "./session";

/**
 * Session-based auth. No sign-in required — every visitor gets an anonymous
 * session via the middleware cookie. Bluesky OAuth is layered on top when
 * the user wants to perform authenticated Bluesky actions.
 *
 * The export names (`requireAuth`, `isAuthError`, `AuthUser`) are kept for
 * backwards compatibility with all API routes.
 */

interface AuthUser {
  userId: string;
  blueskyDid: string | null;
  blueskyHandle: string | null;
}

/**
 * Get the current session user. Never returns an error response — every
 * request has a session via the middleware cookie.
 */
export async function requireAuth(): Promise<AuthUser> {
  const session: SessionUser = await getSession();
  return {
    userId: session.userId,
    blueskyDid: session.blueskyDid,
    blueskyHandle: session.blueskyHandle,
  };
}

/**
 * Kept for backwards compat — always returns false now since requireAuth
 * never returns an error response.
 */
export function isAuthError(_result: unknown): _result is Response {
  return false;
}
