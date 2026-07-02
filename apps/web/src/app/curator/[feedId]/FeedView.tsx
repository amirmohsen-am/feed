"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  Fragment,
  type ReactNode,
} from "react";
import SwipeableCard from "@/components/SwipeableCard";
import SwipeFollowupCard from "@/components/SwipeFollowupCard";
import SwipeApproveCard from "@/components/SwipeApproveCard";
import BranchTopicsHeader from "@/components/BranchTopicsHeader";
import PipelineLoader, { type PipelineStage } from "@/components/PipelineLoader";
import { FeedSkeleton } from "@/components/FeedSkeleton";
import PostCard, { EngageFooter } from "@/components/PostCard";
import SwipeDemo from "./SwipeDemo";
import { BlueskyEmbed } from "@/components/postCardUtils";
import { authedFetch } from "@/lib/authed-fetch";
import type { MechanicalFilters } from "@/lib/types";
import { useCurator } from "../curatorContext";
import { useFeedActions } from "../feedActions";
import { useFeedFocus } from "../feedFocus";
import { useSeenTracker } from "./useSeenTracker";
import { useBranchController } from "./useBranchController";
import type { Post } from "../feedTypes";

// Config echoed back by the feed-preview stream's "done" event — reported up so
// the workbench's Tune panel + feed-signature stay in sync (root feed only).
export interface StreamedConfig {
  mechanical_filters?: MechanicalFilters;
  subqueries?: string[];
  candidate_budget?: number;
  rerank_prompt?: string;
  rerank_model?: string;
  rerank_thinking_enabled?: boolean;
}

// How a reload mutates the feed:
//   full  — replace the whole list (Refresh button, feed switch)
//   tail  — keep the frozen prefix (read + look-ahead) and recompute only the
//           posts past the commit point, splicing the result in place. Used by
//           refinement signals (chat tune, swipe-left "less like this") so the
//           feed the user is reading is not yanked. Degrades to a full load when
//           nothing has been read yet (empty prefix).
export interface ReloadOpts {
  force?: boolean;
  tail?: boolean;
}

export interface FeedViewHandle {
  reload: (opts?: ReloadOpts | boolean) => Promise<void> | void;
  setPosts: (posts: Post[]) => void;
}

// Look-ahead buffer past the last-seen post that stays frozen on a tail recompute
// — "keep the feed up until now, plus the next few". Tunable.
const TAIL_BUFFER = 3;

interface FeedViewProps {
  feedId: number;
  /** The root feed is driven by the workbench (chat/branch-init/snapshot); a
   *  nested branch feed auto-loads on mount and tunes itself. */
  isRoot?: boolean;
  /** Topic-chips header rendered above the list (branch feeds). */
  headerContent?: ReactNode;
  /** A URI to omit from the list — the source post a branch was made from
   *  (already pinned/folded in the parent feed), so it isn't shown twice. */
  excludeUri?: string;
  /** Back affordance: route-back for a branched route (root) or unfold for an
   *  inline branch (nested). Omitted on the home feed. */
  onBack?: () => void;
  /** Root only: report streamed feed config up to the workbench. */
  onConfigLoaded?: (cfg: StreamedConfig) => void;
  /** Root only: mirror posts up so the workbench can snapshot them on unmount. */
  onPostsChange?: (posts: Post[]) => void;
  /** Root only: a swipe-left tune routes through the workbench chat. When
   *  omitted (nested), the FeedView tunes its own feed and reloads. */
  onTune?: (message: string, post: Post) => void;
  /** Root only: faded while a chat turn may be changing the feed. */
  refreshing?: boolean;
  /** Fires whenever a post load settles (success or failure). */
  onLoaded?: () => void;
}

