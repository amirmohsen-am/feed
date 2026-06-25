"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { motion, useMotionValue, useTransform, animate } from "framer-motion";

export type SwipeVerdict = "approve" | "reject";

const SWIPE_THRESHOLD = 120;       // left (skip) commit distance
const COLLAPSE_DISTANCE = 260;     // left collapse range
const BRANCH_COLLAPSE_DISTANCE = 210; // right fold range (prototype COLLAPSE_DIST)
const BRANCH_COMMIT = 0.5;         // fraction of the fold at which a release branches
const TX_MAX = 132;                // rubber-band asymptote for the rightward ride

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const cl01 = (v: number) => Math.max(0, Math.min(1, v));
// iOS-style rubber band: rides the finger, then resists toward an asymptote so
// the card never travels more than ~TX_MAX no matter how far you drag.
const rubber = (d: number) => TX_MAX * (1 - Math.exp(-d / TX_MAX));

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
  /** Called on every right-drag frame with t ∈ [0,1] (0 = at rest, 1 = fully folded). */
  onRightProgress?: (t: number) => void;
  disabled?: boolean;
}) {
  // Visual transform we own directly (so the rightward ride can be rubber-banded
  // independently of the raw pointer distance that drives the fold).
  const xv = useMotionValue(0);
  const scale = useTransform(xv, [-260, 0], [0.82, 1]);

  const decidedRef = useRef(false);
  const firstLeftFired = useRef(false);
  const firstRightFired = useRef(false);
  const unlockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [locked, setLocked] = useState(false);

  // Pointer-drag bookkeeping.
  const draggingRef = useRef(false);
  const engagedRef = useRef(false);      // horizontal intent confirmed
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const dxRef = useRef(0);
  const lastXRef = useRef(0);
  const lastTRef = useRef(0);
  const velRef = useRef(0);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const naturalH = useRef(0);

  const followupRef = useRef<HTMLDivElement>(null);
  const followupNaturalH = useRef(0);

  const branchActionRef = useRef<HTMLDivElement>(null);

  // Set true once a swipe-right has committed; lets the Back-driven re-arm
  // (disabled → false) know to reset the gesture latches.
  const branchCommittedRef = useRef(false);

  // Clear the "release to branch" affordance (used on cancel / Back).
  const clearBranchAction = useCallback(() => {
    const action = branchActionRef.current;
    if (action) { action.style.opacity = "0"; action.classList.remove("ready"); }
  }, []);

  const setLeftCollapse = useCallback((dx: number) => {
    const card = wrapperRef.current;
    if (card) {
      if (dx >= 0) { card.style.height = ""; card.style.overflow = ""; }
      else {
        if (!naturalH.current) naturalH.current = card.scrollHeight;
        const t = Math.min(1, -dx / COLLAPSE_DISTANCE);
        card.style.height = `${naturalH.current * (1 - t)}px`;
        card.style.overflow = "hidden";
      }
    }
    const followup = followupRef.current;
    if (followup) {
      if (dx >= 0) { followup.style.height = "0"; followup.style.overflow = "hidden"; followup.style.opacity = "0"; }
      else {
        if (!followupNaturalH.current) {
          const prev = followup.style.height;
          followup.style.height = "auto";
          followupNaturalH.current = followup.scrollHeight;
          followup.style.height = prev;
        }
        const t = Math.min(1, -dx / COLLAPSE_DISTANCE);
        const h = followupNaturalH.current || 120;
        followup.style.height = `${h * t}px`;
        followup.style.overflow = "hidden";
        followup.style.opacity = String(t);
      }
    }
  }, []);

  const swallowNextClick = useCallback(() => {
    const swallow = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && t.closest(".cur-chat-pane")) return;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true });
    window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 400);
  }, []);

  const commitApprove = useCallback(() => {
    if (decidedRef.current) return;
    decidedRef.current = true;
    branchCommittedRef.current = true;
    swallowNextClick();
    // The source post renders as a normal full post in the parent (marked by the
    // "Branched from" banner) — no fold to undo. Just unlock content so its links
    // stay clickable and settle the card back to x=0.
    setLocked(false);
    const action = branchActionRef.current;
    if (action) { action.style.transition = "opacity 0.2s"; action.style.opacity = "0"; }
    // Settle the rubber-banded ride back to x=0 quickly and decisively — a lazy
    // spring leaves the card visibly drifting rightward while the parent is
    // already lifting it to the top, which reads as a two-step "right, then up".
    // A short ease-out gets the horizontal out of the way so the vertical lift
    // is the only motion the eye tracks.
    animate(xv, 0, { duration: 0.2, ease: [0.4, 0, 0.2, 1] });
    onSwipe("approve");
  }, [xv, onSwipe, swallowNextClick]);

  const commitReject = useCallback(() => {
    if (decidedRef.current) return;
    decidedRef.current = true;
    swallowNextClick();
    animate(xv, -1200, { type: "spring", stiffness: 190, damping: 28 });
    onSwipe("reject");
  }, [xv, onSwipe, swallowNextClick]);

  // On Back the parent flips `disabled` false again — re-arm the gesture so the
  // post is fully interactive once more.
  useEffect(() => {
    if (!disabled && branchCommittedRef.current) {
      branchCommittedRef.current = false;
      decidedRef.current = false;
      firstRightFired.current = false;
      firstLeftFired.current = false;
      clearBranchAction();
      setLocked(false);
    }
  }, [disabled, clearBranchAction]);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (disabled || decidedRef.current) return;
    draggingRef.current = true;
    engagedRef.current = false;
    // Re-arm the first-drag latches each gesture. Otherwise a cancelled right
    // drag leaves firstRightFired=true, so a second right drag never re-fires
    // onFirstRightDrag → the card isn't re-marked the branch source → it recedes
    // (slides left + fades) along with the others. (Fetches are idempotent.)
    firstLeftFired.current = false;
    firstRightFired.current = false;
    startXRef.current = e.clientX;
    startYRef.current = e.clientY;
    dxRef.current = 0;
    lastXRef.current = e.clientX;
    lastTRef.current = e.timeStamp;
    velRef.current = 0;
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const dx = e.clientX - startXRef.current;
    const dy = e.clientY - startYRef.current;

    if (!engagedRef.current) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if (Math.abs(dy) > Math.abs(dx)) { draggingRef.current = false; return; } // vertical scroll
      engagedRef.current = true;
      setLocked(true);
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (wrapperRef.current) { wrapperRef.current.style.position = "relative"; wrapperRef.current.style.zIndex = "10"; }
    }

    const dt = e.timeStamp - lastTRef.current;
    if (dt > 0) velRef.current = (e.clientX - lastXRef.current) / dt;
    lastXRef.current = e.clientX;
    lastTRef.current = e.timeStamp;
    dxRef.current = dx;

    if (dx > 0) {
      // The card just rides right (rubber-banded) while the other posts recede;
      // no fold/collapse of its own content.
      if (!firstRightFired.current) { firstRightFired.current = true; onFirstRightDrag?.(); }
      xv.set(rubber(dx));
      const t = Math.min(1, dx / BRANCH_COLLAPSE_DISTANCE);
      onRightProgress?.(t);
      const action = branchActionRef.current;
      if (action) {
        const reveal = cl01(dx / 70);
        action.style.opacity = String(reveal);
        action.style.transform = `translateY(-50%) translateX(${lerp(-12, 0, reveal)}px)`;
        action.classList.toggle("ready", t >= BRANCH_COMMIT);
      }
      setLeftCollapse(0);
    } else {
      if (!firstLeftFired.current) { firstLeftFired.current = true; onFirstLeftDrag?.(); }
      xv.set(dx);
      onRightProgress?.(0);
      setLeftCollapse(dx);
    }
  }

  function endDrag() {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const dx = dxRef.current;
    if (!engagedRef.current) { setLocked(false); return; }

    const power = dx + velRef.current * 90; // velocity is px/ms → weight a flick
    const t = Math.max(0, dx) / BRANCH_COLLAPSE_DISTANCE;

    if (dx > 0 && (t >= BRANCH_COMMIT || power > SWIPE_THRESHOLD)) {
      commitApprove();
      return;
    }
    if (power < -SWIPE_THRESHOLD) {
      commitReject();
      return;
    }
    // Cancel — settle back to rest. Also tell the parent the rightward progress
    // is back to 0 so the *other* posts (which receded via --branch-progress)
    // animate back in; without this they stay stuck mid-recede.
    onRightProgress?.(0);
    clearBranchAction();
    animate(xv, 0, { type: "spring", stiffness: 340, damping: 32 });
    if (wrapperRef.current) { wrapperRef.current.style.position = ""; wrapperRef.current.style.zIndex = ""; }
    unlockTimer.current = setTimeout(() => setLocked(false), 350);
  }

  return (
    <>
      <div ref={wrapperRef} style={{ position: "relative" }}>
        {/* Branch affordance revealed on the left as the card rides right. */}
        <div ref={branchActionRef} className="cur-swipe-branch-action" style={{ opacity: 0 }} aria-hidden>
          <span className="cur-swipe-branch-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="6" r="2.4" />
              <circle cx="6" cy="18" r="2.4" />
              <circle cx="18" cy="9" r="2.4" />
              <path d="M6 8.4v7.2M8.2 7 16 8.6M8 17l8-6.6" />
            </svg>
          </span>
          <span className="cur-swipe-branch-label">release to branch</span>
        </div>
        <motion.div
          className="cur-swipe-wrap"
          style={{ x: xv, scale, position: "relative", zIndex: 1 }}
          onPointerDown={disabled ? undefined : onPointerDown}
          onPointerMove={disabled ? undefined : onPointerMove}
          onPointerUp={disabled ? undefined : endDrag}
          onPointerCancel={disabled ? undefined : endDrag}
        >
          <div className="cur-swipe-content" style={{ pointerEvents: locked ? "none" : undefined }}>
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
