"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useCurator } from "./curatorContext";

const TOUR_DONE_KEY = "curator:tourDone";
const PAD = 6;
const RADIUS = 10;

interface MobileTourStep {
  target: string;
  label: string;
  tapHint: string;
  tooltipPos: "above" | "below";
  /** Where the caret arrow points — "center" or "left". */
  caretAlign: "center" | "left";
  advanceDelay: number;
  /** If true, the tap only advances the tour without clicking the real element. */
  tapOnly: boolean;
  prep?: (ctx: { setSidebarOpen: (b: boolean) => void; setMobileTab: (t: "chat" | "feed") => void }) => void;
}

const STEPS: MobileTourStep[] = [
  {
    target: ".capsule",
    label: "Describe what you want to read and the AI will curate your feed.",
    tapHint: "Tap the input to continue",
    tooltipPos: "above",
    caretAlign: "center",
    advanceDelay: 300,
    tapOnly: false,
    prep: ({ setSidebarOpen, setMobileTab }) => { setSidebarOpen(false); setMobileTab("feed"); },
  },
  {
    target: ".cur-topbar-burger",
    label: "Tap to see all your feeds and create new ones.",
    tapHint: "Tap the menu to continue",
    tooltipPos: "below",
    caretAlign: "left",
    advanceDelay: 350,
    tapOnly: false,
    prep: ({ setSidebarOpen }) => { setSidebarOpen(false); },
  },
  {
    target: ".cur-new-feed",
    label: "Create a new topic feed anytime.",
    tapHint: "Tap to finish the tour",
    tooltipPos: "above",
    caretAlign: "center",
    advanceDelay: 100,
    tapOnly: false,
    prep: ({ setSidebarOpen }) => { setSidebarOpen(true); },
  },
];

function getCutout(el: Element): DOMRect | null {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return new DOMRect(r.x - PAD, r.y - PAD, r.width + PAD * 2, r.height + PAD * 2);
}

// SVG path: full-screen rect with an inner rounded-rect hole (evenodd).
function backdropPath(
  vw: number, vh: number,
  cx: number, cy: number, cw: number, ch: number,
  r: number,
): string {
  const outer = `M0,0 H${vw} V${vh} H0 Z`;
  const x1 = cx, y1 = cy, x2 = cx + cw, y2 = cy + ch;
  const inner = [
    `M${x1 + r},${y1}`,
    `H${x2 - r} A${r},${r} 0 0 1 ${x2},${y1 + r}`,
    `V${y2 - r} A${r},${r} 0 0 1 ${x2 - r},${y2}`,
    `H${x1 + r} A${r},${r} 0 0 1 ${x1},${y2 - r}`,
    `V${y1 + r} A${r},${r} 0 0 1 ${x1 + r},${y1}`,
    "Z",
  ].join(" ");
  return `${outer} ${inner}`;
}

