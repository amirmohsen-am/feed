/**
 * Direct Vertex AI Vector Search client.
 *
 * Embeds the query with Gemini (`gemini-embedding-001`, 768d, RETRIEVAL_QUERY)
 * then calls MatchServiceClient.findNeighbors against the Vertex Vector Search
 * index in `timelines-492720`. Post text + metadata are stored as datapoint
 * restricts by the jetstream-indexer worker, so a single round-trip returns
 * hydrated posts.
 *
 * The runtime needs ADC with `roles/aiplatform.user` on this project. On
 * Cloud Run, the default compute SA already has it.
 */

import { v1 } from "@google-cloud/aiplatform";
import { GoogleGenAI } from "@google/genai";

const { MatchServiceClient } = v1;

// Public resource IDs (not secrets). Overridable via env for local-dev / staging.
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
  has_images: boolean;
  has_video: boolean;
  has_quote: boolean;
  has_external_link: boolean;
  domains: string[];
  lang: string | null;
}

export interface SearchFilter {
  lang?: string[];
  hasImages?: boolean;
  hasVideo?: boolean;
  hasQuote?: boolean;
  hasExternalLink?: boolean;
  didExclude?: string[];
}

async function embedQuery(query: string): Promise<number[]> {
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
  return values;
}

function boolToken(b: boolean): string {
  return b ? "true" : "false";
}

function buildQueryRestricts(
  filter?: SearchFilter
): Array<{ namespace: string; allowList?: string[]; denyList?: string[] }> {
  const restricts: Array<{
    namespace: string;
    allowList?: string[];
    denyList?: string[];
  }> = [];
  if (!filter) return restricts;
  if (filter.lang?.length)
    restricts.push({ namespace: "lang", allowList: filter.lang });
  if (filter.didExclude?.length)
    restricts.push({ namespace: "did", denyList: filter.didExclude });
  if (filter.hasImages !== undefined)
    restricts.push({
      namespace: "has_images",
      allowList: [boolToken(filter.hasImages)],
    });
  if (filter.hasVideo !== undefined)
    restricts.push({
      namespace: "has_video",
      allowList: [boolToken(filter.hasVideo)],
    });
  if (filter.hasQuote !== undefined)
    restricts.push({
      namespace: "has_quote",
      allowList: [boolToken(filter.hasQuote)],
    });
  if (filter.hasExternalLink !== undefined)
    restricts.push({
      namespace: "has_external_link",
      allowList: [boolToken(filter.hasExternalLink)],
    });
  return restricts;
}

interface RawRestrict {
  namespace?: string | null;
  allowList?: string[] | null;
}
interface RawNumericRestrict {
  namespace?: string | null;
  valueInt?: string | number | null;
}

function reconstructHit(
  restricts: RawRestrict[],
  numericRestricts: RawNumericRestrict[],
  score: number
): VectorHit | null {
  const get = (ns: string): string[] =>
    restricts
      .filter((r) => r.namespace === ns)
      .flatMap((r) => r.allowList ?? []);
  const first = (ns: string): string | undefined => get(ns)[0];
  const numeric = (ns: string): number | undefined => {
    const r = numericRestricts.find((nr) => nr.namespace === ns);
    if (r?.valueInt === undefined || r?.valueInt === null) return undefined;
    return typeof r.valueInt === "string" ? parseInt(r.valueInt, 10) : r.valueInt;
  };

  const uri = first("uri");
  if (!uri) return null;

  const created_at_us = numeric("created_at_us") ?? 0;
  const created_at = created_at_us
    ? new Date(Math.floor(created_at_us / 1000)).toISOString()
    : "";

  return {
    uri,
    did: first("did") ?? "",
    text: first("text") ?? "",
    created_at,
    vector_score: score,
    has_images: first("has_images") === "true",
    has_video: first("has_video") === "true",
    has_quote: first("has_quote") === "true",
    has_external_link: first("has_external_link") === "true",
    domains: get("domain"),
    lang: first("lang") ?? null,
  };
}

export async function searchPosts(opts: {
  query: string;
  k?: number;
  filter?: SearchFilter;
}): Promise<VectorHit[]> {
  const k = opts.k ?? 25;
  const queryVec = await embedQuery(opts.query);

  const indexEndpoint = `projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/indexEndpoints/${VERTEX_INDEX_ENDPOINT_ID}`;
  const restricts = buildQueryRestricts(opts.filter);

  const [resp] = await matchClient().findNeighbors({
    indexEndpoint,
    deployedIndexId: VERTEX_DEPLOYED_INDEX_ID,
    returnFullDatapoint: true,
    queries: [
      {
        datapoint: {
          featureVector: queryVec,
          restricts,
        },
        neighborCount: k,
      },
    ],
  });

  const neighbors = resp.nearestNeighbors?.[0]?.neighbors ?? [];
  const hits: VectorHit[] = [];
  for (const n of neighbors) {
    const dp = n.datapoint;
    const score = typeof n.distance === "number" ? n.distance : 0;
    const h = reconstructHit(
      (dp?.restricts ?? []) as RawRestrict[],
      (dp?.numericRestricts ?? []) as RawNumericRestrict[],
      score
    );
    if (h) hits.push(h);
  }
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
