"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  Fragment,
  type ReactNode,
} from "react";
import SwipeableCard, { type SwipeVerdict } from "@/components/SwipeableCard";
import SwipeFollowupCard from "@/components/SwipeFollowupCard";
import BranchTopicsHeader from "@/components/BranchTopicsHeader";
import PipelineLoader, { type PipelineStage } from "@/components/PipelineLoader";
import PostCard, { EngageFooter } from "@/components/PostCard";
import { BlueskyEmbed } from "@/components/postCardUtils";
import { authedFetch } from "@/lib/authed-fetch";
import type { MechanicalFilters } from "@/lib/types";
import { type BranchOption } from "@/lib/branch";
import { useCurator } from "../curatorContext";
import { useFeedActions } from "../feedActions";
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

export interface FeedViewHandle {
  reload: (force?: boolean) => void;
  setPosts: (posts: Post[]) => void;
}

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
    setActivePostCount,
    setUnavailableCount,
    openPublish,
    reloadFeeds,
  } = useCurator();
  const { trackPosts } = useFeedActions();

  const [posts, setPosts] = useState<Post[]>([]);
  const [postCount, setPostCount] = useState(0);
  const [postsLoading, setPostsLoading] = useState(false);

  // ── Local pipeline state (each FeedView owns its own loader so a nested
  //    branch's progress never collides with its parent's) ──
  const [pipelineStage, setPipelineStage] = useState<PipelineStage>("idle");
  const [pipelineCandidates, setPipelineCandidates] = useState<number | undefined>();
  const [pipelineHits, setPipelineHits] = useState<number | undefined>();
  const [pipelineImages, setPipelineImages] = useState<number | undefined>();
  const [pipelineModel, setPipelineModel] = useState<string | undefined>();
  const [pipelineThinkingEnabled, setPipelineThinkingEnabled] = useState<boolean | undefined>();
  const [pipelineSeenFiltered, setPipelineSeenFiltered] = useState<number | undefined>();

  // ── Swipe-to-tune (left) + swipe-to-branch (right) state ──
  const [swipedUris, setSwipedUris] = useState<Set<string>>(() => new Set());
  const [followupTopics, setFollowupTopics] = useState<Map<string, BranchOption[]>>(() => new Map());
  const fetchingFollowupRef = useRef(new Set<string>());
  const [swipeRightTopics, setSwipeRightTopics] = useState<Map<string, BranchOption[] | null>>(() => new Map());
  const [branchPendingUri, setBranchPendingUri] = useState<string | null>(null);
  const [pendingBranch, setPendingBranch] = useState<{
    post: Post;
    options: BranchOption[] | null;
    branchFeedId?: number;
    branchFeedName?: string;
  } | null>(null);
  const [committedBranchUri, setCommittedBranchUri] = useState<string | null>(null);
  const [othersCleared, setOthersCleared] = useState(false);
  const [branchDragging, setBranchDragging] = useState(false);
  const branchDraggingRef = useRef(false);
  const [branchReturning, setBranchReturning] = useState(false);
  const [returningSourceUri, setReturningSourceUri] = useState<string | null>(null);
  const branchCommittedRef = useRef(false);
  const feedInnerRef = useRef<HTMLDivElement | null>(null);

  const postsRef = useRef<Post[]>([]);
  useEffect(() => {
    postsRef.current = posts;
    onPostsChange?.(posts);
  }, [posts, onPostsChange]);

  // Register posts for shared quote + AI-label hydration.
  useEffect(() => { trackPosts(posts); }, [posts, trackPosts]);

  // ── Streaming post loader ───────────────────────────────────────
  const loadPosts = useCallback(async (force?: boolean) => {
    setPostsLoading(true);
    setPipelineStage("searching");
    setPipelineCandidates(undefined);
    setPipelineHits(undefined);
    setPipelineImages(undefined);
    setPipelineModel(undefined);
    setPipelineThinkingEnabled(undefined);
    setPipelineSeenFiltered(undefined);
    try {
      const url = `/api/feed-preview/stream?feedId=${feedId}${force ? "&refresh=1" : ""}`;
      const res = await authedFetch(url);
      if (!res.ok || !res.body) {
        setPostsLoading(false);
        setPipelineStage("idle");
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
              const nextCount = ev.total_stored || (ev.posts?.length ?? 0);
              const incoming = ev.posts || [];
              // The "done" event carries the full recomputed snapshot in final
              // reranked+blended order, so replace outright.
              setPosts(incoming);
              setPostCount(nextCount);
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
      onLoaded?.();
    }
  }, [feedId, isRoot, setActivePostCount, onConfigLoaded, onLoaded]);

  // Expose imperative control to the workbench (root only uses it).
  useImperativeHandle(ref, () => ({
    reload: (force?: boolean) => { void loadPosts(force); },
    setPosts: (p: Post[]) => { setPosts(p); setPostsLoading(false); },
  }), [loadPosts]);

  // Nested branch feeds load themselves on mount; the root is driven by the
  // workbench (which sequences chat load / branch-init / snapshot restore).
  useEffect(() => {
    if (isRoot) return;
    void loadPosts();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Branch (swipe-right) ────────────────────────────────────────
  function fetchSwipeRightTopics(post: Post) {
    if (swipeRightTopics.has(post.uri)) return;
    setSwipeRightTopics((prev) => { const next = new Map(prev); next.set(post.uri, null); return next; });
    void authedFetch("/api/branch/options", {
      method: "POST",
      body: JSON.stringify({ feedId, postUri: post.uri }),
    })
      .then(async (res) => {
        const d = await res.json();
        const topics: BranchOption[] = Array.isArray(d.options) ? d.options : [];
        setSwipeRightTopics((prev) => { const next = new Map(prev); next.set(post.uri, topics); return next; });
      })
      .catch(() => {
        setSwipeRightTopics((prev) => { const next = new Map(prev); next.set(post.uri, []); return next; });
      });
  }

  // Creates the branch feed in the background and stores its id on pendingBranch
  // so the inline nested FeedView can stream it. Does NOT navigate.
  async function createBranchForOverlay(post: Post, options: BranchOption[]) {
    const effective: BranchOption[] = options.length > 0 ? options : [{
      kind: "deeper",
      label: post.text.slice(0, 40).trim() || "this topic",
      subquery: post.text.replace(/\s+/g, " ").trim().slice(0, 200),
    }];
    try {
      const res = await authedFetch("/api/feeds/branch", {
        method: "POST",
        body: JSON.stringify({
          parentFeedId: feedId,
          sourcePostUri: post.uri,
          subqueries: effective.map((o) => o.subquery),
          labels: effective.map((o) => o.label),
        }),
      });
      const d = await res.json();
      if (d.feed?.id) {
        reloadFeeds();
        setPendingBranch((prev) => prev ? { ...prev, branchFeedId: d.feed.id, branchFeedName: d.feed.name } : prev);
      }
    } catch { /* panel still shows topics; can retry */ }
  }

  function handleCardSwipe(post: Post, verdict: SwipeVerdict) {
    if (verdict === "reject") return;
    branchCommittedRef.current = true;
    branchDraggingRef.current = false;
    setBranchDragging(false);
    feedInnerRef.current?.style.removeProperty("--branch-progress");
    setCommittedBranchUri(post.uri);
    setOthersCleared(false);
    setTimeout(() => {
      setOthersCleared(true);
      document.querySelector(".cur-feed-posts")?.scrollTo({ top: 0, behavior: "smooth" });
      window.scrollTo({ top: 0, behavior: "smooth" });
    }, 480);
    const options = swipeRightTopics.get(post.uri);
    if (Array.isArray(options) && options.length > 0) {
      void createBranchForOverlay(post, options);
    } else {
      setBranchPendingUri(post.uri);
    }
  }

  function resetBranch() {
    const sourceUri = committedBranchUri;
    branchCommittedRef.current = false;
    branchDraggingRef.current = false;
    setBranchDragging(false);
    setCommittedBranchUri(null);
    setOthersCleared(false);
    setPendingBranch(null);
    if (isRoot) setActivePostCount(postCount);
    feedInnerRef.current?.style.removeProperty("--branch-progress");
    setReturningSourceUri(sourceUri);
    setBranchReturning(true);
    setTimeout(() => { setBranchReturning(false); setReturningSourceUri(null); }, 520);
  }

  const handleRightProgress = useCallback((t: number) => {
    if (branchCommittedRef.current) return;
    const el = feedInnerRef.current;
    if (!el) return;
    if (t <= 0) {
      el.style.removeProperty("--branch-progress");
      if (branchDraggingRef.current) {
        branchDraggingRef.current = false;
        setBranchDragging(false);
        setPendingBranch(null);
      }
      return;
    }
    if (!branchDraggingRef.current) {
      branchDraggingRef.current = true;
      setBranchDragging(true);
    }
    el.style.setProperty("--branch-progress", String(t));
  }, []);

  // When topics arrive, fill the pending panel + kick off deferred creation.
  useEffect(() => {
    if (!pendingBranch) return;
    const uri = pendingBranch.post.uri;
    const topics = swipeRightTopics.get(uri);
    if (!Array.isArray(topics) || topics.length === 0) return;
    if (pendingBranch.options === null) {
      setPendingBranch((prev) => prev ? { ...prev, options: topics } : prev);
    }
    if (branchPendingUri === uri) {
      setBranchPendingUri(null);
      void createBranchForOverlay(pendingBranch.post, topics);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swipeRightTopics]);

  // ── Tune (swipe-left) ───────────────────────────────────────────
  function fetchFollowupTopics(post: Post) {
    if (followupTopics.has(post.uri)) return;
    if (fetchingFollowupRef.current.has(post.uri)) return;
    fetchingFollowupRef.current.add(post.uri);
    void authedFetch("/api/branch/options", {
      method: "POST",
      body: JSON.stringify({ feedId, postUri: post.uri }),
    })
      .then(async (res) => {
        fetchingFollowupRef.current.delete(post.uri);
        const d = await res.json();
        const topics: BranchOption[] = Array.isArray(d.options)
          ? (d.options as BranchOption[]).filter((o) => o.kind === "deeper")
          : [];
        setFollowupTopics((prev) => { const next = new Map(prev); next.set(post.uri, topics); return next; });
      })
      .catch(() => {
        fetchingFollowupRef.current.delete(post.uri);
        setFollowupTopics((prev) => { const next = new Map(prev); next.set(post.uri, []); return next; });
      });
  }

  function submitTune(post: Post, reason: string) {
    const token = `⟦swipe:reject:${post.uri}⟧`;
    const message = `${token} ${reason} Update my feed to show less of this.`;
    if (onTune) {
      onTune(message, post);
    } else {
      // Nested branch: tune this feed directly, then reload its posts.
      void authedFetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message, feedId }),
      })
        .then(() => loadPosts())
        .catch(() => {});
    }
  }

  function handleFollowupChipSend(post: Post, reason: string) {
    submitTune(post, reason);
    setSwipedUris((prev) => { const next = new Set(prev); next.add(post.uri); return next; });
  }
  function handleFollowupTextSend(post: Post, reason: string) {
    submitTune(post, reason);
  }
  function handleFollowupDismiss(uri: string) {
    setSwipedUris((prev) => { const next = new Set(prev); next.add(uri); return next; });
  }

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

  return (
    <div
      ref={feedInnerRef}
      className={`cur-feed-posts-inner${refreshing ? " refreshing" : ""}${branchDragging ? " cur-branch-dragging" : ""}${committedBranchUri ? " cur-branching" : ""}${branchReturning ? " cur-branch-returning" : ""}`}
    >
      {onBack && (
        <button type="button" className="cur-branch-back" onClick={onBack} aria-label="Back">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </button>
      )}

      {headerContent}

      {pipelineStage !== "idle" && (
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

      {posts.length === 0 ? (
        <div className="cur-empty">
          {postsLoading ? null : (
            <>
              <p>No posts yet.</p>
              <p className="sub">Try Refresh, or refine the subqueries in chat or the Tune panel.</p>
            </>
          )}
        </div>
      ) : viewMode === "embed" ? (
        posts.map((post) => {
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
            <div key={post.uri} className="cur-post-item cur-post-item-embed">
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
        posts
          .filter((post) => post.uri !== excludeUri)
          .filter((post) => !swipedUris.has(post.uri))
          .filter((post) => !othersCleared || post.uri === committedBranchUri)
          .map((post) => {
            const sourceUri = committedBranchUri ?? pendingBranch?.post?.uri ?? returningSourceUri ?? null;
            const isBranchSource = post.uri === sourceUri;
            const isCommittedSource = committedBranchUri === post.uri;
            return (
              <Fragment key={post.uri}>
                <div className={`cur-post-item${isBranchSource ? " cur-post-item-source" : " cur-post-item-other"}`}>
                  <SwipeableCard
                    disabled={isCommittedSource}
                    onSwipe={(v) => handleCardSwipe(post, v)}
                    onFirstLeftDrag={() => fetchFollowupTopics(post)}
                    onFirstRightDrag={() => {
                      const prefetched = swipeRightTopics.get(post.uri);
                      const options = Array.isArray(prefetched) && prefetched.length > 0 ? prefetched : null;
                      setPendingBranch({ post, options });
                      fetchSwipeRightTopics(post);
                    }}
                    onRightProgress={handleRightProgress}
                    followupContent={
                      <SwipeFollowupCard
                        post={post}
                        topics={followupTopics.get(post.uri)}
                        onChipSend={(reason) => handleFollowupChipSend(post, reason)}
                        onTextSend={(reason) => handleFollowupTextSend(post, reason)}
                        onDismiss={() => handleFollowupDismiss(post.uri)}
                      />
                    }
                  >
                    <PostCard post={post} />
                  </SwipeableCard>
                </div>
                {isCommittedSource && (
                  <div className="cur-branch-inline-host">
                    {pendingBranch?.branchFeedId ? (
                      // Branch feed is created — render it through the same
                      // FeedView so it has full swipe/branch parity.
                      <FeedView
                        feedId={pendingBranch.branchFeedId}
                        headerContent={<BranchTopicsHeader options={pendingBranch.options ?? []} />}
                        excludeUri={committedBranchUri ?? undefined}
                        onBack={resetBranch}
                      />
                    ) : (
                      // Branch feed still being created — show back + topics
                      // (or a finding-topics shimmer) until its id arrives, then
                      // the FeedView above takes over with the real pipeline loader.
                      <div className="cur-feed-posts-inner">
                        <button type="button" className="cur-branch-back" onClick={resetBranch} aria-label="Back">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <polyline points="15 18 9 12 15 6" />
                          </svg>
                          Back
                        </button>
                        {pendingBranch?.options ? (
                          <BranchTopicsHeader options={pendingBranch.options} />
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

      {posts.length > 0 && !postsLoading && !committedBranchUri && (
        <div className="cur-feed-end-prompt">
          <p className="cur-feed-end-title">You&rsquo;ve reached the end</p>
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
        </div>
      )}
    </div>
  );
}

const FeedView = forwardRef<FeedViewHandle, FeedViewProps>(FeedViewImpl);
export default FeedView;
