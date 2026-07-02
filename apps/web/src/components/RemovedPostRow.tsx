"use client";

import { useEffect, useRef, useState } from "react";
import PostCard from "./PostCard";
import type { Post } from "@/app/curator/feedTypes";

/**
 * A post removed by the post-swipe revalidation sweep ("less like this").
 *
 * Mounts in place of the live card showing the same PostCard, so the swap is
 * invisible; then collapses (CSS grid 1fr → 0fr, staggered per batch index)
 * into a slim receipt row: "Removed. You asked for less of this." The receipt
 * persists until the next full reload. "Show post" peeks the removed post back
 * open, dimmed, in place — removal stays committed (there is no undo; the
 * config change is already live).
 */
export default function RemovedPostRow({
  post,
  staggerIndex = 0,
}: {
  post: Post;
  staggerIndex?: number;
}) {
  const [phase, setPhase] = useState<"card" | "collapsing" | "receipt">("card");
  const [peek, setPeek] = useState(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const staggerMs = staggerIndex * 90;

  useEffect(() => {
    // Double RAF: commit the open (1fr) frame first so the 0fr transition
    // actually animates instead of mounting collapsed.
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => setPhase("collapsing"))
    );
    // Fallback settle for when transitionend never fires (reduced motion,
    // display:none ancestors): force the receipt shortly after the transition
    // would have ended.
    settleTimer.current = setTimeout(() => setPhase("receipt"), staggerMs + 700);
    return () => {
      cancelAnimationFrame(raf);
      if (settleTimer.current) clearTimeout(settleTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase !== "receipt") {
    return (
      <div
        className={`cur-removed-collapse${phase === "collapsing" ? " closing" : ""}`}
        style={{ transitionDelay: `${staggerMs}ms` }}
        onTransitionEnd={(e) => {
          if (e.propertyName === "grid-template-rows") setPhase("receipt");
        }}
        aria-hidden
      >
        <div className="cur-removed-collapse-inner">
          <PostCard post={post} />
        </div>
      </div>
    );
  }

  return (
    <div className="cur-removed-row">
      <div className="cur-removed-receipt">
        <span className="cur-removed-x" aria-hidden>✕</span>
        <span className="cur-removed-label">Removed. You asked for less of this.</span>
        <button
          type="button"
          className="cur-removed-peek-btn"
          onClick={() => setPeek((v) => !v)}
          aria-expanded={peek}
        >
          {peek ? "Hide post" : "Show post"}
        </button>
      </div>
      <div className={`cur-removed-peek${peek ? " open" : ""}`}>
        <div className="cur-removed-peek-inner">
          <PostCard post={post} />
        </div>
      </div>
    </div>
  );
}
