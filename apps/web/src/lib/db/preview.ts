import { createHash } from "node:crypto";
import { searchPosts } from "../vector-search";
import { rerank, type RerankCandidate } from "../rerank";
import { DEFAULT_RERANK_PROMPT } from "../defaults";
import { query } from "./connection";
import { rowToFeed, type DbFeed } from "./feeds";
import { mechanicalToSearchFilter } from "./filters";
import { blendedScore } from "./blend";
import { filterUnseen, recordSeen } from "./seen";
import { getUserById } from "./users";

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
  has_video: boolean;
  image_count: number;
  image_alts: string[];
  image_urls: string[];
  video_thumbnail: string | null;
  video_playlist: string | null;
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
const FEED_CACHE_TTL = "24 hours"; // Postgres interval literal.

// Snapshot depth: every compute stores this many reranked + blended posts as
// the feed's canonical snapshot. The curator preview shows the first 25; the
// skeleton xrpc paginates the full list (Bluesky app pages 30 at a time). Also
// the `N` the reranker is told to return, so it directly bounds rerank output
// (and latency). 50 keeps modest serve-time seen-filtering headroom while
// roughly halving the kept-item count the model has to emit vs 100.
export const SNAPSHOT_LIMIT = 50;

/**
 * The Anthropic rerank call failed. Callers must not substitute vector-order
 * results: the curator preview surfaces the error, the skeleton serves an
 * empty page, and nothing is cached — the next request retries.
 */
class RerankUnavailableError extends Error {}

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
// touches these → different hash → cache miss → recompute. The snapshot depth
// is fixed (SNAPSHOT_LIMIT), so the caller's slice size doesn't participate.
function computeFeedConfigHash(feed: DbFeed): string {
  return createHash("sha256")
    .update(
      stableStringify({
        subqueries: feed.subqueries,
        candidate_budget: feed.candidate_budget,
        mechanical_filters: feed.mechanical_filters,
        rerank_prompt: feed.rerank_prompt,
        rerank_model: feed.rerank_model,
        rerank_thinking_enabled: feed.rerank_thinking_enabled,
        // Ranking-bias weights shape the snapshot's order, so editing one must
        // invalidate the cache. Seen filtering is NOT included: it is a
        // serve-time, per-viewer concern that never affects the shared snapshot.
        engagement_weight: feed.engagement_weight,
        recency_weight: feed.recency_weight,
        recency_halflife_h: feed.recency_halflife_h,
      })
    )
    .digest("hex");
}

/**
 * Public entry point. Builds (or reads) the feed's SHARED snapshot, then
 * applies per-viewer serve-time concerns on top:
 *
 *   - `viewerUserId` whose user has seen filtering on → drop posts this viewer
 *     has already seen (count reported via `opts.onSeenFiltered`). Seen
 *     filtering is a per-USER preference (users.seen_filter_enabled), not a
 *     per-feed setting.
 *
 * This path FILTERS by seen but does NOT record: recording is viewport-driven,
 * matching how the Bluesky client marks posts seen. The curator preview reports
 * impressions from the browser (IntersectionObserver → POST /api/seen → see
 * src/app/curator/[feedId]/useSeenTracker.ts); the published feed reports them
 * via app.bsky.feed.sendInteractions (#interactionSeen). Serve-time recording
 * would mark every served post seen even if it never reached the screen.
 *
 * Seen filtering is deliberately NOT part of buildSnapshot: that function's
 * output is cached and shared with every published subscriber, so it must stay
 * viewer-agnostic. The refresh cron calls this without a viewer, keeping the
 * shared snapshot clean.
 */
