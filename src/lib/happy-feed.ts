/**
 * Client for the happy-feed search service.
 *
 * happy-feed is a separate Bun/Express service that ingests Bluesky's Jetstream
 * into a Vertex AI Vector Search index using Gemini embeddings (gemini-embedding-001,
 * 768-d). When the user views a feed in the curator, we embed their feed config
 * as a query and ask happy-feed for matching posts via /query/search.
 *
 * Source: /Users/amir/code/happy-feed
 * Default URL: http://localhost:8787 (set with PORT=8787 bun run start)
 */

const DEFAULT_URL = "http://localhost:8787";

export interface HappyFeedHit {
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

export interface HappyFeedFilter {
  lang?: string[];
  has_images?: boolean;
  has_video?: boolean;
  has_quote?: boolean;
  has_external_link?: boolean;
}

export interface SearchResult {
  hits: HappyFeedHit[];
  ms: number;
  query_id?: string;
}

function baseUrl(): string {
  return process.env.HAPPY_FEED_URL || DEFAULT_URL;
}

/**
 * POST /query/search — embed query + vector search.
 * Throws on network/HTTP error so the caller can decide how to surface it.
 */
export async function searchFeed(opts: {
  query: string;
  k?: number;
  filter?: HappyFeedFilter;
}): Promise<SearchResult> {
  const res = await fetch(`${baseUrl()}/query/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: opts.query,
      k: opts.k ?? 25,
      ...(opts.filter ? { filter: opts.filter } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`happy-feed /query/search ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as SearchResult;
}

/**
 * Convert an AT-Protocol post URI to its public bsky.app URL.
 * Returns null for malformed URIs.
 */
export function blueskyUrl(uri: string): string | null {
  const m = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
  if (!m) return null;
  return `https://bsky.app/profile/${m[1]}/post/${m[2]}`;
}
