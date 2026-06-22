import { query } from "./pg";

/**
 * Resolve or create the amadi user for a browser session cookie.
 */
export async function ensureSessionUser(sessionId: string): Promise<string> {
  const existing = await query(
    `SELECT user_id FROM user_sessions WHERE session_id = $1`,
    [sessionId]
  );
  if (existing.rows[0]) {
    return existing.rows[0].user_id as string;
  }

  const legacy = await query(
    `SELECT id FROM users WHERE session_id = $1`,
    [sessionId]
  );
  if (legacy.rows[0]) {
    const userId = legacy.rows[0].id as string;
    await query(
      `INSERT INTO user_sessions (session_id, user_id) VALUES ($1, $2)
       ON CONFLICT (session_id) DO NOTHING`,
      [sessionId, userId]
    );
    return userId;
  }

  const created = await query(
    `INSERT INTO users (session_id, name, email)
     VALUES ($1, 'Anonymous', '')
     RETURNING id`,
    [sessionId]
  );
  const userId = created.rows[0].id as string;
  await query(
    `INSERT INTO user_sessions (session_id, user_id) VALUES ($1, $2)
     ON CONFLICT (session_id) DO NOTHING`,
    [sessionId, userId]
  );
  return userId;
}

async function getUserByBlueskyDid(did: string): Promise<{ id: string } | null> {
  const res = await query(`SELECT id FROM users WHERE bluesky_did = $1`, [did]);
  return res.rows[0] ?? null;
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
    await query(`UPDATE feeds SET user_id = $1 WHERE user_id = $2`, [
      canonicalUserId,
      oauthUserId,
    ]);
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
