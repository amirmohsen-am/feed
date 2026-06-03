"use client";

import { useState, useEffect, useRef } from "react";
import { authedFetch } from "@/lib/authed-fetch";

type Category = "bug" | "idea" | "feed_quality" | "other";

const CATEGORIES: { value: Category; label: string }[] = [
  { value: "bug", label: "Bug" },
  { value: "idea", label: "Idea" },
  { value: "feed_quality", label: "Feed quality" },
  { value: "other", label: "Other" },
];

const MAX_BODY_CHARS = 4000;

interface FeedbackModalProps {
  onClose: () => void;
  /** Numeric feed id of the currently-open feed, if any. */
  feedId: number | null;
  /** Human-readable name of the currently-open feed (for the subtitle). */
  feedName: string | null;
}

export default function FeedbackModal({
  onClose,
  feedId,
  feedName,
}: FeedbackModalProps) {
  // Default to "feed_quality" when opened from inside a feed — it's the
  // more useful answer 80% of the time. User can still flip.
  const [category, setCategory] = useState<Category>(
    feedId ? "feed_quality" : "idea"
  );
  const [rating, setRating] = useState<number | null>(null);
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const firstRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (rating == null) {
      setError("Pick a 1–10 rating before sending.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await authedFetch("/api/feedback", {
        method: "POST",
        body: JSON.stringify({
          category,
          rating,
          body: body.trim() || undefined,
          feedId,
          pageUrl: typeof window !== "undefined" ? window.location.href : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setDone(true);
      setTimeout(onClose, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
        padding: 16,
      }}
      onClick={() => { if (!submitting) onClose(); }}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--midnight, #0a1a14)",
          border: "1px solid var(--hair, #1a2e24)",
          borderRadius: 12,
          width: "100%",
          maxWidth: 480,
          overflow: "hidden",
          fontFamily: "var(--rf-body, system-ui)",
          color: "var(--cream, #f3ecdd)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 24px",
            borderBottom: "1px solid var(--hair, #1a2e24)",
          }}
        >
          <div>
            <div
              style={{
                fontFamily: "var(--rf-display, Georgia)",
                fontSize: 18,
                fontWeight: 400,
              }}
            >
              Send feedback
            </div>
            {feedName && (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--parchment-dim, #8a9a90)",
                  marginTop: 2,
                  fontFamily: "var(--rf-mono, ui-monospace)",
                  letterSpacing: "0.04em",
                }}
              >
                About: {feedName}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            style={{
              background: "none",
              border: "none",
              color: "var(--parchment-dim, #8a9a90)",
              fontSize: 20,
              cursor: submitting ? "not-allowed" : "pointer",
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div style={{ padding: "20px 24px", display: "grid", gap: 18 }}>
          {/* Category */}
          <label style={{ display: "grid", gap: 6 }}>
            <span
              style={{
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                color: "var(--parchment-dim)",
                fontFamily: "var(--rf-mono)",
              }}
            >
              Topic
            </span>
            <select
              ref={firstRef}
              value={category}
              onChange={(e) => setCategory(e.target.value as Category)}
              disabled={submitting}
              style={{
                background: "var(--void, #060f0b)",
                border: "1px solid var(--hair-strong, #2a3e34)",
                borderRadius: 8,
                padding: "10px 12px",
                fontSize: 13,
                color: "var(--cream)",
                fontFamily: "var(--rf-body)",
                outline: "none",
                appearance: "none",
              }}
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          {/* Rating */}
          <div style={{ display: "grid", gap: 8 }}>
            <span
              style={{
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                color: "var(--parchment-dim)",
                fontFamily: "var(--rf-mono)",
              }}
            >
              How happy are you with Ripple Feed right now?
            </span>
            <div
              role="radiogroup"
              aria-label="Rating from 1 to 10"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(10, 1fr)",
                gap: 4,
              }}
            >
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
                const selected = rating === n;
                return (
                  <button
                    type="button"
                    key={n}
                    onClick={() => setRating(n)}
                    aria-pressed={selected}
                    disabled={submitting}
                    style={{
                      padding: "8px 0",
                      borderRadius: 6,
                      border: selected
                        ? "1px solid var(--aurora, #6fd1a3)"
                        : "1px solid var(--hair-strong, #2a3e34)",
                      background: selected ? "var(--aurora, #6fd1a3)" : "var(--void, #060f0b)",
                      color: selected ? "var(--void, #060f0b)" : "var(--cream)",
                      fontFamily: "var(--rf-mono, ui-monospace)",
                      fontSize: 12,
                      cursor: submitting ? "not-allowed" : "pointer",
                      transition: "background 120ms, color 120ms, border-color 120ms",
                    }}
                  >
                    {n}
                  </button>
                );
              })}
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 10,
                color: "var(--parchment-dim)",
                fontFamily: "var(--rf-mono)",
                letterSpacing: "0.05em",
              }}
            >
              <span>1 · not great</span>
              <span>10 · love it</span>
            </div>
          </div>

          {/* Comment */}
          <label style={{ display: "grid", gap: 6 }}>
            <span
              style={{
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                color: "var(--parchment-dim)",
                fontFamily: "var(--rf-mono)",
              }}
            >
              Tell us more <span style={{ textTransform: "none", letterSpacing: 0 }}>(optional)</span>
            </span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, MAX_BODY_CHARS))}
              rows={5}
              placeholder="What worked, what didn't, what you wish was different…"
              disabled={submitting}
              style={{
                background: "var(--void, #060f0b)",
                border: "1px solid var(--hair-strong, #2a3e34)",
                borderRadius: 8,
                padding: "10px 12px",
                fontSize: 13,
                color: "var(--cream)",
                fontFamily: "var(--rf-body)",
                resize: "vertical",
                outline: "none",
                minHeight: 80,
              }}
            />
            <span
              style={{
                fontSize: 10,
                color: "var(--parchment-dim)",
                fontFamily: "var(--rf-mono)",
                textAlign: "right",
              }}
            >
              {body.length} / {MAX_BODY_CHARS}
            </span>
          </label>

          {error && (
            <div
              style={{
                fontSize: 12,
                color: "var(--rose, #ff7a7a)",
                fontFamily: "var(--rf-mono)",
              }}
            >
              {error}
            </div>
          )}

          {done && (
            <div
              style={{
                fontSize: 12,
                color: "var(--aurora, #6fd1a3)",
                fontFamily: "var(--rf-mono)",
              }}
            >
              ✓ Thanks — feedback sent.
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            padding: "12px 24px 18px",
            borderTop: "1px solid var(--hair, #1a2e24)",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            style={{
              background: "transparent",
              border: "1px solid var(--hair-strong, #2a3e34)",
              color: "var(--parchment)",
              fontFamily: "var(--rf-mono)",
              fontSize: 11,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              borderRadius: 999,
              padding: "8px 16px",
              cursor: submitting ? "not-allowed" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || done}
            style={{
              background: "var(--aurora, #6fd1a3)",
              border: "1px solid var(--aurora, #6fd1a3)",
              color: "var(--void, #060f0b)",
              fontFamily: "var(--rf-mono)",
              fontSize: 11,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              borderRadius: 999,
              padding: "8px 18px",
              cursor: submitting || done ? "not-allowed" : "pointer",
              opacity: submitting || done ? 0.6 : 1,
            }}
          >
            {submitting ? "Sending…" : done ? "Sent" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}
