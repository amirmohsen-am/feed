"use client";

import { useEffect, useRef, useState } from "react";

/**
 * First-run surface shown inside the feed pane while a feed has no criteria yet.
 * Three phases:
 *   brand  — wordmark + "What's your intention?" reveal
 *   prompt — brand stays; "[tap to start]" fades in. User must tap to proceed.
 *   options — options cards slide in.
 */

let introPlayed = false;

interface Props {
  onDescribe: () => void;
  onMemory: () => void;
  onGuided: () => void;
}

export default function OnboardingIntention({ onDescribe, onMemory, onGuided }: Props) {
  const shouldPlayRef = useRef(!introPlayed);
  const shouldPlay = shouldPlayRef.current;
  const [phase, setPhase] = useState<"brand" | "prompt" | "options">(shouldPlay ? "brand" : "options");
  const [revealed, setRevealed] = useState(!shouldPlay);

  useEffect(() => {
    if (!shouldPlay) return;
    introPlayed = true;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setRevealed(true);
      setPhase("prompt");
      return;
    }
    const t0 = setTimeout(() => setRevealed(true), 80);
    const t1 = setTimeout(() => setPhase("prompt"), 2520);
    return () => {
      clearTimeout(t0);
      clearTimeout(t1);
    };
  }, [shouldPlay]);

  function handleBrandTap() {
    if (phase === "prompt") setPhase("options");
  }

  return (
    <div className="cur-ob" data-phase={phase}>
      {/* ── brand + prompt moment ── */}
      <div
        className={`cur-ob-brand${revealed ? " revealed" : ""}`}
        aria-hidden={phase === "options"}
        onClick={handleBrandTap}
        style={{ cursor: phase === "prompt" ? "pointer" : undefined }}
      >
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
        <p className="cur-ob-subtitle">means intention.</p>
        <p className="cur-ob-q">What&apos;s your intention?</p>
        <p className="cur-ob-tap-prompt" aria-hidden>[ tap to start ]</p>
      </div>

      {/* ── options ── */}
      <div className="cur-ob-options" aria-hidden={phase !== "options"}>
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
