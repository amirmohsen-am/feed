/**
 * pgvector KNN search over bsky.posts (Cloud SQL bsky-db).
 *
 * Multi-query design (curator redesign):
 * 1. For each subquery, embed with Gemini (`gemini-embedding-001`, 768d,
 *    RETRIEVAL_QUERY) and run one SQL KNN with k = floor(N / M). The query
 *    does retrieval + metadata filter + engagement/author join + field
 *    selection in a single statement — there is no separate hydrate step.
 * 2. Union the result rows across subqueries, deduping on URI and keeping
 *    the max vector_score.
 * 3. AppView label gate (NSFW deny-list).
 *
 * `<=>` is cosine *distance* in [0, 2]; we map it to the documented
 * vector_score contract of [0, 1] via `1 - distance / 2` in SQL.
 *
 * HNSW recall knob: `hnsw.ef_search = 250` is set at the database level
 * (ALTER DATABASE), so every pooled connection inherits it.
 *
 * The KNN itself runs inside a transaction with `SET LOCAL enable_sort = off`
 * (see knnQuery). Without it the planner sometimes abandons the HNSW index
 * for feeds with a trailing time window: the append-only table's stats go
 * stale between ANALYZEs, the planner underestimates the window's row count,
 * and flips to a created_at_us btree scan + exact distance sort over the
 * whole window (~500k rows, 30-100s cold). The only sort a plan could use
 * here is that exact-distance sort, so disabling sort nodes deterministically
 * selects the HNSW ordering path regardless of stats freshness.
 *
 * The runtime needs ADC with `roles/aiplatform.user` (query embedding only)
 * + `roles/secretmanager.secretAccessor` on `bsky-database-url`.
 */

import { GoogleGenAI } from "@google/genai";
import { bskyQuery, withBskyClient } from "./bsky-pg";
import { LIKE_NSFW_DESCRIPTION_KEYWORDS } from "./defaults";
import { onAdcChange } from "./adc-watcher";

const VERTEX_PROJECT = process.env.VERTEX_PROJECT ?? "timelines-492720";
const VERTEX_LOCATION = process.env.VERTEX_LOCATION ?? "us-central1";

const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMENSION = 768;

// The HNSW index is PARTIAL: `WHERE ingested_at_us >= INDEX_INGEST_CUTOFF_US`
// (a fixed point ~3 days before the index was built — see DECISIONS.md #12 and
// scripts/build-hnsw.mjs). Every KNN query MUST carry this same literal floor,
// otherwise the planner can't prove the query implies the partial predicate and
// falls back to an exact scan over all 36M rows. The cutoff is fixed, so the
// indexed/searchable window grows past 3 days over time (up to the 14d
// retention) rather than rolling — offered feed windows are capped at 3d to
// stay honest about what's reliably searchable today.
const INDEX_INGEST_CUTOFF_US = "1780253847390000";

// AppView host + the official Bluesky moderation labeler. We ask the AppView
// to attach this labeler's labels onto getPosts responses so we can drop
// labeler-applied NSFW that wasn't self-labeled by the author.
const APPVIEW_HOST = process.env.BLUESKY_APPVIEW_HOST ?? "https://public.api.bsky.app";
const OFFICIAL_LABELER_DID = "did:plc:ar7c4by46qjdydhdevvrndac";
const GET_POSTS_BATCH = 25; // app.bsky.feed.getPosts caps at 25 URIs per call
const GET_PROFILES_BATCH = 25; // app.bsky.actor.getProfiles caps at 25 actors per call

let _genai: GoogleGenAI | null = null;
function genai() {
  if (!_genai) {
    _genai = new GoogleGenAI({
      vertexai: true,
      project: VERTEX_PROJECT,
      location: VERTEX_LOCATION,
    });
  }
  return _genai;
}

onAdcChange(() => {
  const had = _genai !== null;
  _genai = null;
  if (had) console.log("[vector-search] Gemini client reset after ADC change");
});

export interface VectorHit {
  uri: string;
  did: string;
  text: string;
  created_at: string;
  // Cosine similarity mapped to [0, 1]: `1 - (embedding <=> query) / 2`.
  // Cosine distance lives in [0, 2], so this keeps the documented [0, 1]
  // contract that downstream consumers (UI, search-runs) rely on.
  vector_score: number;

