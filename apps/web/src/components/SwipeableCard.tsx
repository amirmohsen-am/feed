"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent, Fragment } from "react";
import { motion, useMotionValue, useTransform, animate } from "framer-motion";

export type SwipeVerdict = "approve" | "reject";

const SWIPE_THRESHOLD = 120;       // right flick commit power
const BRANCH_COLLAPSE_DISTANCE = 210; // right rubber-band range
const BRANCH_COMMIT = 0.5;         // fraction at which a right-drag release approves
const HOLD_DELAY = 550;            // ms before a stationary press becomes a hold
const TX_MAX = 224;                // rubber-band asymptote for the rightward ride
// Left "less like this" reveal-and-confirm (iMessage style): the card parks open
// to a red dot that mirrors the swipe-right "Dive deeper" dot; tap it or slide
// all the way to commit.
const LESS_OPEN = 120;             // parked-open distance — just far enough to reveal the dot + label
const LESS_FULL = 250;             // slide-all-the-way commit distance
const LESS_DOT = 46;               // circle diameter (mirrors the branch dot)

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const cl01 = (v: number) => Math.max(0, Math.min(1, v));
// iOS-style rubber band: rides the finger, then resists toward an asymptote so
// the card never travels more than ~TX_MAX no matter how far you drag.
const rubber = (d: number) => TX_MAX * (1 - Math.exp(-d / TX_MAX));

