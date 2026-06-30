/**
 * Engagement fetcher — orchestrates the PDS-list + AppView-hydrate pipeline
 * and composes the per-engagement records the LLM will read.
 *
 * Fetch caps (design §6.2, locked):
 *    likes:       200 newest
 *    reposts:     100 newest
 *    quotes:       50 newest
 *    own posts:    50 newest
 *    own replies: 100 newest
 *
 * Output is sorted newest-first by timestamp across all signal types so the
 * batcher can slice it into 100-record chronological windows.
 */

import {
  resolveHandle,
  didToPds,
  listRecords,
  getPosts,
  type LikeRecord,
  type RepostRecord,
  type PostRecord,
  type HydratedPost,
  type HydratedRecordEmbed,
} from "./bsky-api";
import type { Engagement, Subject, SignalType } from "./types";

const FETCH_CAPS = {
  like: 200,
  repost: 100,
  quote: 50, // upper bound; quote-vs-non-quote is decided during composition
  post: 50, // upper bound on own-posts (no reply, no quoted record)
  reply: 100, // upper bound on own-replies
} as const;

interface FetchResult {
  did: string;
  pds: string;
  engagements: Engagement[];
  /** URIs we tried to hydrate but couldn't (deleted, blocked, 404). */
  unavailableUris: string[];
}

/**
 * The main entry point. Resolves the handle, lists records from PDS,
 * hydrates referenced posts via AppView, and composes Engagement records.
 *
 * Does NOT fetch images — that's the LLM step's job, since images are only
 * needed when a batch is actually processed.
 */
export async function fetchEngagements(handle: string): Promise<FetchResult> {
  // Strip a leading @ if the user typed it.
  const cleanHandle = handle.replace(/^@/, "").trim().toLowerCase();
  if (!cleanHandle) throw new Error("empty handle");

  const did = await resolveHandle(cleanHandle);
  const pds = await didToPds(did);

  // ── 1) PDS listRecords for likes, reposts, and posts ────────────────────
  const [likeRecs, repostRecs, postRecs] = await Promise.all([
    listRecords<LikeRecord>(pds, did, "app.bsky.feed.like", FETCH_CAPS.like),
    listRecords<RepostRecord>(
      pds,
      did,
      "app.bsky.feed.repost",
      FETCH_CAPS.repost
    ),
    // Pull enough posts to cover the worst case where the user only writes
    // quotes / replies / originals — pull cap.quote+cap.post+cap.reply, then
    // categorize.
    listRecords<PostRecord>(
      pds,
      did,
      "app.bsky.feed.post",
      FETCH_CAPS.quote + FETCH_CAPS.post + FETCH_CAPS.reply
    ),
  ]);

  // ── 2) Categorize the user's own posts into quote / post / reply ────────
  // Classification overlap (design Q3 default): a post that is BOTH a reply
  // AND quotes another is classified as reply; the quote still surfaces via
  // the recursive `quoting` field.
  type UserPostEntry = {
    uri: string;
    rec: PostRecord;
    cid: string;
    type: SignalType;
    quotedUri?: string;
  };
  const userPosts: UserPostEntry[] = postRecs.map((r) => {
    const rec = r.value;
    const isReply = !!rec.reply;
    const quotedUri = extractQuotedUri(rec.embed);
    const type: SignalType = isReply
      ? "reply"
      : quotedUri
        ? "quote"
        : "post";
    return { uri: r.uri, rec, cid: r.cid, type, quotedUri };
  });

  // Apply per-signal caps after classification.
  const perTypeUserPosts: Record<"quote" | "post" | "reply", UserPostEntry[]> =
    { quote: [], post: [], reply: [] };
  for (const p of userPosts) {
    const bucket = perTypeUserPosts[p.type as "quote" | "post" | "reply"];
    const cap =
      p.type === "quote"
        ? FETCH_CAPS.quote
        : p.type === "post"
          ? FETCH_CAPS.post
          : FETCH_CAPS.reply;
    if (bucket.length < cap) bucket.push(p);
  }

  // ── 3) Collect every URI we need to hydrate via AppView ────────────────
  const urisToHydrate = new Set<string>();
  for (const r of likeRecs) urisToHydrate.add(r.value.subject.uri);
  for (const r of repostRecs) urisToHydrate.add(r.value.subject.uri);
  // For user posts: hydrate the user's own post (gets embed details),
  // plus the parent/quoted URI for reply/quote context.
  for (const p of [
    ...perTypeUserPosts.quote,
    ...perTypeUserPosts.post,
    ...perTypeUserPosts.reply,
  ]) {
    urisToHydrate.add(p.uri);
    if (p.rec.reply) urisToHydrate.add(p.rec.reply.parent.uri);
    if (p.quotedUri) urisToHydrate.add(p.quotedUri);
  }

  const hydrated = await getPosts(Array.from(urisToHydrate));

  // ── 4) Compose Engagement records ─────────────────────────────────────
  const engagements: Engagement[] = [];
  let nextId = 1;

  for (const r of likeRecs) {
    const subject = subjectFromHydrated(r.value.subject.uri, hydrated);
    engagements.push({
      id: nextId++,
      type: "like",
      ts: r.value.createdAt,
      subject,
    });
  }

  for (const r of repostRecs) {
    const subject = subjectFromHydrated(r.value.subject.uri, hydrated);
    engagements.push({
      id: nextId++,
      type: "repost",
      ts: r.value.createdAt,
      subject,
    });
  }

  // Resolve the author handle of the user themselves for own posts. We get it
  // from the first hydrated own post (or, if none, leave blank — that branch
  // never actually happens once any post fetches succeed).
  let selfHandle = cleanHandle;
  for (const p of [
    ...perTypeUserPosts.quote,
    ...perTypeUserPosts.post,
    ...perTypeUserPosts.reply,
  ]) {
    const own = hydrated.get(p.uri);
    if (own) {
      selfHandle = own.author.handle;
      break;
    }
  }

  for (const p of perTypeUserPosts.post) {
    const own = hydrated.get(p.uri);
    const subject: Subject = own
      ? subjectFromHydrated(p.uri, hydrated)
      : selfSubjectFromRecord(p.uri, p.rec, did, selfHandle);
    engagements.push({
      id: nextId++,
      type: "post",
      ts: p.rec.createdAt,
      subject,
      userText: p.rec.text || null,
    });
  }

  for (const p of perTypeUserPosts.quote) {
    const own = hydrated.get(p.uri);
    const subject: Subject = own
      ? subjectFromHydrated(p.uri, hydrated)
      : selfSubjectFromRecord(p.uri, p.rec, did, selfHandle);
    // Make sure `quoting` is populated even if hydration miss happened on the
    // user's own post but hit the quoted target.
    if (!subject.quoting && p.quotedUri) {
      subject.quoting = subjectFromHydrated(p.quotedUri, hydrated);
    }
    engagements.push({
      id: nextId++,
      type: "quote",
      ts: p.rec.createdAt,
      subject,
      userText: p.rec.text || null,
    });
  }

  for (const p of perTypeUserPosts.reply) {
    const own = hydrated.get(p.uri);
    const subject: Subject = own
      ? subjectFromHydrated(p.uri, hydrated)
      : selfSubjectFromRecord(p.uri, p.rec, did, selfHandle);
    if (!subject.replyingTo && p.rec.reply) {
      subject.replyingTo = subjectFromHydrated(
        p.rec.reply.parent.uri,
        hydrated
      );
    }
    engagements.push({
      id: nextId++,
      type: "reply",
      ts: p.rec.createdAt,
      subject,
      userText: p.rec.text || null,
    });
  }

  // ── 5) Sort newest-first and tally unavailable subjects ────────────────
  engagements.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  const unavailableUris: string[] = [];
  for (const e of engagements) {
    if (e.subject.unavailable) unavailableUris.push(e.subject.uri);
  }

  return { did, pds, engagements, unavailableUris };
}