  langs: string[];
  has_images: boolean;
  has_video: boolean;
  has_quote: boolean;
  has_external_link: boolean;
  is_reply: boolean;
  reply_parent_uri: string | null;
  reply_root_uri: string | null;
  image_count: number;
  image_alts: string[];
  external_uri: string | null;
  external_title: string | null;
  external_desc: string | null;
  quote_uri: string | null;
  hashtags: string[];
  mention_dids: string[];
  domains: string[];
  self_labels: string[];

  like_count: number;
  repost_count: number;
  reply_count: number;
  quote_count: number;

  author_handle: string | null;
  author_display_name: string | null;
  author_avatar_cid: string | null;

  // True when the author's description matches one of the heuristics in
  // LIKE_NSFW_DESCRIPTION_KEYWORDS. Computed in searchPosts; always
  // populated (boolean, never undefined).
  like_nsfw: boolean;

  // CDN URLs for the post's images, pulled from the AppView via
  // app.bsky.feed.getPosts. Empty if the post has no images, or if the
  // AppView fetch was not enabled for this search. The reranker uses these
  // when the feed has a rerank prompt configured.
  image_urls: string[];
  // Link-card thumbnail from AppView embed.external.thumb (when present).
  external_thumb: string | null;
  // Video thumbnail from AppView embed (app.bsky.embed.video#view).
  // A single frame from the video, used for AI-generated content detection.
  video_thumbnail: string | null;
}

export interface SearchFilter {
  lang?: string[];
  hasImages?: boolean;
  hasVideo?: boolean;
  hasQuote?: boolean;
  hasExternalLink?: boolean;
  isReply?: boolean;
  didExclude?: string[];
  hashtags?: string[];
  selfLabelsDeny?: string[];
  // Drop hits where hit.like_nsfw === true. Computed after the KNN query, so
  // it applies only to the union (not the SQL pre-filter).
  excludeLikelyNsfw?: boolean;
  minLikeCount?: number;
  minRepostCount?: number;
  minReplyCount?: number;
  createdAfterUs?: number;
  createdBeforeUs?: number;
}

// In-memory LRU cache for query embeddings. The embedding is a pure function
// of the subquery text, so identical subqueries hit cache across refreshes.
// Process-local; does not survive restarts or scale-out.
const EMBED_CACHE_MAX = 256;
const embedCache = new Map<string, number[]>();

export async function embedQuery(query: string): Promise<number[]> {
  const cached = embedCache.get(query);
  if (cached) {
    // Touch: re-insert to make it MRU.
    embedCache.delete(query);
    embedCache.set(query, cached);
    return cached;
  }
  const res = await genai().models.embedContent({
    model: EMBEDDING_MODEL,
    contents: [{ parts: [{ text: query }] }],
    config: {
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: EMBEDDING_DIMENSION,
    },
  });
  const values = res.embeddings?.[0]?.values;
  if (!values || values.length === 0) {
    throw new Error("Vertex Gemini returned an empty embedding");
  }
  if (embedCache.size >= EMBED_CACHE_MAX) {
    const oldest = embedCache.keys().next().value;
    if (oldest !== undefined) embedCache.delete(oldest);
  }
  embedCache.set(query, values);
  return values;
}

interface PgRow {
  uri: string;
  did: string;
  text: string;
  created_at: Date;
  vector_score: number;
  langs: string[];
  has_images: boolean;
  has_video: boolean;
  has_quote: boolean;
  has_external_link: boolean;
  is_reply: boolean;
  reply_parent_uri: string | null;
  reply_root_uri: string | null;
  image_count: number;
  image_alts: string[];
  external_uri: string | null;
  external_title: string | null;
  external_desc: string | null;
  quote_uri: string | null;
  hashtags: string[];
  mention_dids: string[];
  domains: string[];
  self_labels: string[];
  like_count: number | null;
  repost_count: number | null;
  reply_count: number | null;
  quote_count: number | null;
  author_handle: string | null;
  author_display_name: string | null;
  author_avatar_cid: string | null;
}

