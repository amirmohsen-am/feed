"use client";

import { useState, type KeyboardEvent } from "react";
import SendButton from "@/components/SendButton";
import type { BranchOption } from "@/lib/branch";

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
  /** undefined = not yet fetched, null = loading, array = done */
  topics: BranchOption[] | null | undefined;
  onChipSend: (reason: string) => void;
  onTextSend: (reason: string) => void;
  onDismiss: () => void;
}) {
  const [text, setText] = useState("");
  const [sentText, setSentText] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);

  const author =
    post.author_display_name?.trim() ||
    (post.author_handle ? `@${post.author_handle}` : post.author_did.slice(0, 12) + "\u2026");

  function chipSend(topic: BranchOption) {
    onChipSend(
      `I skipped this post by ${author}. I want to see less about \u201c${topic.label}\u201d. Please tune my feed to show less of this.`
    );
  }

  function textSend() {
    const trimmed = text.trim();
    if (!trimmed) return;
    const raw = post.text.replace(/\s+/g, " ").trim();
    const snippet = raw.slice(0, 140) + (raw.length > 140 ? "\u2026" : "");
    onTextSend(
      `I skipped this post by ${author}: \u201c${snippet}\u201d. ${trimmed}`
    );
    setSentText(trimmed);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      textSend();
    }
  }

  function handleDismiss() {
    setDismissing(true);
  }

  // Sent state: show a read-only receipt of what was submitted.
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
        onClick={handleDismiss}
        aria-label="Skip feedback"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <p className="cur-swipe-followup-label">what you&rsquo;ll see less of</p>

      <div className="cur-swipe-followup-topics">
        {topics === null ? (
          <span className="cur-dots-inline"><span /><span /><span /></span>
        ) : topics != null ? topics.map((t, i) => (
          <button
            key={i}
            type="button"
            className="cur-swipe-followup-chip"
            onClick={() => chipSend(t)}
          >
            {t.label}
          </button>
        )) : null}
      </div>

      <form
        className="cur-swipe-followup-input-row"
        onSubmit={(e) => { e.preventDefault(); textSend(); }}
      >
        <textarea
          className="cur-swipe-followup-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="or say it in your own words\u2026"
          rows={1}
        />
        <SendButton disabled={!text.trim()} />
      </form>
    </div>
  );
}
