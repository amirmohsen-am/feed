/**
 * Bluesky API client for the introspection pipeline.
 *
 * All calls are public, unauthenticated:
 *  - handle → DID:   GET public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle
 *  - DID → PDS:      GET plc.directory/<did>
 *  - listRecords:    GET <pds>/xrpc/com.atproto.repo.listRecords
 *  - getPosts:       GET public.api.bsky.app/xrpc/app.bsky.feed.getPosts (25 URIs/call)
 *
 * The pattern (PDS-list + AppView-hydrate) is locked in PRD decision #3:
 * PDS exposes likes/reposts/posts as plain unauthenticated records,
 * and AppView batches post hydration with embed details.
 */

const APPVIEW = "https://public.api.bsky.app";
const PLC = "https://plc.directory";

interface RecordEntry<T = unknown> {
  uri: string;
  cid: string;
  value: T;
}

interface ListRecordsResponse<T = unknown> {
  records: RecordEntry<T>[];
  cursor?: string;
}

/** Resolve a Bluesky handle to a DID. */
export async function resolveHandle(handle: string): Promise<string> {
  const url = `${APPVIEW}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `resolveHandle failed for ${handle}: ${res.status} ${await res.text()}`
    );
  }
  const data = (await res.json()) as { did: string };
  return data.did;
}

/** Resolve a DID to its PDS endpoint via the PLC directory. */
export async function didToPds(did: string): Promise<string> {
  // did:web identities self-host their DID document at the web origin; we
  // only handle did:plc here (the common case), which lives in plc.directory.
  if (!did.startsWith("did:plc:")) {
    throw new Error(`Only did:plc supported for now (got ${did})`);
  }
  const res = await fetch(`${PLC}/${did}`);
  if (!res.ok) {
    throw new Error(
      `PLC lookup failed for ${did}: ${res.status} ${await res.text()}`
    );
  }
  const doc = (await res.json()) as {
    service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
  };
  const svc = doc.service?.find(
    (s) =>
      s.id === "#atproto_pds" ||
      s.type === "AtprotoPersonalDataServer"
  );
  if (!svc) throw new Error(`No PDS service in DID doc for ${did}`);
  return svc.serviceEndpoint.replace(/\/$/, "");
}

/**
 * Page through one collection on a user's PDS, newest-first, until `cap`
 * records are collected or pagination ends.
 */
export async function listRecords<T = unknown>(
  pds: string,
  did: string,
  collection: string,
  cap: number
): Promise<RecordEntry<T>[]> {
  const out: RecordEntry<T>[] = [];
  let cursor: string | undefined;
  // PDS default page size is 50; max 100. Request 100 to minimize round-trips.
  const pageSize = 100;
  while (out.length < cap) {
    const remaining = cap - out.length;
    const limit = Math.min(pageSize, remaining);
    const params = new URLSearchParams({
      repo: did,
      collection,
      limit: String(limit),
      reverse: "false", // newest-first is the default; explicit for safety
    });
    if (cursor) params.set("cursor", cursor);
    const url = `${pds}/xrpc/com.atproto.repo.listRecords?${params}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      // Empty collection (e.g. user never reposted) returns 400 on some PDSes
      // with InvalidRequest; treat that as "no records" rather than an error.
      if (res.status === 400 && /Could not locate record/i.test(body)) {
        return out;
      }
      throw new Error(
        `listRecords ${collection} failed: ${res.status} ${body}`
      );
    }
    const data = (await res.json()) as ListRecordsResponse<T>;
    out.push(...data.records);
    if (!data.cursor || data.records.length === 0) break;
    cursor = data.cursor;
  }
  return out;
}

// ── App.bsky record shapes we actually read ──────────────────────────────

export interface LikeRecord {
  $type?: "app.bsky.feed.like";
  subject: { uri: string; cid: string };
  createdAt: string;
}

export interface RepostRecord {
  $type?: "app.bsky.feed.repost";
  subject: { uri: string; cid: string };
  createdAt: string;
}

export interface PostRecord {
  $type?: "app.bsky.feed.post";
  text: string;
  createdAt: string;
  reply?: {
    root: { uri: string; cid: string };
    parent: { uri: string; cid: string };
  };
  embed?: PostEmbed;
  langs?: string[];
}