// One statement: KNN + SearchFilter predicates + engagement/author join +
// full field selection. Each optional filter param is IS NULL-guarded so an
// absent filter doesn't constrain the row set (notably $11 selfLabelsDeny —
// an absent deny-list must not drop every row). Time bounds compare against
// created_at_us (bigint, µs) which already has a btree index for the
// exact-scan fallback; pgvector post-filters during the HNSW graph walk.
export const KNN_SQL = `
SELECT
  p.uri, p.did, p.text, p.created_at, p.langs,
  p.has_images, p.has_video, p.has_quote, p.has_external_link,
  (p.reply_parent_uri IS NOT NULL) AS is_reply,
  p.reply_parent_uri, p.reply_root_uri,
  p.image_count, p.image_alts,
  p.external_uri, p.external_title, p.external_desc, p.quote_uri,
  p.hashtags, p.mention_dids, p.domains, p.self_labels,
  pe.like_count, pe.repost_count, pe.reply_count, pe.quote_count,
  a.handle       AS author_handle,
  a.display_name AS author_display_name,
  a.avatar_cid   AS author_avatar_cid,
  1 - (p.embedding <=> $1::halfvec) / 2 AS vector_score
FROM bsky.posts p
LEFT JOIN bsky.post_engagement pe ON pe.uri = p.uri
LEFT JOIN bsky.authors a          ON a.did = p.did
WHERE p.embedding IS NOT NULL
  -- Partial-index floor (literal, NOT a param): lets the planner match the
  -- partial HNSW index. Without it the KNN degrades to an exact scan.
  AND p.ingested_at_us >= ${INDEX_INGEST_CUTOFF_US}
  AND ($3::text[]   IS NULL OR p.langs && $3::text[])
  AND ($4::bigint   IS NULL OR p.created_at_us >= $4::bigint)
  AND ($5::bigint   IS NULL OR p.created_at_us <= $5::bigint)
  AND ($6::boolean  IS NULL OR p.has_images = $6::boolean)
  AND ($7::boolean  IS NULL OR p.has_video = $7::boolean)
  AND ($8::boolean  IS NULL OR p.has_quote = $8::boolean)
  AND ($9::boolean  IS NULL OR p.has_external_link = $9::boolean)
  AND ($10::boolean IS NULL OR (p.reply_parent_uri IS NOT NULL) = $10::boolean)
  AND ($11::text[]  IS NULL OR p.hashtags && $11::text[])
  AND ($12::text[]  IS NULL OR NOT (p.self_labels && $12::text[]))
  AND ($13::text[]  IS NULL OR p.did <> ALL($13::text[]))
  AND (COALESCE(pe.like_count, 0)   >= $14::int)
  AND (COALESCE(pe.repost_count, 0) >= $15::int)
  AND (COALESCE(pe.reply_count, 0)  >= $16::int)
ORDER BY p.embedding <=> $1::halfvec
LIMIT $2
`;

// pgvector's text input format: "[f1,f2,...]".
function toVectorLiteral(vec: number[]): string {
  return "[" + vec.join(",") + "]";
}

// Exported so diagnostics (scripts/diagnose-search.ts) can EXPLAIN the exact
// production statement with the exact production params.
export function buildKnnParams(
  queryVec: number[],
  k: number,
  filter?: SearchFilter
): unknown[] {
  const f = filter;
  return [
    toVectorLiteral(queryVec),
    k,
    f?.lang?.length ? f.lang : null,
    // created_at_us is µs since epoch (~1.7e15) — within Number.MAX_SAFE_INTEGER,
    // but pass as string so pg treats it as bigint text cleanly.
    f?.createdAfterUs !== undefined ? String(f.createdAfterUs) : null,
    f?.createdBeforeUs !== undefined ? String(f.createdBeforeUs) : null,
    f?.hasImages ?? null,
    f?.hasVideo ?? null,
    f?.hasQuote ?? null,
    f?.hasExternalLink ?? null,
    f?.isReply ?? null,
    f?.hashtags?.length ? f.hashtags.map((t) => t.toLowerCase()) : null,
    f?.selfLabelsDeny?.length ? f.selfLabelsDeny : null,
    f?.didExclude?.length ? f.didExclude : null,
    f?.minLikeCount ?? 0,
    f?.minRepostCount ?? 0,
    f?.minReplyCount ?? 0,
  ];
}

