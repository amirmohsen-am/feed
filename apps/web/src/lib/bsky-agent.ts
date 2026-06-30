/**
 * Minimal AT Protocol agent for authenticated actions (like, repost).
 *
 * Uses the user's Bluesky handle + app password to create a session, then
 * calls createRecord / deleteRecord on their PDS. Sessions are short-lived
 * and not cached — each action creates a fresh session. This is fine for
 * low-volume interactive use (a few likes per feed preview).
 */

const BSKY_SERVICE = "https://bsky.social";

interface BskySession {
  did: string;
  accessJwt: string;
}

export async function createSession(
  handle: string,
  appPassword: string
): Promise<BskySession> {
  const res = await fetch(`${BSKY_SERVICE}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bluesky createSession failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return { did: data.did, accessJwt: data.accessJwt };
}

/**
 * Resolve a post URI to its CID by fetching it from the AppView.
 */
export async function publishFeedGenerator(
  session: BskySession,
  params: {
    rkey: string;
    serviceDid: string;
    displayName: string;
    description: string;
  }
): Promise<string> {
  const res = await fetch(`${BSKY_SERVICE}/xrpc/com.atproto.repo.putRecord`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.generator",
      rkey: params.rkey,
      record: {
        $type: "app.bsky.feed.generator",
        did: params.serviceDid,
        displayName: params.displayName.slice(0, 24),
        description: params.description.slice(0, 300),
        // Opt into the client feed-feedback API so Bluesky sends
        // #interactionSeen events to our sendInteractions endpoint.
        acceptsInteractions: true,
        createdAt: new Date().toISOString(),
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bluesky publishFeedGenerator failed (${res.status}): ${body}`);
  }
  return `at://${session.did}/app.bsky.feed.generator/${params.rkey}`;
}