export async function getFeedPreviewPosts(
  feedId: number,
  limit: number = 25,
  onStage?: (e: PreviewStageEvent) => void,
  opts?: {
    forceFresh?: boolean;
    viewerUserId?: string;
    // Reports how many snapshot posts were dropped as already-seen for this
    // viewer. The stream route folds it into the final "done" event so the
    // loader can show it without regressing the stage progression.
    onSeenFiltered?: (n: number) => void;
    // Tail-recompute: URIs to drop from the result before serving. The curator's
    // partial-refresh sends the FROZEN PREFIX (posts the viewer has read + the
    // small look-ahead buffer) here so a refinement signal recomputes only the
    // tail and the client can splice [...frozen, ...newTail] without disturbing
    // the read position. Like seen filtering, this is a serve-time, per-request
    // concern applied AFTER the shared snapshot build — never cached, never fed
    // into buildSnapshot's config hash.
    excludeUris?: string[];
  }
): Promise<FeedPreviewPost[]> {
  const feedRes = await query("SELECT * FROM feeds WHERE id = $1", [feedId]);
  if (feedRes.rows.length === 0) return [];
  const feed = rowToFeed(feedRes.rows[0]);

  // Full, unfiltered, shared snapshot (up to SNAPSHOT_LIMIT).
  let snapshot = await buildSnapshot(feed, onStage, opts);

  // Tail-recompute exclude (frozen prefix). Dropped before the per-viewer seen
  // filter and the display slice so the tail returns only fresh posts.
  if (opts?.excludeUris?.length) {
    const ex = new Set(opts.excludeUris);
    snapshot = snapshot.filter((p) => !ex.has(p.uri));
  }

  // Serve-time seen filter (per viewer). Skipped entirely without a viewer or
  // when the viewer has the preference off — the cron and anonymous reads land
  // here. The viewer's preference is read fresh (one PK lookup) since it lives
  // on the user, not the feed.
  const viewerUserId = opts?.viewerUserId;
  if (!viewerUserId || snapshot.length === 0) {
    return snapshot.slice(0, limit);
  }
  const viewer = await getUserById(viewerUserId);
  if (!viewer?.seen_filter_enabled) {
    return snapshot.slice(0, limit);
  }

  const { visible, seenFiltered } = await filterUnseen(
    viewerUserId,
    feedId,
    snapshot
  );
  if (seenFiltered > 0) opts?.onSeenFiltered?.(seenFiltered);
  return visible.slice(0, limit);
}

// --- Live-post revalidation (swipe-left "less like this") ---
// After a tune commits a config change, the tail reload recomputes only the
// posts past the commit point — the frozen prefix the user is reading keeps
// posts the updated reranker would now reject. The client echoes those posts
// back (see the stream route's `revalidate` body field) and this re-judges
// them against the CURRENT rerank prompt, returning the URIs to remove.

export interface RevalidateCandidate extends RerankCandidate {
  uri: string;
}

// Appended to the feed's rerank prompt for the revalidation call. The model
// tends to include every candidate in its ranking regardless of instructions
// to omit (the output contract asks for a sorted list), so the working verdict
// signal is the SCORE: offenders of a fresh "less like this" come back very
// low (~10) while fine posts stay high (~90). The suffix pins that semantic
// and REVALIDATE_SCORE_FLOOR draws the removal line, deliberately low so only
// clear offenders fall under it — removing a visible post is disruptive.
const REVALIDATE_PROMPT_SUFFIX = `

The candidates below are posts ALREADY SHOWING in the user's feed, selected before the criteria above were last refined. Re-score each against the current criteria: a post that clearly matches something the user asked to see less of must score very low (under 20); a post that still fits the feed keeps a high score. When unsure, score high — removing a visible post is disruptive, so only clear offenders should score low.`;

const REVALIDATE_SCORE_FLOOR = 35;

/**
 * Re-judge already-served posts against the feed's current rerank prompt.
 * Returns the URIs the reranker would no longer surface (omitted from the
 * ranking or scored under the floor). Best-effort: any failure returns []
 * (remove nothing) — a broken sweep must never break the tail reload it
 * rides along with.
 */
export async function revalidateFrozenPosts(
  feed: DbFeed,
  candidates: RevalidateCandidate[]
): Promise<string[]> {
  if (candidates.length === 0 || feed.subqueries.length === 0) return [];
  const systemPrompt =
    (feed.rerank_prompt.trim().length > 0
      ? feed.rerank_prompt
      : DEFAULT_RERANK_PROMPT) + REVALIDATE_PROMPT_SUFFIX;
  try {
    // No images and no extended thinking: the sweep races the full tail
    // recompute and should land first so removals animate while the tail
    // loader is still up. Text + image alts carry enough signal to spot
    // clear offenders.
    const r = await rerank({
      query: feed.subqueries.join(" | "),
      candidates,
      topK: candidates.length,
      systemPrompt,
      model: feed.rerank_model,
      feedId: feed.id,
    });
    const keptAbove = new Set(
      r.kept.filter((k) => k.score >= REVALIDATE_SCORE_FLOOR).map((k) => k.i)
    );
    const removed = candidates
      .map((c, i) => (keptAbove.has(i) ? null : c.uri))
      .filter((u): u is string => u !== null);
    console.log(
      `[revalidate] feedId=${feed.id} candidates=${candidates.length} ` +
        `removed=${removed.length} ms=${r.ms_rerank}`
    );
    return removed;
  } catch (e) {
    console.warn(
      "[revalidate] failed:",
      e instanceof Error ? e.message : String(e)
    );
    return [];
  }
}

