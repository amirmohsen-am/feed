/**
 * Vector Search → Postgres hydration.
 *
 * 1. Embed the query with Gemini (`gemini-embedding-001`, 768d, RETRIEVAL_QUERY).
 * 2. findNeighbors against Vertex AI Vector Search — returns vector scores +
 *    restricts (including `uri`).
 * 3. Hydrate the full post from Postgres (`bsky.posts` LEFT JOIN `bsky.authors`
 *    LEFT JOIN `bsky.post_engagement`) in a single batched query.
 *
 * Post text + display fields live in `bsky.posts`; the vector index carries
 * only filter restricts. The runtime needs ADC with `roles/aiplatform.user`
 * + `roles/secretmanager.secretAccessor` on `bsky-database-url`.
 */

import { v1 } from "@google-cloud/aiplatform";
import { GoogleGenAI } from "@google/genai";
import { bskyQuery } from "./bsky-pg";

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

export interface VectorHit {
  uri: string;
  did: string;
  text: string;
  created_at: string;
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
  minLikeCount?: number;
  minRepostCount?: number;
  createdAfterUs?: number;
}

// In-memory LRU cache for query embeddings. The embedding is a pure function
// of the query text, which itself is a deterministic projection of the feed's
// semantic_config — so it only changes when the user edits the feed. Keyed by
// raw query text; evicts FIFO when over capacity. Process-local; does not
// survive restarts or scale-out (acceptable for the demo; persist on the feed
// row when we need cross-instance durability).
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
  if (filter.createdAfterUs !== undefined) out.push({ namespace: "created_at_us", valueInt: String(filter.createdAfterUs), op: "GREATER_EQUAL" });
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
  // Preserve Vertex ordering — iterate uris, not res.rows.
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
    });
  }
  return hits;
}

export async function searchPosts(opts: {
  query: string;
  k?: number;
  filter?: SearchFilter;
}): Promise<VectorHit[]> {
  const k = opts.k ?? 25;
  const t0 = performance.now();
  const embedCached = embedCache.has(opts.query);
  const queryVec = await embedQuery(opts.query);
  const tEmbed = performance.now();

  const indexEndpoint = `projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/indexEndpoints/${VERTEX_INDEX_ENDPOINT_ID}`;
  const restricts = buildQueryRestricts(opts.filter);
  const numericRestricts = buildNumericQueryRestricts(opts.filter);

  const findRes = await matchClient().findNeighbors({
    indexEndpoint,
    deployedIndexId: VERTEX_DEPLOYED_INDEX_ID,
    // True so the response carries the `uri` restrict — we need it to JOIN to
    // bsky.posts. With `false`, neighbors come back as opaque datapoint IDs.
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
  const tFind = performance.now();
  const resp = Array.isArray(findRes) ? findRes[0] : findRes;

  const neighbors = resp.nearestNeighbors?.[0]?.neighbors ?? [];
  const uris: string[] = [];
  const scoreByUri = new Map<string, number>();
  for (const n of neighbors) {
    // We didn't ask for full datapoint, but Vertex returns id + restricts on
    // findNeighbors anyway. Look for the uri restrict; fall back to id if absent.
    const dp = n.datapoint;
    const restrictsList = (dp?.restricts ?? []) as RawRestrict[];
    const uri = restrictsList.find((r) => r.namespace === "uri")?.allowList?.[0];
    if (!uri) continue;
    const score = typeof n.distance === "number" ? n.distance : 0;
    uris.push(uri);
    scoreByUri.set(uri, score);
  }

  const hits = await hydrateFromPostgres(uris, scoreByUri);
  const tHydrate = performance.now();
  console.log(
    `[timing] searchPosts embed=${(tEmbed - t0).toFixed(0)}ms${embedCached ? "(cached)" : ""} ` +
      `findNeighbors=${(tFind - tEmbed).toFixed(0)}ms ` +
      `pg-hydrate=${(tHydrate - tFind).toFixed(0)}ms ` +
      `total=${(tHydrate - t0).toFixed(0)}ms ` +
      `neighbors=${neighbors.length} hits=${hits.length}`
  );
  return hits;
}

/**
 * Convert an AT-Protocol post URI to its public bsky.app URL.
 */
export function blueskyUrl(uri: string): string | null {
  const m = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
  if (!m) return null;
  return `https://bsky.app/profile/${m[1]}/post/${m[2]}`;
}
