"use client";

import { useEffect, useRef, useState } from "react";

/**
 * First-run surface shown inside the feed pane while a feed has no criteria yet
 * (new feed / first visit). Opens with the brand "intention" moment — the logo
 * stands in for the "a" in "amadi" and the wordmark reveals per-character, the
 * same treatment as the landing headline — then lifts away into three ways in:
 * describe it, bring your ChatGPT memory, or answer a few questions.
 *
 * The full moment plays only the first time the surface appears in a session;
 * after that the options show directly (the animation is a welcome, not a gate).
 */

// Module-scoped so it survives the per-feed remount of the workbench.
let introPlayed = false;

interface Props {
  onDescribe: () => void;
  onMemory: () => void;
  onGuided: () => void;
}

export default function OnboardingIntention({ onDescribe, onMemory, onGuided }: Props) {
  const shouldPlayRef = useRef(!introPlayed);
  const shouldPlay = shouldPlayRef.current;
  const [phase, setPhase] = useState<"brand" | "options">(shouldPlay ? "brand" : "options");
  const [revealed, setRevealed] = useState(!shouldPlay);

  useEffect(() => {
    if (!shouldPlay) return;
    introPlayed = true;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setRevealed(true);
      setPhase("options");
      return;
    }
    const t0 = setTimeout(() => setRevealed(true), 80); // release the char reveal
    const t1 = setTimeout(() => setPhase("options"), 2600); // hold, then lift out
    return () => {
      clearTimeout(t0);
      clearTimeout(t1);
    };
  }, [shouldPlay]);

  return (
    <div className="cur-ob" data-phase={phase}>
      {/* ── brand moment ── */}
      <div className={`cur-ob-brand${revealed ? " revealed" : ""}`} aria-hidden={phase === "options"}>
        <h1 className="cur-ob-word" aria-label="amadi">
          <span className="cur-ob-mask">
            <span className="cur-ob-char cur-ob-logochar">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/images/logo_periwinkle.svg" alt="" />
            </span>
            {Array.from("madi").map((ch, i) => (
              <span key={i} className="cur-ob-char">
                {ch}
              </span>
            ))}
          </span>
        </h1>
        <p className="cur-ob-q">What&apos;s your intention?</p>
      </div>

      {/* ── options ── */}
      <div className="cur-ob-options" aria-hidden={phase === "brand"}>
        <div className="cur-ob-inner">
          <div className="cur-ob-head">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="cur-ob-mk" src="/images/logo_periwinkle.svg" alt="amadi" />
            <span className="cur-ob-hq">What&apos;s your intention?</span>
          </div>
          <div className="cur-ob-cards">
            <button className="cur-ob-card" type="button" onClick={onDescribe}>
              <span className="cur-ob-ic">
                <svg viewBox="0 0 24 24" strokeWidth={1.7} fill="none">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </span>
              <span className="cur-ob-ct">
                <b>Describe what you want to read</b>
                <i>Tell amadi and it builds the feed</i>
              </span>
            </button>

            <button className="cur-ob-card" type="button" onClick={onMemory}>
              <span className="cur-ob-ic">
                <svg viewBox="0 0 24 24" strokeWidth={1.7} fill="none">
                  <path d="M12 3l1.8 4.7L18.5 9l-4.7 1.8L12 15.5l-1.8-4.7L5.5 9l4.7-1.3zM18 15l.9 2.3L21 18l-2.1.7L18 21l-.9-2.3L15 18l2.1-.7z" />
                </svg>
              </span>
              <span className="cur-ob-ct">
                <b>Bring your ChatGPT memory</b>
                <i>Start from what you already told it</i>
              </span>
            </button>

            <button className="cur-ob-card" type="button" onClick={onGuided}>
              <span className="cur-ob-ic">
                <svg viewBox="0 0 24 24" strokeWidth={1.7} fill="none">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M15 9l-2 5-4 2 2-5z" />
                </svg>
              </span>
              <span className="cur-ob-ct">
                <b>Help me figure it out</b>
                <i>Answer a few quick questions</i>
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