/**
 * Run the single-statement KNN for one query vector. Wrapped in a transaction
 * solely to scope `SET LOCAL enable_sort = off`, which pins the plan to the
 * HNSW index (see the header comment). Exported for scripts/diagnose-search.ts
 * so diagnostics exercise the exact production execution path.
 */
export async function knnQuery(
  queryVec: number[],
  k: number,
  filter?: SearchFilter
): Promise<PgRow[]> {
  return withBskyClient(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query("SET LOCAL enable_sort = off");
      const res = await c.query<PgRow>(KNN_SQL, buildKnnParams(queryVec, k, filter));
      await c.query("COMMIT");
      return res.rows;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => { /* ignore */ });
      throw e;
    }
  });
}

/**
 * Embed one subquery and run the single-statement KNN. Returns fully
 * hydrated rows — there is no separate Postgres hydrate step.
 */
async function embedAndKnn(
  query: string,
  k: number,
  filter?: SearchFilter
): Promise<PgRow[]> {
  const queryVec = await embedQuery(query);
  return knnQuery(queryVec, k, filter);
}

// Hydrate a single post by its at:// URI — same projection as KNN_SQL minus
// the vector math and the partial-index cutoff (a direct URI lookup must work
// regardless of the post's age). Used by the branch flow to read the source
// post (text + image alts + embed cards) for option generation + chat seeding.
const HYDRATE_BY_URI_SQL = `
SELECT
  p.uri, p.did, p.text, p.created_at, p.langs,
  p.has_images, p.has_video, p.has_quote, p.has_external_link,
  (p.reply_parent_uri IS NOT NULL) AS is_reply,
  p.reply_parent_uri, p.reply_root_uri,
  p.image_count, p.image_alts,
  p.external_uri, p.external_title, p.external_desc, p.quote_uri,
  p.hashtags, p.mention_dids, p.domains, p.self_labels,
  pe.like_count, pe.repost_count, pe.reply_count, pe.quote_count,
  a.handle       AS author_handle,
  a.display_name AS author_display_name,
  a.avatar_cid   AS author_avatar_cid,
  1.0 AS vector_score
FROM bsky.posts p
LEFT JOIN bsky.post_engagement pe ON pe.uri = p.uri
LEFT JOIN bsky.authors a          ON a.did = p.did
WHERE p.uri = $1
LIMIT 1
`;

export async function hydratePostByUri(uri: string): Promise<VectorHit | null> {
  const res = await bskyQuery<PgRow>(HYDRATE_BY_URI_SQL, [uri]);
  return res.rows[0] ? rowToHit(res.rows[0]) : null;
}

function rowToHit(r: PgRow): VectorHit {
  return {
    uri: r.uri,
    did: r.did,
    text: r.text,
    created_at: r.created_at.toISOString(),
    vector_score: r.vector_score,
    langs: r.langs,
    has_images: r.has_images,
    has_video: r.has_video,
    has_quote: r.has_quote,
    has_external_link: r.has_external_link,
    is_reply: r.is_reply,
    reply_parent_uri: r.reply_parent_uri,
    reply_root_uri: r.reply_root_uri,
    image_count: r.image_count,
    image_alts: r.image_alts,
    external_uri: r.external_uri,
    external_title: r.external_title,
    external_desc: r.external_desc,
    quote_uri: r.quote_uri,
    hashtags: r.hashtags,
    mention_dids: r.mention_dids,
    domains: r.domains,
    self_labels: r.self_labels,
    like_count: r.like_count ?? 0,
    repost_count: r.repost_count ?? 0,
    reply_count: r.reply_count ?? 0,
    quote_count: r.quote_count ?? 0,
    author_handle: r.author_handle,
    author_display_name: r.author_display_name,
    author_avatar_cid: r.author_avatar_cid,
    like_nsfw: false,
    image_urls: [],
    external_thumb: null,
    video_thumbnail: null,
  };
}

interface ResolvedAuthor {
  did: string;
  handle: string | null;
  displayName: string | null;
  avatarCid: string | null;
}

