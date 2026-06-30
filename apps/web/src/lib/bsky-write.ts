import { createSession } from "./bsky-agent";
import { restoreBskySession } from "./bsky-oauth";
import { getUserById } from "./pg";

export class BskyWriteError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

interface PostTarget {
  uri: string;
  cid: string;
  root: { uri: string; cid: string };
}

interface CreateRecordResult {
  uri: string;
}

interface BskyWriter {
  did: string;
  createRecord: (
    collection: string,
    record: object
  ) => Promise<CreateRecordResult>;
  deleteRecord: (collection: string, rkey: string) => Promise<void>;
}

const BSKY_SERVICE = "https://bsky.social";
const APPVIEW = "https://public.api.bsky.app";

async function resolvePostTarget(postUri: string): Promise<PostTarget> {
  const params = new URLSearchParams();
  params.append("uris", postUri);
  const res = await fetch(`${APPVIEW}/xrpc/app.bsky.feed.getPosts?${params}`);
  if (!res.ok) {
    throw new BskyWriteError(`Failed to load post: ${res.status}`, 502);
  }
  const data = (await res.json()) as {
    posts?: Array<{
      uri: string;
      cid: string;
      record?: {
        reply?: {
          root?: { uri: string; cid: string };
        };
      };
    }>;
  };
  const post = data.posts?.[0];
  if (!post?.uri || !post?.cid) {
    throw new BskyWriteError("Post not found", 404);
  }
  const parent = { uri: post.uri, cid: post.cid };
  const replyRoot = post.record?.reply?.root;
  const root =
    replyRoot?.uri && replyRoot?.cid
      ? { uri: replyRoot.uri, cid: replyRoot.cid }
      : parent;
  return { uri: parent.uri, cid: parent.cid, root };
}

async function oauthCreateRecord(
  oauthSession: Awaited<ReturnType<typeof restoreBskySession>>,
  repo: string,
  collection: string,
  record: object
): Promise<CreateRecordResult> {
  const res = await oauthSession.fetchHandler(
    "/xrpc/com.atproto.repo.createRecord",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, collection, record }),
    }
  );
  if (!res.ok) {
    throw new BskyWriteError(`createRecord failed: ${await res.text()}`, 502);
  }
  return res.json();
}

async function oauthDeleteRecord(
  oauthSession: Awaited<ReturnType<typeof restoreBskySession>>,
  repo: string,
  collection: string,
  rkey: string
): Promise<void> {
  const res = await oauthSession.fetchHandler(
    "/xrpc/com.atproto.repo.deleteRecord",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, collection, rkey }),
    }
  );
  if (!res.ok) {
    throw new BskyWriteError(`deleteRecord failed: ${await res.text()}`, 502);
  }
}