/**
 * Build (or read from cache) the feed's shared snapshot: vector search →
 * always-on LLM rerank → deterministic bake-time blend → top SNAPSHOT_LIMIT.
 * Viewer-agnostic and cached in feed_result_cache. Returns the full list (not
 * sliced to the caller's display limit — the wrapper slices after seen
 * filtering).
 */
async function buildSnapshot(
  feed: DbFeed,
  onStage?: (e: PreviewStageEvent) => void,
  opts?: { forceFresh?: boolean }
): Promise<FeedPreviewPost[]> {
  const feedId = feed.id;
  const t0 = performance.now();
  const tFeed = performance.now();

  const configHash = computeFeedConfigHash(feed);

  if (feed.subqueries.length === 0) {
    onStage?.({ stage: "done" });
    // Write an empty snapshot row (best-effort). Without it, a published
    // feed whose subqueries were later emptied has no cache row at all and
    // sorts first (NULLS FIRST) in the refresh cron's queue, occupying a
    // slot every single run.
    try {
      await query(
        `INSERT INTO feed_result_cache (feed_id, config_hash, posts, cached_at)
         VALUES ($1, $2, '[]'::jsonb, now())
         ON CONFLICT (feed_id) DO UPDATE SET
           config_hash = EXCLUDED.config_hash,
           posts = EXCLUDED.posts,
           cached_at = now()`,
        [feedId, configHash]
      );
    } catch {
      /* best-effort */
    }
    return [];
  }

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
    const hits = await searchPosts({
      subqueries: feed.subqueries,
      totalBudget: feed.candidate_budget,
      filter,
      withImages: true,
    });
    const tSearch = performance.now();

    // Map of original-hit index → {score, reason} from the reranker.
    let rerankByIndex: Map<number, { score: number; reason: string }> | null = null;
    // Kept hits paired with their index in the original `hits` array, so the
    // blend and result mapping recover rerank fields in O(1) — no indexOf scan
    // back into `hits` (which is O(n·budget) on a pool now up to 500).
    let ordered: Array<{ hit: (typeof hits)[number]; origIdx: number }> =
      hits.map((hit, origIdx) => ({ hit, origIdx }));
    let msRerank = 0;

    // The reranker is ALWAYS on (single ranking path). Feeds without a curator-
    // authored editorial prompt fall back to DEFAULT_RERANK_PROMPT. An empty
    // candidate pool is the only case that skips it.
    if (hits.length > 0) {
      const systemPrompt =
        feed.rerank_prompt.trim().length > 0
          ? feed.rerank_prompt
          : DEFAULT_RERANK_PROMPT;
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
          topK: SNAPSHOT_LIMIT,
          systemPrompt,
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
        ordered = [];
        for (const k of r.kept) {
          if (k.i < 0 || k.i >= hits.length) continue;
          rerankByIndex.set(k.i, { score: k.score, reason: k.reason });
          ordered.push({ hit: hits[k.i], origIdx: k.i });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[rerank] failed:", msg);
        throw new RerankUnavailableError(`rerank failed: ${msg}`);
      }
    }

    // Deterministic bake-time blend: re-sort the reranked pool by
    // w_q·(rerank/100) + w_e·engagement + w_r·recency. The reranker chose
    // membership + relevance; the blend lifts fresh / resonating posts. One
    // pinned clock across the pool keeps the ordering self-consistent.
    const nowMs = Date.now();
    const weights = {
      engagementWeight: feed.engagement_weight,
      recencyWeight: feed.recency_weight,
      recencyHalflifeH: feed.recency_halflife_h,
    };
    const blended = ordered
      .map(({ hit: h, origIdx }) => ({
        hit: h,
        origIdx,
        score: blendedScore({
          rerankScore: rerankByIndex?.get(origIdx)?.score ?? 0,
          counts: {
            like_count: h.like_count ?? 0,
            repost_count: h.repost_count ?? 0,
            reply_count: h.reply_count ?? 0,
            quote_count: h.quote_count ?? 0,
          },
          createdAtIso: h.created_at,
          weights,
          nowMs,
        }),
      }))
      .sort((a, b) => b.score - a.score);

    const sliced = blended.slice(0, SNAPSHOT_LIMIT);
    console.log(
      `[timing] getFeedPreviewPosts feed-lookup=${(tFeed - t0).toFixed(0)}ms ` +
        `searchPosts=${(tSearch - tFeed).toFixed(0)}ms ` +
        `rerank=${msRerank}ms ` +
        `total=${(performance.now() - t0).toFixed(0)}ms feedId=${feedId} ` +
        `subqueries=${feed.subqueries.length} budget=${feed.candidate_budget} ` +
        `hits=${hits.length} ` +
        (rerankByIndex ? `kept=${rerankByIndex.size} ` : "") +
        `blend=[q≈${(1 - weights.engagementWeight - weights.recencyWeight).toFixed(2)},` +
        `e=${weights.engagementWeight},r=${weights.recencyWeight}/${weights.recencyHalflifeH}h] ` +
        `returned=${sliced.length}`
    );
    const result: FeedPreviewPost[] = sliced.map(({ hit: h, origIdx }) => {
      const rr = rerankByIndex?.get(origIdx);
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
        has_video: h.has_video,
        image_count: h.image_count,
        image_alts: h.image_alts,
        image_urls: h.image_urls,
        video_thumbnail: h.video_thumbnail,
        video_playlist: h.video_playlist,
        is_reply: h.is_reply,
        reply_parent_uri: h.reply_parent_uri,
      };
    });

    // Cache write (best-effort): store the fresh snapshot for the next view.
    // Only reached when the rerank (if configured) succeeded — a failed
    // rerank throws above, keeping the previous good snapshot in place.
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
    if (e instanceof RerankUnavailableError) throw e;
    console.warn(
      "[vector-search] search failed:",
      e instanceof Error ? e.message : String(e)
    );
    return [];
  }
}