// Extract the CID from a full Bluesky CDN avatar URL.
// Format varies:
//   https://cdn.bsky.app/img/avatar/plain/did:plc:xxx/bafkreiabc123@jpeg  (with format suffix)
//   https://cdn.bsky.app/img/avatar/plain/did:plc:xxx/bafkreiabc123       (without format suffix)
function extractAvatarCid(url: string | undefined | null): string | null {
  if (!url) return null;
  // Match the last path segment, optionally followed by @format
  const m = url.match(/\/([a-z0-9]+)(?:@[a-z]+)?$/i);
  return m ? m[1] : null;
}

async function fetchAndCacheAuthorProfiles(
  dids: string[]
): Promise<Map<string, ResolvedAuthor>> {
  const out = new Map<string, ResolvedAuthor>();
  if (dids.length === 0) return out;

  const batches: string[][] = [];
  for (let i = 0; i < dids.length; i += GET_PROFILES_BATCH) {
    batches.push(dids.slice(i, i + GET_PROFILES_BATCH));
  }

  interface AppViewProfile {
    did: string;
    handle?: string;
    displayName?: string;
    avatar?: string;
  }

  const results = await Promise.all(
    batches.map(async (batch) => {
      const params = new URLSearchParams();
      for (const did of batch) params.append("actors", did);
      const url = `${APPVIEW_HOST}/xrpc/app.bsky.actor.getProfiles?${params}`;
      try {
        const res = await fetch(url);
        if (!res.ok) {
          console.warn(
            `[vector-search] author backfill getProfiles ${res.status} (batch of ${batch.length})`
          );
          return [] as AppViewProfile[];
        }
        const json = (await res.json()) as { profiles?: AppViewProfile[] };
        return json.profiles ?? [];
      } catch (e) {
        console.warn("[vector-search] author backfill getProfiles failed:", e);
        return [] as AppViewProfile[];
      }
    })
  );

  for (const profiles of results) {
    for (const p of profiles) {
      out.set(p.did, {
        did: p.did,
        handle: p.handle ?? null,
        displayName: p.displayName ?? null,
        avatarCid: extractAvatarCid(p.avatar),
      });
    }
  }

  // Fire-and-forget batch upsert into bsky.authors so future queries hit Postgres
  if (out.size > 0) {
    const rows = Array.from(out.values());
    bskyQuery(
      `INSERT INTO bsky.authors (did, handle, display_name, avatar_cid, updated_at)
       SELECT UNNEST($1::text[]), UNNEST($2::text[]), UNNEST($3::text[]), UNNEST($4::text[]), now()
       ON CONFLICT (did) DO UPDATE SET
         handle       = COALESCE(EXCLUDED.handle, bsky.authors.handle),
         display_name = COALESCE(EXCLUDED.display_name, bsky.authors.display_name),
         avatar_cid   = COALESCE(EXCLUDED.avatar_cid, bsky.authors.avatar_cid),
         updated_at   = now()`,
      [
        rows.map((r) => r.did),
        rows.map((r) => r.handle),
        rows.map((r) => r.displayName),
        rows.map((r) => r.avatarCid),
      ]
    ).catch((e) => {
      console.warn("[vector-search] author backfill upsert failed:", e);
    });
  }

  return out;
}

// Backfill authors that are missing or have incomplete data (no handle or
// no avatar) from the Bluesky AppView. Mutates hits in place.
async function backfillIncompleteAuthors(hits: VectorHit[]): Promise<void> {
  const backfillDids = new Set<string>();
  for (const h of hits) {
    if (h.author_handle === null || h.author_avatar_cid === null) {
      backfillDids.add(h.did);
    }
  }
  if (backfillDids.size === 0) return;
  try {
    const resolved = await fetchAndCacheAuthorProfiles(Array.from(backfillDids));
    for (const h of hits) {
      const r = resolved.get(h.did);
      if (!r) continue;
      if (h.author_handle === null) h.author_handle = r.handle;
      if (h.author_display_name === null) h.author_display_name = r.displayName;
      if (h.author_avatar_cid === null) h.author_avatar_cid = r.avatarCid;
    }
    if (resolved.size > 0) {
      console.log(
        `[vector-search] author backfill: resolved ${resolved.size}/${backfillDids.size} incomplete authors`
      );
    }
  } catch (e) {
    console.warn("[vector-search] author backfill failed (non-fatal):", e);
  }
}

