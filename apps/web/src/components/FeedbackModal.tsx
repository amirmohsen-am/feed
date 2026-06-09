"use client";

import { useState } from "react";
import { authedFetch } from "@/lib/authed-fetch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";

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

  const fieldStyle: React.CSSProperties = {
    background: "#fff",
    border: "1px solid var(--hair-strong)",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 13,
    color: "var(--ink)",
    fontFamily: "var(--rf-body)",
    outline: "none",
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !submitting) onClose();
      }}
    >
      <DialogContent className="settings-dialog">
        <DialogHeader>
          <DialogTitle
            style={{ fontFamily: "var(--rf-display)", fontSize: 22, fontWeight: 400 }}
          >
            Send feedback
          </DialogTitle>
          {feedName && (
            <div
              style={{
                fontSize: 11,
                color: "var(--ink-3)",
                fontFamily: "var(--rf-mono)",
                letterSpacing: "0.04em",
              }}
            >
              About: {feedName}
            </div>
          )}
        </DialogHeader>
        <Separator />

        <form onSubmit={handleSubmit} style={{ display: "grid", gap: 18 }}>
          {/* Category */}
          <label style={{ display: "grid", gap: 6 }}>
            <span className="settings-label" style={{ marginBottom: 0 }}>
              Topic
            </span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as Category)}
              disabled={submitting}
              style={{ ...fieldStyle, appearance: "none" }}
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
            <span className="settings-label" style={{ marginBottom: 0 }}>
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
                        ? "1px solid var(--aurora-deep)"
                        : "1px solid var(--hair-strong)",
                      background: selected ? "var(--aurora-deep)" : "#fff",
                      color: selected ? "#fff" : "var(--ink-2)",
                      fontFamily: "var(--rf-mono)",
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
                color: "var(--ink-3)",
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
            <span className="settings-label" style={{ marginBottom: 0 }}>
              Tell us more{" "}
              <span style={{ textTransform: "none", letterSpacing: 0 }}>
                (optional)
              </span>
            </span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, MAX_BODY_CHARS))}
              rows={5}
              placeholder="What worked, what didn't, what you wish was different…"
              disabled={submitting}
              style={{ ...fieldStyle, resize: "vertical", minHeight: 80 }}
            />
            <span
              style={{
                fontSize: 10,
                color: "var(--ink-3)",
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
                color: "var(--rose)",
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
                color: "var(--aurora-deep)",
                fontFamily: "var(--rf-mono)",
              }}
            >
              ✓ Thanks — feedback sent.
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 10,
            }}
          >
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              style={{
                background: "transparent",
                border: "1px solid var(--hair-strong)",
                color: "var(--ink-2)",
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
                background: "var(--aurora-deep)",
                border: "1px solid var(--aurora-deep)",
                color: "#fff",
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
      </DialogContent>
    </Dialog>
  );
}