export default function SwipeableCard({
  children,
  followupContent,
  approveFollowupContent,
  onSwipe,
  onFirstLeftDrag,
  onFirstRightDrag,
  onHoldStart,
  onBranch,
  disabled = false,
}: {
  children: ReactNode;
  followupContent?: ReactNode;
  approveFollowupContent?: ReactNode;
  onSwipe: (v: SwipeVerdict) => void;
  onFirstLeftDrag?: () => void;
  /** Called on the first rightward drag frame — use to preload approve topics. */
  onFirstRightDrag?: () => void;
  /** Called when a hold gesture activates — use to preload branch topics. */
  onHoldStart?: () => void;
  /** Called when the Dive Deeper button in the hold overlay is tapped. */
  onBranch?: () => void;
  disabled?: boolean;
}) {
  // Visual transform we own directly (so the rightward ride can be rubber-banded
  // independently of the raw pointer distance that drives the fold).
  const xv = useMotionValue(0);

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
  const followupRef = useRef<HTMLDivElement>(null);
  const branchActionRef = useRef<HTMLDivElement>(null);
  const branchIconRef = useRef<HTMLSpanElement>(null);
  const lessActionRef = useRef<HTMLDivElement>(null);
  const approveFollowupRef = useRef<HTMLDivElement>(null);
  const lessPillRef = useRef<HTMLButtonElement>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdActiveRef = useRef(false);
  const [holdActive, setHoldActive] = useState(false);
  // True once the approve panel has been shown — card stays interactive after approve.
  const approveShownRef = useRef(false);
  // Incrementing this key force-remounts the approve panel content (e.g. after dismiss).
  const [approveKey, setApproveKey] = useState(0);
  // Drives the square-bottom-corner class on the card while the panel is visible.
  const [approveOpen, setApproveOpen] = useState(false);

  // Left "less like this" gesture: whether the card is parked open (iMessage
  // style), and the resting x the next drag builds on (0 normally, -LESS_OPEN
  // when parked).
  const leftOpenRef = useRef(false);
  const baseXRef = useRef(0);

  // Set true once a swipe-right has committed; lets the Back-driven re-arm
  // (disabled → false) know to reset the gesture latches.
  const branchCommittedRef = useRef(false);

  // Clear the "release to branch" affordance (used on cancel / Back).
  const clearBranchAction = useCallback(() => {
    const action = branchActionRef.current;
    if (action) {
      action.style.opacity = "0";
      action.style.transition = "";
      action.classList.remove("ready", "plus-confirming", "plus-filled");
    }
    branchIconRef.current?.style.removeProperty("--branch-fill");
  }, []);

  // Keep the approve panel x-aligned with the card on every frame — covers the
  // initial spring-back, subsequent drags while the panel is visible, and any
  // left-swipe that moves the card while the panel is still shown.
  useEffect(() => {
    return xv.on("change", (x) => {
      const f = approveFollowupRef.current;
      if (f && approveShownRef.current) f.style.transform = `translateX(${x}px)`;
    });
  }, [xv]);

  // Detect when the approve panel collapses (X button, dismiss, left-swipe) and
  // restore the card's bottom border-radius regardless of which path closed it.
  useEffect(() => {
    const f = approveFollowupRef.current;
    if (!f) return;
    let wasOpen = false;
    const obs = new ResizeObserver(([entry]) => {
      const isOpen = entry.contentRect.height > 5;
      if (wasOpen && !isOpen) setApproveOpen(false);
      wasOpen = isOpen;
    });
    obs.observe(f);
    return () => obs.disconnect();
  }, []);

  // Imperatively drive the red "less like this" circle from the card's x.
  // Stays a circle (no oval stretch) — mirrors the "more like this" indicator.
  const paintLessPill = useCallback((x: number) => {
    const wrap = lessActionRef.current;
    const pill = lessPillRef.current;
    if (!wrap || !pill) return;
    const gap = Math.max(0, -x);
    const readyAt = LESS_OPEN * 0.55;
    const ready = gap >= readyAt;
    wrap.classList.toggle("ready", ready);
    wrap.style.opacity = String(Math.min(gap / (LESS_OPEN * 0.4), 1));
    const scale = ready ? 1.08 : 0.7 + Math.min(gap / readyAt, 1) * 0.3;
    pill.style.transform = `scale(${scale})`;
  }, []);

  const settleLessPill = useCallback((open: boolean) => {
    const wrap = lessActionRef.current;
    const pill = lessPillRef.current;
    if (wrap) {
      wrap.style.transition = "opacity 0.2s";
      wrap.style.opacity = open ? "1" : "0";
      wrap.classList.toggle("ready", open);
    }
    if (pill) {
      pill.style.transition = "transform 0.26s cubic-bezier(0.2,0.8,0.3,1), background 0.18s, color 0.18s, border-color 0.18s";
      pill.style.transform = open ? "scale(1.08)" : "scale(0.7)";
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

  const bounceApprovePanel = useCallback(() => {
    const f = approveFollowupRef.current;
    if (!f) return;
    const h = f.offsetHeight;
    // Panel was dismissed by the user (height 0) — reset so the next commitApprove
    // call will run the full entrance again with a freshly-mounted panel.
    if (h < 5) {
      approveShownRef.current = false;
      setApproveOpen(false);
      setApproveKey((k) => k + 1);
      return;
    }
    f.style.overflow = "hidden";
    f.style.height = `${h}px`;
    void f.offsetHeight;
    // Quick collapse then re-expand — "repeating the animation" feel.
    f.style.transition = "height 0.2s cubic-bezier(0.4,0,0.2,1), opacity 0.18s";
    f.style.height = "0px";
    f.style.opacity = "0.2";
    setTimeout(() => {
      const ff = approveFollowupRef.current;
      if (!ff) return;
      ff.style.transition = "height 0.55s cubic-bezier(0.2,0.7,0.3,1), opacity 0.42s";
      ff.style.height = `${h}px`;
      ff.style.opacity = "1";
      setTimeout(() => {
        const fff = approveFollowupRef.current;
        if (fff) { fff.style.height = "auto"; fff.style.overflow = "visible"; }
      }, 580);
    }, 220);
  }, []);

  const commitApprove = useCallback(() => {
    if (decidedRef.current) return;
    swallowNextClick();
    setLocked(false);
    // Flash the indicator to solid then fade.
    const action = branchActionRef.current;
    if (action) {
      action.classList.add("plus-confirming");
      action.style.transition = "opacity 0.2s";
      action.style.opacity = "0";
    }
    // Snap the card back with a soft spring.
    animate(xv, 0, { type: "spring", stiffness: 90, damping: 20 });

    if (approveShownRef.current) {
      // Panel already visible — bounce it to signal the repeated swipe.
      bounceApprovePanel();
      return;
    }

    // First approve: show the panel and stay interactive (no decidedRef lock).
    approveShownRef.current = true;
    setApproveOpen(true);
    const f = approveFollowupRef.current;
    if (f) {
      // Negate the card's bottom margin exactly (12px desktop, 8px mobile).
      const card = wrapperRef.current?.querySelector(".cur-post-card");
      const cardMarginBottom = card ? parseFloat(getComputedStyle(card).marginBottom) : 12;
      f.style.marginTop = `-${cardMarginBottom}px`;
      // Start the panel at the card's current rubber-banded x so it appears
      // from behind the card rather than from the center of the screen.
      const startX = xv.get();
      // Seed the panel at the card's current x; the xv subscription takes over
      // from here so no CSS transform transition is needed — the panel tracks
      // the spring exactly on every frame.
      f.style.transform = `translateX(${startX}px)`;
      f.style.height = "auto";
      const target = f.scrollHeight;
      f.style.height = "0px";
      f.style.opacity = "0";
      f.style.overflow = "hidden";
      void f.offsetHeight;
      f.style.transition = "height 0.65s cubic-bezier(0.2,0.7,0.3,1), opacity 0.5s";
      f.style.height = `${target}px`;
      f.style.opacity = "1";
      window.setTimeout(() => {
        const ff = approveFollowupRef.current;
        if (ff) { ff.style.height = "auto"; ff.style.overflow = "visible"; }
      }, 680);
    }
    onSwipe("approve");
  }, [xv, onSwipe, swallowNextClick, bounceApprovePanel]);

  // Release below the park threshold — snap shut and re-arm.
  const closeLess = useCallback(() => {
    leftOpenRef.current = false;
    baseXRef.current = 0;
    settleLessPill(false);
    animate(xv, 0, { type: "spring", stiffness: 340, damping: 32 });
    if (wrapperRef.current) { wrapperRef.current.style.position = ""; wrapperRef.current.style.zIndex = ""; }
    unlockTimer.current = setTimeout(() => setLocked(false), 300);
  }, [xv, settleLessPill]);

  // Release in the middle — park open showing the red circle (iMessage rest).
  const parkLess = useCallback(() => {
    leftOpenRef.current = true;
    baseXRef.current = -LESS_OPEN;
    settleLessPill(true);
    animate(xv, -LESS_OPEN, { type: "spring", stiffness: 320, damping: 32 });
  }, [xv, settleLessPill]);

  // Commit: lift the post away (collapse its height so the posts below rise up),
  // then reveal the follow-up panel in its place.
  const commitLess = useCallback(() => {
    if (decidedRef.current) return;
    decidedRef.current = true;
    leftOpenRef.current = false;
    swallowNextClick();
    settleLessPill(false);
    // If the approve panel was visible, slide it away with the card.
    if (approveShownRef.current) {
      approveShownRef.current = false;
      const ap = approveFollowupRef.current;
      if (ap) {
        ap.style.transition = "opacity 0.26s, height 0.34s cubic-bezier(0.4,0,0.2,1)";
        ap.style.opacity = "0";
        ap.style.height = "0px";
      }
    }
    const card = wrapperRef.current;
    if (card) {
      const h = card.scrollHeight;
      card.style.height = `${h}px`;
      card.style.overflow = "hidden";
      void card.offsetHeight; // reflow so the height transition runs from the measured value
      card.style.transition = "height 0.34s cubic-bezier(0.4,0,0.2,1), opacity 0.26s, transform 0.34s";
      card.style.height = "0px";
      card.style.opacity = "0";
      card.style.transform = "translateY(-6px)";
    }
    const f = followupRef.current;
    if (f) {
      f.style.height = "auto";
      const target = f.scrollHeight;
      f.style.height = "0px";
      f.style.opacity = "0";
      f.style.overflow = "hidden";
      void f.offsetHeight;
      f.style.transition = "height 0.4s cubic-bezier(0.2,0.7,0.3,1), opacity 0.3s";
      f.style.height = `${target}px`;
      f.style.opacity = "1";
      window.setTimeout(() => { const ff = followupRef.current; if (ff) ff.style.height = "auto"; }, 420);
    }
    onSwipe("reject");
  }, [onSwipe, swallowNextClick, settleLessPill]);

  // On Back the parent flips `disabled` false again — re-arm the gesture so the
  // post is fully interactive once more.
  useEffect(() => {
    if (!disabled && branchCommittedRef.current) {
      branchCommittedRef.current = false;
      decidedRef.current = false;
      approveShownRef.current = false;
      setApproveOpen(false);
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
    firstLeftFired.current = false;
    firstRightFired.current = false;
    // Start hold timer — fires HOLD_DELAY ms after press if no horizontal movement.
    holdTimerRef.current = setTimeout(() => {
      if (!draggingRef.current || engagedRef.current) return;
      holdActiveRef.current = true;
      setHoldActive(true);
      onHoldStart?.();
      draggingRef.current = false; // prevent endDrag from processing a swipe
    }, HOLD_DELAY);
    startXRef.current = e.clientX;
    startYRef.current = e.clientY;
    dxRef.current = 0;
    lastXRef.current = e.clientX;
    lastTRef.current = e.timeStamp;
    velRef.current = 0;
    // Build this drag on top of the resting offset (parked-open or closed) and
    // let the pill ride the finger without easing until release.
    baseXRef.current = leftOpenRef.current ? -LESS_OPEN : 0;
    if (lessActionRef.current) lessActionRef.current.style.transition = "none";
    // Width tracks the finger with no easing; the scale pop + the solid-fill
    // colour change still animate smoothly while dragging.
    if (lessPillRef.current) lessPillRef.current.style.transition = "transform 0.16s, background 0.18s, color 0.18s, border-color 0.18s";
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const dx = e.clientX - startXRef.current;
    const dy = e.clientY - startYRef.current;

    if (!engagedRef.current) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      // Cancel hold timer — user is swiping, not holding.
      if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
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

    const baseX = baseXRef.current;
    if (baseX === 0 && dx > 0) {
      // Card rides right rubber-banded; + indicator fills as you approach the threshold.
      if (!firstRightFired.current) { firstRightFired.current = true; onFirstRightDrag?.(); }
      xv.set(rubber(dx));
      const t = Math.min(1, dx / BRANCH_COLLAPSE_DISTANCE);
      const action = branchActionRef.current;
      if (action) {
        const reveal = cl01(dx / 70);
        action.style.opacity = String(reveal);
        action.style.transform = `translateY(-50%) translateX(${lerp(-12, 0, reveal)}px)`;
        branchIconRef.current?.style.setProperty("--branch-fill", String(Math.min(1, t / BRANCH_COMMIT)));
        action.classList.toggle("plus-filled", t >= BRANCH_COMMIT);
      }
    } else {
      // Leftward "less of this" reveal — also handles dragging from the parked
      // state. The card rides the finger; past LESS_FULL it resists.
      if (!firstLeftFired.current) { firstLeftFired.current = true; onFirstLeftDrag?.(); }
      let x = Math.min(0, baseX + dx);
      const over = -x - LESS_FULL;
      if (over > 0) x = -(LESS_FULL + 60 * (1 - Math.exp(-over / 60)));
      xv.set(x);
      paintLessPill(x);
    }
  }

  function endDrag() {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const dx = dxRef.current;
    if (!engagedRef.current) {
      // A tap with no horizontal intent: if parked open, a tap anywhere closes it.
      if (leftOpenRef.current) closeLess();
      else setLocked(false);
      return;
    }

    const baseX = baseXRef.current;

    // Rightward "more like this".
    if (baseX === 0 && dx > 0) {
      const power = dx + velRef.current * 90; // velocity is px/ms → weight a flick
      const t = dx / BRANCH_COLLAPSE_DISTANCE;
      if (t >= BRANCH_COMMIT || power > SWIPE_THRESHOLD) { commitApprove(); return; }
      // Cancel — bounce back.
      clearBranchAction();
      animate(xv, 0, { type: "spring", stiffness: 340, damping: 32 });
      if (wrapperRef.current) { wrapperRef.current.style.position = ""; wrapperRef.current.style.zIndex = ""; }
      unlockTimer.current = setTimeout(() => setLocked(false), 350);
      return;
    }

    // Leftward "less of this": slide all the way (or flick hard) commits; a
    // medium pull parks open; anything shorter snaps shut.
    const gap = -(baseX + dx);
    const leftFlick = -(dx + velRef.current * 90);
    if (gap >= LESS_FULL || (gap >= 40 && leftFlick > LESS_OPEN + 120)) { commitLess(); return; }
    if (gap >= LESS_OPEN * 0.55) { parkLess(); return; }
    closeLess();
  }

  const dismissHold = useCallback(() => {
    holdActiveRef.current = false;
    setHoldActive(false);
  }, []);

  const handleDiveDeeperTap = useCallback(() => {
    holdActiveRef.current = false;
    setHoldActive(false);
    onBranch?.();
  }, [onBranch]);

  return (
    <>
      <div ref={wrapperRef} className={[holdActive && "cur-hold-active", approveOpen && "cur-approve-open"].filter(Boolean).join(" ") || undefined} style={{ position: "relative" }}>
        {/* Branch affordance revealed on the left as the card rides right. */}
        <div ref={branchActionRef} className="cur-swipe-branch-action" style={{ opacity: 0 }} aria-hidden>
          <span ref={branchIconRef} className="cur-swipe-branch-icon">
            <span className="cur-swipe-branch-fill" aria-hidden />
            <span className="cur-swipe-branch-plus">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </span>
          </span>
          <span className="cur-swipe-branch-label">More like this</span>
        </div>
        {/* Hold overlay: appears on long-press, offers Dive Deeper into branch feed. */}
        {holdActive && (
          <div className="cur-hold-overlay" onClick={dismissHold} role="dialog" aria-label="Hold options">
            <button
              className="cur-hold-branch-btn"
              onClick={(e) => { e.stopPropagation(); handleDiveDeeperTap(); }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="6" cy="6" r="2.4" />
                <circle cx="6" cy="18" r="2.4" />
                <circle cx="18" cy="9" r="2.4" />
                <path d="M6 8.4v7.2M8.2 7 16 8.6M8 17l8-6.6" />
              </svg>
              Dive deeper
            </button>
          </div>
        )}
        {/* "less like this" affordance revealed on the right as the card rides
            left, sitting behind the card in the space it vacates. Mirrors the
            "Dive deeper" dot: an outlined red circle with a label underneath that
            fills solid at the park and stretches into an oval if you pull on.
            Tapping it commits. */}
        <div ref={lessActionRef} className="cur-swipe-less-action" style={{ opacity: 0 }}>
          <button
            ref={lessPillRef}
            type="button"
            className="cur-swipe-less-icon"
            aria-label="See less like this"
            onClick={(e) => { e.stopPropagation(); commitLess(); }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
              <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
              <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
              <line x1="2" y1="2" x2="22" y2="22" />
            </svg>
          </button>
          <span className="cur-swipe-less-label">Less like this</span>
        </div>
        <motion.div
          className="cur-swipe-wrap"
          style={{ x: xv, position: "relative", zIndex: 1 }}
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
      {approveFollowupContent != null && (
        <div ref={approveFollowupRef} style={{ height: 0, overflow: "hidden", opacity: 0 }}>
          <Fragment key={approveKey}>{approveFollowupContent}</Fragment>
        </div>
      )}
      {followupContent != null && (
        <div ref={followupRef} style={{ height: 0, overflow: "hidden", opacity: 0 }}>
          {followupContent}
        </div>
      )}
    </>
  );
}
