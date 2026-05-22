/**
 * Vector Search → Postgres hydration.
 *
 * Multi-query design (curator redesign):
 * 1. For each subquery, embed with Gemini (`gemini-embedding-001`, 768d,
 *    RETRIEVAL_QUERY) and call Vertex `findNeighbors` with k = floor(N / M).
 * 2. Union the result URIs across subqueries, deduping on URI and keeping
 *    the max raw similarity score.
 * 3. Rescale raw cosine similarity from [-1, 1] to [0, 1] via (x + 1) / 2.
 * 4. Hydrate the union from Postgres (bsky.posts ⨝ authors ⨝ post_engagement).
 * 5. AppView label gate (NSFW deny-list).
 *
 * Post text + display fields live in `bsky.posts`; the vector index carries
 * only filter restricts. The runtime needs ADC with `roles/aiplatform.user`
 * + `roles/secretmanager.secretAccessor` on `bsky-database-url`.
 */

import { v1 } from "@google-cloud/aiplatform";
import { GoogleGenAI } from "@google/genai";
import { bskyQuery } from "./bsky-pg";
import { LIKE_NSFW_DESCRIPTION_KEYWORDS } from "./defaults";
import { onAdcChange } from "./adc-watcher";

const { MatchServiceClient } = v1;

const VERTEX_PROJECT = process.env.VERTEX_PROJECT ?? "timelines-492720";
const VERTEX_LOCATION = process.env.VERTEX_LOCATION ?? "us-central1";
const VERTEX_INDEX_ENDPOINT_ID =
  process.env.VERTEX_INDEX_ENDPOINT_ID ?? "5941683870687559680";
const VERTEX_INDEX_ENDPOINT_HOST =
  process.env.VERTEX_INDEX_ENDPOINT_HOST ??
  "1238902659.us-central1-777152549518.vdb.vertexai.goog";
const VERTEX_DEPLOYED_INDEX_ID =
  process.env.VERTEX_DEPLOYED_INDEX_ID ?? "happy_feed_v2";

const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMENSION = 768;

// AppView host + the official Bluesky moderation labeler. We ask the AppView
// to attach this labeler's labels onto getPosts responses so we can drop
// labeler-applied NSFW that wasn't self-labeled by the author.
const APPVIEW_HOST = process.env.BLUESKY_APPVIEW_HOST ?? "https://public.api.bsky.app";
const OFFICIAL_LABELER_DID = "did:plc:ar7c4by46qjdydhdevvrndac";
const GET_POSTS_BATCH = 25; // app.bsky.feed.getPosts caps at 25 URIs per call
const GET_PROFILES_BATCH = 25; // app.bsky.actor.getProfiles caps at 25 actors per call

let _matchClient: InstanceType<typeof MatchServiceClient> | null = null;
function matchClient() {
  if (!_matchClient) {
    _matchClient = new MatchServiceClient({
      apiEndpoint: VERTEX_INDEX_ENDPOINT_HOST,
    });
  }
  return _matchClient;
}

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
  const had = _matchClient !== null || _genai !== null;
  _matchClient = null;
  _genai = null;
  if (had) console.log("[vector-search] Vertex / Gemini clients reset after ADC change");
});

export interface VectorHit {
  uri: string;
  did: string;
  text: string;
  created_at: string;
  // Rescaled cosine similarity in [0, 1]. The raw dot product from Vertex sits
  // in [-1, 1] for L2-normalized Gemini vectors; we apply (x + 1) / 2 here so
  // downstream callers don't have to know about the dot-product convention.
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
  // LIKE_NSFW_DESCRIPTION_KEYWORDS. Computed by hydrateFromPostgres; always
  // populated (boolean, never undefined).
  like_nsfw: boolean;

