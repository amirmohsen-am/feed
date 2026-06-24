"use client";

import { useCallback, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
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

  const branchTintRef = useRef<HTMLDivElement>(null);
  const branchActionRef = useRef<HTMLDivElement>(null);

  // ── Branch fold targets (measured lazily on first rightward drag) ──
  const branchCommittedRef = useRef(false);
  const foldMeasured = useRef(false);
  const cardElRef = useRef<HTMLElement | null>(null);
  const avatarElRef = useRef<HTMLElement | null>(null);
  const flagElRef = useRef<HTMLElement | null>(null);
  const naturalCardH = useRef(0);
  const compactCardH = useRef(0);

  const measureFold = useCallback(() => {
    const wrap = wrapperRef.current;
    if (!wrap) return;
    const card = wrap.querySelector<HTMLElement>(".cur-post-card");
    if (!card) return;
    cardElRef.current = card;
    avatarElRef.current = wrap.querySelector<HTMLElement>(".cur-post-avatar");
    flagElRef.current = wrap.querySelector<HTMLElement>(".cur-post-branch-flag");
    const head = wrap.querySelector<HTMLElement>(".cur-post-card-head");
    const prevMax = card.style.maxHeight;
    card.style.maxHeight = "none";
    naturalCardH.current = card.offsetHeight;
    card.style.maxHeight = prevMax;
    const headH = head?.offsetHeight ?? 48;
    compactCardH.current = headH + 84; // flag + header + one body line + compact paddings
    foldMeasured.current = true;
  }, []);

  const applyFold = useCallback((t: number) => {
    const card = cardElRef.current;
    if (!card) return;
    const avatar = avatarElRef.current;
    const flag = flagElRef.current;
    const av = cl01((t - 0.15) / 0.7);
    const flagP = cl01((t - 0.5) / 0.5);
    card.style.overflow = "hidden";
    card.style.maxHeight = `${lerp(naturalCardH.current, compactCardH.current, t)}px`;
    card.style.paddingTop = card.style.paddingBottom = `${lerp(16, 11, t)}px`;
    if (avatar) {
      avatar.style.width = avatar.style.height = `${lerp(40, 30, av)}px`;
      avatar.style.fontSize = `${lerp(16, 12, av)}px`;
    }
    if (flag) {
      flag.style.maxHeight = `${lerp(0, 20, flagP)}px`;
      flag.style.opacity = String(flagP);
    }
  }, []);

  const setFoldTransition = useCallback((on: boolean) => {
    const trans = on
      ? "max-height 0.42s cubic-bezier(0.34,0,0.2,1), padding 0.42s, width 0.32s, height 0.32s, font-size 0.32s, opacity 0.32s"
      : "none";
    [cardElRef.current, avatarElRef.current, flagElRef.current].forEach((el) => {
      if (el) el.style.transition = trans;
    });
  }, []);

  const resetFold = useCallback((animated: boolean) => {
    setFoldTransition(animated);
    const card = cardElRef.current;
    const avatar = avatarElRef.current;
    const flag = flagElRef.current;
    if (card) { card.style.maxHeight = ""; card.style.overflow = ""; card.style.paddingTop = card.style.paddingBottom = ""; }
    if (avatar) { avatar.style.width = avatar.style.height = ""; avatar.style.fontSize = ""; }
    if (flag) { flag.style.maxHeight = "0"; flag.style.opacity = "0"; }
    const action = branchActionRef.current;
    if (action) { action.style.opacity = "0"; action.classList.remove("ready"); }
  }, [setFoldTransition]);

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
    // Keep the card (folded) and settle it back to x=0 with a springy bounce.
    setFoldTransition(true);
    applyFold(1);
    const action = branchActionRef.current;
    if (action) { action.style.transition = "opacity 0.2s"; action.style.opacity = "0"; }
    animate(xv, 0, { type: "spring", stiffness: 240, damping: 20 });
    onSwipe("approve");
  }, [xv, onSwipe, swallowNextClick, applyFold, setFoldTransition]);

  const commitReject = useCallback(() => {
    if (decidedRef.current) return;
    decidedRef.current = true;
    swallowNextClick();
    animate(xv, -1200, { type: "spring", stiffness: 190, damping: 28 });
    onSwipe("reject");
  }, [xv, onSwipe, swallowNextClick]);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (disabled || decidedRef.current) return;
    // Ignore clicks on interactive children (links/buttons) — let them through.
    draggingRef.current = true;
    engagedRef.current = false;
    startXRef.current = e.clientX;
    startYRef.current = e.clientY;
    dxRef.current = 0;
    lastXRef.current = e.clientX;
    lastTRef.current = e.timeStamp;
    velRef.current = 0;
    setFoldTransition(false);
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

    // velocity (px/ms)
    const dt = e.timeStamp - lastTRef.current;
    if (dt > 0) velRef.current = (e.clientX - lastXRef.current) / dt;
    lastXRef.current = e.clientX;
    lastTRef.current = e.timeStamp;
    dxRef.current = dx;

    if (dx > 0) {
      if (!firstRightFired.current) { firstRightFired.current = true; onFirstRightDrag?.(); }
      if (!foldMeasured.current) measureFold();
      setFoldTransition(false);
      xv.set(rubber(dx));
      const t = Math.min(1, dx / BRANCH_COLLAPSE_DISTANCE);
      applyFold(t);
      onRightProgress?.(t);
      const action = branchActionRef.current;
      if (action) {
        const reveal = cl01(dx / 70);
        action.style.opacity = String(reveal);
        action.style.transform = `translateY(-50%) translateX(${lerp(-12, 0, reveal)}px)`;
        action.classList.toggle("ready", t >= BRANCH_COMMIT);
      }
      const tint = branchTintRef.current;
      if (tint) tint.style.opacity = String(Math.min(1, dx / SWIPE_THRESHOLD));
      setLeftCollapse(0);
    } else {
      if (!firstLeftFired.current) { firstLeftFired.current = true; onFirstLeftDrag?.(); }
      xv.set(dx);
      onRightProgress?.(0);
      const tint = branchTintRef.current;
      if (tint) tint.style.opacity = "0";
      if (foldMeasured.current) resetFold(false);
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
    // Cancel — un-fold and settle back to rest.
    if (foldMeasured.current) resetFold(true);
    animate(xv, 0, { type: "spring", stiffness: 340, damping: 32 });
    const tint = branchTintRef.current;
    if (tint) tint.style.opacity = "0";
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
          {/* Branch tint: aurora wash that builds as you drag right */}
          <div ref={branchTintRef} className="cur-swipe-branch-tint" style={{ opacity: 0 }} aria-hidden />
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
