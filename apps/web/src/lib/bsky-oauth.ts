/**
 * Bluesky AT Protocol OAuth 2.0 client.
 *
 * Uses @atproto/oauth-client-node for the PKCE + DPoP flow.
 * State and sessions are stored in Postgres (feed-db).
 */

import {
  NodeOAuthClient,
  type NodeSavedSession,
  type NodeSavedState,
  type NodeSavedSessionStore,
  type NodeSavedStateStore,
} from "@atproto/oauth-client-node";
import { query } from "./pg";

// ---------------------------------------------------------------------------
// Postgres-backed stores
// ---------------------------------------------------------------------------

// Track which user and browser session started each OAuth flow so we can link
// the DID back to the correct user even when cookies don't survive the redirect.
let _pendingUserId: string | null = null;
let _pendingSessionId: string | null = null;

export function setPendingOAuthUserId(userId: string) {
  _pendingUserId = userId;
}

export function setPendingOAuthSessionId(sessionId: string) {
  _pendingSessionId = sessionId;
}

function pgStateStore(): NodeSavedStateStore {
  return {
    async set(key: string, val: NodeSavedState) {
      await query(
        `INSERT INTO bsky_oauth_state (key, data, user_id, session_id, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '10 minutes')
         ON CONFLICT (key) DO UPDATE SET
           data = $2, user_id = $3, session_id = $4,
           expires_at = now() + interval '10 minutes'`,
        [key, JSON.stringify(val), _pendingUserId, _pendingSessionId]
      );
      _pendingUserId = null;
      _pendingSessionId = null;
    },
    async get(key: string) {
      const res = await query(
        `DELETE FROM bsky_oauth_state WHERE key = $1 RETURNING data, user_id`,
        [key]
      );
      const row = res.rows[0];
      return row ? (row.data as NodeSavedState) : undefined;
    },
    async del(key: string) {
      await query(`DELETE FROM bsky_oauth_state WHERE key = $1`, [key]);
    },
  };
}

/**
 * Look up the user_id and session_id stored alongside an OAuth state key.
 * Called from the callback route BEFORE the state is consumed.
 */
export async function getOAuthStateContext(stateKey: string): Promise<{
  userId: string | null;
  sessionId: string | null;
}> {
  const res = await query(
    `SELECT user_id, session_id FROM bsky_oauth_state WHERE key = $1`,
    [stateKey]
  );
  return {
    userId: res.rows[0]?.user_id ?? null,
    sessionId: res.rows[0]?.session_id ?? null,
  };
}

function pgSessionStore(): NodeSavedSessionStore {
  return {
    async set(sub: string, val: NodeSavedSession) {
      await query(
        `INSERT INTO bsky_oauth_session (did, data, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (did) DO UPDATE SET data = $2, updated_at = now()`,
        [sub, JSON.stringify(val)]
      );
    },
    async get(sub: string) {
      const res = await query(
        `SELECT data FROM bsky_oauth_session WHERE did = $1`,
        [sub]
      );
      const row = res.rows[0];
      return row ? (row.data as NodeSavedSession) : undefined;
    },
    async del(sub: string) {
      await query(`DELETE FROM bsky_oauth_session WHERE did = $1`, [sub]);
    },
  };
}

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

let _client: NodeOAuthClient | null = null;

// Granular scopes — only what the app actually does with the user's repo:
// create replies/quotes (never edit/delete posts), like/unlike, repost/unrepost,
// and publish feed generator records. No blob, rpc, profile, or follow access.
const BSKY_OAUTH_SCOPE =
  "atproto repo:app.bsky.feed.post?action=create repo:app.bsky.feed.like repo:app.bsky.feed.repost repo:app.bsky.feed.generator";

function getPublicUrl(): string {
  // In production, this must be the publicly accessible HTTPS URL.
  // Locally, use 127.0.0.1 (not "localhost") per RFC 8252.
  return (
    process.env.NEXT_PUBLIC_URL ||
    process.env.NEXTAUTH_URL ||
    `http://127.0.0.1:${process.env.PORT || 3000}`
  );
}

