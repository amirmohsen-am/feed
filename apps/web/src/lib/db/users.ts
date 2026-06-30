import { query } from "./connection";

// --- User ---

interface DbUser {
  id: string; // UUID
  firebase_uid: string;
  name: string;
  email: string;
  photo_url: string | null;
  bluesky_handle: string | null;
  bluesky_did: string | null;
  bsky_app_password: string | null;
  // Per-user preference: hide posts this viewer has already seen. Default true.
  // Gates seen filtering + impression recording on every read path (curator
  // preview, published skeleton, sendInteractions).
  seen_filter_enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function getUserById(
  userId: string
): Promise<DbUser | null> {
  const res = await query("SELECT * FROM users WHERE id = $1", [userId]);
  return res.rows[0] ?? null;
}

/** Update the per-user "hide seen posts" preference. */
export async function setUserSeenFilterEnabled(
  userId: string,
  enabled: boolean
): Promise<void> {
  await query(
    "UPDATE users SET seen_filter_enabled = $2, updated_at = now() WHERE id = $1",
    [userId, enabled]
  );
}

/**
 * Resolve a Bluesky DID to the Ripple user who linked it (via OAuth). Used by
 * the published feed skeleton to map a verified requester DID to internal seen
 * state. Returns null for DIDs that aren't Ripple users — those readers get the
 * unfiltered shared snapshot.
 */
export async function getUserByBlueskyDid(
  did: string
): Promise<DbUser | null> {
  const res = await query("SELECT * FROM users WHERE bluesky_did = $1", [did]);
  return res.rows[0] ?? null;
}
