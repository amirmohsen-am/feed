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

  const wrapperRef = useRef<HTMLDivElement>(null);
  const naturalH = useRef(0);

  const followupRef = useRef<HTMLDivElement>(null);
  const followupNaturalH = useRef(0);

  // Tint overlay that appears inside the card when dragging right, signalling
  // "this opens something new".
  const branchTintRef = useRef<HTMLDivElement>(null);

  useMotionValueEvent(x, "change", (latest) => {
    if (latest < 0 && !firstLeftFired.current && onFirstLeftDrag) {
      firstLeftFired.current = true;
      onFirstLeftDrag();
    }
    if (latest > 0 && !firstRightFired.current && onFirstRightDrag) {
      firstRightFired.current = true;
      onFirstRightDrag();
    }
    if (onRightProgress) {
      onRightProgress(latest > 0 ? Math.min(1, latest / RIGHT_PROGRESS_DISTANCE) : 0);
    }

    const card = wrapperRef.current;
    if (card) {
      if (latest >= 0) {
        card.style.height = "";
        card.style.overflow = "";
      } else {
        if (!naturalH.current) naturalH.current = card.scrollHeight;
        const t = Math.min(1, -latest / COLLAPSE_DISTANCE);
        card.style.height = `${naturalH.current * (1 - t)}px`;
        card.style.overflow = "hidden";
      }
    }

    // Aurora tint builds up as you drag right toward the commit threshold.
    const tint = branchTintRef.current;
    if (tint) {
      tint.style.opacity = latest > 0 ? String(Math.min(1, latest / SWIPE_THRESHOLD)) : "0";
    }

    const followup = followupRef.current;
    if (followup) {
      if (latest >= 0) {
        followup.style.height = "0";
        followup.style.overflow = "hidden";
        followup.style.opacity = "0";
      } else {
        if (!followupNaturalH.current) {
          const prev = followup.style.height;
          followup.style.height = "auto";
          followupNaturalH.current = followup.scrollHeight;
          followup.style.height = prev;
        }
        const t = Math.min(1, -latest / COLLAPSE_DISTANCE);
        const h = followupNaturalH.current || 120;
        followup.style.height = `${h * t}px`;
        followup.style.overflow = "hidden";
        followup.style.opacity = String(t);
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
      onSwipe(v);
    },
    [x, onSwipe, swallowNextClick]
  );

  function handleDragStart() {
    if (unlockTimer.current) clearTimeout(unlockTimer.current);
    setLocked(true);
    if (wrapperRef.current) {
      wrapperRef.current.style.position = "relative";
      wrapperRef.current.style.zIndex = "10";
    }
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
    animate(x, 0, { type: "spring", stiffness: 340, damping: 32 });
    if (wrapperRef.current) {
      wrapperRef.current.style.position = "";
      wrapperRef.current.style.zIndex = "";
    }
    unlockTimer.current = setTimeout(() => setLocked(false), 350);
  }

  return (
    <>
      <div ref={wrapperRef}>
        <motion.div
          className="cur-swipe-wrap"
          style={{ x, scale }}
          drag={disabled ? false : "x"}
          dragMomentum={false}
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
        <div ref={followupRef} style={{ height: 0, overflow: "hidden", opacity: 0 }}>
          {followupContent}
        </div>
      )}
    </>
  );
}
