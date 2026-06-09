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
 * Like a post. Returns the URI of the like record (needed to unlike later).
 */
export async function likePost(
  session: BskySession,
  postUri: string,
  postCid: string
): Promise<string> {
  const res = await fetch(`${BSKY_SERVICE}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.like",
      record: {
        $type: "app.bsky.feed.like",
        subject: { uri: postUri, cid: postCid },
        createdAt: new Date().toISOString(),
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bluesky likePost failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return data.uri;
}

/**
 * Unlike a post by deleting its like record.
 */
export async function unlikePost(
  session: BskySession,
  likeUri: string
): Promise<void> {
  // likeUri format: at://did:plc:.../app.bsky.feed.like/rkey
  const parts = likeUri.split("/");
  const rkey = parts[parts.length - 1];
  const res = await fetch(`${BSKY_SERVICE}/xrpc/com.atproto.repo.deleteRecord`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.like",
      rkey,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bluesky unlikePost failed (${res.status}): ${body}`);
  }
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

export async function resolvePostCid(postUri: string): Promise<string> {
  const params = new URLSearchParams();
  params.append("uris", postUri);
  const res = await fetch(
    `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?${params}`
  );
  if (!res.ok) {
    throw new Error(`Failed to resolve CID for ${postUri}: ${res.status}`);
  }
  const data = await res.json();
  const post = data.posts?.[0];
  if (!post?.cid) {
    throw new Error(`No CID found for ${postUri}`);
  }
  return post.cid;
}
