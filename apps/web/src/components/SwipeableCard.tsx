"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  motion,
  useMotionValue,
  useTransform,
  useMotionValueEvent,
  animate,
  type PanInfo,
} from "framer-motion";

export type SwipeVerdict = "approve" | "reject";

const SWIPE_THRESHOLD = 120;
const COLLAPSE_DISTANCE = 260;
// How far the card must travel for onRightProgress to reach t=1.
// Larger than SWIPE_THRESHOLD so the panel is still rising at release — the
// CSS spring then finishes the job after the card is let go.
const RIGHT_PROGRESS_DISTANCE = 400;

export default function SwipeableCard({
  children,
  followupContent,
  onSwipe,
  onFirstLeftDrag,
  onFirstRightDrag,
  onRightProgress,
  disabled = false,
}: {
  children: ReactNode;
  followupContent?: ReactNode;
  onSwipe: (v: SwipeVerdict) => void;
  onFirstLeftDrag?: () => void;
  onFirstRightDrag?: () => void;
  /** Called on every right-drag frame with t ∈ [0,1] (0 = at rest, 1 = at threshold). */
  onRightProgress?: (t: number) => void;
  disabled?: boolean;
}) {
  const x = useMotionValue(0);
  const scale = useTransform(x, [-260, 0, 260], [0.82, 1, 1.08]);
  const decidedRef = useRef(false);
  const firstLeftFired = useRef(false);
  const firstRightFired = useRef(false);
  const unlockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [locked, setLocked] = useState(false);

  // containerRef wraps card + followup and is pinned to its exact rendered
  // height for the entire duration of a drag. The card below is a sibling of
  // containerRef in the DOM, so it never sees a layout shift regardless of
  // how the card and followup heights change inside the container.
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const naturalH = useRef(0);      // card's content height for collapse math
  const followupRef = useRef<HTMLDivElement>(null);
  const followupNaturalH = useRef(0); // measured lazily on first left drag

  // Tint overlay that appears inside the card when dragging right.
  const branchTintRef = useRef<HTMLDivElement>(null);

  // Snap-back state — set on release, cleared on next drag-start.
  const isSpringBackRef = useRef(false);
  const snapBackNegRef = useRef(false);   // release was from negative x (left drag)
  const heightsLockedRef = useRef(false); // x has crossed zero; styles pinned

  // Gesture direction lock: determined from raw pointer movement so that a
  // mostly-vertical scroll never accidentally activates the horizontal drag.
  const pointerStartRef = useRef({ x: 0, y: 0 });
  const gestureDirRef = useRef<"unknown" | "h" | "v">("unknown");

  const logNextCardTop = (label: string) => {
    const container = containerRef.current;
    const nextItem = container?.parentElement?.nextElementSibling;
    const top = nextItem?.getBoundingClientRect().top ?? null;
    const cH = container ? getComputedStyle(container).height : "?";
    const wH = wrapperRef.current ? getComputedStyle(wrapperRef.current).height : "?";
    const fH = followupRef.current ? getComputedStyle(followupRef.current).height : "?";
    console.log(`[SwipeCard] ${label} | next.top=${top?.toFixed(1)} scrollY=${window.scrollY.toFixed(1)} | c=${cH} w=${wH} f=${fH}`);
  };

  useMotionValueEvent(x, "change", (latest) => {
    // If the gesture is predominantly vertical, keep x at zero and bail.
    // This prevents vertical scrolling from accidentally drifting the card.
    if (gestureDirRef.current === "v") {
      if (x.get() !== 0) x.set(0);
      return;
    }

    if (latest < 0 && !firstLeftFired.current && onFirstLeftDrag) {
      firstLeftFired.current = true;
      logNextCardTop(`onFirstLeftDrag x=${latest.toFixed(1)}`);
      onFirstLeftDrag();
    }
    if (latest > 0 && !firstRightFired.current && onFirstRightDrag) {
      firstRightFired.current = true;
      onFirstRightDrag();
    }
    if (onRightProgress) {
      onRightProgress(latest > 0 ? Math.min(1, latest / RIGHT_PROGRESS_DISTANCE) : 0);
    }

    // Aurora tint always tracks x so it fades smoothly during snap-back too.
    const tint = branchTintRef.current;
    if (tint) {
      tint.style.opacity = latest > 0 ? String(Math.min(1, latest / SWIPE_THRESHOLD)) : "0";
    }

    if (isSpringBackRef.current) {
      if (!heightsLockedRef.current) {
        // x has crossed zero back toward rest — pin everything at neutral and
        // release the container so it returns to its natural auto height.
        const settled = snapBackNegRef.current ? latest >= 0 : latest <= 0;
        if (settled) {
          heightsLockedRef.current = true;
          logNextCardTop(`lock-before x=${latest.toFixed(1)}`);
          const card = wrapperRef.current;
          if (card) { card.style.height = ""; card.style.overflow = ""; }
          const followup = followupRef.current;
          if (followup) { followup.style.height = ""; followup.style.opacity = ""; }
          const container = containerRef.current;
          if (container) { container.style.height = ""; container.style.overflow = ""; container.style.overflowClipMargin = ""; }
          naturalH.current = 0;
          followupNaturalH.current = 0;
          logNextCardTop(`lock-after x=${latest.toFixed(1)}`);
        } else if (snapBackNegRef.current) {
          // Left-drag snap-back in progress — mirror the same formula used
          // during active drag so the two heights always move in sync.
          const t = Math.min(1, -latest / COLLAPSE_DISTANCE);
          const card = wrapperRef.current;
          if (card && naturalH.current > 0) {
            card.style.height = `${naturalH.current * (1 - t)}px`;
          }
          const followup = followupRef.current;
          if (followup && followupNaturalH.current > 0) {
            followup.style.height = `${followupNaturalH.current * t}px`;
            followup.style.opacity = String(t);
          }
        }
      }
      return;
    }

    // ── Active drag ──────────────────────────────────────────────────────────
    const card = wrapperRef.current;
    if (card) {
      if (latest >= 0) {
        card.style.height = "";
        card.style.overflow = "";
      } else {
        // On the very first drag ever, Framer Motion fires motion events before
        // onDragStart (motion value updates as soon as the pointer moves; the
        // drag-start callback fires only after the threshold is crossed).
        // Lazily initialize here so naturalH is valid before we use it.
        if (!naturalH.current) {
          naturalH.current = card.scrollHeight;
          const container = containerRef.current;
          if (container && !container.style.height) {
            const h = container.getBoundingClientRect().height;
            container.style.height = `${h}px`;
            container.style.overflow = "clip";
          }
        }
        const firstOverflow = !card.style.overflow;
        const t = Math.min(1, -latest / COLLAPSE_DISTANCE);
        card.style.height = `${naturalH.current * (1 - t)}px`;
        // overflow:clip clips the collapsing card content visually without
        // creating a BFC. overflow:hidden would create a BFC, which stops the
        // wrapperRef's margin-top from collapsing through to cur-post-item —
        // shifting every card below by 8px the moment a left drag begins.
        card.style.overflow = "clip";
        if (firstOverflow) logNextCardTop(`card-overflow-set x=${latest.toFixed(1)} t=${t.toFixed(3)}`);
      }
    }

    const followup = followupRef.current;
    if (followup) {
      if (latest >= 0) {
        followup.style.height = "0";
        followup.style.opacity = "";
      } else {
        // Measure natural height once, lazily, on first left-drag frame.
        const firstMeasure = !followupNaturalH.current;
        if (firstMeasure) {
          const prev = followup.style.height;
          followup.style.height = "auto";
          followupNaturalH.current = followup.scrollHeight || 120;
          followup.style.height = prev;
        }
        const t = Math.min(1, -latest / COLLAPSE_DISTANCE);
        followup.style.height = `${followupNaturalH.current * t}px`;
        followup.style.opacity = String(t);
        if (firstMeasure) logNextCardTop(`followup-height-set x=${latest.toFixed(1)} natH=${followupNaturalH.current} h=${(followupNaturalH.current * t).toFixed(2)}`);
      }
    }
  });

  const swallowNextClick = useCallback(() => {
    const swallow = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && t.closest(".cur-chat-pane")) return;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true });
    window.setTimeout(
      () => window.removeEventListener("click", swallow, { capture: true }),
      400
    );
  }, []);

  const fling = useCallback(
    (v: SwipeVerdict) => {
      if (decidedRef.current) return;
      decidedRef.current = true;
      swallowNextClick();
      animate(x, v === "approve" ? 1200 : -1200, {
        type: "spring",
        stiffness: 190,
        damping: 28,
      });

      if (v === "reject") {
        // The card flies off left; the followup card stays in the feed as the
        // replacement. Collapse the card's layout height to 0, expand the followup
        // to its natural height, and release the container so the feed item shrinks
        // to the followup's size rather than leaving a gap.
        const card = wrapperRef.current;
        if (card) {
          card.style.height = "0";
          card.style.overflow = "clip";
          card.style.position = "";
          card.style.zIndex = "";
        }
        const followup = followupRef.current;
        if (followup) {
          followup.style.height = "auto";
          followup.style.opacity = "1";
        }
        const container = containerRef.current;
        if (container) {
          container.style.height = "";
          container.style.overflow = "";
        }
      }

      onSwipe(v);
    },
    [x, onSwipe, swallowNextClick]
  );

  function handleDragStart(_: unknown, info: PanInfo) {
    // At the moment Framer Motion recognizes the drag, info.offset holds the
    // total displacement since touch-down. If the finger has moved more
    // vertically than horizontally this is a scroll/pull-to-refresh gesture —
    // lock it to vertical and bail before any card state is touched.
    if (Math.abs(info.offset.y) >= Math.abs(info.offset.x)) {
      gestureDirRef.current = "v";
      return;
    }
    gestureDirRef.current = "h";
    isSpringBackRef.current = false;
    snapBackNegRef.current = false;
    heightsLockedRef.current = false;
    followupNaturalH.current = 0;
    // naturalH is NOT reset to 0 here. On the very first drag ever, Framer
    // Motion fires motion events before this callback (motion value updates on
    // pointer-move; onDragStart fires only after the threshold is crossed). The
    // lazy-init inside the motion event handler may have already set naturalH
    // and pinned the container correctly. Resetting and re-measuring here would
    // read a partially-collapsed card and pin the container to the wrong height.

    const card = wrapperRef.current;
    const container = containerRef.current;
    if (card && container) {
      if (!naturalH.current) {
        // Normal path: this callback fired before any motion events.
        naturalH.current = card.scrollHeight;
        const containerH = container.getBoundingClientRect().height;
        logNextCardTop(`dragStart-before cardH=${naturalH.current} containerH=${containerH.toFixed(2)}`);
        container.style.height = `${containerH}px`;
        // overflow:clip clips content visually without creating a Block Formatting
        // Context. overflow:hidden would create a BFC, which stops the wrapperRef's
        // top margin from collapsing through to cur-post-item — shifting cur-post-item
        // and every card below it by 8px. overflow:clip has no such side effect.
        container.style.overflow = "clip";
        logNextCardTop(`dragStart-after`);
      } else {
        // First-drag race: motion events already lazily initialized naturalH
        // and pinned the container — nothing more needed here.
        logNextCardTop(`dragStart (lazy-init already ran, naturalH=${naturalH.current})`);
      }
      card.style.position = "relative";
      card.style.zIndex = "10";
    }

    if (unlockTimer.current) clearTimeout(unlockTimer.current);
    setLocked(true);
  }

  function handleDragEnd(_: unknown, info: PanInfo) {
    const power = info.offset.x + info.velocity.x * 0.25;
    if (power > SWIPE_THRESHOLD) {
      fling("approve");
      return;
    }
    if (power < -SWIPE_THRESHOLD) {
      fling("reject");
      return;
    }

    const curX = x.get();
    logNextCardTop(`dragEnd x=${curX.toFixed(1)} power=${power.toFixed(1)}`);
    isSpringBackRef.current = true;
    snapBackNegRef.current = curX < 0;
    heightsLockedRef.current = false;

    const card = wrapperRef.current;
    if (card) {
      card.style.position = "";
      card.style.zIndex = "";
    }

    // velocity: 0 ensures the spring always starts moving toward 0 immediately
    // rather than inheriting the gesture's final velocity, which could briefly
    // push the card further collapsed before reversing (a visible re-bounce).
    animate(x, 0, { type: "spring", stiffness: 340, damping: 32, velocity: 0 });
    unlockTimer.current = setTimeout(() => setLocked(false), 350);
  }

  return (
    <div ref={containerRef}>
      <div ref={wrapperRef}>
        <motion.div
          className="cur-swipe-wrap"
          style={{ x, scale }}
          drag={disabled ? false : "x"}
          dragMomentum={false}
          onPointerDown={(e) => {
            pointerStartRef.current = { x: e.clientX, y: e.clientY };
            gestureDirRef.current = "unknown";
          }}
          onPointerMove={(e) => {
            if (!e.buttons || gestureDirRef.current !== "unknown") return;
            const dx = Math.abs(e.clientX - pointerStartRef.current.x);
            const dy = Math.abs(e.clientY - pointerStartRef.current.y);
            if (dx + dy < 6) return; // wait for enough movement to judge direction
            // Require clearly horizontal movement: dx must exceed dy.
            // A diagonal or mostly-vertical touch stays as scroll.
            gestureDirRef.current = dx > dy ? "h" : "v";
          }}
          onDragStart={disabled ? undefined : handleDragStart}
          onDragEnd={disabled ? undefined : handleDragEnd}
          whileTap={disabled ? undefined : { cursor: "grabbing" }}
        >
          {/* Branch tint: aurora wash that builds as you drag right */}
          <div ref={branchTintRef} className="cur-swipe-branch-tint" style={{ opacity: 0 }} aria-hidden />
          <div
            className="cur-swipe-content"
            style={{ pointerEvents: locked ? "none" : undefined }}
          >
            {children}
          </div>
        </motion.div>
      </div>
      {followupContent != null && (
        <div ref={followupRef} className="cur-swipe-followup-wrap">
          {followupContent}
        </div>
      )}
    </div>
  );
}