interface AppViewMeta {
  labels: string[];
  imageUrls: string[];
  externalThumb: string | null;
  videoThumbnail: string | null;
}

interface AppViewPostView {
  uri: string;
  labels?: Array<{ val: string }>;
  embed?: {
    $type?: string;
    external?: { thumb?: string };
    images?: Array<{ thumb?: string; fullsize?: string }>;
    // Video embed (app.bsky.embed.video#view).
    thumbnail?: string;
    playlist?: string;
    // recordWithMedia nests the media one level deeper.
    media?: {
      $type?: string;
      external?: { thumb?: string };
      images?: Array<{ thumb?: string; fullsize?: string }>;
      thumbnail?: string;
      playlist?: string;
    };
  };
}

function extractImageUrls(p: AppViewPostView): string[] {
  const direct = p.embed?.images ?? [];
  const nested = p.embed?.media?.images ?? [];
  const all = [...direct, ...nested];
  return all
    .map((img) => img.thumb ?? img.fullsize ?? null)
    .filter((u): u is string => typeof u === "string" && u.length > 0);
}

function extractVideoThumbnail(p: AppViewPostView): string | null {
  const embed = p.embed;
  if (!embed) return null;
  if (embed.$type === "app.bsky.embed.video#view") {
    const thumb = embed.thumbnail;
    return typeof thumb === "string" && thumb.length > 0 ? thumb : null;
  }
  if (
    embed.$type === "app.bsky.embed.recordWithMedia#view" &&
    embed.media?.$type === "app.bsky.embed.video#view"
  ) {
    const thumb = embed.media.thumbnail;
    return typeof thumb === "string" && thumb.length > 0 ? thumb : null;
  }
  return null;
}

function extractExternalThumb(p: AppViewPostView): string | null {
  const embed = p.embed;
  if (!embed) return null;
  if (embed.$type === "app.bsky.embed.external#view") {
    const thumb = embed.external?.thumb;
    return typeof thumb === "string" && thumb.length > 0 ? thumb : null;
  }
  if (
    embed.$type === "app.bsky.embed.recordWithMedia#view" &&
    embed.media?.$type === "app.bsky.embed.external#view"
  ) {
    const thumb = embed.media.external?.thumb;
    return typeof thumb === "string" && thumb.length > 0 ? thumb : null;
  }
  return null;
}

/**
 * Fetch labels + image URLs for a set of post URIs from the public Bluesky
 * AppView. Asks the AppView to merge in labels from the official moderation
 * labeler. Same call returns `embed.images[].thumb` URLs for image posts.
 *
 * The AppView caps `app.bsky.feed.getPosts` at 25 URIs per call, so we batch
 * and fan out in parallel. Returns a `uri → {labels, imageUrls}` map.
 *
 * Fail-soft: any HTTP error returns an empty entry for that batch — callers
 * treat missing entries as "no labels / no images known."
 */
async function fetchAppViewMeta(
  uris: string[],
  labelerDids: string[] = [OFFICIAL_LABELER_DID]
): Promise<Map<string, AppViewMeta>> {
  const out = new Map<string, AppViewMeta>();
  if (uris.length === 0) return out;

  const batches: string[][] = [];
  for (let i = 0; i < uris.length; i += GET_POSTS_BATCH) {
    batches.push(uris.slice(i, i + GET_POSTS_BATCH));
  }

  const acceptHeader = labelerDids.join(",");
  const results = await Promise.all(
    batches.map(async (batch) => {
      const params = new URLSearchParams();
      for (const uri of batch) params.append("uris", uri);
      const url = `${APPVIEW_HOST}/xrpc/app.bsky.feed.getPosts?${params}`;
      try {
        const res = await fetch(url, {
          headers: { "atproto-accept-labelers": acceptHeader },
        });
        if (!res.ok) {
          console.warn(
            `[vector-search] AppView getPosts ${res.status} (batch of ${batch.length})`
          );
          return [] as AppViewPostView[];
        }
        const json = (await res.json()) as { posts?: AppViewPostView[] };
        return json.posts ?? [];
      } catch (e) {
        console.warn("[vector-search] AppView getPosts failed:", e);
        return [] as AppViewPostView[];
      }
    })
  );

  for (const posts of results) {
    for (const p of posts) {
      out.set(p.uri, {
        labels: (p.labels ?? []).map((l) => l.val),
        imageUrls: extractImageUrls(p),
        externalThumb: extractExternalThumb(p),
        videoThumbnail: extractVideoThumbnail(p),
      });
    }
  }
  return out;
}

