"use client";

import { useState, useEffect, useCallback, useRef } from "react";

const TOUR_DONE_KEY = "curator:tourDone";

type LabelPos = "below-right" | "above-right";

interface TourStep {
  target: string;
  label: string;
  cursorOffset?: { x: number; y: number };
  cursorOffsetPct?: { x: number; y: number };
  labelPos?: LabelPos;
}

const STEPS: TourStep[] = [
  {
    target: ".cur-feed-list",
    label: "Switch between your topics here",
    cursorOffsetPct: { x: 0.65, y: 0.2 },
    labelPos: "below-right",
  },
  {
    target: ".cur-input-bar",
    label: "Describe your ideal feed to the AI here",
    cursorOffsetPct: { x: 0.3, y: 0.4 },
    labelPos: "above-right",
  },
  {
    target: ".cur-verify-box",
    label: "Verify to get a human-verified label on Bluesky",
    cursorOffsetPct: { x: 0.7, y: 0.75 },
    labelPos: "above-right",
  },
  {
    target: ".cur-new-feed",
    label: "Create a new feed anytime",
    cursorOffsetPct: { x: 0.5, y: 0.5 },
    labelPos: "above-right",
  },
];

const FADE_OUT_MS = 280;

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function animateCurve(
  from: { x: number; y: number },
  to: { x: number; y: number },
  duration: number,
  onFrame: (pos: { x: number; y: number }) => void,
  onDone: () => void
) {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const arcStrength = Math.min(dist * 0.25, 120);
  const cp = dist > 0
    ? { x: mx - (dy / dist) * arcStrength, y: my + (dx / dist) * arcStrength }
    : { x: mx, y: my };

  const start = performance.now();
  let raf: number;

  function tick(now: number) {
    const elapsed = now - start;
    const raw = Math.min(elapsed / duration, 1);
    const t = easeInOut(raw);
    const inv = 1 - t;
    const x = inv * inv * from.x + 2 * inv * t * cp.x + t * t * to.x;
    const y = inv * inv * from.y + 2 * inv * t * cp.y + t * t * to.y;
    onFrame({ x, y });
    if (raw < 1) {
      raf = requestAnimationFrame(tick);
    } else {
      onDone();
    }
  }

  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

export default function CuratorTour() {
  const [active, setActive] = useState(false);
  const [step, setStep] = useState(-1);
  const [cursorPos, setCursorPos] = useState({ x: -40, y: -40 });
  const [showLabel, setShowLabel] = useState(false);

  // Displayed label content — frozen while fading out, updated before fading in
  const [displayLabel, setDisplayLabel] = useState("");
  const [displayStep, setDisplayStep] = useState(0);
  const [displayPos, setDisplayPos] = useState<LabelPos>("below-right");
  const [displayIsLast, setDisplayIsLast] = useState(false);

  const cancelAnim = useRef<(() => void) | null>(null);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPos = useRef({ x: -40, y: -40 });

  useEffect(() => {
    try {
      if (window.localStorage.getItem(TOUR_DONE_KEY)) return;
    } catch { /* ignore */ }
    const t = setTimeout(() => setActive(true), 1400);
    return () => clearTimeout(t);
  }, []);

  const flyTo = useCallback((idx: number) => {
    const s = STEPS[idx];
    const el = document.querySelector(s.target);
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const dest = s.cursorOffsetPct
      ? { x: rect.left + rect.width * s.cursorOffsetPct.x, y: rect.top + rect.height * s.cursorOffsetPct.y }
      : { x: rect.left + (s.cursorOffset?.x ?? 0), y: rect.top + (s.cursorOffset?.y ?? 0) };

    const dx = dest.x - lastPos.current.x;
    const dy = dest.y - lastPos.current.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const duration = Math.max(800, Math.min(1400, dist * 1.2));

    cancelAnim.current?.();
    cancelAnim.current = animateCurve(
      lastPos.current,
      dest,
      duration,
      (pos) => setCursorPos(pos),
      () => {
        lastPos.current = dest;
        // Update displayed content to new step, then fade in
        setDisplayLabel(s.label);
        setDisplayStep(idx);
        setDisplayPos(s.labelPos ?? "below-right");
        setDisplayIsLast(idx === STEPS.length - 1);
        setTimeout(() => setShowLabel(true), 180);
      }
    );
  }, []);

  // Start the tour
  useEffect(() => {
    if (!active) return;
    const start = { x: window.innerWidth * 0.5, y: window.innerHeight * 0.5 };
    setCursorPos(start);
    lastPos.current = start;
    const t = setTimeout(() => setStep(0), 400);
    return () => {
      clearTimeout(t);
      cancelAnim.current?.();
    };
  }, [active]);

  // When step changes, fade out current label first, then fly
  useEffect(() => {
    if (step < 0 || step >= STEPS.length) return;

    if (fadeTimer.current) clearTimeout(fadeTimer.current);

    if (showLabel) {
      // Label is visible — fade it out first, keep old text
      setShowLabel(false);
      fadeTimer.current = setTimeout(() => {
        flyTo(step);
      }, FADE_OUT_MS);
    } else {
      // No label showing (first step or already hidden) — fly immediately
      flyTo(step);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function goNext() {
    const next = step + 1;
    if (next >= STEPS.length) {
      dismiss();
      return;
    }
    setStep(next);
  }

  function dismiss() {
    setShowLabel(false);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    cancelAnim.current?.();
    // Let the label fade out before removing
    setTimeout(() => setActive(false), FADE_OUT_MS);
    try { window.localStorage.setItem(TOUR_DONE_KEY, "1"); } catch { /* */ }
  }

  if (!active) return null;

  return (
    <>
      <div
        className="tour-cursor"
        style={{ transform: `translate(${cursorPos.x}px, ${cursorPos.y}px)` }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path
            d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87c.45 0 .67-.54.35-.85L5.85 2.36a.5.5 0 0 0-.35.85z"
            fill="#0b1814"
            stroke="#fbfaf6"
            strokeWidth="1.5"
          />
        </svg>
        <div className={`tour-label${showLabel ? " visible" : ""} tour-label-${displayPos}`}>
          <div className="tour-label-step">{displayStep + 1} / {STEPS.length}</div>
          <div className="tour-label-text">{displayLabel}</div>
          <div className="tour-label-actions">
            <button className="tour-btn-skip" onClick={dismiss}>Skip</button>
            <button className="tour-btn-next" onClick={goNext}>
              {displayIsLast ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