// --- Public feed skeleton (xrpc) ---
// The skeleton serves the feed's snapshot (one row in feed_result_cache,
// regardless of TTL/config-hash — any reranked snapshot beats recomputing
// under the reader's spinner). Freshness is the Cloud Scheduler job's work
// (POST /api/internal/refresh-feeds), plus curator previews and publish
// warming.

interface FeedSnapshot {
  posts: FeedPreviewPost[];
  // Epoch ms of cached_at — identifies this snapshot generation in cursors.
  version: number;
}

// Returns null only when the row is truly missing (or unreadable). A row
// holding zero posts is a VALID empty snapshot — a feed whose subqueries
// matched nothing — and must not be conflated with a broken precompute.
async function readFeedSnapshot(feedId: number): Promise<FeedSnapshot | null> {
  try {
    const res = await query(
      `SELECT posts, cached_at FROM feed_result_cache WHERE feed_id = $1`,
      [feedId]
    );
    if (res.rows.length === 0) return null;
    const posts = res.rows[0].posts as FeedPreviewPost[];
    return {
      posts: Array.isArray(posts) ? posts : [],
      version: new Date(res.rows[0].cached_at).getTime(),
    };
  } catch (e) {
    console.warn(
      `[skeleton] cache read failed feedId=${feedId}:`,
      e instanceof Error ? e.message : String(e)
    );
    return null;
  }
}

interface SkeletonPage {
  uris: string[];
  cursor?: string;
}

// Cursor format: "<snapshotVersion>::<offset>" — a position in a specific
// snapshot generation, not a timestamp. Our order is rerank order, so
// timestamp cursors (the chronological-feed convention) don't apply; an
// offset into a pinned list gives exact pages with no same-timestamp skips.
// If the snapshot rotated mid-scroll (version mismatch) we resume at the
// same offset in the new snapshot — at worst one post repeats or is skipped
// at the page boundary, once per daily refresh. Unparseable cursors (e.g.
// pre-deploy timestamp cursors) restart from the top.
function paginateSnapshot(
  snapshot: FeedSnapshot,
  limit: number,
  cursor?: string
): SkeletonPage {
  let offset = 0;
  if (cursor) {
    const m = cursor.match(/^(\d+)::(\d+)$/);
    if (m) offset = Number(m[2]);
  }
  const page = snapshot.posts.slice(offset, offset + limit);
  const end = offset + page.length;
  return {
    uris: page.map((p) => p.uri),
    cursor:
      end < snapshot.posts.length ? `${snapshot.version}::${end}` : undefined,
  };
}