const IS_LOCAL_DEV = !process.env.NEXT_PUBLIC_URL && !process.env.NEXTAUTH_URL;

export function getBskyOAuthClient(): NodeOAuthClient {
  if (_client) return _client;

  const publicUrl = getPublicUrl();

  _client = new NodeOAuthClient({
    // For local dev, the AT Protocol allows "http://localhost" as a special
    // loopback client_id (no client metadata fetch needed). In production,
    // the client_id points at the real HTTPS metadata endpoint.
    clientMetadata: IS_LOCAL_DEV
      ? {
          client_id: `http://localhost?redirect_uri=${encodeURIComponent(`${publicUrl}/oauth/callback`)}&scope=${encodeURIComponent(BSKY_OAUTH_SCOPE)}`,
          client_name: "amadi (dev)",
          client_uri: publicUrl,
          redirect_uris: [`${publicUrl}/oauth/callback`],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: BSKY_OAUTH_SCOPE,
          token_endpoint_auth_method: "none",
          application_type: "web",
          dpop_bound_access_tokens: true,
        }
      : {
          client_id: `${publicUrl}/oauth/client-metadata.json`,
          client_name: "amadi",
          client_uri: publicUrl,
          redirect_uris: [`${publicUrl}/oauth/callback`],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: BSKY_OAUTH_SCOPE,
          token_endpoint_auth_method: "none",
          application_type: "web",
          dpop_bound_access_tokens: true,
        },
    stateStore: pgStateStore(),
    sessionStore: pgSessionStore(),
  });

  return _client;
}

/**
 * Start the OAuth authorization flow. `input` is a Bluesky handle, or an
 * `https://` service URL (the client library resolves URLs via
 * resolveFromService, sending no login_hint).
 * Returns the URL to redirect the user to.
 */
export async function startBskyOAuth(
  input: string,
  opts: { prompt?: "create" } = {}
): Promise<string> {
  const client = getBskyOAuthClient();
  const url = await client.authorize(input, {
    scope: BSKY_OAUTH_SCOPE,
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
  });
  return url.toString();
}

const BSKY_ENTRYWAY = "https://bsky.social";

/**
 * Start the OAuth flow on Bluesky's hosted ACCOUNT CREATION screen
 * (`prompt=create` against the bsky.social entryway — advertised in its
 * prompt_values_supported). The user signs up there and returns through the
 * normal /oauth/callback already authenticated, so create and connect share
 * the entire downstream path.
 */
export async function startBskyCreateOAuth(): Promise<string> {
  return startBskyOAuth(BSKY_ENTRYWAY, { prompt: "create" });
}

/**
 * Complete the OAuth callback. Exchanges the authorization code for tokens.
 * Returns the DID of the authenticated user.
 */
export async function handleBskyOAuthCallback(
  params: URLSearchParams
): Promise<{ did: string }> {
  const client = getBskyOAuthClient();
  const result = await client.callback(params);
  return { did: result.session.did };
}

/**
 * Restore an existing OAuth session for a DID. Returns the OAuthSession
 * which has a `fetchHandler` for making authenticated AT Proto requests.
 */
export async function restoreBskySession(did: string) {
  const client = getBskyOAuthClient();
  return client.restore(did);
}

/** Whether we have stored OAuth tokens for this DID (may still need refresh). */
async function hasBskyOAuthSession(did: string): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM bsky_oauth_session WHERE did = $1 LIMIT 1`,
    [did]
  );
  return (res.rowCount ?? 0) > 0;
}

/** True when stored OAuth tokens exist and restore succeeds (refresh if needed). */
export async function canRestoreBskySession(did: string): Promise<boolean> {
  if (!(await hasBskyOAuthSession(did))) return false;
  try {
    await restoreBskySession(did);
    return true;
  } catch {
    return false;
  }
}
