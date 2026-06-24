import { query } from "./pg";
import { getUserByBlueskyDid } from "./db/users";

/**
 * Resolve or create the amadi user for a browser session cookie.
 *
 * This is a get-or-create keyed on the session id. On a brand-new visitor the
 * browser fires several `/api/*` calls in parallel, all carrying the same fresh
 * `sid` that has no user row yet (the cookie is minted on the middleware
 * *response*, so it can't be provisioned during that first server render). Every
 * step here must therefore be concurrency-safe: the writes are atomic upserts,
 * never a check-then-insert that two requests could both pass.
 */
export async function ensureSessionUser(sessionId: string): Promise<string> {
  // Fast path (the overwhelmingly common case): the session is already mapped.
  const mapped = await query(
    `SELECT user_id FROM user_sessions WHERE session_id = $1`,
    [sessionId]
  );
  if (mapped.rows[0]) {
    return mapped.rows[0].user_id as string;
  }

  // Resolve the user id, preferring a legacy row keyed by users.session_id
  // (pre-dates user_sessions), otherwise atomically get-or-create one.
  const legacy = await query(
    `SELECT id FROM users WHERE session_id = $1`,
    [sessionId]
  );
  const userId = (legacy.rows[0]?.id ??
    // Single atomic statement: concurrent first-requests for the same brand-new
    // sid all resolve to one row in one round-trip. The loser's INSERT collides
    // on users_session_id_key, and DO UPDATE (a no-op write) still returns the
    // winning row via RETURNING — so there is no 500 and no second SELECT.
    (
      await query(
        `INSERT INTO users (session_id, name, email)
         VALUES ($1, 'Anonymous', '')
         ON CONFLICT (session_id) DO UPDATE SET session_id = EXCLUDED.session_id
         RETURNING id`,
        [sessionId]
      )
    ).rows[0].id) as string;

  // Map the session → user. Idempotent so parallel requests don't collide.
  await query(
    `INSERT INTO user_sessions (session_id, user_id) VALUES ($1, $2)
     ON CONFLICT (session_id) DO NOTHING`,
    [sessionId, userId]
  );
  return userId;
}

/**
 * Link a Bluesky DID to the amadi account for this browser session.
 *
 * If the DID already belongs to another user (e.g. logged in on a second
 * device), attach this session to that canonical user and migrate any feeds
 * created on the ephemeral anonymous user during this visit.
 */
export async function linkBlueskyAccount(params: {
  sessionId: string;
  oauthUserId: string;
  did: string;
  handle: string | null;
}): Promise<{ userId: string }> {
  const { sessionId, oauthUserId, did, handle } = params;

  const existingByDid = await getUserByBlueskyDid(did);
  let canonicalUserId: string;

  if (existingByDid && existingByDid.id !== oauthUserId) {
    canonicalUserId = existingByDid.id;
    // Only adopt this visit's feeds when the returning account has none of its
    // own. If it already has real feeds, we must not dump the anonymous
    // session's feeds into it — just attach the session and leave those feeds
    // orphaned on the throwaway anonymous user. The home feed is auto-created
    // for every user, so it doesn't count as "has feeds" and is never moved
    // (moving it would also violate feeds_user_home_unique).
    const canonicalHasFeeds = await query(
      `SELECT 1 FROM feeds WHERE user_id = $1 AND is_home = false LIMIT 1`,
      [canonicalUserId]
    );
    if (canonicalHasFeeds.rowCount === 0) {
      await query(
        `UPDATE feeds SET user_id = $1 WHERE user_id = $2 AND is_home = false`,
        [canonicalUserId, oauthUserId]
      );
    }
    if (handle) {
      await query(
        `UPDATE users SET bluesky_handle = $1, updated_at = now() WHERE id = $2`,
        [handle, canonicalUserId]
      );
    }
  } else {
    canonicalUserId = oauthUserId;
    await query(
      `UPDATE users SET bluesky_did = $1, bluesky_handle = $2,
         name = COALESCE(NULLIF(name, 'Anonymous'), $2), updated_at = now()
       WHERE id = $3`,
      [did, handle, oauthUserId]
    );
  }

  await query(
    `INSERT INTO user_sessions (session_id, user_id) VALUES ($1, $2)
     ON CONFLICT (session_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
    [sessionId, canonicalUserId]
  );

  return { userId: canonicalUserId };
}
