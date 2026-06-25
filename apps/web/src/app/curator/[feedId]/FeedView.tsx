"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { FeedSkeleton } from "@/components/FeedSkeleton";
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

// useLayoutEffect on the client, useEffect on the server — so the FLIP measure +
// invert runs after DOM mutation but before paint (no flash) without the SSR
// "useLayoutEffect does nothing on the server" warning.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

// The scroll container the feed lives in: the curator pane when it scrolls,
// otherwise the window (mobile / short panes).
function activeScroller(): HTMLElement | Window {
  const pane = document.querySelector(".cur-feed-posts") as HTMLElement | null;
  if (pane && pane.scrollHeight > pane.clientHeight + 4) return pane;
  return window;
}

function scrollTopOf(scroller: HTMLElement | Window): number {
  return scroller instanceof Window ? window.scrollY : scroller.scrollTop;
}

// Set scroll position instantly (no smooth) — used to anchor the source in place
// across a DOM re-insertion before the eased scroll takes over.
function setScrollTop(scroller: HTMLElement | Window, v: number) {
  const top = Math.max(0, v);
  if (scroller instanceof Window) window.scrollTo(0, top);
  else scroller.scrollTop = top;
}

// The source's top relative to the scroller's top edge (viewport px).
function topWithinScroller(el: HTMLElement, scroller: HTMLElement | Window): number {
  const refTop = scroller instanceof Window ? 0 : scroller.getBoundingClientRect().top;
  return el.getBoundingClientRect().top - refTop;
}