// Published feeds are PRECOMPUTED — the skeleton never runs the pipeline
// under a reader's request. The snapshot row is written by curator previews,
// publish-time warming, and the 6-hourly refresh cron (whose staleness query
// also backfills missing rows). A missing row here means all three failed —
// log loudly and serve an empty feed until the cron heals it.
export async function getFeedSkeletonPage(
  feedId: number,
  limit: number,
  cursor?: string,
  // Set when the requester was identified (service-auth JWT verified → DID →
  // Ripple user) AND the feed has seen filtering on. Anonymous / unverified
  // requests and feeds with the toggle off fall through to plain pagination.
  viewer?: { userId: string }
): Promise<SkeletonPage> {
  const t0 = performance.now();

  const cached = await readFeedSnapshot(feedId);
  if (!cached) {
    console.error(
      `[skeleton] NO SNAPSHOT for published feedId=${feedId} — ` +
        `precompute invariant broken (warm failed + never previewed?); ` +
        `serving empty until the refresh cron backfills`
    );
    return { uris: [] };
  }
  console.log(
    `[skeleton] cache hit feedId=${feedId} posts=${cached.posts.length} ` +
      (viewer ? `viewer=${viewer.userId.slice(0, 8)} ` : "") +
      `total=${(performance.now() - t0).toFixed(0)}ms`
  );

  if (!viewer) return paginateSnapshot(cached, limit, cursor);

  // Per-viewer serve-time seen filtering over the SHARED snapshot. Seen posts
  // are removed, not offset-skipped, so the natural model is "serve the top
  // `limit` unseen, then record them seen." On the next page the just-served
  // posts are gone from the filtered list, so we always page from the top —
  // the incoming cursor's offset is irrelevant on this path. recordSeen is
  // awaited so a fast follow-up page can't re-serve the same posts (loop guard).
  const { visible } = await filterUnseen(viewer.userId, feedId, cached.posts);
  const page = visible.slice(0, limit);
  const uris = page.map((p) => p.uri);
  let recorded = true;
  if (uris.length > 0) {
    try {
      await recordSeen(viewer.userId, feedId, uris);
    } catch (e) {
      recorded = false;
      console.warn(
        `[skeleton] seen record failed feedId=${feedId}:`,
        e instanceof Error ? e.message : String(e)
      );
    }
  }
  // Continuation cursor, emitted only when more unseen posts remain AND this
  // page was recorded — otherwise the next request would re-filter from the top,
  // find these same posts unseen, and serve them again in a loop. We encode the
  // served page's position in the SHARED snapshot (not a `::seen` marker): the
  // viewer path ignores the offset, but if a later page falls through to the
  // unfiltered path (seen filtering toggled off mid-scroll, or the requester's
  // JWT stops verifying) that numeric offset lets paginateSnapshot resume
  // instead of restarting from the top.
  let cursor2: string | undefined;
  if (recorded && visible.length > limit) {
    const lastUri = uris[uris.length - 1];
    const snapshotIdx = cached.posts.findIndex((p) => p.uri === lastUri);
    const nextOffset = snapshotIdx >= 0 ? snapshotIdx + 1 : limit;
    cursor2 = `${cached.version}::${nextOffset}`;
  }
  return { uris, cursor: cursor2 };
}

/**
 * Full post objects for the public share page (/f/[feedId]). Snapshot-only,
 * like the skeleton: anonymous traffic must never trigger pipeline spend.
 */
export async function getSharedFeedPosts(
  feedId: number,
  limit = 30
): Promise<FeedPreviewPost[]> {
  const cached = await readFeedSnapshot(feedId);
  return cached ? cached.posts.slice(0, limit) : [];
}

/**
 * Publishing requires a snapshot computed from the feed's CURRENT config with
 * at least one post — the user must have seen a non-empty preview of what
 * they're publishing. (After publish they can edit freely; the refresh cron
 * recomputes within 24h.)
 */
type PublishSnapshotState = "ready" | "missing" | "stale_config" | "empty";

export async function getPublishSnapshotState(
  feed: DbFeed
): Promise<PublishSnapshotState> {
  try {
    const res = await query(
      `SELECT config_hash, posts FROM feed_result_cache WHERE feed_id = $1`,
      [feed.id]
    );
    if (res.rows.length === 0) return "missing";
    if (res.rows[0].config_hash !== computeFeedConfigHash(feed)) {
      return "stale_config";
    }
    const posts = res.rows[0].posts as FeedPreviewPost[];
    if (!Array.isArray(posts) || posts.length === 0) return "empty";
    return "ready";
  } catch {
    // A transient read failure blocks publish (retryable) rather than
    // letting an unverified feed through.
    return "missing";
  }
}