export type PostEmbed =
  | { $type: "app.bsky.embed.images"; images: Array<{ alt?: string; image?: { ref?: { $link?: string }; cid?: string } }> }
  | { $type: "app.bsky.embed.external"; external: { uri: string; title: string; description: string } }
  | { $type: "app.bsky.embed.record"; record: { uri: string; cid: string } }
  | {
      $type: "app.bsky.embed.recordWithMedia";
      record: { record: { uri: string; cid: string } };
      media:
        | { $type: "app.bsky.embed.images"; images: Array<{ alt?: string; image?: { ref?: { $link?: string }; cid?: string } }> }
        | { $type: "app.bsky.embed.external"; external: { uri: string; title: string; description: string } };
    };

// ── AppView hydrated post (from getPosts) ────────────────────────────────

export interface HydratedPost {
  uri: string;
  cid: string;
  author: {
    did: string;
    handle: string;
    displayName?: string;
  };
  record: PostRecord;
  embed?: HydratedEmbed;
  indexedAt: string;
}

export type HydratedEmbed =
  | {
      $type: "app.bsky.embed.images#view";
      images: Array<{ thumb: string; fullsize: string; alt?: string }>;
    }
  | {
      $type: "app.bsky.embed.external#view";
      external: { uri: string; title: string; description: string; thumb?: string };
    }
  | {
      $type: "app.bsky.embed.record#view";
      record: HydratedRecordEmbed;
    }
  | {
      $type: "app.bsky.embed.recordWithMedia#view";
      record: { record: HydratedRecordEmbed };
      media:
        | {
            $type: "app.bsky.embed.images#view";
            images: Array<{ thumb: string; fullsize: string; alt?: string }>;
          }
        | {
            $type: "app.bsky.embed.external#view";
            external: { uri: string; title: string; description: string; thumb?: string };
          };
    };

export type HydratedRecordEmbed =
  | {
      $type: "app.bsky.embed.record#viewRecord";
      uri: string;
      cid: string;
      author: { did: string; handle: string; displayName?: string };
      value: PostRecord;
      embeds?: HydratedEmbed[];
    }
  | { $type: "app.bsky.embed.record#viewNotFound"; uri: string; notFound: true }
  | { $type: "app.bsky.embed.record#viewBlocked"; uri: string; blocked: true }
  | { $type: "app.bsky.embed.record#viewDetached"; uri: string; detached: true };

/**
 * Hydrate up to 25 post URIs at a time via the AppView. Posts that 404 or
 * are blocked simply don't appear in the response — callers must handle
 * missing URIs as "unavailable subject".
 *
 * Batches run in parallel: with the demo-small fetch caps (~400 unique URIs
 * → ~16 batches) this collapses what was a 4–8s sequential hydrate into a
 * single round-trip's worth of latency. The AppView's public rate limit is
 * 3000 rpm, so 16 simultaneous calls is well within budget.
 */
export async function getPosts(uris: string[]): Promise<Map<string, HydratedPost>> {
  const out = new Map<string, HydratedPost>();
  const BATCH = 25;
  const slices: string[][] = [];
  for (let i = 0; i < uris.length; i += BATCH) {
    slices.push(uris.slice(i, i + BATCH));
  }
  const results = await Promise.all(
    slices.map(async (slice, idx) => {
      const params = new URLSearchParams();
      for (const u of slice) params.append("uris", u);
      const url = `${APPVIEW}/xrpc/app.bsky.feed.getPosts?${params}`;
      try {
        const res = await fetch(url);
        if (!res.ok) {
          console.warn(
            `[introspect] getPosts batch ${idx} failed: ${res.status} ${await res.text()}`
          );
          return [] as HydratedPost[];
        }
        const data = (await res.json()) as { posts: HydratedPost[] };
        return data.posts;
      } catch (err) {
        console.warn(`[introspect] getPosts batch ${idx} threw:`, err);
        return [] as HydratedPost[];
      }
    })
  );
  for (const posts of results) for (const p of posts) out.set(p.uri, p);
  return out;
}
