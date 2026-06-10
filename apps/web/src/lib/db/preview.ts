import { createHash } from "node:crypto";
import { searchPosts } from "../vector-search";
import { rerank } from "../rerank";
import { query } from "./connection";
import { rowToFeed, type DbFeed } from "./feeds";
import { mechanicalToSearchFilter } from "./filters";

// --- Posts ---
// Posts come from the pgvector (HNSW, halfvec) index on `bsky-db`, fed by the
// jetstream-indexer worker. We embed the feed's subqueries with Gemini and run
// KNN directly — see src/lib/vector-search.ts.

export interface FeedPreviewPost {
  uri: string;
  text: string;
  author_did: string;
  author_handle: string | null;
  author_display_name: string | null;
  author_avatar_cid: string | null;
  score: number;
  // Set when the feed has a rerank prompt and the rerank call succeeded.
  // 0–100, as returned by the LLM. Independent of `score` (cosine similarity).
  rerank_score?: number;
  rerank_reason?: string;
  // Heuristic flag from the author's description (see LIKE_NSFW_DESCRIPTION_KEYWORDS).
  // Hits flagged true are dropped before rerank when exclude_likely_nsfw is on;
  // we still surface the field so the UI debug strip can show it for tuning.
  like_nsfw: boolean;
  indexed_at: string;
  like_count: number;
  repost_count: number;
  reply_count: number;
  quote_count: number;
  external_uri: string | null;
  external_title: string | null;
  external_desc: string | null;
  external_thumb: string | null;
  quote_uri: string | null;
  has_images: boolean;
  image_count: number;
  image_alts: string[];
  image_urls: string[];
  is_reply: boolean;
  reply_parent_uri: string | null;
}

// Pipeline stage names surfaced to the streaming loader. Mirrors the
// frontend's PipelineLoader component states.
//   searching → Vertex ANN + hydrate + AppView meta + author profiles
//   thinking  → request sent to Claude, model processing before any output
//                (TTFT today; would surface real thinking deltas if extended
//                 thinking were enabled on the rerank call)
//   ranking   → model emitting the sorted JSON output token-by-token
//   done      → final posts ready
export type PreviewStage =
  | "searching"
  | "thinking"
  | "ranking"
  | "done"
  // Result served from feed_result_cache — no pipeline ran, so the loader
  // should hide rather than show empty "queued" Thinking/Ranking steps.
  | "cached"
  | "skipped_rerank";

export interface PreviewStageEvent {
  stage: PreviewStage;
  // Set on "thinking" — counts surfaced to the loader sub-line.
  candidates?: number;  // candidates actually sent to the reranker (capped)
  hits?: number;        // total vector-search hits before the cap
  images?: number;
  model?: string;
  thinking_enabled?: boolean;
}

// --- Feed result cache ---
// The preview pipeline is slow + token-costly, so we cache its final post list
// per feed in feed-db (`feed_result_cache`) and reuse it while fresh. See
// DECISIONS.md for the TTL / invalidation rationale.
const FEED_CACHE_TTL = "1 hour"; // Postgres interval literal.

// Stable JSON: object keys sorted recursively so semantically-equal configs
// (keys in a different order) hash identically and don't cause false misses.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

// Digest of only the fields that change search results. Any feed edit that
// touches these → different hash → cache miss → recompute. `limit` is included
// so a slice-size change can't serve a wrongly-sized cached list.
function computeFeedConfigHash(feed: DbFeed, limit: number): string {
  return createHash("sha256")
    .update(
      stableStringify({
        subqueries: feed.subqueries,
        candidate_budget: feed.candidate_budget,
        mechanical_filters: feed.mechanical_filters,
        rerank_prompt: feed.rerank_prompt,
        rerank_model: feed.rerank_model,
        rerank_thinking_enabled: feed.rerank_thinking_enabled,
        limit,
      })
    )
    .digest("hex");
}