// ── Helpers ────────────────────────────────────────────────────────────

function extractQuotedUri(embed: PostRecord["embed"]): string | undefined {
  if (!embed) return;
  if (embed.$type === "app.bsky.embed.record") return embed.record.uri;
  if (embed.$type === "app.bsky.embed.recordWithMedia")
    return embed.record.record.uri;
  return;
}

/**
 * Build a Subject from a hydrated AppView post. Recursively hydrates the
 * quoted record (one level deep — Bluesky only nests one level anyway).
 */
function subjectFromHydrated(
  uri: string,
  hydrated: Map<string, HydratedPost>
): Subject {
  const h = hydrated.get(uri);
  if (!h) {
    return {
      uri,
      author: "@unknown",
      text: "",
      unavailable: true,
    };
  }
  return composeSubject(h, hydrated);
}

function composeSubject(
  h: HydratedPost,
  hydrated: Map<string, HydratedPost>
): Subject {
  const { images, linkCard, quotingFromEmbed, replyingFromRecord } =
    interpretEmbed(h);

  const replyParentUri = h.record.reply?.parent?.uri;

  const subject: Subject = {
    uri: h.uri,
    cid: h.cid,
    author: `@${h.author.handle}`,
    authorDid: h.author.did,
    text: h.record.text ?? "",
    imageCids: images.length > 0 ? images : undefined,
    linkCard,
  };

  // Inline quote / reply contexts: the embed sometimes carries the quoted
  // record's content directly (viewRecord); fall back to a second hydrated
  // lookup if not.
  if (quotingFromEmbed) {
    subject.quoting = quotingFromEmbed;
  }
  if (replyParentUri && !replyingFromRecord) {
    subject.replyingTo = subjectFromHydrated(replyParentUri, hydrated);
  } else if (replyingFromRecord) {
    subject.replyingTo = replyingFromRecord;
  }

  return subject;
}

interface EmbedView {
  images: string[]; // raw image CIDs only — bytes fetched later, lazily
  linkCard: { title: string; description: string } | null;
  quotingFromEmbed: Subject | null;
  replyingFromRecord: Subject | null;
}

