"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCurator } from "../curatorContext";

const DEMO_DONE_KEY = "curator:swipeDemoDone";
const TOUR_DONE_KEY = "curator:tourDone";
const SLIDE_LEFT = 190;
const SLIDE_RIGHT = 120;

function easeOutCubic(t: number) { return 1 - Math.pow(1 - t, 3); }

/** Animate a value from `from` to `to` over `duration` ms, calling `onFrame` each frame. */
function tweenValue(
  from: number, to: number, duration: number,
  onFrame: (v: number) => void,
  onDone: () => void,
): () => void {
  const start = performance.now();
  let raf: number;
  function tick(now: number) {
    const t = Math.min((now - start) / duration, 1);
    onFrame(from + (to - from) * easeOutCubic(t));
    if (t < 1) raf = requestAnimationFrame(tick);
    else onDone();
  }
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

/**
 * Auto-plays a swipe-left then swipe-right demo on the first post card
 * so users learn the gesture exists. Mobile only, shown once.
 */
export default function SwipeDemo({ postsLoaded }: { postsLoaded: boolean }) {
  const { setMobileTab, showOnboarding } = useCurator();
  const [phase, setPhase] = useState<
    "waiting" | "swipe-left" | "hold-left" | "return-left" |
    "swipe-right" | "hold-right" | "return-right" |
    "show-branch" | "done"
  >("waiting");
  const [showButton, setShowButton] = useState(false);
  const [tipText, setTipText] = useState("");
  const [tipVisible, setTipVisible] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(true);
  const prevOverflowRef = useRef("");
  // Bounding rect of the active card — used for the spotlight overlay.
  const [cardBand, setCardBand] = useState<{ top: number; left: number; width: number; height: number } | null>(null);

  // Gate: mobile only, not already seen, and tour must be finished first
  const [shouldRun, setShouldRun] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { if (window.localStorage.getItem(DEMO_DONE_KEY)) return; } catch { /* */ }
    const mq = window.matchMedia("(max-width: 767px)");
    const activate = () => { if (mq.matches) setShouldRun(true); };
    activate();
    mq.addEventListener("change", activate);
    return () => mq.removeEventListener("change", activate);
  }, []);

  // Find the first card's DOM elements
  function getCardEls() {
    const wrap = document.querySelector(".cur-swipe-wrap") as HTMLElement | null;
    const lessAction = wrap?.parentElement?.querySelector(".cur-swipe-less-action") as HTMLElement | null;
    const lessPill = lessAction?.querySelector(".cur-swipe-less-icon") as HTMLElement | null;
    const branchAction = wrap?.parentElement?.querySelector(".cur-swipe-branch-action") as HTMLElement | null;
    return { wrap, lessAction, lessPill, branchAction };
  }

  // Drive the card to position x, painting affordances
  function driveCard(x: number) {
    const { wrap, lessAction, lessPill, branchAction } = getCardEls();
    if (!wrap) return;

    // Apply transform directly on the Framer Motion element's style
    wrap.style.transform = `translateX(${x}px) translateZ(0)`;

    if (x < 0 && lessAction && lessPill) {
      // Left: show red "less of this" pill
      const gap = Math.abs(x);
      const grow = Math.min(gap / 175, 1);
      lessAction.style.opacity = String(Math.min(gap / 70, 1));
      lessAction.style.transition = "none";
      lessPill.style.transform = `scale(${0.7 + grow * 0.3})`;
      lessPill.style.transition = "none";
    } else if (lessAction) {
      lessAction.style.opacity = "0";
    }

    if (x > 0 && branchAction) {
      // Right: show blue "dive deeper" affordance
      const reveal = Math.min(x / 70, 1);
      branchAction.style.opacity = String(reveal);
      branchAction.style.transition = "none";
      branchAction.style.transform = `translateY(-50%) translateX(${-12 + 12 * reveal}px)`;
      if (x > SLIDE_RIGHT * 0.5) branchAction.classList.add("ready");
      else branchAction.classList.remove("ready");
    } else if (branchAction) {
      branchAction.style.opacity = "0";
      branchAction.classList.remove("ready");
    }
  }

  // Reset card to neutral
  function resetCard() {
    const { wrap, lessAction, lessPill, branchAction } = getCardEls();
    if (wrap) { wrap.style.transform = ""; wrap.style.pointerEvents = ""; }
    if (lessAction) { lessAction.style.opacity = "0"; lessAction.style.transition = ""; }
    if (lessPill) { lessPill.style.transform = ""; lessPill.style.transition = ""; }
    if (branchAction) {
      branchAction.style.opacity = "0";
      branchAction.style.transition = "";
      branchAction.style.transform = "";
      branchAction.classList.remove("ready");
    }
  }

  // Cleanup helper
  function cleanup() {
    cancelRef.current?.();
    if (timerRef.current) clearTimeout(timerRef.current);
    resetCard();
  }

  // Sequence the animation phases. Lock scroll immediately (before the centering
  // delay) so the user can't shift the layout between queuing and starting.
  useEffect(() => {
    if (!shouldRun || !postsLoaded || showOnboarding) return;
    activeRef.current = true;

    setMobileTab("feed");

    prevOverflowRef.current = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    timerRef.current = setTimeout(() => {
      if (!activeRef.current) return;
      const { wrap } = getCardEls();
      if (!wrap) {
        document.body.style.overflow = prevOverflowRef.current;
        try { window.localStorage.setItem(DEMO_DONE_KEY, "1"); } catch { /* */ }
        setPhase("done");
        return;
      }
      // Check wrapper parent height — inner elements report natural height even
      // when clipped by a height:0;overflow:hidden parent wrapper.
      const followupVisible = [...document.querySelectorAll<HTMLElement>(".cur-swipe-followup, .cur-swipe-approve")]
        .some(el => (el.parentElement?.offsetHeight ?? 0) > 0);
      if (followupVisible) {
        document.body.style.overflow = prevOverflowRef.current;
        setPhase("done");
        return;
      }
      const card = wrap.querySelector(".cur-post-card") as HTMLElement | null;
      (card ?? wrap).scrollIntoView({ block: "center" });
      const rect = (card ?? wrap).getBoundingClientRect();
      setCardBand({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
      wrap.style.pointerEvents = "none";
      setPhase("swipe-left");
    }, 1500);

    return () => {
      activeRef.current = false;
      document.body.style.overflow = prevOverflowRef.current;
      setCardBand(null);
      cleanup();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldRun, postsLoaded, showOnboarding]);

  // Run each phase
  useEffect(() => {
    if (!shouldRun || phase === "waiting" || phase === "done") return;
    // If posts cleared mid-demo (feed refreshing), abort cleanly.
    if (!postsLoaded) { cleanup(); setPhase("waiting"); return; }
    let alive = true;

    switch (phase) {
      case "swipe-left":
        setTipText("Swipe left to see less of this");
        setTipVisible(true);
        setShowButton(true);
        timerRef.current = setTimeout(() => {
          if (!alive) return;
          cancelRef.current = tweenValue(0, -SLIDE_LEFT, 700, driveCard, () => {
            if (alive) setPhase("hold-left");
          });
        }, 600);
        break;

      case "hold-left":
        break;

      case "return-left":
        cancelRef.current = tweenValue(-SLIDE_LEFT, 0, 400, driveCard, () => {
          if (!alive) return;
          resetCard();
          timerRef.current = setTimeout(() => {
            if (alive) setPhase("swipe-right");
          }, 400);
        });
        break;

      case "swipe-right":
        setTipText("Swipe right to see more");
        setTipVisible(true);
        setShowButton(true);
        timerRef.current = setTimeout(() => {
          if (!alive) return;
          cancelRef.current = tweenValue(0, SLIDE_RIGHT, 600, driveCard, () => {
            if (alive) setPhase("hold-right");
          });
        }, 600);
        break;

      case "hold-right":
        break;

      case "return-right":
        cancelRef.current = tweenValue(SLIDE_RIGHT, 0, 400, driveCard, () => {
          if (!alive) return;
          const { wrap } = getCardEls();
          if (wrap) wrap.style.pointerEvents = "";
          resetCard();
          if (alive) setPhase("show-branch");
        });
        break;

      case "show-branch": {
        // Spotlight the always-visible branch FAB in the card's top-right corner
        const { wrap } = getCardEls();
        const fab = wrap?.closest(".cur-post-item")?.querySelector(".cur-post-branch-fab") as HTMLElement | null;
        if (fab) {
          const rect = fab.getBoundingClientRect();
          // Add a small halo so the box-shadow ring has breathing room
          const pad = 6;
          setCardBand({ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 });
        }
        setTipText("Branch a topic to dive deeper");
        setTipVisible(true);
        setShowButton(true);
        break;
      }
    }

    return () => {
      alive = false;
      cancelRef.current?.();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, shouldRun, postsLoaded]);


  function handleGotIt() {
    // Cancel any in-flight tween/timer but do NOT reset the card —
    // the return phase tweens from the card's current held position back to 0.
    cancelRef.current?.();
    if (timerRef.current) clearTimeout(timerRef.current);
    setShowButton(false);
    setTipVisible(false);
    // Mark done immediately when the user confirms the right-swipe step — the
    // return animation is cosmetic and its onDone callback can be interrupted
    // by navigation, which would leave the key unset and re-trigger next session.
    if (phase === "swipe-right" || phase === "hold-right") {
      try { window.localStorage.setItem(DEMO_DONE_KEY, "1"); } catch { /* */ }
    }
    setTimeout(() => {
      if (phase === "swipe-left" || phase === "hold-left") setPhase("return-left");
      else if (phase === "swipe-right" || phase === "hold-right") setPhase("return-right");
      else if (phase === "show-branch") {
        document.body.style.overflow = prevOverflowRef.current;
        try { window.localStorage.setItem(DEMO_DONE_KEY, "1"); } catch { /* */ }
        setCardBand(null);
        setPhase("done");
      }
    }, 300);
  }

  function handleDismiss() {
    document.body.style.overflow = prevOverflowRef.current;
    cleanup();
    const { wrap } = getCardEls();
    if (wrap) wrap.style.pointerEvents = "";
    try { window.localStorage.setItem(DEMO_DONE_KEY, "1"); } catch { /* */ }
    setCardBand(null);
    setPhase("done");
  }

  if (!shouldRun || phase === "done" || phase === "waiting") return null;

  const isBranchPhase = phase === "show-branch";
  const arrowLeft = !isBranchPhase && (phase === "swipe-left" || phase === "hold-left" || phase === "return-left");
  const tipTop = cardBand ? cardBand.top + cardBand.height + 24 : undefined;
  // Buttons sit above the card/spotlight in the header dead-space.
  const btnBottom = cardBand ? window.innerHeight - cardBand.top + 12 : undefined;

  // Portal to body so position:fixed is relative to the true viewport,
  // not broken by ancestor CSS transforms (which happen during card animation).
  return createPortal(
    <>
      {/* Full-screen blocker — captures all taps; tapping the dim = "Got it" fallback */}
      <div className="swipe-demo-blocker" onClick={handleGotIt} />
      {/* Spotlight — card-shaped normally, circular for the branch-button step */}
      {cardBand && (
        <div
          className="swipe-demo-spotlight"
          style={{
            top: cardBand.top,
            left: cardBand.left,
            width: cardBand.width,
            height: cardBand.height,
            ...(isBranchPhase && { borderRadius: "50%" }),
          }}
        />
      )}

      {/* Instruction bubble — below the spotlight */}
      <div
        className={`swipe-demo-tip${tipVisible ? " visible" : ""}`}
        style={tipTop !== undefined ? { top: tipTop } : undefined}
      >
        <div className="swipe-demo-bubble">
          {isBranchPhase ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="9" r="2" />
              <path d="M6 8v8" /><path d="M6 14c0-3 1.5-5 5-5h5" />
            </svg>
          ) : arrowLeft ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M19 12H5" /><path d="m12 19-7-7 7-7" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
            </svg>
          )}
          <span className="swipe-demo-bubble-text">{tipText}</span>
        </div>
      </div>

      {/* Got it / Dismiss buttons — above the card in the header bar dead space */}
      {showButton && (
        <div
          className={`swipe-demo-actions${tipVisible ? " visible" : ""}`}
          style={btnBottom !== undefined ? { bottom: btnBottom } : undefined}
        >
          <button className="swipe-demo-got-it" onClick={handleGotIt}>Got it</button>
          <button className="swipe-demo-dismiss" onClick={handleDismiss}>Dismiss tutorial</button>
        </div>
      )}
    </>,
    document.body
  );
}
