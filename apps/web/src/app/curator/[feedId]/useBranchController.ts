import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { SwipeVerdict } from "@/components/SwipeableCard";
import { authedFetch } from "@/lib/authed-fetch";
import { type BranchOption, type NegativeTopic } from "@/lib/branch";
import { useCurator } from "../curatorContext";
import type { Post } from "../feedTypes";

// All of FeedView's swipe-right "dive deeper" (branch) + swipe-left "less like
// this" (tune) state machine, plus the imperative fold/lift choreography that
// makes the source post pin to the top as the inline branch opens. Lifted out of
// FeedView so the component body reads as "load + render a feed" and this owns the
// (intricate, measured) animation bookkeeping. Behaviour is unchanged.

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
const FOLD_MIN = 48;      // collapsed body height (≈ 2 lines + the fade)
const AVA_FULL = 40, AVA_MIN = 30;
const FOLD_DUR = 440;     // ms — matches the recede/lift timing on commit & Back
const foldMask = (stopPct: number) => `linear-gradient(to bottom,#000 ${stopPct}%,transparent)`;
const prefersReducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

interface PendingBranch {
  post: Post;
  options: BranchOption[] | null;
  branchFeedId?: number;
  branchFeedName?: string;
}

interface BranchController {
  // ── Container-class flags ──
  branchDragging: boolean;
  committedBranchUri: string | null;
  branchReturning: boolean;

  // ── Per-post render state ──
  swipedUris: Set<string>;
  othersCleared: boolean;
  returningSourceUri: string | null;
  pendingBranch: PendingBranch | null;
  followupTopics: Map<string, NegativeTopic[]>;
  /** Approve topics indexed by post URI (same API as branch options). */
  swipeRightTopics: Map<string, BranchOption[] | null>;
  sourceExpanded: boolean;
  setSourceExpanded: (b: boolean) => void;

  // ── SwipeableCard wiring ──
  handleCardSwipe: (post: Post, verdict: SwipeVerdict) => void;
  handleRightProgress: (t: number) => void;
  /** First right-drag frame: prefetch approve topics (no branch commit). */
  onFirstRightDrag: (post: Post) => void;
  fetchFollowupTopics: (post: Post) => void;
  handleFollowupChipSend: (post: Post, reason: string) => void;
  handleFollowupTextSend: (post: Post, reason: string) => void;
  handleFollowupDismiss: (uri: string) => void;

  // ── Approve ("more like this") wiring ──
  handleApproveFollowupChipSend: (post: Post, reason: string) => void;
  handleApproveFollowupTextSend: (post: Post, reason: string) => void;
  handleApproveFollowupDismiss: (uri: string) => void;

  // ── Branch-button / hold gesture ──
  handleHoldBranch: (post: Post) => void;

  // ── Back + fold ──
  resetBranch: () => void;
  settleFold: (collapsed: boolean) => void;
}