export default function CuratorMobileTour() {
  const { setSidebarOpen, setMobileTab, sidebarOpen } = useCurator();
  const [active, setActive] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [cutout, setCutout] = useState<DOMRect | null>(null);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [backdropVisible, setBackdropVisible] = useState(false);
  const [vw, setVw] = useState(0);
  const [vh, setVh] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cutoutRef = useRef<DOMRect | null>(null);

  // Keep ref in sync for use in event handlers (avoids stale closure)
  useEffect(() => { cutoutRef.current = cutout; }, [cutout]);

  // Only activate on mobile
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.innerWidth >= 768) return;
    try { if (window.localStorage.getItem(TOUR_DONE_KEY)) return; } catch { /* */ }
    const t = setTimeout(() => setActive(true), 1400);
    return () => clearTimeout(t);
  }, []);

  const dismiss = useCallback(() => {
    setTooltipVisible(false);
    setTimeout(() => setActive(false), 300);
    try { window.localStorage.setItem(TOUR_DONE_KEY, "1"); } catch { /* */ }
  }, []);

  const measure = useCallback((step: MobileTourStep) => {
    const el = document.querySelector(step.target);
    if (!el) return false;
    const rect = getCutout(el);
    if (!rect) return false;
    setCutout(rect);
    setVw(window.innerWidth);
    setVh(window.innerHeight);
    return true;
  }, []);

  // When step changes, run prep, then poll for target element
  useEffect(() => {
    if (!active) return;
    const step = STEPS[stepIdx];
    if (!step) { dismiss(); return; }

    setTooltipVisible(false);
    // Fade out backdrop before repositioning the cutout
    setBackdropVisible(false);

    // After fade-out, run prep and poll for the new target
    const prepDelay = setTimeout(() => {
      step.prep?.({ setSidebarOpen, setMobileTab });

      const pollDelay = setTimeout(() => {
        let attempts = 0;
        const maxAttempts = 20;
        pollRef.current = setInterval(() => {
          attempts++;
          if (measure(step)) {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            // Fade backdrop back in, then show tooltip
            setBackdropVisible(true);
            setTimeout(() => setTooltipVisible(true), 200);
          } else if (attempts >= maxAttempts) {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            const next = stepIdx + 1;
            if (next >= STEPS.length) dismiss();
            else setStepIdx(next);
          }
        }, 250);
      }, 100);

      return () => clearTimeout(pollDelay);
    }, stepIdx === 0 ? 0 : 250); // No fade delay on first step

    return () => {
      clearTimeout(prepDelay);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      if (advanceTimerRef.current) { clearTimeout(advanceTimerRef.current); advanceTimerRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, stepIdx]);

  // Re-measure on resize/scroll
  useEffect(() => {
    if (!active) return;
    const step = STEPS[stepIdx];
    if (!step) return;
    const handleResize = () => measure(step);
    window.addEventListener("resize", handleResize);
    window.addEventListener("scroll", handleResize, true);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleResize, true);
    };
  }, [active, stepIdx, measure]);

  // Re-measure when sidebar opens/closes
  useEffect(() => {
    if (!active) return;
    const step = STEPS[stepIdx];
    if (!step) return;
    const t = setTimeout(() => measure(step), 350);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarOpen]);

  // Tap handler: check if tap coordinates are inside the cutout rect.
  // If yes, advance (and optionally click the real element underneath).
  useEffect(() => {
    if (!active || !tooltipVisible) return;
    const step = STEPS[stepIdx];
    if (!step) return;

    function handler(e: MouseEvent | TouchEvent) {
      const rect = cutoutRef.current;
      if (!rect) return;

      const px = "touches" in e ? e.touches[0]?.clientX ?? 0 : e.clientX;
      const py = "touches" in e ? e.touches[0]?.clientY ?? 0 : e.clientY;

      if (px < rect.x || px > rect.x + rect.width) return;
      if (py < rect.y || py > rect.y + rect.height) return;

      e.preventDefault();
      e.stopPropagation();
      setTooltipVisible(false);

      const isLastStep = stepIdx >= STEPS.length - 1;

      // For the last step, dismiss immediately so the overlay is gone
      // before we click the real element (prevents the tour from
      // intercepting the synthetic click).
      if (isLastStep) {
        dismiss();
      }

      // Click the real element underneath (unless tapOnly)
      if (!step.tapOnly) {
        // Small delay to let the overlay unmount / hide pointer-events
        setTimeout(() => {
          const el = document.querySelector(step.target) as HTMLElement | null;
          el?.click();
        }, isLastStep ? 50 : 0);
      }

      if (!isLastStep) {
        const advance = () => setStepIdx(stepIdx + 1);
        if (step.advanceDelay > 0) {
          advanceTimerRef.current = setTimeout(advance, step.advanceDelay);
        } else {
          advanceTimerRef.current = setTimeout(advance, 150);
        }
      }
    }

    document.addEventListener("click", handler, true);
    document.addEventListener("touchstart", handler, true);
    return () => {
      document.removeEventListener("click", handler, true);
      document.removeEventListener("touchstart", handler, true);
    };
  }, [active, tooltipVisible, stepIdx, dismiss]);

  if (!active || !cutout) return null;

  const step = STEPS[stepIdx];
  if (!step) return null;

  // Tooltip positioning
  const tooltipGap = 14;
  const tooltipTop = step.tooltipPos === "below"
    ? cutout.y + cutout.height + tooltipGap
    : undefined;
  const tooltipBottom = step.tooltipPos === "above"
    ? vh - cutout.y + tooltipGap
    : undefined;

  // Caret alignment class
  const caretClass = step.caretAlign === "left" ? " caret-left" : "";

  return (
    <div className={`mtour-overlay${backdropVisible ? " backdrop-visible" : ""}`}>
      <svg className="mtour-backdrop" width={vw} height={vh}>
        <path
          d={backdropPath(vw, vh, cutout.x, cutout.y, cutout.width, cutout.height, RADIUS)}
          fillRule="evenodd"
        />
      </svg>

      <div
        className="mtour-cutout-ring"
        style={{
          top: cutout.y,
          left: cutout.x,
          width: cutout.width,
          height: cutout.height,
        }}
      />

      <div
        className={`mtour-tooltip ${step.tooltipPos}${caretClass}${tooltipVisible ? " visible" : ""}`}
        style={{
          ...(tooltipTop != null ? { top: tooltipTop } : {}),
          ...(tooltipBottom != null ? { bottom: tooltipBottom } : {}),
        }}
      >
        <div className="mtour-step">{stepIdx + 1} / {STEPS.length}</div>
        <div className="mtour-text">{step.label}</div>
        <div className="mtour-hint">{step.tapHint}</div>
        <button className="mtour-skip" onClick={dismiss}>Skip tour</button>
      </div>
    </div>
  );
}
