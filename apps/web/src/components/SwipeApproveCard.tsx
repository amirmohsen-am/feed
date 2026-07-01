"use client";

import { useState, useEffect, useRef, type KeyboardEvent } from "react";
import type { BranchOption } from "@/lib/branch";

const LOADING_PHRASES = [
  "reading the vibes",
  "finding related topics",
  "surfacing what matters",
  "connecting the dots",
  "tuning in",
];

function LoadingCycler() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setIdx((i) => (i + 1) % LOADING_PHRASES.length), 2000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="cur-swipe-followup-loading">
      <span key={idx} className="cur-swipe-followup-loading-text">
        {LOADING_PHRASES[idx]}
      </span>
    </div>
  );
}

interface PostSummary {
  uri: string;
  author_handle: string | null;
  author_display_name: string | null;
  author_did: string;
  text: string;
}

export default function SwipeApproveCard({
  post,
  topics,
  onChipSend,
  onTextSend,
  onDismiss,
}: {
  post: PostSummary;
  topics: BranchOption[] | undefined;
  onChipSend: (reason: string) => void;
  onTextSend: (reason: string) => void;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(() => new Set());

  const wrapRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyInnerRef = useRef<HTMLDivElement>(null);

  const author =
    post.author_display_name?.trim() ||
    (post.author_handle ? `@${post.author_handle}` : post.author_did.slice(0, 12) + "\u2026");

  const hasPills = selectedIndices.size > 0;
  const canSubmit = hasPills || text.trim().length > 0;

  function openBody() {
    const body = bodyRef.current;
    const inner = bodyInnerRef.current;
    if (!body || !inner) return;
    body.style.overflow = "hidden";
    body.style.height = "0px";
    const target = inner.scrollHeight;
    void body.offsetHeight;
    body.style.transition = "height 0.34s cubic-bezier(0.2, 0.7, 0.3, 1)";
    body.style.height = `${target}px`;
    setTimeout(() => { if (bodyRef.current) { bodyRef.current.style.height = "auto"; bodyRef.current.style.overflow = "visible"; } }, 360);
  }

  function closeBody() {
    const body = bodyRef.current;
    if (!body) return;
    const h = body.offsetHeight;
    body.style.overflow = "hidden";
    body.style.height = `${h}px`;
    void body.offsetHeight;
    body.style.transition = "height 0.3s cubic-bezier(0.4, 0, 0.2, 1)";
    body.style.height = "0px";
  }

  function handleToggle() {
    const next = !expanded;
    setExpanded(next);
    if (next) openBody(); else closeBody();
  }

  function handleDismiss() {
    const wrap = wrapRef.current;
    if (!wrap) { onDismiss(); return; }
    const h = wrap.offsetHeight;
    wrap.style.height = `${h}px`;
    wrap.style.overflow = "hidden";
    void wrap.offsetHeight;
    wrap.style.transition = "height 0.32s cubic-bezier(0.4,0,0.2,1), opacity 0.26s";
    wrap.style.height = "0px";
    wrap.style.opacity = "0";
    setTimeout(onDismiss, 340);
  }

  function handlePillClick(index: number) {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function submit() {
    if (!canSubmit) return;
    if (hasPills && topics) {
      const selected = topics.filter((_, i) => selectedIndices.has(i));
      const labels = selected.map((t) => t.label).join(", ");
      const extra = text.trim() ? ` ${text.trim()}` : "";
      onChipSend(
        `I liked this post by ${author}. Please tune my feed to show more of: ${labels}${extra}`
      );
    } else {
      const trimmed = text.trim();
      const raw = post.text.replace(/\s+/g, " ").trim();
      const snippet = raw.slice(0, 140) + (raw.length > 140 ? "\u2026" : "");
      onTextSend(
        `I liked this post by ${author}: \u201c${snippet}\u201d. ${trimmed}`
      );
    }
    // Collapse the panel back behind the card — post stays visible.
    handleDismiss();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  }

  return (
    <div ref={wrapRef} className={`cur-swipe-approve${expanded ? " cur-swipe-approve--expanded" : ""}`}>
      <button
        type="button"
        className="cur-swipe-approve-header"
        onClick={handleToggle}
        aria-expanded={expanded}
      >
        <span className="cur-swipe-approve-header-text">What did you like?</span>
        <svg
          className="cur-swipe-approve-chevron"
          width="14" height="14" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Body — height driven imperatively, overflow:hidden initial state set in CSS */}
      <div ref={bodyRef} className="cur-swipe-approve-body">
        <div ref={bodyInnerRef} className="cur-swipe-approve-body-inner">
          <button
            type="button"
            className="cur-swipe-followup-dismiss"
            onClick={handleDismiss}
            aria-label="Skip feedback"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>

          <p className="cur-swipe-approve-label">what you&rsquo;ll see more of</p>

          {topics === undefined ? (
            <LoadingCycler />
          ) : (
            <div className="cur-swipe-followup-topics">
              {topics.map((t, i) => (
                <button
                  key={i}
                  type="button"
                  className={`cur-swipe-followup-chip${selectedIndices.has(i) ? " cur-swipe-followup-chip--selected" : ""}`}
                  onClick={() => handlePillClick(i)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          <form
            className="cur-swipe-followup-composer"
            onSubmit={(e) => { e.preventDefault(); submit(); }}
          >
            <textarea
              className="cur-swipe-followup-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="or say it in your own words\u2026"
              rows={1}
            />
            <button
              type="submit"
              className="cur-swipe-followup-send"
              disabled={!canSubmit}
              aria-label="Send"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