/**
 * Fetch author descriptions from the public Bluesky AppView. Batches DIDs
 * into groups of 25 (the `app.bsky.actor.getProfiles` cap) and fans out in
 * parallel. Returns a `did → description` map. Authors that don't come back
 * (deleted, suspended, takedown) are simply absent from the result.
 *
 * Fail-soft: any HTTP error on a batch leaves those authors out of the map —
 * the caller treats "no description known" as "don't flag."
 */
async function fetchAuthorDescriptions(
  dids: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (dids.length === 0) return out;

  const batches: string[][] = [];
  for (let i = 0; i < dids.length; i += GET_PROFILES_BATCH) {
    batches.push(dids.slice(i, i + GET_PROFILES_BATCH));
  }

  const results = await Promise.all(
    batches.map(async (batch) => {
      const params = new URLSearchParams();
      for (const did of batch) params.append("actors", did);
      const url = `${APPVIEW_HOST}/xrpc/app.bsky.actor.getProfiles?${params}`;
      try {
        const res = await fetch(url);
        if (!res.ok) {
          console.warn(
            `[vector-search] AppView getProfiles ${res.status} (batch of ${batch.length})`
          );
          return [] as Array<{ did: string; description?: string }>;
        }
        const json = (await res.json()) as {
          profiles?: Array<{ did: string; description?: string }>;
        };
        return json.profiles ?? [];
      } catch (e) {
        console.warn("[vector-search] AppView getProfiles failed:", e);
        return [] as Array<{ did: string; description?: string }>;
      }
    })
  );

  for (const profiles of results) {
    for (const p of profiles) {
      if (typeof p.description === "string" && p.description.length > 0) {
        out.set(p.did, p.description);
      }
    }
  }
  return out;
}

// Case-insensitive substring scan against LIKE_NSFW_DESCRIPTION_KEYWORDS.
// Returns true if any keyword appears in the description.
function descriptionLooksNsfw(description: string | null | undefined): boolean {
  if (!description) return false;
  const lower = description.toLowerCase();
  for (const k of LIKE_NSFW_DESCRIPTION_KEYWORDS) {
    if (lower.includes(k.toLowerCase())) return true;
  }
  return false;
}

export interface SearchOpts {
  subqueries: string[];
  totalBudget: number;
  filter?: SearchFilter;
  // When true, always hit the AppView (even if block_labels is empty) and
  // populate `hit.image_urls` from the response. Set by callers that intend
  // to pass images into the reranker.
  withImages?: boolean;
}

/**
 * Multi-subquery vector search.
 *
 * For each subquery, runs a parallel embed + SQL KNN with
 * `k = floor(totalBudget / subqueries.length)`. Unions the results by URI
 * (keeping max vector_score), applies the NSFW label gate. The reranker is
 * not invoked here.
 */