function interpretEmbed(h: HydratedPost): EmbedView {
  const embed = h.embed;
  const out: EmbedView = {
    images: [],
    linkCard: null,
    quotingFromEmbed: null,
    replyingFromRecord: null,
  };
  // Cross-reference the record's raw embed (has the CIDs of attached images)
  // with the hydrated embed (has fullsize URLs and external link metadata).
  const rawEmbed = h.record.embed;

  if (rawEmbed?.$type === "app.bsky.embed.images") {
    out.images = rawEmbed.images
      .map((i) => i.image?.ref?.$link || i.image?.cid)
      .filter((c): c is string => !!c);
  } else if (rawEmbed?.$type === "app.bsky.embed.recordWithMedia") {
    if (rawEmbed.media.$type === "app.bsky.embed.images") {
      out.images = rawEmbed.media.images
        .map((i) => i.image?.ref?.$link || i.image?.cid)
        .filter((c): c is string => !!c);
    }
  }

  if (embed?.$type === "app.bsky.embed.external#view") {
    out.linkCard = {
      title: embed.external.title || "",
      description: embed.external.description || "",
    };
  } else if (embed?.$type === "app.bsky.embed.recordWithMedia#view") {
    if (embed.media.$type === "app.bsky.embed.external#view") {
      out.linkCard = {
        title: embed.media.external.title || "",
        description: embed.media.external.description || "",
      };
    }
  }

  // Quote embed — viewRecord carries author + value inline.
  if (embed?.$type === "app.bsky.embed.record#view") {
    out.quotingFromEmbed = subjectFromRecordEmbed(embed.record);
  } else if (embed?.$type === "app.bsky.embed.recordWithMedia#view") {
    out.quotingFromEmbed = subjectFromRecordEmbed(embed.record.record);
  }

  return out;
}

function subjectFromRecordEmbed(view: HydratedRecordEmbed): Subject {
  if (view.$type === "app.bsky.embed.record#viewRecord") {
    // Best-effort: pull images out of nested embed if any. We don't recurse
    // further into quotes-of-quotes — one level is the design's stated limit.
    const nestedRaw = view.value.embed;
    let imageCids: string[] | undefined;
    let linkCard: { title: string; description: string } | null = null;
    if (nestedRaw?.$type === "app.bsky.embed.images") {
      imageCids = nestedRaw.images
        .map((i) => i.image?.ref?.$link || i.image?.cid)
        .filter((c): c is string => !!c);
    } else if (nestedRaw?.$type === "app.bsky.embed.external") {
      linkCard = {
        title: nestedRaw.external.title || "",
        description: nestedRaw.external.description || "",
      };
    } else if (nestedRaw?.$type === "app.bsky.embed.recordWithMedia") {
      if (nestedRaw.media.$type === "app.bsky.embed.images") {
        imageCids = nestedRaw.media.images
          .map((i) => i.image?.ref?.$link || i.image?.cid)
          .filter((c): c is string => !!c);
      } else if (nestedRaw.media.$type === "app.bsky.embed.external") {
        linkCard = {
          title: nestedRaw.media.external.title || "",
          description: nestedRaw.media.external.description || "",
        };
      }
    }
    return {
      uri: view.uri,
      cid: view.cid,
      author: `@${view.author.handle}`,
      authorDid: view.author.did,
      text: view.value.text ?? "",
      imageCids,
      linkCard,
    };
  }
  // notFound / blocked / detached — surface unavailable but keep the URI so
  // the user can at least see "this engaged-with post is gone".
  return {
    uri: view.uri,
    author: "@unknown",
    text: "",
    unavailable: true,
  };
}

/**
 * Fallback: build a Subject from the user's own record when AppView didn't
 * hydrate it (rare — usually because the post is very fresh). We have the
 * raw record bytes, so we can still render the text + embed best-effort.
 */
function selfSubjectFromRecord(
  uri: string,
  rec: PostRecord,
  selfDid: string,
  selfHandle: string
): Subject {
  let imageCids: string[] | undefined;
  let linkCard: { title: string; description: string } | null = null;
  if (rec.embed?.$type === "app.bsky.embed.images") {
    imageCids = rec.embed.images
      .map((i) => i.image?.ref?.$link || i.image?.cid)
      .filter((c): c is string => !!c);
  } else if (rec.embed?.$type === "app.bsky.embed.external") {
    linkCard = {
      title: rec.embed.external.title || "",
      description: rec.embed.external.description || "",
    };
  } else if (rec.embed?.$type === "app.bsky.embed.recordWithMedia") {
    if (rec.embed.media.$type === "app.bsky.embed.images") {
      imageCids = rec.embed.media.images
        .map((i) => i.image?.ref?.$link || i.image?.cid)
        .filter((c): c is string => !!c);
    } else if (rec.embed.media.$type === "app.bsky.embed.external") {
      linkCard = {
        title: rec.embed.media.external.title || "",
        description: rec.embed.media.external.description || "",
      };
    }
  }
  return {
    uri,
    author: `@${selfHandle}`,
    authorDid: selfDid,
    text: rec.text ?? "",
    imageCids,
    linkCard,
  };
}
