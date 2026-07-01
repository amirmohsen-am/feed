"use client";

import { useState, useEffect, type KeyboardEvent } from "react";
import type { BranchOption } from "@/lib/branch";

// Accepts either NegativeTopic (description field) or BranchOption (subquery field).
type FollowupTopic = { label: string; description?: string; subquery?: string };

const LOADING_PHRASES = [
  "analyzing content",
  "filtering slop",
  "fighting shit posts",
  "identifying bait",
  "reading between the posts",
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

export default function SwipeFollowupCard({
  post,
  topics,
  onChipSend,
  onTextSend,
  onDismiss,
}: {
  post: PostSummary;
  /** undefined = not yet fetched/loading, array = done */
  topics: FollowupTopic[] | BranchOption[] | undefined;
  onChipSend: (reason: string) => void;
  onTextSend: (reason: string) => void;
  onDismiss: () => void;
}) {
  const [text, setText] = useState("");
  const [sentText, setSentText] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(() => new Set());

  const author =
    post.author_display_name?.trim() ||
    (post.author_handle ? `@${post.author_handle}` : post.author_did.slice(0, 12) + "\u2026");

  const hasPills = selectedIndices.size > 0;
  const canSubmit = hasPills || text.trim().length > 0;

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
      const descriptions = selected.map((t) => ("description" in t ? t.description : undefined) ?? ("subquery" in t ? t.subquery : undefined) ?? t.label).join(" ");
      const extra = text.trim() ? ` ${text.trim()}` : "";
      onChipSend(
        `I skipped this post by ${author}. ${descriptions}${extra} Please tune my feed to show less of this.`
      );
      const receipt = selected.map((t) => t.label).join(", ");
      setSentText(text.trim() ? `${receipt} — ${text.trim()}` : receipt);
    } else {
      const trimmed = text.trim();
      const raw = post.text.replace(/\s+/g, " ").trim();
      const snippet = raw.slice(0, 140) + (raw.length > 140 ? "\u2026" : "");
      onTextSend(
        `I skipped this post by ${author}: \u201c${snippet}\u201d. ${trimmed}`
      );
      setSentText(trimmed);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  if (sentText !== null) {
    return (
      <div className="cur-swipe-followup cur-swipe-followup-receipt-wrap">
        <p className="cur-swipe-followup-label">what you&rsquo;ll see less of</p>
        <div className="cur-swipe-followup-receipt">{sentText}</div>
      </div>
    );
  }

  return (
    <div
      className={`cur-swipe-followup${dismissing ? " cur-swipe-followup-out" : ""}`}
      onAnimationEnd={() => { if (dismissing) onDismiss(); }}
    >
      <button
        type="button"
        className="cur-swipe-followup-dismiss"
        onClick={() => setDismissing(true)}
        aria-label="Skip feedback"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <p className="cur-swipe-followup-label">what you&rsquo;ll see less of</p>

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
          placeholder="or say it in your own words…"
          rows={1}
        />
        <button
          type="submit"
          className="cur-swipe-followup-send"
          disabled={!canSubmit}
          aria-label="Send"
          title="Send"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </form>
    </div>
  );
}