async function sessionCreateRecord(
  session: { did: string; accessJwt: string },
  collection: string,
  record: object
): Promise<CreateRecordResult> {
  const res = await fetch(`${BSKY_SERVICE}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({ repo: session.did, collection, record }),
  });
  if (!res.ok) {
    throw new BskyWriteError(`createRecord failed: ${await res.text()}`, 502);
  }
  return res.json();
}

async function sessionDeleteRecord(
  session: { did: string; accessJwt: string },
  collection: string,
  rkey: string
): Promise<void> {
  const res = await fetch(`${BSKY_SERVICE}/xrpc/com.atproto.repo.deleteRecord`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({ repo: session.did, collection, rkey }),
  });
  if (!res.ok) {
    throw new BskyWriteError(`deleteRecord failed: ${await res.text()}`, 502);
  }
}

function sessionExpiredError(): BskyWriteError {
  return new BskyWriteError(
    "Bluesky session expired. Open Settings and reconnect Bluesky.",
    403
  );
}

async function withBskyWriter<T>(
  userId: string,
  fn: (writer: BskyWriter) => Promise<T>
): Promise<T> {
  const user = await getUserById(userId);
  if (!user?.bluesky_did && !user?.bluesky_handle) {
    throw new BskyWriteError("Bluesky account not connected.", 403);
  }

  if (user.bluesky_did) {
    try {
      const oauthSession = await restoreBskySession(user.bluesky_did);
      return fn({
        did: user.bluesky_did,
        createRecord: (collection, record) =>
          oauthCreateRecord(oauthSession, user.bluesky_did!, collection, record),
        deleteRecord: (collection, rkey) =>
          oauthDeleteRecord(oauthSession, user.bluesky_did!, collection, rkey),
      });
    } catch {
      if (!user.bsky_app_password) {
        throw sessionExpiredError();
      }
      /* fall through to app password */
    }
  }

  if (!user.bluesky_handle || !user.bsky_app_password) {
    throw new BskyWriteError(
      "Bluesky not connected. Sign in with Bluesky in Settings.",
      403
    );
  }

  const session = await createSession(
    user.bluesky_handle,
    user.bsky_app_password
  );
  return fn({
    did: session.did,
    createRecord: (collection, record) =>
      sessionCreateRecord(session, collection, record),
    deleteRecord: (collection, rkey) =>
      sessionDeleteRecord(session, collection, rkey),
  });
}

export async function repostPost(
  userId: string,
  postUri: string
): Promise<{ repostUri: string }> {
  const target = await resolvePostTarget(postUri);
  return withBskyWriter(userId, async (w) => {
    const result = await w.createRecord("app.bsky.feed.repost", {
      $type: "app.bsky.feed.repost",
      subject: { uri: target.uri, cid: target.cid },
      createdAt: new Date().toISOString(),
    });
    return { repostUri: result.uri };
  });
}

export async function unrepostPostWrite(
  userId: string,
  repostUri: string
): Promise<void> {
  const rkey = repostUri.split("/").pop();
  if (!rkey) throw new BskyWriteError("Invalid repost URI", 400);
  await withBskyWriter(userId, async (w) => {
    await w.deleteRecord("app.bsky.feed.repost", rkey);
  });
}

export async function replyToPost(
  userId: string,
  postUri: string,
  text: string
): Promise<{ postUri: string }> {
  const trimmed = text.trim();
  if (!trimmed) throw new BskyWriteError("Reply text required", 400);
  if (trimmed.length > 300) {
    throw new BskyWriteError("Reply too long (max 300 characters)", 400);
  }
  const target = await resolvePostTarget(postUri);
  return withBskyWriter(userId, async (w) => {
    const result = await w.createRecord("app.bsky.feed.post", {
      $type: "app.bsky.feed.post",
      text: trimmed,
      reply: {
        root: target.root,
        parent: { uri: target.uri, cid: target.cid },
      },
      createdAt: new Date().toISOString(),
    });
    return { postUri: result.uri };
  });
}

export async function likePostWrite(
  userId: string,
  postUri: string
): Promise<{ likeUri: string }> {
  const target = await resolvePostTarget(postUri);
  return withBskyWriter(userId, async (w) => {
    const result = await w.createRecord("app.bsky.feed.like", {
      $type: "app.bsky.feed.like",
      subject: { uri: target.uri, cid: target.cid },
      createdAt: new Date().toISOString(),
    });
    return { likeUri: result.uri };
  });
}

export async function unlikePostWrite(
  userId: string,
  likeUri: string
): Promise<void> {
  const rkey = likeUri.split("/").pop();
  if (!rkey) throw new BskyWriteError("Invalid like URI", 400);
  await withBskyWriter(userId, async (w) => {
    await w.deleteRecord("app.bsky.feed.like", rkey);
  });
}

export async function quotePost(
  userId: string,
  postUri: string,
  text: string
): Promise<{ postUri: string }> {
  const trimmed = text.trim();
  if (!trimmed) throw new BskyWriteError("Quote text required", 400);
  if (trimmed.length > 300) {
    throw new BskyWriteError("Quote too long (max 300 characters)", 400);
  }
  const target = await resolvePostTarget(postUri);
  return withBskyWriter(userId, async (w) => {
    const result = await w.createRecord("app.bsky.feed.post", {
      $type: "app.bsky.feed.post",
      text: trimmed,
      embed: {
        $type: "app.bsky.embed.record",
        record: { uri: target.uri, cid: target.cid },
      },
      createdAt: new Date().toISOString(),
    });
    return { postUri: result.uri };
  });
}