export async function searchPosts(opts: SearchOpts): Promise<VectorHit[]> {
  const subqueries = opts.subqueries.map((s) => s.trim()).filter(Boolean);
  if (subqueries.length === 0) return [];
  const totalBudget = Math.max(1, opts.totalBudget);
  const perQueryK = Math.max(1, Math.floor(totalBudget / subqueries.length));
  const t0 = performance.now();

  // Parallel embed + KNN per subquery. Rows come back fully hydrated.
  const perQueryResults = await Promise.all(
    subqueries.map((q) => embedAndKnn(q, perQueryK, opts.filter))
  );
  const tKnn = performance.now();

  // Union + dedup by URI, keeping the max vector_score across subqueries.
  // Insertion order on the Map preserves the first occurrence's position,
  // which gives a stable downstream ordering even before any reranker runs.
  const byUri = new Map<string, PgRow>();
  for (const list of perQueryResults) {
    for (const row of list) {
      const prev = byUri.get(row.uri);
      if (prev === undefined || row.vector_score > prev.vector_score) {
        byUri.set(row.uri, row);
      }
    }
  }
  const hits = Array.from(byUri.values()).map(rowToHit);
  const uris = hits.map((h) => h.uri);

  // AppView meta (labels + image URLs) + author profiles (descriptions for
  // the NSFW heuristic) + incomplete-author backfill in parallel. Each
  // AppView call is gated on whether the caller actually needs it.
  const blockLabels = opts.filter?.selfLabelsDeny ?? [];
  const blockSet = new Set(blockLabels);
  const wantLabels = blockLabels.length > 0;
  const wantImages = opts.withImages === true;
  const wantExternalThumbs = hits.some(
    (h) => h.has_external_link || !!h.external_uri
  );
  const wantAppView = wantLabels || wantImages || wantExternalThumbs;
  const wantProfiles = opts.filter?.excludeLikelyNsfw === true;

  const authorDids = wantProfiles ? uniqueAuthorDids(hits) : [];

  const [appViewMeta, authorDescriptions] = await Promise.all([
    wantAppView
      ? fetchAppViewMeta(uris)
      : Promise.resolve(null as Map<string, AppViewMeta> | null),
    wantProfiles
      ? fetchAuthorDescriptions(authorDids)
      : Promise.resolve(null as Map<string, string> | null),
    backfillIncompleteAuthors(hits),
  ]);
  const tParallel = performance.now();

  // Attach AppView media to hits (in place).
  if (appViewMeta) {
    for (const h of hits) {
      const meta = appViewMeta.get(h.uri);
      if (!meta) continue;
      if (wantImages && meta.imageUrls.length > 0) h.image_urls = meta.imageUrls;
      if (meta.externalThumb) h.external_thumb = meta.externalThumb;
      if (meta.videoThumbnail) h.video_thumbnail = meta.videoThumbnail;
    }
  }

  // Mark like_nsfw on hits whose author description matches a keyword.
  // We do this before filtering so the field is always populated when a
  // profile fetch happened.
  if (authorDescriptions) {
    for (const h of hits) {
      const desc = authorDescriptions.get(h.did);
      if (desc && descriptionLooksNsfw(desc)) h.like_nsfw = true;
    }
  }

  let filteredHits = hits;
  let labelerRemoved = 0;
  if (wantLabels && appViewMeta) {
    filteredHits = filteredHits.filter((h) => {
      const meta = appViewMeta.get(h.uri);
      const labels = meta?.labels ?? [];
      if (labels.length === 0) return true;
      const hit = labels.some((l) => blockSet.has(l));
      if (hit) labelerRemoved++;
      return !hit;
    });
  }

  let nsfwRemoved = 0;
  if (opts.filter?.excludeLikelyNsfw) {
    const before = filteredHits.length;
    filteredHits = filteredHits.filter((h) => !h.like_nsfw);
    nsfwRemoved = before - filteredHits.length;
  }

  console.log(
    `[timing] searchPosts subqueries=${subqueries.length} perK=${perQueryK} ` +
      `knn=${(tKnn - t0).toFixed(0)}ms ` +
      `appview=${(tParallel - tKnn).toFixed(0)}ms ` +
      `total=${(tParallel - t0).toFixed(0)}ms ` +
      `union=${uris.length} hits=${hits.length}` +
      (wantLabels ? ` labeler-filtered=${labelerRemoved}` : "") +
      (wantProfiles ? ` profiles=${authorDescriptions?.size ?? 0}/${authorDids.length}` : "") +
      (wantProfiles ? ` like_nsfw-filtered=${nsfwRemoved}` : "")
  );
  return filteredHits;
}

function uniqueAuthorDids(hits: VectorHit[]): string[] {
  const seen = new Set<string>();
  for (const h of hits) seen.add(h.did);
  return Array.from(seen);
}

/**
 * Convert an AT-Protocol post URI to its public bsky.app URL.
 */
export function blueskyUrl(uri: string): string | null {
  const m = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
  if (!m) return null;
  return `https://bsky.app/profile/${m[1]}/post/${m[2]}`;
}