export function useBranchController({
  feedId,
  isRoot,
  postCount,
  feedInnerRef,
  loadPosts,
  onTune,
}: {
  feedId: number;
  isRoot: boolean;
  postCount: number;
  /** The feed's inner container (owned by FeedView) — DOM queries scope to it. */
  feedInnerRef: RefObject<HTMLDivElement | null>;
  loadPosts: (opts?: { force?: boolean; tail?: boolean } | boolean) => Promise<void> | void;
  /** Root only: a swipe-left tune routes through the workbench chat. When
   *  omitted (nested), the controller tunes its own feed and reloads. */
  onTune?: (message: string, post: Post) => void;
}): BranchController {
  const { reloadFeeds, setActivePostCount } = useCurator();

  // ── Swipe-to-tune (left) + swipe-to-branch (right) state ──
  const [swipedUris, setSwipedUris] = useState<Set<string>>(() => new Set());
  const [followupTopics, setFollowupTopics] = useState<Map<string, NegativeTopic[]>>(() => new Map());
  const fetchingFollowupRef = useRef(new Set<string>());
  const [swipeRightTopics, setSwipeRightTopics] = useState<Map<string, BranchOption[] | null>>(() => new Map());
  const [branchPendingUri, setBranchPendingUri] = useState<string | null>(null);
  const [pendingBranch, setPendingBranch] = useState<PendingBranch | null>(null);
  const [committedBranchUri, setCommittedBranchUri] = useState<string | null>(null);
  const [othersCleared, setOthersCleared] = useState(false);
  const [branchDragging, setBranchDragging] = useState(false);
  const branchDraggingRef = useRef(false);
  const [branchReturning, setBranchReturning] = useState(false);
  const [returningSourceUri, setReturningSourceUri] = useState<string | null>(null);
  const branchCommittedRef = useRef(false);
  // Committed source post: whether the user has expanded the folded body via the
  // chevron. The fold itself lives in inline styles on the source card's foldable
  // region (measured heights + mask), tracked here so cleanup can find them.
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const foldElRef = useRef<{ foldable: HTMLElement; avatar: HTMLElement | null } | null>(null);
  const foldFullRef = useRef<number | null>(null);
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
    // Right swipe is now "more like this" — the approve panel handles it.
    // Left swipe (reject) is also handled by the followup card via commitLess.
    void post; void verdict;
  }

  // First right-drag frame: prefetch approve topics. Does NOT mark the post as the
  // branch source — right-swipe is "more like this", not branch.
  function onFirstRightDrag(post: Post) {
    requestAnimationFrame(() => fetchSwipeRightTopics(post));
  }

  // Triggered by the branch FAB button or hold gesture. Does the full branch commit:
  // folds the source post, clears receded posts, creates the branch feed overlay.
  function handleHoldBranch(post: Post) {
    const prefetched = swipeRightTopics.get(post.uri);
    const branchOptions = Array.isArray(prefetched) && prefetched.length > 0 ? prefetched : null;
    setPendingBranch({ post, options: branchOptions });
    fetchSwipeRightTopics(post);
    branchCommittedRef.current = true;
    branchDraggingRef.current = false;
    setBranchDragging(false);
    feedInnerRef.current?.style.removeProperty("--branch-progress");
    setCommittedBranchUri(post.uri);
    setOthersCleared(false);
    setSourceExpanded(false);
    // The fold runs in the committedBranchUri layout effect below, not here: the
    // branch button fires with no preceding drag, so at this instant no element
    // carries .cur-post-item-source yet — settleFold would find nothing and no-op.
    setTimeout(() => {
      const scroller = activeScroller();
      const el = sourceItemEl();
      clearAnchorRef.current = el ? { scroller, top: topWithinScroller(el, scroller) } : null;
      setOthersCleared(true);
    }, 480);
    if (branchOptions) {
      void createBranchForOverlay(post, branchOptions);
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

  // On commit, fold the source into its compact pinned preview. This has to run
  // after the commit render (not inside handleHoldBranch): the branch button/hold
  // fires without a drag having marked the post, so when the handler runs no DOM
  // node has .cur-post-item-source yet and settleFold can't find the foldable.
  // Here the class is committed to the DOM and the measure + collapse start
  // before paint.
  useIsoLayoutEffect(() => {
    if (!committedBranchUri) return;
    settleFold(true);
  }, [committedBranchUri, settleFold]);

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
    // The source stays a fixed size for the whole drag — it does not fold and its
    // banner does not grow (both would reflow the post on every pointer move and make
    // the swipe shake on a real phone). --branch-progress only drives the OTHER posts
    // receding, all via composited transforms. The fold + banner play once, on commit.
    if (t <= 0) {
      el.style.removeProperty("--branch-progress");
      if (branchDraggingRef.current) {
        branchDraggingRef.current = false;
        // Drop the class imperatively too (mirror of the add below) so the other
        // posts settle back via the base 0.28s transition the same frame
        // --branch-progress clears.
        el.classList.remove("cur-branch-dragging");
        setBranchDragging(false);
        // Deliberately do NOT clear pendingBranch here. t hits 0 not only on a
        // cancelled swipe but mid-gesture whenever the finger crosses back left
        // (a right→left→right wiggle without releasing). Clearing the source mark
        // on that transient zero un-marks this card as the branch source; the next
        // rightward frame then re-applies --branch-progress before React can
        // re-mark it, so for one frame the card is treated as a receding "other"
        // and visibly jumps left. Keeping the mark sticky for the whole gesture
        // means the source stays excluded from the recede throughout. It is
        // overwritten by the next card's onFirstRightDrag and cleared on
        // commit/reset, so a lingering mark after a plain cancel is inert (the
        // recede transforms only apply while --branch-progress / dragging is set).
      }
      return;
    }
    if (!branchDraggingRef.current) {
      branchDraggingRef.current = true;
      // Add the class imperatively, not only via React state. The recede CSS
      // (.cur-branch-dragging > .cur-post-item-other) only consumes
      // --branch-progress while this class is present. setBranchDragging is async,
      // so if we waited for the re-render the other posts would sit still for the
      // first frames of the drag and then snap to the current progress once the
      // class landed — a laggy, jumpy start. Setting it here lands the class on the
      // same frame as --branch-progress below; setBranchDragging keeps React's owned
      // className in sync so later renders preserve it.
      el.classList.add("cur-branch-dragging");
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
    void authedFetch("/api/swipe/negative", {
      method: "POST",
      body: JSON.stringify({ feedId, postUri: post.uri }),
    })
      .then(async (res) => {
        fetchingFollowupRef.current.delete(post.uri);
        const d = await res.json();
        const topics: NegativeTopic[] = Array.isArray(d.topics)
          ? (d.topics as NegativeTopic[])
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
      // Nested branch: tune this feed directly, then recompute only the tail so
      // the posts already read in the branch stay put (the read prefix isn't
      // yanked — same partial-refresh behaviour as the root feed).
      void authedFetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message, feedId }),
      })
        .then(() => loadPosts({ tail: true }))
        .catch(() => {});
    }
  }

  // An explicit swipe-left reject must suppress that exact post across reloads.
  // Tuning only adjusts the query (not the post), and a dismiss doesn't tune at
  // all, so without recording the post as seen now it can re-enter the next
  // snapshot. Record it via the same /api/seen path impressions use; the post-
  // tune reload (or the next Refresh) then filters it out. Best-effort and
  // idempotent server-side; fires well before any chat-driven reload completes.
  function markRejected(uri: string) {
    void authedFetch("/api/seen", {
      method: "POST",
      body: JSON.stringify({ feedId, uris: [uri] }),
      suppressErrorToast: true,
    }).catch(() => {});
  }

  function handleFollowupChipSend(post: Post, reason: string) {
    submitTune(post, reason);
    markRejected(post.uri);
    setSwipedUris((prev) => { const next = new Set(prev); next.add(post.uri); return next; });
  }
  function handleFollowupTextSend(post: Post, reason: string) {
    submitTune(post, reason);
    markRejected(post.uri);
  }
  function handleFollowupDismiss(uri: string) {
    markRejected(uri);
    setSwipedUris((prev) => { const next = new Set(prev); next.add(uri); return next; });
  }

  // ── Approve ("more like this") ──────────────────────────────────
  function submitApprove(post: Post, reason: string) {
    const token = `\u27e6swipe:approve:${post.uri}\u27e7`;
    const message = `${token} ${reason} Update my feed to show more of this.`;
    if (onTune) {
      onTune(message, post);
    } else {
      void authedFetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message, feedId }),
      })
        .then(() => loadPosts({ tail: true }))
        .catch(() => {});
    }
  }
  function handleApproveFollowupChipSend(post: Post, reason: string) {
    submitApprove(post, reason);
  }
  function handleApproveFollowupTextSend(post: Post, reason: string) {
    submitApprove(post, reason);
  }
  function handleApproveFollowupDismiss(_uri: string) {
    // Dismissing the approve panel just hides it — post stays in the feed.
  }

  return {
    branchDragging,
    committedBranchUri,
    branchReturning,
    swipedUris,
    othersCleared,
    returningSourceUri,
    pendingBranch,
    followupTopics,
    swipeRightTopics,
    sourceExpanded,
    setSourceExpanded,
    handleCardSwipe,
    handleRightProgress,
    onFirstRightDrag,
    fetchFollowupTopics,
    handleFollowupChipSend,
    handleFollowupTextSend,
    handleFollowupDismiss,
    handleApproveFollowupChipSend,
    handleApproveFollowupTextSend,
    handleApproveFollowupDismiss,
    handleHoldBranch,
    resetBranch,
    settleFold,
  };
}
