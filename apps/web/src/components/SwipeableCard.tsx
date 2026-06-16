"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  motion,
  useMotionValue,
  useTransform,
  animate,
  type PanInfo,
} from "framer-motion";

export type SwipeVerdict = "approve" | "reject";

// Past this much horizontal travel (offset + a slice of velocity), the swipe
// commits and the card flings off-screen.
const SWIPE_THRESHOLD = 120;

/**
 * Wraps a feed card so it can be dragged horizontally: left-to-right = approve
 * (keep), right-to-left = reject (nope). Vertical scrolling still works because
 * framer-motion sets touch-action: pan-y for drag="x".
 *
 * While dragging (and for a beat after), the card's contents get
 * pointer-events: none so the gesture can't accidentally activate a link inside
 * the post — without that, a swipe over an external-link card would open that
 * link in a new tab on release. A genuine tap (no drag) still works normally.
 */
export default function SwipeableCard({
  children,
  onSwipe,
  disabled = false,
}: {
  children: ReactNode;
  onSwipe: (v: SwipeVerdict) => void;
  disabled?: boolean;
}) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-260, 0, 260], [-7, 0, 7]);
  const keepOpacity = useTransform(x, [30, 150], [0, 1]);
  const nopeOpacity = useTransform(x, [-150, -30], [1, 0]);
  const tintKeep = useTransform(x, [20, 200], [0, 0.14]);
  const tintNope = useTransform(x, [-200, -20], [0.14, 0]);
  const decidedRef = useRef(false);
  const unlockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [locked, setLocked] = useState(false);

  // Eat the synthetic click the browser fires on release after a drag, so it
  // can't activate a post link / focus something underneath. Chat clicks pass
  // through so the chat the swipe opens stays usable.
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
    // Keep contents inert briefly so the trailing click after the spring-back
    // doesn't open a link the finger happened to lift over.
    unlockTimer.current = setTimeout(() => setLocked(false), 350);
  }

  return (
    <motion.div
      className="cur-swipe-wrap"
      style={{ x, rotate }}
      drag={disabled ? false : "x"}
      dragMomentum={false}
      onDragStart={disabled ? undefined : handleDragStart}
      onDragEnd={disabled ? undefined : handleDragEnd}
      whileTap={disabled ? undefined : { cursor: "grabbing" }}
    >
      <motion.span
        className="cur-swipe-tint cur-swipe-tint-keep"
        style={{ opacity: tintKeep }}
        aria-hidden
      />
      <motion.span
        className="cur-swipe-tint cur-swipe-tint-nope"
        style={{ opacity: tintNope }}
        aria-hidden
      />
      <motion.span
        className="cur-swipe-stamp cur-swipe-keep"
        style={{ opacity: keepOpacity }}
        aria-hidden
      >
        KEEP
      </motion.span>
      <motion.span
        className="cur-swipe-stamp cur-swipe-nope"
        style={{ opacity: nopeOpacity }}
        aria-hidden
      >
        NOPE
      </motion.span>
      <div
        className="cur-swipe-content"
        style={{ pointerEvents: locked ? "none" : undefined }}
      >
        {children}
      </div>
    </motion.div>
  );
}