  // CDN URLs for the post's images, pulled from the AppView via
  // app.bsky.feed.getPosts. Empty if the post has no images, or if the
  // AppView fetch was not enabled for this search. The reranker uses these
  // when the feed has a rerank prompt configured.
  image_urls: string[];
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
  // Drop hits where hit.like_nsfw === true. Computed after hydration, so
  // it applies only to the union (not the Vertex pre-filter).
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

async function embedQuery(query: string): Promise<number[]> {
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

const boolToken = (b: boolean): string => (b ? "true" : "false");

function buildQueryRestricts(filter?: SearchFilter): Array<{
  namespace: string;
  allowList?: string[];
  denyList?: string[];
}> {
  const out: Array<{ namespace: string; allowList?: string[]; denyList?: string[] }> = [];
  if (!filter) return out;
  if (filter.lang?.length) out.push({ namespace: "langs", allowList: filter.lang });
  if (filter.didExclude?.length) out.push({ namespace: "did", denyList: filter.didExclude });
  if (filter.hasImages !== undefined) out.push({ namespace: "has_images", allowList: [boolToken(filter.hasImages)] });
  if (filter.hasVideo !== undefined) out.push({ namespace: "has_video", allowList: [boolToken(filter.hasVideo)] });
  if (filter.hasQuote !== undefined) out.push({ namespace: "has_quote", allowList: [boolToken(filter.hasQuote)] });
  if (filter.hasExternalLink !== undefined) out.push({ namespace: "has_external_link", allowList: [boolToken(filter.hasExternalLink)] });
  if (filter.isReply !== undefined) out.push({ namespace: "is_reply", allowList: [boolToken(filter.isReply)] });
  if (filter.hashtags?.length) out.push({ namespace: "hashtags", allowList: filter.hashtags.map((t) => t.toLowerCase()) });
  if (filter.selfLabelsDeny?.length) out.push({ namespace: "self_labels", denyList: filter.selfLabelsDeny });
  return out;
}

type NumericRestrict = {
  namespace: string;
  valueInt?: string;
  op?: "GREATER_EQUAL" | "GREATER" | "LESS" | "LESS_EQUAL" | "EQUAL" | "NOT_EQUAL";
};

function buildNumericQueryRestricts(filter?: SearchFilter): NumericRestrict[] {
  // schema_v >= 2 hides old-shape datapoints left over in the index from the
  // pre-migration indexer (those points have no schema_v namespace so they
  // don't satisfy the filter).
  const out: NumericRestrict[] = [
    { namespace: "schema_v", valueInt: "2", op: "GREATER_EQUAL" },
  ];
  if (!filter) return out;
  if (filter.minLikeCount !== undefined) out.push({ namespace: "like_count", valueInt: String(filter.minLikeCount), op: "GREATER_EQUAL" });
  if (filter.minRepostCount !== undefined) out.push({ namespace: "repost_count", valueInt: String(filter.minRepostCount), op: "GREATER_EQUAL" });
  if (filter.minReplyCount !== undefined) out.push({ namespace: "reply_count", valueInt: String(filter.minReplyCount), op: "GREATER_EQUAL" });
  if (filter.createdAfterUs !== undefined) out.push({ namespace: "created_at_us", valueInt: String(filter.createdAfterUs), op: "GREATER_EQUAL" });
  if (filter.createdBeforeUs !== undefined) out.push({ namespace: "created_at_us", valueInt: String(filter.createdBeforeUs), op: "LESS_EQUAL" });
  return out;
}

interface RawRestrict {
  namespace?: string | null;
  allowList?: string[] | null;
}

interface PgRow {
  uri: string;
  did: string;
  text: string;
  created_at: Date;
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

async function hydrateFromPostgres(
  uris: string[],
  scoreByUri: Map<string, number>
): Promise<VectorHit[]> {
  if (uris.length === 0) return [];
  const res = await bskyQuery<PgRow>(
    `SELECT
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
       a.avatar_cid   AS author_avatar_cid
     FROM bsky.posts p
     LEFT JOIN bsky.post_engagement pe ON pe.uri = p.uri
     LEFT JOIN bsky.authors a          ON a.did = p.did
     WHERE p.uri = ANY($1::text[])`,
    [uris]
  );

  const byUri = new Map<string, PgRow>();
  for (const row of res.rows) byUri.set(row.uri, row);

  const hits: VectorHit[] = [];
  // Preserve the input ordering (which carries the union-merge order from
  // multi-query); the reranker (when enabled) will re-order anyway.
  for (const uri of uris) {
    const r = byUri.get(uri);
    if (!r) continue;
    hits.push({
      uri: r.uri,
      did: r.did,
      text: r.text,
      created_at: r.created_at.toISOString(),
      vector_score: scoreByUri.get(uri) ?? 0,
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
    });
  }
  return hits;
}

interface AppViewMeta {
  labels: string[];
  imageUrls: string[];
}

interface AppViewPostView {
  uri: string;
  labels?: Array<{ val: string }>;
  embed?: {
    $type?: string;
    images?: Array<{ thumb?: string; fullsize?: string }>;
    // recordWithMedia nests the media one level deeper.
    media?: {
      $type?: string;
      images?: Array<{ thumb?: string; fullsize?: string }>;
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

/**
 * Embed one subquery and call Vertex findNeighbors. Returns the neighbor list
 * with raw similarity scores (dot product in [-1, 1] for L2-normalized vectors).
 */
async function embedAndFindNeighbors(
  query: string,
  k: number,
  filter?: SearchFilter
): Promise<Array<{ uri: string; rawScore: number }>> {
  const queryVec = await embedQuery(query);
  const indexEndpoint = `projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/indexEndpoints/${VERTEX_INDEX_ENDPOINT_ID}`;
  const restricts = buildQueryRestricts(filter);
  const numericRestricts = buildNumericQueryRestricts(filter);

  const findRes = await matchClient().findNeighbors({
    indexEndpoint,
    deployedIndexId: VERTEX_DEPLOYED_INDEX_ID,
    returnFullDatapoint: true,
    queries: [
      {
        datapoint: {
          featureVector: queryVec,
          restricts,
          numericRestricts,
        },
        neighborCount: k,
      },
    ],
  });
  const resp = Array.isArray(findRes) ? findRes[0] : findRes;
  const neighbors = resp.nearestNeighbors?.[0]?.neighbors ?? [];

  const out: Array<{ uri: string; rawScore: number }> = [];
  for (const n of neighbors) {
    const dp = n.datapoint;
    const restrictsList = (dp?.restricts ?? []) as RawRestrict[];
    const uri = restrictsList.find((r) => r.namespace === "uri")?.allowList?.[0];
    if (!uri) continue;
    const rawScore = typeof n.distance === "number" ? n.distance : 0;
    out.push({ uri, rawScore });
  }
  return out;
}

// Cosine similarity (returned by Vertex for L2-normalized Gemini vectors on a
// DOT_PRODUCT_DISTANCE index) lives in [-1, 1]. Rescale to [0, 1] so the UI
// can read "higher = better" without doing the math itself.
function rescaleSimilarity(raw: number): number {
  const x = (raw + 1) / 2;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
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
 * For each subquery, runs a parallel embed + Vertex ANN call with
 * `k = floor(totalBudget / subqueries.length)`. Unions the results by URI
 * (keeping max raw similarity), hydrates the union from Postgres, applies
 * the NSFW label gate. The reranker is not invoked here.
 */
export async function searchPosts(opts: SearchOpts): Promise<VectorHit[]> {
  const subqueries = opts.subqueries.map((s) => s.trim()).filter(Boolean);
  if (subqueries.length === 0) return [];
  const totalBudget = Math.max(1, opts.totalBudget);
  const perQueryK = Math.max(1, Math.floor(totalBudget / subqueries.length));
  const t0 = performance.now();

  // Parallel embed + findNeighbors per subquery.
  const perQueryResults = await Promise.all(
    subqueries.map((q) => embedAndFindNeighbors(q, perQueryK, opts.filter))
  );
  const tFind = performance.now();

  // Union + dedup by URI, keeping the max raw similarity across subqueries.
  // Insertion order on the Map preserves the first occurrence's position,
  // which gives a stable downstream ordering even before any reranker runs.
  const rawByUri = new Map<string, number>();
  for (const list of perQueryResults) {
    for (const { uri, rawScore } of list) {
      const prev = rawByUri.get(uri);
      if (prev === undefined || rawScore > prev) rawByUri.set(uri, rawScore);
    }
  }
  const uris = Array.from(rawByUri.keys());
  const scoreByUri = new Map<string, number>();
  for (const [uri, raw] of rawByUri) scoreByUri.set(uri, rescaleSimilarity(raw));

  // Hydrate from Postgres AND fetch AppView meta (labels + image URLs) AND
  // fetch author profiles (descriptions for the NSFW heuristic) in parallel.
  // Each AppView call is gated on whether the caller actually needs it.
  const blockLabels = opts.filter?.selfLabelsDeny ?? [];
  const blockSet = new Set(blockLabels);
  const wantLabels = blockLabels.length > 0;
  const wantImages = opts.withImages === true;
  const wantAppView = wantLabels || wantImages;
  const wantProfiles = opts.filter?.excludeLikelyNsfw === true;

  // Extract author DIDs from URIs without waiting for hydration: the AT URI
  // already carries `did:plc:xxx` between `at://` and the next `/`.
  const authorDids = wantProfiles ? uniqueAuthorDidsFromUris(uris) : [];

  const [hits, appViewMeta, authorDescriptions] = await Promise.all([
    hydrateFromPostgres(uris, scoreByUri),
    wantAppView
      ? fetchAppViewMeta(uris)
      : Promise.resolve(null as Map<string, AppViewMeta> | null),
    wantProfiles
      ? fetchAuthorDescriptions(authorDids)
      : Promise.resolve(null as Map<string, string> | null),
  ]);
  const tParallel = performance.now();

  // Attach image URLs to hits (in place). image_urls is otherwise [].
  if (wantImages && appViewMeta) {
    for (const h of hits) {
      const meta = appViewMeta.get(h.uri);
      if (meta && meta.imageUrls.length > 0) h.image_urls = meta.imageUrls;
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
      `find=${(tFind - t0).toFixed(0)}ms ` +
      `hydrate+appview=${(tParallel - tFind).toFixed(0)}ms ` +
      `total=${(tParallel - t0).toFixed(0)}ms ` +
      `union=${uris.length} hits=${hits.length}` +
      (wantLabels ? ` labeler-filtered=${labelerRemoved}` : "") +
      (wantProfiles ? ` profiles=${authorDescriptions?.size ?? 0}/${authorDids.length}` : "") +
      (wantProfiles ? ` like_nsfw-filtered=${nsfwRemoved}` : "")
  );
  return filteredHits;
}

function uniqueAuthorDidsFromUris(uris: string[]): string[] {
  const seen = new Set<string>();
  for (const uri of uris) {
    const m = uri.match(/^at:\/\/([^/]+)\//);
    if (m) seen.add(m[1]);
  }
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