// Ease a scroller's scrollTop to `to` over `dur` ms (ease-out cubic). The source
// moves via scroll — not a transform — so every other post stays in real layout
// and nothing overlaps or leaves a blank gap as it travels.
function easeScrollTop(scroller: HTMLElement | Window, to: number, dur = 460) {
  const from = scrollTopOf(scroller);
  const target = Math.max(0, to);
  if (Math.abs(target - from) < 1) { setScrollTop(scroller, target); return; }
  const start = performance.now();
  const ease = (p: number) => 1 - Math.pow(1 - p, 3); // easeOutCubic

  function step(now: number) {
    const p = Math.min(1, (now - start) / dur);
    setScrollTop(scroller, from + (target - from) * ease(p));
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ── Source-post fold (swipe-right "dive deeper") ──
// The source post folds into a compact pinned preview as you drag right: the body
// region collapses to a couple of lines whose text dissolves to transparent (a
// mask, not a white overlay — no hard clip), and the avatar shrinks. Heights are
// measured (not guessable in CSS), so the fold is driven imperatively here.
const foldLerp = (a: number, b: number, p: number) => a + (b - a) * p;
const fold01 = (v: number) => Math.max(0, Math.min(1, v));
const FOLD_MIN = 48;      // collapsed body height (≈ 2 lines + the fade)
const AVA_FULL = 40, AVA_MIN = 30;
const FOLD_DUR = 440;     // ms — matches the recede/lift timing on commit & Back
const foldMask = (stopPct: number) => `linear-gradient(to bottom,#000 ${stopPct}%,transparent)`;
const prefersReducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

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
  // Committed source post: whether the user has expanded the folded body via the
  // chevron. The fold itself lives in inline styles on the source card's foldable
  // region (measured heights + mask), tracked here so cleanup can find them.
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const foldElRef = useRef<{ foldable: HTMLElement; avatar: HTMLElement | null } | null>(null);
  const foldFullRef = useRef<number | null>(null);
  const foldClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The source's viewport top, captured at Back (before it un-pins) so the scroll
  // can be anchored to keep it visually still across the other posts re-inserting.
  const backAnchorTopRef = useRef<number | null>(null);
  // Same idea for the moment the receded posts are removed from the DOM (480ms
  // after commit): their removal shrinks the content above the source and the
  // browser yanks the scroll to compensate ("then it goes down"). Capture the
  // source's spot just before removal so we can pin it across the removal. We
  // store the SCROLLER too, not just the top: at capture the full feed makes the
  // pane scrollable (activeScroller → pane), but once the other posts are gone the
  // pane may be shorter than its viewport (activeScroller → window). Re-resolving
  // the scroller in the restore would then pin the wrong element while the pane's
  // own scrollTop clamps and snaps. Same scroller in, same scroller out.
  const clearAnchorRef = useRef<{ scroller: HTMLElement | Window; top: number } | null>(null);

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
    // A non-forced load means we're entering a feed fresh (feed switch, branch
    // mount, or a chat-driven config change) rather than refreshing the current
    // one in place. Drop the prior feed's posts so the skeleton shows instead of
    // stale results lingering dimmed. Forced loads (Refresh button, pull-to-
    // refresh) keep the posts on screen and dim them via the .refreshing class.
    if (!force) {
      setPosts([]);
      setPostCount(0);
    }
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

  const sourceItemEl = () =>
    (feedInnerRef.current?.querySelector(".cur-post-item-source") as HTMLElement | null) ?? null;

  function handleCardSwipe(post: Post, verdict: SwipeVerdict) {
    if (verdict === "reject") return;
    branchCommittedRef.current = true;
    branchDraggingRef.current = false;
    setBranchDragging(false);
    feedInnerRef.current?.style.removeProperty("--branch-progress");
    setCommittedBranchUri(post.uri);
    setOthersCleared(false);
    // Fold the source into its compact pinned preview (the drag left it part-folded;
    // ease it the rest of the way) and start it collapsed.
    setSourceExpanded(false);
    settleFold(true);
    // Drop the receded posts once they've slid out. Capture the source's spot first
    // so the clearAnchor effect can pin it across the removal (removing the
    // full-height posts above it would otherwise yank the scroll — "then it goes
    // down").
    setTimeout(() => {
      const scroller = activeScroller();
      const el = sourceItemEl();
      clearAnchorRef.current = el ? { scroller, top: topWithinScroller(el, scroller) } : null;
      setOthersCleared(true);
    }, 480);
    const options = swipeRightTopics.get(post.uri);
    if (Array.isArray(options) && options.length > 0) {
      void createBranchForOverlay(post, options);
    } else {
      setBranchPendingUri(post.uri);
    }
  }

  // Locate the source card's foldable region (the block under the header) + its
  // avatar. Direct-child scope so a nested branch feed folds only its own source.
  const sourceFoldEls = useCallback(() => {
    const inner = feedInnerRef.current;
    const src = inner?.querySelector(":scope > .cur-post-item-source") as HTMLElement | null;
    const foldable = (src?.querySelector(".cur-post-foldable") as HTMLElement | null) ?? null;
    const avatar = (src?.querySelector(".cur-post-avatar") as HTMLElement | null) ?? null;
    if (foldable) foldElRef.current = { foldable, avatar };
    return { foldable, avatar };
  }, []);

  // Scrub the fold to the drag (t ∈ [0,1]); no transition, follows the finger. The
  // body/avatar fold lags the ride (starts at t=0.4) so the early drag is just the
  // card sliding right — the collapse reads as a consequence of committing.
  const driveFold = useCallback((t: number) => {
    const { foldable, avatar } = sourceFoldEls();
    if (!foldable) return;
    if (foldFullRef.current == null) {
      const prev = foldable.style.maxHeight;
      foldable.style.maxHeight = "none";
      foldFullRef.current = foldable.scrollHeight;
      foldable.style.maxHeight = prev;
    }
    const full = foldFullRef.current;
    const p = fold01((t - 0.4) / 0.6);
    foldable.style.transition = "none";
    foldable.style.overflow = "hidden";
    foldable.style.maxHeight = foldLerp(full, Math.min(FOLD_MIN, full), p) + "px";
    foldable.style.webkitMaskImage = foldable.style.maskImage = foldMask(foldLerp(100, 52, p));
    if (avatar) {
      const a = foldLerp(AVA_FULL, AVA_MIN, p) + "px";
      avatar.style.transition = "none";
      avatar.style.width = a;
      avatar.style.height = a;
    }
  }, [sourceFoldEls]);

  // Animate the source to its folded (collapsed=true) or full (collapsed=false)
  // state — used on commit, on the expand/collapse chevron, and on Back. Re-measures
  // the natural height each time (images may have loaded since the drag).
  const settleFold = useCallback((collapsed: boolean) => {
    const { foldable, avatar } = sourceFoldEls();
    if (!foldable) return;
    const prevMax = foldable.style.maxHeight;
    foldable.style.transition = "none";
    foldable.style.maxHeight = "none";
    const full = foldable.scrollHeight;
    foldFullRef.current = full;
    foldable.style.maxHeight = prevMax || full + "px";
    void foldable.offsetHeight; // reflow so the change below animates from here
    const reduce = prefersReducedMotion();
    const ease = "cubic-bezier(0.4,0,0.2,1)";
    foldable.style.transition = reduce
      ? "none"
      : `max-height ${FOLD_DUR}ms ${ease}, -webkit-mask-image ${FOLD_DUR}ms, mask-image ${FOLD_DUR}ms`;
    foldable.style.overflow = "hidden";
    foldable.style.maxHeight = (collapsed ? Math.min(FOLD_MIN, full) : full) + "px";
    foldable.style.webkitMaskImage = foldable.style.maskImage = foldMask(collapsed ? 52 : 100);
    if (avatar) {
      avatar.style.transition = reduce ? "none" : `width ${FOLD_DUR}ms ${ease}, height ${FOLD_DUR}ms ${ease}`;
      const a = (collapsed ? AVA_MIN : AVA_FULL) + "px";
      avatar.style.width = a;
      avatar.style.height = a;
    }
  }, [sourceFoldEls]);

  // Strip the inline fold styles so the card returns to a plain post (after Back, or
  // after a cancelled drag eases back open).
  const clearFoldInline = useCallback(() => {
    const els = foldElRef.current;
    if (els?.foldable) {
      const f = els.foldable.style;
      f.transition = ""; f.maxHeight = ""; f.overflow = ""; f.webkitMaskImage = ""; f.maskImage = "";
    }
    if (els?.avatar) {
      const a = els.avatar.style;
      a.transition = ""; a.width = ""; a.height = "";
    }
    foldElRef.current = null;
    foldFullRef.current = null;
    foldClearTimerRef.current = null;
  }, []);

  const resetBranch = useCallback(() => {
    // Capture the source's viewport top (before it un-pins) so the Back effect can
    // anchor the scroll there as the other posts re-insert, then glide it down.
    const scroller = activeScroller();
    const el = sourceItemEl();
    backAnchorTopRef.current = el ? topWithinScroller(el, scroller) : null;
    branchCommittedRef.current = false;
    branchDraggingRef.current = false;
    setBranchDragging(false);
    setReturningSourceUri(committedBranchUri);
    setCommittedBranchUri(null);
    setOthersCleared(false);
    setPendingBranch(null);
    if (isRoot) setActivePostCount(postCount);
    feedInnerRef.current?.style.removeProperty("--branch-progress");
    // Unfold the source back to a full post as the other posts re-insert, then drop
    // the inline fold styles once it has settled.
    setSourceExpanded(false);
    settleFold(false);
    setBranchReturning(true);
    setTimeout(() => { setBranchReturning(false); setReturningSourceUri(null); clearFoldInline(); }, 520);
  }, [committedBranchUri, isRoot, postCount, setActivePostCount, settleFold, clearFoldInline]);

  // On commit, ease the source up to the top as the other posts recede — but only
  // as far as it can actually REST once those posts are unmounted. The source rises
  // by "scroll", and the receding posts above it keep their layout height until they
  // drop, so the scroll offset the lift travels through exists *only while they do*.
  // Lift further than their combined height (e.g. all the way to viewport y=0) and
  // the shrunken document can't hold that offset: it clamps the instant the posts go
  // and the source snaps back DOWN by the overshoot. So the lift distance is exactly
  // the height of the posts being removed ABOVE the source (back-button top → topmost
  // removed post top) — the source lands precisely where the post-removal layout puts
  // it (just under the back button), and the clamp cancels the document shrink with
  // nothing left over. (Measuring the gap between those two elements captures the
  // posts' heights AND the inter-post spacing, and naturally leaves any header above
  // the back button in place — the source rides up only past what disappears.)
  useIsoLayoutEffect(() => {
    if (!committedBranchUri) return;
    const el = sourceItemEl();
    const inner = feedInnerRef.current;
    if (!el || !inner) return;
    const topEl = (inner.querySelector(".cur-branch-back-pinned") as HTMLElement | null) ?? el;
    const above = (Array.from(inner.querySelectorAll(".cur-post-item-other")) as HTMLElement[])
      .filter((o) => (el.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_PRECEDING) !== 0);
    if (above.length === 0) return; // source already at the top — nothing to lift through
    // ABSOLUTE target scroll, not a delta: the layout distance from the topmost
    // removed post to the back button equals the scrollTop that lands the back button
    // (and the source just below it) at the feed's content top — where they rest once
    // the posts above unmount. Use offsetTop, NOT getBoundingClientRect().top: at this
    // instant the receding posts are mid-transition under `.cur-branching`
    // (transform: scale + translateX), and rect.top *includes* that transform, so a
    // scaled-down post reads ~tens of px lower than its real layout top — under-lifting
    // and leaving a small bounce on removal. offsetTop is transform-immune. (The back
    // button + every post item are siblings, so their offsetTops share a parent.)
    const topMostOffset = Math.min(...above.map((o) => o.offsetTop));
    const target = topEl.offsetTop - topMostOffset;
    const scroller = activeScroller();
    easeScrollTop(scroller, target, 460);
  }, [committedBranchUri]);

  // When the receded posts are removed (othersCleared), pin the source where it
  // was a moment earlier — removing the full-height posts above it shrinks the
  // content and the browser would otherwise jump the scroll to compensate.
  useIsoLayoutEffect(() => {
    if (!othersCleared) return;
    const anchor = clearAnchorRef.current;
    clearAnchorRef.current = null;
    const el = sourceItemEl();
    if (el && anchor != null) {
      const { scroller } = anchor;
      setScrollTop(scroller, scrollTopOf(scroller) + (topWithinScroller(el, scroller) - anchor.top));
    }
  }, [othersCleared]);

  // On Back, the source stays at the top (we do NOT restore the pre-branch scroll).
  // The other posts re-insert at full height — shoving the source down — so anchor
  // the scroll to hold the source exactly where it sat (just under the Back button),
  // cancelling that jump. The Back button + banner then shrink out (reverse of the
  // commit grow), and the source rises to the very top via reflow as they collapse,
  // while the other cards slide back in (cur-post-return). One motion, the mirror
  // of the commit.
  useIsoLayoutEffect(() => {
    if (!branchReturning) return;
    const scroller = activeScroller();
    const el = sourceItemEl();
    const anchor = backAnchorTopRef.current;
    backAnchorTopRef.current = null;
    if (el && anchor != null) {
      setScrollTop(scroller, scrollTopOf(scroller) + (topWithinScroller(el, scroller) - anchor));
    }
  }, [branchReturning]);

  const handleRightProgress = useCallback((t: number) => {
    if (branchCommittedRef.current) return;
    const el = feedInnerRef.current;
    if (!el) return;
    if (t <= 0) {
      el.style.removeProperty("--branch-progress");
      if (branchDraggingRef.current) {
        branchDraggingRef.current = false;
        setBranchDragging(false);
        settleFold(false);                                  // ease the source back open
        foldClearTimerRef.current = setTimeout(clearFoldInline, FOLD_DUR + 40); // then drop the inline styles
        setPendingBranch(null);
      }
      return;
    }
    if (!branchDraggingRef.current) {
      branchDraggingRef.current = true;
      setBranchDragging(true);
      // A fresh drag pre-empts a pending "ease back open then clear" from a just-
      // cancelled drag, so the cleanup can't strip styles mid-fold.
      if (foldClearTimerRef.current) { clearTimeout(foldClearTimerRef.current); foldClearTimerRef.current = null; }
    }
    el.style.setProperty("--branch-progress", String(t));
    driveFold(t);
  }, [driveFold, settleFold, clearFoldInline]);

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

      {(pipelineStage !== "idle" || posts.length > 0) && (
        <div className="cur-feed-pl-row">
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
          {posts.length > 0 && (
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

      {posts.length === 0 ? (
        postsLoading ? (
          <FeedSkeleton />
        ) : (
          <div className="cur-empty">
            <p>No posts yet.</p>
            <p className="sub">Try Refresh, or refine the subqueries in chat or the Tune panel.</p>
          </div>
        )
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
            const isReturningSource = branchReturning && returningSourceUri === post.uri;
            // Keep the Back button + banner mounted through the return so they can
            // animate OUT (shrink), the reverse of the commit grow.
            const branchHeaderLeaving = isReturningSource;
            const showBackButton = isCommittedSource || isReturningSource;
            const showBranchBanner = isCommittedSource || pendingBranch?.post?.uri === post.uri || isReturningSource;
            return (
              <Fragment key={post.uri}>
                {showBackButton && (
                  <button
                    type="button"
                    className={`cur-branch-back cur-branch-back-pinned${branchHeaderLeaving ? " cur-branch-back-leaving" : ""}`}
                    onClick={resetBranch}
                    disabled={branchHeaderLeaving}
                    aria-label="Back to feed"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <polyline points="15 18 9 12 15 6" />
                    </svg>
                    Back
                  </button>
                )}
                <div className={`cur-post-item${isBranchSource ? " cur-post-item-source" : " cur-post-item-other"}`}>
                  <SwipeableCard
                    disabled={isCommittedSource}
                    onSwipe={(v) => handleCardSwipe(post, v)}
                    onFirstLeftDrag={() => fetchFollowupTopics(post)}
                    onFirstRightDrag={() => {
                      const prefetched = swipeRightTopics.get(post.uri);
                      const options = Array.isArray(prefetched) && prefetched.length > 0 ? prefetched : null;
                      // pendingBranch must be set now so this card is marked the
                      // source (excluded from the recede). The topic fetch is
                      // visual-irrelevant, so defer it off the first drag frame.
                      setPendingBranch({ post, options });
                      requestAnimationFrame(() => fetchSwipeRightTopics(post));
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
                    <PostCard
                      post={post}
                      branchBanner={showBranchBanner}
                      branchLeaving={branchHeaderLeaving}
                      collapsible={isCommittedSource}
                      collapsed={!sourceExpanded}
                      onToggleCollapse={() => {
                        const next = !sourceExpanded;
                        setSourceExpanded(next);
                        settleFold(!next);
                      }}
                    />
                  </SwipeableCard>
                </div>
                {isCommittedSource && (
                  <div className="cur-branch-inline-host">
                    {pendingBranch?.branchFeedId ? (
                      // Branch feed is created — render it through the same
                      // FeedView so it has full swipe/branch parity. (Back lives
                      // above the pinned source post, not inside the branch.)
                      <FeedView
                        feedId={pendingBranch.branchFeedId}
                        headerContent={<BranchTopicsHeader options={pendingBranch.options ?? []} />}
                        excludeUri={committedBranchUri ?? undefined}
                      />
                    ) : (
                      // Branch feed still being created — show topics (or a
                      // finding-topics shimmer) until its id arrives, then the
                      // FeedView above takes over with the real pipeline loader.
                      <div className="cur-feed-posts-inner">
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
