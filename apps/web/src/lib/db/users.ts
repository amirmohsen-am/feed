import { query } from "./connection";

// --- User ---

export interface DbUser {
  id: string; // UUID
  firebase_uid: string;
  name: string;
  email: string;
  photo_url: string | null;
  bluesky_handle: string | null;
  bluesky_did: string | null;
  bsky_app_password: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function upsertUser(params: {
  firebaseUid: string;
  name: string;
  email: string;
  photoUrl?: string;
  blueskyHandle?: string;
  blueskyDid?: string;
  bskyAppPassword?: string;
}): Promise<DbUser> {
  const res = await query(
    `INSERT INTO users (firebase_uid, name, email, photo_url, bluesky_handle, bluesky_did, bsky_app_password)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (firebase_uid) DO UPDATE SET
       name = EXCLUDED.name,
       email = EXCLUDED.email,
       photo_url = COALESCE(EXCLUDED.photo_url, users.photo_url),
       bluesky_handle = COALESCE(EXCLUDED.bluesky_handle, users.bluesky_handle),
       bluesky_did = COALESCE(EXCLUDED.bluesky_did, users.bluesky_did),
       bsky_app_password = COALESCE(EXCLUDED.bsky_app_password, users.bsky_app_password),
       updated_at = now()
     RETURNING *`,
    [
      params.firebaseUid,
      params.name,
      params.email,
      params.photoUrl ?? null,
      params.blueskyHandle ?? null,
      params.blueskyDid ?? null,
      params.bskyAppPassword ?? null,
    ]
  );
  return res.rows[0];
}

export async function getUserByFirebaseUid(
  firebaseUid: string
): Promise<DbUser | null> {
  const res = await query("SELECT * FROM users WHERE firebase_uid = $1", [
    firebaseUid,
  ]);
  return res.rows[0] ?? null;
}

export async function getUserById(
  userId: string
): Promise<DbUser | null> {
  const res = await query("SELECT * FROM users WHERE id = $1", [userId]);
  return res.rows[0] ?? null;
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