function FeedViewImpl(
  { feedId, isRoot = false, headerContent, excludeUri, onBack, onConfigLoaded, onPostsChange, onTune, refreshing = false, onLoaded }: FeedViewProps,
  ref: React.Ref<FeedViewHandle>
) {
  const {
    viewMode,
    showDebug,
    hideUnavailable,
    hideSeen,
    setActivePostCount,
    setUnavailableCount,
    openPublish,
    profile,
    feeds,
  } = useCurator();

  // Branching goes one level deep only: it's offered on the root feed, and never
  // from a feed that is itself a branch — neither inline (nested FeedView, not
  // root) nor when a branch feed is opened directly from the sidebar (root, but
  // with a parent).
  const isBranchFeed = feeds.some((f) => f.id === String(feedId) && f.parentFeedId != null);
  const canBranch = isRoot && !isBranchFeed;
  const { trackPosts } = useFeedActions();
  const { registerLeaf } = useFeedFocus();

  // Client-side "seen" impression tracking, scoped to THIS feed's id. Recursion
  // gives the root feed and every nested branch their own independent seen set.
  const seenTracker = useSeenTracker(feedId, hideSeen);

  const [posts, setPosts] = useState<Post[]>([]);
  const [postCount, setPostCount] = useState(0);
  const [postsLoading, setPostsLoading] = useState(false);
  // Tail recompute in flight: the frozen prefix stays rendered while only the
  // posts past `tailCommitIndex` are recomputed. Null when not in a tail load.
  const [tailCommitIndex, setTailCommitIndex] = useState<number | null>(null);

  // ── Local pipeline state (each FeedView owns its own loader so a nested
  //    branch's progress never collides with its parent's) ──
  const [pipelineStage, setPipelineStage] = useState<PipelineStage>("idle");
  const [pipelineCandidates, setPipelineCandidates] = useState<number | undefined>();
  const [pipelineHits, setPipelineHits] = useState<number | undefined>();
  const [pipelineImages, setPipelineImages] = useState<number | undefined>();
  const [pipelineModel, setPipelineModel] = useState<string | undefined>();
  const [pipelineThinkingEnabled, setPipelineThinkingEnabled] = useState<boolean | undefined>();
  const [pipelineSeenFiltered, setPipelineSeenFiltered] = useState<number | undefined>();

  // ── Loading → posts reveal choreography ("Settle") ──────────────
  const prevShowSkelRef = useRef(false);
  const [skelExiting, setSkelExiting] = useState(false);
  const [postsEntering, setPostsEntering] = useState(false);
  const revealTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => { revealTimersRef.current.forEach(clearTimeout); }, []);

  useEffect(() => {
    const showSkel = posts.length === 0 && postsLoading;
    const reduce =
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (prevShowSkelRef.current && posts.length > 0 && !reduce) {
      revealTimersRef.current.forEach(clearTimeout);
      setSkelExiting(true);
      setPostsEntering(false);
      revealTimersRef.current = [
        setTimeout(() => { setSkelExiting(false); setPostsEntering(true); }, 300),
        setTimeout(() => setPostsEntering(false), 300 + 850),
      ];
    }
    prevShowSkelRef.current = showSkel;
  }, [posts.length, postsLoading]);

  const postsRef = useRef<Post[]>([]);
  useEffect(() => {
    postsRef.current = posts;
    onPostsChange?.(posts);
  }, [posts, onPostsChange]);

  // Register posts for shared quote + AI-label hydration.
  useEffect(() => { trackPosts(posts); }, [posts, trackPosts]);

  // ── Streaming post loader ───────────────────────────────────────
  const loadPosts = useCallback(async (arg?: ReloadOpts | boolean) => {
    // Back-compat: a bare boolean means `force`. Prefer { force, tail }.
    const opts: ReloadOpts = typeof arg === "boolean" ? { force: arg } : (arg ?? {});
    const force = opts.force ?? false;

    // Record any pending on-screen impressions before we re-query, so the
    // reload's server-side seen filter accounts for what was just viewed.
    await seenTracker.flushNow();

    // Tail recompute: keep the frozen prefix (everything up to last-seen +
    // TAIL_BUFFER) and recompute only the posts past it. Compute the commit
    // point from impressions recorded so far. Falls back to a full load when the
    // prefix is empty (nothing read yet — a fresh feed), where a tail splice
    // would be indistinguishable from a replace anyway.
    const current = postsRef.current;
    let frozen: Post[] = [];
    let excludeUris: string[] | undefined;
    if (opts.tail && current.length > 0) {
      const seen = seenTracker.getSeenUris();
      let lastSeenIndex = -1;
      for (let i = 0; i < current.length; i++) {
        if (seen.has(current[i].uri)) lastSeenIndex = i;
      }
      const commitIndex = Math.min(lastSeenIndex + TAIL_BUFFER, current.length - 1);
      if (commitIndex >= 0) {
        frozen = current.slice(0, commitIndex + 1);
        // Exclude the frozen prefix AND every seen post (so a tail can't re-serve
        // something already read even when per-user seen filtering is off).
        excludeUris = Array.from(new Set([...frozen.map((p) => p.uri), ...seen]));
      }
    }
    const isTail = frozen.length > 0;

    // A full load (feed switch, branch mount, chat-driven recompute, AND explicit
    // Refresh / pull-to-refresh) drops the prior posts so the skeleton shows while
    // it loads — including cache hits, which still take a beat to arrive. Tail
    // recomputes keep the frozen prefix on screen and recompute only below the
    // commit point.
    if (isTail) {
      setTailCommitIndex(frozen.length - 1);
    } else {
      // Full load generation: clear per-fetch impression dedup so the incoming
      // results are all freshly trackable.
      seenTracker.reset();
      setTailCommitIndex(null);
      setPosts([]);
      setPostCount(0);
    }
    setPostsLoading(true);
    // Don't optimistically show "searching" — drive the loader purely off the
    // server's stage events. A cache hit emits no visible stage (only the final
    // done{cached}), so the loader never mounts for cached loads instead of
    // flashing in and vanishing. Reset to idle in case a prior load left "done".
    setPipelineStage("idle");
    setPipelineCandidates(undefined);
    setPipelineHits(undefined);
    setPipelineImages(undefined);
    setPipelineModel(undefined);
    setPipelineThinkingEnabled(undefined);
    setPipelineSeenFiltered(undefined);
    try {
      // Tail recomputes POST the frozen prefix as excludeUris; everything else is
      // a plain GET (cache-eligible, or ?refresh=1 to force a fresh snapshot).
      const res = isTail
        ? await authedFetch("/api/feed-preview/stream", {
            method: "POST",
            body: JSON.stringify({ feedId, excludeUris }),
          })
        : await authedFetch(
            `/api/feed-preview/stream?feedId=${feedId}${force ? "&refresh=1" : ""}`
          );
      if (!res.ok || !res.body) {
        setPostsLoading(false);
        setPipelineStage("idle");
        setTailCommitIndex(null);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line) as {
              event?: string;
              stage?: string;
              candidates?: number;
              hits?: number;
              images?: number;
              model?: string;
              thinking_enabled?: boolean;
              posts?: Post[];
              cached?: boolean;
              total_stored?: number;
              seen_filtered?: number;
              mechanical_filters?: MechanicalFilters;
              subqueries?: string[];
              candidate_budget?: number;
              rerank_prompt?: string;
              rerank_model?: string;
              rerank_thinking_enabled?: boolean;
              message?: string;
            };
            if (ev.event === "stage" && ev.stage) {
              if (ev.stage === "skipped_rerank") {
                // No rerank prompt: jump straight to "done".
              } else if (
                ev.stage === "searching" ||
                ev.stage === "thinking" ||
                ev.stage === "ranking" ||
                ev.stage === "done"
              ) {
                setPipelineStage(ev.stage);
                if (ev.stage === "thinking") {
                  if (typeof ev.candidates === "number") setPipelineCandidates(ev.candidates);
                  if (typeof ev.hits === "number") setPipelineHits(ev.hits);
                  if (typeof ev.images === "number") setPipelineImages(ev.images);
                  if (typeof ev.model === "string") setPipelineModel(ev.model);
                  if (typeof ev.thinking_enabled === "boolean") setPipelineThinkingEnabled(ev.thinking_enabled);
                }
              }
            } else if (ev.event === "done") {
              setPipelineStage(ev.cached ? "idle" : "done");
              if (typeof ev.seen_filtered === "number") setPipelineSeenFiltered(ev.seen_filtered);
              const incoming = ev.posts || [];
              // Tail recompute: splice [...frozen, ...newTail] so the read prefix
              // stays put. Otherwise the "done" event carries the full recomputed
              // snapshot in final reranked+blended order, so replace outright.
              const next = isTail ? [...frozen, ...incoming] : incoming;
              const nextCount = isTail
                ? next.length
                : ev.total_stored || incoming.length;
              setPosts(next);
              setPostCount(nextCount);
              setTailCommitIndex(null);
              if (isRoot) setActivePostCount(nextCount);
              onConfigLoaded?.({
                mechanical_filters: ev.mechanical_filters,
                subqueries: ev.subqueries,
                candidate_budget: ev.candidate_budget,
                rerank_prompt: ev.rerank_prompt,
                rerank_model: ev.rerank_model,
                rerank_thinking_enabled: ev.rerank_thinking_enabled,
              });
            } else if (ev.event === "error") {
              console.warn("[feed-preview/stream] error:", ev.message);
            }
          } catch {
            /* ignore malformed line */
          }
        }
      }
    } catch { /* ignore */ }
    finally {
      setPostsLoading(false);
      // Clear any tail-in-flight marker (a clean done already cleared it; this
      // covers a mid-stream error so the frozen-prefix view doesn't get stuck).
      setTailCommitIndex(null);
      onLoaded?.();
    }
  }, [feedId, isRoot, setActivePostCount, onConfigLoaded, onLoaded, seenTracker]);

  // Keep the latest loadPosts reachable from the stable handle without rebuilding
  // it (rebuilding would re-register the leaf on every reload). Updated in an
  // effect so we never mutate a ref during render.
  const loadPostsRef = useRef(loadPosts);
  useEffect(() => { loadPostsRef.current = loadPosts; }, [loadPosts]);

  // Stable handle (identity fixed for the mount): exposed to the workbench via ref
  // AND registered in the leaf-feed stack. setPosts/setPostsLoading are stable
  // state setters; loadPosts is read through the ref above.
  const selfHandle = useMemo<FeedViewHandle>(() => ({
    reload: (opts?: ReloadOpts | boolean) => loadPostsRef.current(opts),
    setPosts: (p: Post[]) => { setPosts(p); setPostsLoading(false); },
  }), []);
  useImperativeHandle(ref, () => selfHandle, [selfHandle]);

  // Register in the workbench's leaf-feed stack so a user-initiated refresh
  // (mobile pull-to-refresh) targets whichever feed is currently in view — the
  // deepest open branch, not always the root. A branch only mounts once its
  // parent commits, so mount order == nesting depth and the stack top is the leaf.
  useEffect(() => registerLeaf(selfHandle), [registerLeaf, selfHandle]);

  // Nested branch feeds load themselves on mount; the root is driven by the
  // workbench (which sequences chat load / branch-init / snapshot restore).
  useEffect(() => {
    if (isRoot) return;
    void loadPosts();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The feed's inner container — the fold/lift choreography scopes its DOM queries
  // to it. Owned here (not by the controller) so the render reads a plain local
  // ref, and the controller's return stays ref-free.
  const feedInnerRef = useRef<HTMLDivElement | null>(null);

  // Swipe-to-branch ("dive deeper") + swipe-to-tune ("less like this") state
  // machine, plus the fold/lift choreography that pins the source post as the
  // inline branch opens. The animation mechanics live in useBranchController so
  // this component stays "load + render a feed".
  const branch = useBranchController({ feedId, isRoot, postCount, feedInnerRef, loadPosts, onTune });

  // ── Embed-mode availability probe (mirrors count up only when root) ──
  const [unavailableUris, setUnavailableUris] = useState<Set<string>>(() => new Set());
  const bskyAvailabilityCache = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    if (!isRoot) return;
    setUnavailableCount(unavailableUris.size);
  }, [unavailableUris, isRoot, setUnavailableCount]);
  useEffect(() => {
    if (!isRoot) return;
    return () => setUnavailableCount(0);
  }, [isRoot, setUnavailableCount]);

  useEffect(() => {
    if (viewMode !== "embed") return;
    const scan = () => window.bluesky?.scan?.();
    scan();
    const t = setTimeout(scan, 300);
    return () => clearTimeout(t);
  }, [viewMode, posts, hideUnavailable, unavailableUris]);

  useEffect(() => {
    if (viewMode !== "embed") return;
    if (posts.length === 0) return;
    const ac = new AbortController();
    const cache = bskyAvailabilityCache.current;
    async function check(uri: string) {
      const cached = cache.get(uri);
      if (cached !== undefined) {
        if (cached === false) setUnavailableUris((prev) => prev.has(uri) ? prev : new Set(prev).add(uri));
        return;
      }
      try {
        const res = await fetch(
          `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0&parentHeight=0`,
          { signal: ac.signal }
        );
        if (!res.ok) {
          cache.set(uri, false);
          setUnavailableUris((prev) => prev.has(uri) ? prev : new Set(prev).add(uri));
          return;
        }
        const data = (await res.json()) as {
          thread?: { post?: { labels?: { val?: string }[]; author?: { labels?: { val?: string }[] } } };
        };
        const post = data.thread?.post;
        const hasNoUnauth =
          post?.labels?.some((l) => l.val === "!no-unauthenticated") ||
          post?.author?.labels?.some((l) => l.val === "!no-unauthenticated") ||
          false;
        if (!post || hasNoUnauth) {
          cache.set(uri, false);
          setUnavailableUris((prev) => prev.has(uri) ? prev : new Set(prev).add(uri));
        } else {
          cache.set(uri, true);
        }
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") return;
      }
    }
    posts.forEach((p) => { check(p.uri); });
    return () => ac.abort();
  }, [viewMode, posts]);

  const showSkeleton = posts.length === 0 && postsLoading;
  // Refresh stays available on an empty feed (e.g. every post already seen —
  // "No more posts" would otherwise strand desktop, which has no pull-to-refresh);
  // it only hides during the initial skeleton, where a second trigger is useless.
  const showRefresh = posts.length > 0 || !postsLoading;
  // While a tail recompute is in flight, render only the frozen prefix; the old
  // tail is replaced by a boundary loader so it can't flash stale-then-swap.
  const renderPosts =
    tailCommitIndex === null ? posts : posts.slice(0, tailCommitIndex + 1);

  return (
    <div
      ref={feedInnerRef}
      className={`cur-feed-posts-inner${refreshing && tailCommitIndex === null ? " refreshing" : ""}${branch.branchDragging ? " cur-branch-dragging" : ""}${branch.committedBranchUri ? " cur-branching" : ""}${branch.branchReturning ? " cur-branch-returning" : ""}${postsEntering ? " cur-feed-entering" : ""}`}
    >
      {onBack && (
        <button type="button" className="cur-branch-back cur-feed-home" onClick={onBack} aria-label="Home">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 10.5 12 3l9 7.5" />
            <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
          </svg>
          Home
        </button>
      )}

      {headerContent}

      {((pipelineStage !== "idle" && tailCommitIndex === null) || (showRefresh && !branch.committedBranchUri)) && (
        <div className="cur-feed-pl-row">
          {pipelineStage !== "idle" && tailCommitIndex === null && (
            <div className="cur-feed-pl">
              <PipelineLoader
                stage={pipelineStage}
                candidates={pipelineCandidates}
                hits={pipelineHits}
                images={pipelineImages}
                model={pipelineModel}
                thinkingEnabled={pipelineThinkingEnabled}
                seenFiltered={pipelineSeenFiltered}
                topK={25}
              />
            </div>
          )}
          {/* Hidden while this feed has an open inline branch — the branch in view
              shows its own Refresh, so the parent's would refresh the wrong feed. */}
          {showRefresh && !branch.committedBranchUri && (
            <button
              type="button"
              className={`cur-feed-refresh${postsLoading ? " busy" : ""}`}
              onClick={() => loadPosts(true)}
              disabled={postsLoading}
              title="Refresh this feed"
              aria-label="Refresh this feed"
            >
              <svg className="cur-feed-refresh-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              <span>Refresh</span>
            </button>
          )}
        </div>
      )}

      {showSkeleton ? (
        <FeedSkeleton />
      ) : skelExiting ? (
        <FeedSkeleton exiting />
      ) : posts.length === 0 ? (
        pipelineSeenFiltered ? (
          <div className="cur-empty">
            <p>No more posts.</p>
            <p className="sub">Drag down to refresh, or refine your interests in chat or the Tune panel.</p>
          </div>
        ) : (
          <div className="cur-empty">
            <p>No posts yet.</p>
            <p className="sub">Drag down to refresh, or refine your interests in chat or the Tune panel.</p>
          </div>
        )
      ) : viewMode === "embed" ? (
        renderPosts.map((post, idx) => {
          const bskyUrl = (() => {
            const m = post.uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
            return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
          })();
          const replyParentUrl = (() => {
            if (!post.reply_parent_uri) return null;
            const m = post.reply_parent_uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
            return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
          })();
          if (post.uri === excludeUri) return null;
          if (hideUnavailable && unavailableUris.has(post.uri)) return null;
          return (
            <div key={post.uri} ref={seenTracker.register(post.uri)} className="cur-post-item cur-post-item-embed" style={{ animationDelay: `${Math.min(idx, 6) * 0.05}s` }}>
              <div className="cur-post-embed-wrap" data-bsky-uri={post.uri}>
                <div className="cur-post-embed-frame">
                  {post.is_reply && (
                    <div className="cur-post-reply-banner cur-post-reply-banner-embed">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <polyline points="9 17 4 12 9 7" />
                        <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
                      </svg>
                      {replyParentUrl ? (
                        <a href={replyParentUrl} target="_blank" rel="noopener noreferrer">Replying to a post</a>
                      ) : (
                        <span>Reply</span>
                      )}
                    </div>
                  )}
                  <div className="cur-post-embed-meta">
                    {bskyUrl && (
                      <a href={bskyUrl} target="_blank" rel="noopener noreferrer" className="cur-post-open" title="Open in Bluesky">
                        Open ↗
                      </a>
                    )}
                  </div>
                  {showDebug && (
                    <div className="cur-post-debug">
                      <span className="cur-post-debug-row">
                        <span className="cur-post-debug-label">vec</span>
                        <span>{(post.score * 100).toFixed(1)}%</span>
                        {typeof post.rerank_score === "number" && (
                          <>
                            <span className="cur-post-debug-label">rr</span>
                            <span>{post.rerank_score}</span>
                          </>
                        )}
                        {post.like_nsfw && <span className="cur-post-debug-flag">nsfw?</span>}
                      </span>
                      {post.rerank_reason && (
                        <span className="cur-post-debug-reason">&ldquo;{post.rerank_reason}&rdquo;</span>
                      )}
                    </div>
                  )}
                </div>
                <BlueskyEmbed uri={post.uri} text={post.text} url={bskyUrl} />
                <EngageFooter post={post} bskyUrl={bskyUrl} />
              </div>
            </div>
          );
        })
      ) : (
        renderPosts
          .filter((post) => post.uri !== excludeUri)
          .filter((post) => !branch.swipedUris.has(post.uri))
          .filter((post) => !branch.othersCleared || post.uri === branch.committedBranchUri)
          .map((post, idx) => {
            const sourceUri = branch.committedBranchUri ?? branch.pendingBranch?.post?.uri ?? branch.returningSourceUri ?? null;
            const isBranchSource = post.uri === sourceUri;
            const isCommittedSource = branch.committedBranchUri === post.uri;
            const isReturningSource = branch.branchReturning && branch.returningSourceUri === post.uri;
            // Keep the Back button + banner mounted through the return so they can
            // animate OUT (shrink), the reverse of the commit grow.
            const branchHeaderLeaving = isReturningSource;
            const showBackButton = isCommittedSource || isReturningSource;
            // Banner appears on commit, not during the drag — growing it per-frame
            // while swiping reflows the source and makes the swipe shake.
            const showBranchBanner = isCommittedSource || isReturningSource;
            return (
              <Fragment key={post.uri}>
                {showBackButton && (
                  <button
                    type="button"
                    className={`cur-branch-back cur-branch-back-pinned${branchHeaderLeaving ? " cur-branch-back-leaving" : ""}`}
                    onClick={branch.resetBranch}
                    disabled={branchHeaderLeaving}
                    aria-label="Back to feed"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <polyline points="15 18 9 12 15 6" />
                    </svg>
                    Back
                  </button>
                )}
                <div ref={seenTracker.register(post.uri)} className={`cur-post-item${isBranchSource ? " cur-post-item-source" : " cur-post-item-other"}`} style={{ animationDelay: `${Math.min(idx, 6) * 0.05}s` }}>
                  <SwipeableCard
                    disabled={isCommittedSource}
                    onSwipe={(v) => branch.handleCardSwipe(post, v)}
                    onFirstLeftDrag={() => branch.fetchFollowupTopics(post)}
                    onFirstRightDrag={() => branch.onFirstRightDrag(post)}
                    onBranch={canBranch ? () => branch.handleHoldBranch(post) : undefined}
                    approveFollowupContent={
                      <SwipeApproveCard
                        post={post}
                        topics={branch.swipeRightTopics.get(post.uri) ?? undefined}
                        onChipSend={(reason) => branch.handleApproveFollowupChipSend(post, reason)}
                        onTextSend={(reason) => branch.handleApproveFollowupTextSend(post, reason)}
                        onDismiss={() => branch.handleApproveFollowupDismiss(post.uri)}
                      />
                    }
                    followupContent={
                      <SwipeFollowupCard
                        post={post}
                        topics={branch.followupTopics.get(post.uri)}
                        onChipSend={(reason) => branch.handleFollowupChipSend(post, reason)}
                        onTextSend={(reason) => branch.handleFollowupTextSend(post, reason)}
                        onDismiss={() => branch.handleFollowupDismiss(post.uri)}
                      />
                    }
                  >
                    <PostCard
                      post={post}
                      branchBanner={showBranchBanner}
                      branchLeaving={branchHeaderLeaving}
                      collapsible={isCommittedSource}
                      collapsed={!branch.sourceExpanded}
                      onToggleCollapse={() => {
                        const next = !branch.sourceExpanded;
                        branch.setSourceExpanded(next);
                        branch.settleFold(!next);
                      }}
                      onBranch={canBranch && !isCommittedSource ? () => branch.handleHoldBranch(post) : undefined}
                    />
                  </SwipeableCard>
                </div>
                {isCommittedSource && (
                  <div className="cur-branch-inline-host">
                    {branch.pendingBranch?.branchFeedId ? (
                      // Branch feed is created — render it through the same
                      // FeedView so it has full swipe/branch parity. (Back lives
                      // above the pinned source post, not inside the branch.)
                      <FeedView
                        feedId={branch.pendingBranch.branchFeedId}
                        headerContent={<BranchTopicsHeader options={branch.pendingBranch.options ?? []} />}
                        excludeUri={branch.committedBranchUri ?? undefined}
                      />
                    ) : (
                      // Branch feed still being created — show topics (or a
                      // finding-topics shimmer) until its id arrives, then the
                      // FeedView above takes over with the real pipeline loader.
                      <div className="cur-feed-posts-inner">
                        {branch.pendingBranch?.options ? (
                          <BranchTopicsHeader options={branch.pendingBranch.options} />
                        ) : (
                          <div className="cur-branch-posts-loading">
                            Finding topics<span className="cur-dots-inline"><span /><span /><span /></span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </Fragment>
            );
          })
      )}

      {/* Tail recompute in flight: the frozen prefix above stays put; the feed
          below the commit point is recomputing. Loader sits at the boundary so
          the read position is never disturbed. */}
      {tailCommitIndex !== null && (
        <div className="cur-feed-tail-loading">
          <PipelineLoader
            stage={pipelineStage === "idle" ? "searching" : pipelineStage}
            candidates={pipelineCandidates}
            hits={pipelineHits}
            images={pipelineImages}
            model={pipelineModel}
            thinkingEnabled={pipelineThinkingEnabled}
            seenFiltered={pipelineSeenFiltered}
            topK={25}
          />
          <p className="cur-feed-tail-loading-note">Updating what comes next</p>
        </div>
      )}

      {isRoot && <SwipeDemo postsLoaded={posts.length > 0 && !postsLoading} />}

      {posts.length > 0 && !postsLoading && !branch.committedBranchUri && (
        <div className="cur-feed-end-prompt">
          <p className="cur-feed-end-title">You&rsquo;ve reached the end</p>
          {profile.blueskyDid ? (
            <>
              <p className="cur-feed-end-sub">Like what you see? Take your feed to Bluesky.</p>
              <div className="cur-feed-end-actions">
                <button type="button" className="cur-feed-end-btn cur-feed-end-publish" onClick={openPublish}>
                  Publish to Bluesky
                </button>
                <button
                  type="button"
                  className="cur-feed-end-btn cur-feed-end-refresh"
                  onClick={() => {
                    document.querySelector(".cur-feed-posts")?.scrollTo({ top: 0 });
                    window.scrollTo({ top: 0 });
                    setTimeout(() => loadPosts(true), 50);
                  }}
                >
                  Refresh feed
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="cur-feed-end-sub">Like what you see? Take this feed with you on Bluesky, the open social network.</p>
              <div className="cur-feed-end-actions">
                <a
                  href="https://bsky.app"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="cur-feed-end-btn cur-feed-end-publish"
                  style={{ textDecoration: "none", textAlign: "center" }}
                >
                  Get started with Bluesky
                </a>
                <button
                  type="button"
                  className="cur-feed-end-btn cur-feed-end-refresh"
                  onClick={() => {
                    document.querySelector(".cur-feed-posts")?.scrollTo({ top: 0 });
                    window.scrollTo({ top: 0 });
                    setTimeout(() => loadPosts(true), 50);
                  }}
                >
                  Refresh feed
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const FeedView = forwardRef<FeedViewHandle, FeedViewProps>(FeedViewImpl);
export default FeedView;
