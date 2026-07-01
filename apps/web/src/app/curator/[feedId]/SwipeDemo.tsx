"use client";

import { useEffect, useRef, useState } from "react";
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
  const { setMobileTab } = useCurator();
  const [phase, setPhase] = useState<
    "waiting" | "swipe-left" | "hold-left" | "return-left" |
    "swipe-right" | "hold-right" | "return-right" | "done"
  >("waiting");
  const [showButton, setShowButton] = useState(false);
  const [tipText, setTipText] = useState("");
  const [tipVisible, setTipVisible] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(true);

  // Gate: mobile only, not already seen, and tour must be finished first
  const [shouldRun, setShouldRun] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Never auto-run the feature onboarding in local dev — it just gets in the way.
    if (process.env.NODE_ENV === "development") return;
    if (window.innerWidth >= 768) return;
    try { if (window.localStorage.getItem(DEMO_DONE_KEY)) return; } catch { /* */ }

    // If the tour is already done, start immediately
    try {
      if (window.localStorage.getItem(TOUR_DONE_KEY)) {
        setShouldRun(true);
        return;
      }
    } catch { /* */ }

    // Otherwise poll until the tour finishes (it sets the key on dismiss/complete)
    const poll = setInterval(() => {
      try {
        if (window.localStorage.getItem(TOUR_DONE_KEY)) {
          clearInterval(poll);
          setShouldRun(true);
        }
      } catch { /* */ }
    }, 500);
    return () => clearInterval(poll);
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
      lessPill.style.width = "140px";
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
    if (wrap) wrap.style.transform = "";
    if (lessAction) { lessAction.style.opacity = "0"; lessAction.style.transition = ""; }
    if (lessPill) { lessPill.style.transform = ""; lessPill.style.transition = ""; lessPill.style.width = ""; }
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

  // Sequence the animation phases
  useEffect(() => {
    if (!shouldRun || !postsLoaded) return;
    activeRef.current = true;

    // Ensure feed tab is visible (not the chat overlay) so the demo is seen
    setMobileTab("feed");

    // Wait for posts to render
    timerRef.current = setTimeout(() => {
      if (!activeRef.current) return;
      const { wrap } = getCardEls();
      if (!wrap) {
        // No card found, give up
        try { window.localStorage.setItem(DEMO_DONE_KEY, "1"); } catch { /* */ }
        setPhase("done");
        return;
      }
      // Disable pointer events during demo
      wrap.style.pointerEvents = "none";
      setPhase("swipe-left");
    }, 1500);

    return () => {
      activeRef.current = false;
      cleanup();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldRun, postsLoaded]);

  // Run each phase
  useEffect(() => {
    if (!shouldRun || phase === "waiting" || phase === "done") return;
    let alive = true;

    switch (phase) {
      case "swipe-left":
        setTipText("Swipe left to see less of this");
        setTipVisible(true);
        timerRef.current = setTimeout(() => {
          if (!alive) return;
          cancelRef.current = tweenValue(0, -SLIDE_LEFT, 700, driveCard, () => {
            if (alive) setPhase("hold-left");
          });
        }, 600);
        break;

      case "hold-left":
        // Wait for user to tap the "Got it" button
        setShowButton(true);
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
        setTipText("Swipe right to dive deeper");
        setTipVisible(true);
        timerRef.current = setTimeout(() => {
          if (!alive) return;
          cancelRef.current = tweenValue(0, SLIDE_RIGHT, 600, driveCard, () => {
            if (alive) setPhase("hold-right");
          });
        }, 600);
        break;

      case "hold-right":
        // Wait for user to tap the "Got it" button
        setShowButton(true);
        break;

      case "return-right":
        cancelRef.current = tweenValue(SLIDE_RIGHT, 0, 400, driveCard, () => {
          if (!alive) return;
          const { wrap } = getCardEls();
          if (wrap) wrap.style.pointerEvents = "";
          resetCard();
          try { window.localStorage.setItem(DEMO_DONE_KEY, "1"); } catch { /* */ }
          setPhase("done");
        });
        break;
    }

    return () => {
      alive = false;
      cancelRef.current?.();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, shouldRun]);


  function handleGotIt() {
    setShowButton(false);
    setTipVisible(false);
    setTimeout(() => {
      if (phase === "hold-left") setPhase("return-left");
      else if (phase === "hold-right") setPhase("return-right");
    }, 300);
  }

  if (!shouldRun || phase === "done" || phase === "waiting") return null;

  return (
    <div
      className={`swipe-demo-tip${tipVisible ? " visible" : ""}`}
      style={{ top: 70 }}
    >
      <span>{tipText}</span>
      {showButton && (
        <button className="swipe-demo-btn" onClick={handleGotIt}>
          Got it
        </button>
      )}
    </div>
  );
}