export async function getFeedPreviewPosts(
  feedId: number,
  limit: number = 25,
  onStage?: (e: PreviewStageEvent) => void,
  opts?: { forceFresh?: boolean; skipRerank?: boolean }
): Promise<FeedPreviewPost[]> {
  const t0 = performance.now();
  const feedRes = await query("SELECT * FROM feeds WHERE id = $1", [feedId]);
  if (feedRes.rows.length === 0) return [];
  const feed = rowToFeed(feedRes.rows[0]);
  const tFeed = performance.now();

  if (feed.subqueries.length === 0) {
    onStage?.({ stage: "done" });
    return [];
  }

  const configHash = computeFeedConfigHash(feed, limit);

  // Cache read: serve the stored posts when the row is fresh and the config
  // hasn't changed. Refresh (forceFresh) skips this and recomputes below.
  if (!opts?.forceFresh) {
    try {
      const cached = await query(
        `SELECT posts FROM feed_result_cache
         WHERE feed_id = $1 AND config_hash = $2
           AND cached_at > now() - $3::interval`,
        [feedId, configHash, FEED_CACHE_TTL]
      );
      if (cached.rows.length > 0) {
        const posts = cached.rows[0].posts as FeedPreviewPost[];
        onStage?.({ stage: "cached" });
        console.log(
          `[cache] hit feedId=${feedId} posts=${posts.length} ` +
            `feed-lookup=${(tFeed - t0).toFixed(0)}ms ` +
            `total=${(performance.now() - t0).toFixed(0)}ms`
        );
        return posts;
      }
    } catch (e) {
      // A cache read failure must never break the preview — fall through to a
      // live recompute.
      console.warn(
        "[cache] read failed, recomputing:",
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  const filter = mechanicalToSearchFilter(feed.mechanical_filters);
  onStage?.({ stage: "searching" });

  try {
    const willRerank =
      !opts?.skipRerank && feed.rerank_prompt.trim().length > 0;
    const hits = await searchPosts({
      subqueries: feed.subqueries,
      totalBudget: feed.candidate_budget,
      filter,
      withImages: true,
    });
    const tSearch = performance.now();

    // Map of post index → {score, reason} from the reranker, if one ran.
    let rerankByIndex: Map<number, { score: number; reason: string }> | null = null;
    let orderedHits = hits;
    let msRerank = 0;
    let rerankAttempted = false;

    if (!willRerank) {
      onStage?.({ stage: "skipped_rerank" });
    }
    if (willRerank && hits.length > 0) {
      rerankAttempted = true;
      try {
        // The reranker sees every candidate that survived the vector-search
        // pipeline. Per-feed `candidate_budget` (Advanced → N) is the only
        // knob — bump it down if rerank latency is hurting, bump it up to
        // give the reranker a wider net.
        const r = await rerank({
          // Joining subqueries with " | " lets the rerank prompt see all
          // intents at once without needing rewrites.
          query: feed.subqueries.join(" | "),
          candidates: hits,
          topK: limit,
          systemPrompt: feed.rerank_prompt,
          model: feed.rerank_model,
          thinkingEnabled: feed.rerank_thinking_enabled,
          feedId,
          withImages: true,
          onRequestSent: ({ candidates, images, model }) => {
            onStage?.({
              stage: "thinking",
              candidates,
              hits: hits.length,
              images,
              model,
              thinking_enabled: feed.rerank_thinking_enabled,
            });
          },
          onFirstToken: () => {
            onStage?.({ stage: "ranking" });
          },
        });
        msRerank = r.ms_rerank;
        rerankByIndex = new Map();
        orderedHits = [];
        for (const k of r.kept) {
          if (k.i < 0 || k.i >= hits.length) continue;
          rerankByIndex.set(k.i, { score: k.score, reason: k.reason });
          orderedHits.push(hits[k.i]);
        }
      } catch (e) {
        // Reranker failure → fall back to vector order. Surface raw hits
        // rather than fail the whole preview.
        console.warn(
          "[rerank] failed, falling back to vector order:",
          e instanceof Error ? e.message : String(e)
        );
      }
    }

    const sliced = orderedHits.slice(0, limit);
    console.log(
      `[timing] getFeedPreviewPosts feed-lookup=${(tFeed - t0).toFixed(0)}ms ` +
        `searchPosts=${(tSearch - tFeed).toFixed(0)}ms ` +
        (rerankAttempted ? `rerank=${msRerank}ms ` : "") +
        `total=${(performance.now() - t0).toFixed(0)}ms feedId=${feedId} ` +
        `subqueries=${feed.subqueries.length} budget=${feed.candidate_budget} ` +
        `hits=${hits.length} ` +
        (rerankByIndex ? `kept=${rerankByIndex.size} ` : "") +
        `returned=${sliced.length}`
    );
    const result: FeedPreviewPost[] = sliced.map((h) => {
      // Find this hit's original index in the unranked list to look up its
      // reranker fields. orderedHits already maps through r.kept, but we
      // need the original index to read rerankByIndex.
      const origIdx = hits.indexOf(h);
      const rr = rerankByIndex && origIdx >= 0 ? rerankByIndex.get(origIdx) : undefined;
      return {
        uri: h.uri,
        text: h.text,
        author_did: h.did,
        author_handle: h.author_handle,
        author_display_name: h.author_display_name,
        author_avatar_cid: h.author_avatar_cid,
        score: h.vector_score,
        rerank_score: rr?.score,
        rerank_reason: rr?.reason,
        like_nsfw: h.like_nsfw,
        indexed_at: h.created_at,
        like_count: h.like_count ?? 0,
        repost_count: h.repost_count ?? 0,
        reply_count: h.reply_count ?? 0,
        quote_count: h.quote_count ?? 0,
        external_uri: h.external_uri,
        external_title: h.external_title,
        external_desc: h.external_desc,
        external_thumb: h.external_thumb,
        quote_uri: h.quote_uri,
        has_images: h.has_images,
        image_count: h.image_count,
        image_alts: h.image_alts,
        image_urls: h.image_urls,
        is_reply: h.is_reply,
        reply_parent_uri: h.reply_parent_uri,
      };
    });

    // Cache write (best-effort): store the fresh result for the next view.
    // A write failure must never fail the response, so we swallow + log.
    try {
      await query(
        `INSERT INTO feed_result_cache (feed_id, config_hash, posts, cached_at)
         VALUES ($1, $2, $3::jsonb, now())
         ON CONFLICT (feed_id) DO UPDATE SET
           config_hash = EXCLUDED.config_hash,
           posts = EXCLUDED.posts,
           cached_at = now()`,
        [feedId, configHash, JSON.stringify(result)]
      );
    } catch (e) {
      console.warn(
        "[cache] write failed:",
        e instanceof Error ? e.message : String(e)
      );
    }

    return result;
  } catch (e) {
    console.warn(
      "[vector-search] search failed:",
      e instanceof Error ? e.message : String(e)
    );
    return [];
  }
}

// --- Public feed skeleton (xrpc) ---
// Posts for the public feed skeleton xrpc (uses preview pipeline + cache).
const SKELETON_STOCK_LIMIT = 100;

async function readAnyFeedCachePosts(
  feedId: number
): Promise<FeedPreviewPost[] | null> {
  try {
    const res = await query(
      `SELECT posts FROM feed_result_cache WHERE feed_id = $1 LIMIT 1`,
      [feedId]
    );
    if (res.rows.length === 0) return null;
    const posts = res.rows[0].posts as FeedPreviewPost[];
    return Array.isArray(posts) && posts.length > 0 ? posts : null;
  } catch {
    return null;
  }
}

function paginateSkeletonPosts(
  posts: FeedPreviewPost[],
  limit: number,
  cursor?: string
): { uri: string; indexed_at: string }[] {
  let filtered = posts;
  if (cursor) {
    filtered = posts.filter((p) => p.indexed_at < cursor);
  }
  return filtered.slice(0, limit).map((p) => ({
    uri: p.uri,
    indexed_at: p.indexed_at,
  }));
}

export async function getFeedSkeletonPosts(
  feedId: number,
  limit: number,
  cursor?: string
): Promise<{ uri: string; indexed_at: string }[]> {
  const t0 = performance.now();

  // Bluesky times out around ~3s. Serve any cached posts immediately — even
  // if the curator warmed a different limit/hash — rather than blocking on
  // vector search + rerank.
  const cached = await readAnyFeedCachePosts(feedId);
  if (cached) {
    console.log(
      `[skeleton] cache hit feedId=${feedId} posts=${cached.length} ` +
        `total=${(performance.now() - t0).toFixed(0)}ms`
    );
    return paginateSkeletonPosts(cached, limit, cursor);
  }

  // Cold path: vector order only (no LLM rerank) to stay within Bluesky's timeout.
  const posts = await getFeedPreviewPosts(
    feedId,
    SKELETON_STOCK_LIMIT,
    undefined,
    { skipRerank: true }
  );
  console.log(
    `[skeleton] cold compute feedId=${feedId} posts=${posts.length} ` +
      `total=${(performance.now() - t0).toFixed(0)}ms`
  );
  return paginateSkeletonPosts(posts, limit, cursor);
}

/**
 * Full post objects for the public share page (/f/[feedId]). Serves whatever
 * is cached; cold path mirrors the skeleton xrpc (vector order, no LLM rerank)
 * so an anonymous visit can't burn rerank tokens.
 */
export async function getSharedFeedPosts(
  feedId: number,
  limit = 30
): Promise<FeedPreviewPost[]> {
  const cached = await readAnyFeedCachePosts(feedId);
  if (cached) return cached.slice(0, limit);
  return getFeedPreviewPosts(feedId, limit, undefined, { skipRerank: true });
}

/** Pre-warm skeleton cache after publish so Bluesky's first fetch succeeds. */
export async function warmFeedSkeletonCache(feedId: number): Promise<number> {
  const posts = await getFeedPreviewPosts(
    feedId,
    SKELETON_STOCK_LIMIT,
    undefined,
    { skipRerank: true }
  );
  return posts.length;
}
