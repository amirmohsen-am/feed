"use client";

import { useEffect, useState } from "react";
import type { ApiErrorDetail } from "@/lib/authed-fetch";

interface VisibleError extends ApiErrorDetail {
  id: number;
  ts: number;
}

/**
 * Fixed-position banner that listens for `ripple:api-error` CustomEvents
 * (dispatched from `authedFetch`) and surfaces them so the user sees what
 * would otherwise be a silent 4xx/5xx. Mounted in the root layout so it
 * works across every page without any per-page wiring.
 *
 * Multiple errors collapse to one banner showing the most recent.
 */
export default function ServerErrorToast() {
  const [current, setCurrent] = useState<VisibleError | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);

  useEffect(() => {
    let counter = 0;
    function onError(ev: Event) {
      const ce = ev as CustomEvent<ApiErrorDetail>;
      const d = ce.detail;
      if (!d) return;
      // The account wall has its own full-screen modal (CuratorShell listens
      // for this same event) — a toast on top would be redundant noise.
      if (d.code === "account_wall") return;
      counter += 1;
      setCurrent({ ...d, id: counter, ts: Date.now() });
    }
    window.addEventListener("ripple:api-error", onError as EventListener);
    return () =>
      window.removeEventListener("ripple:api-error", onError as EventListener);
  }, []);

  if (!current || current.id === dismissed) return null;

  const pathName = (() => {
    try {
      return new URL(current.url, window.location.origin).pathname;
    } catch {
      return current.url;
    }
  })();

  // A 429 is an expected rate-limit, not a server fault — render it as a calm
  // amber "slow down" notice instead of the alarming red error banner.
  const isRateLimit = current.status === 429;
  const accent = isRateLimit ? "#d8b075" : "#d88575";
  const background = isRateLimit ? "#19140c" : "#1a0e0c";
  const title = isRateLimit ? "Easy there" : `${current.status} ${pathName}`;
  const tag = isRateLimit ? "rate limit" : "server error";
  const retryHint =
    isRateLimit && current.retryAfter
      ? `Try again in about ${current.retryAfter} second${current.retryAfter === 1 ? "" : "s"}.`
      : current.hint;

  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 10000,
        maxWidth: 560,
        width: "calc(100% - 32px)",
        background,
        border: `1px solid ${isRateLimit ? "rgba(216,176,117,.55)" : "rgba(216,133,117,.55)"}`,
        borderRadius: 8,
        padding: "12px 16px",
        color: "#f3ecdd",
        fontFamily: "var(--font-sans), system-ui, sans-serif",
        fontSize: 13,
        lineHeight: 1.5,
        boxShadow: "0 8px 32px -8px rgba(0,0,0,.6)",
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
      }}
    >
      <div style={{ flex: 1 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            marginBottom: 4,
          }}
        >
          <strong style={{ color: accent }}>{title}</strong>
          <span
            style={{
              fontFamily:
                "var(--font-geist-mono), ui-monospace, 'SF Mono', monospace",
              fontSize: 11,
              color: "#a8b5a8",
            }}
          >
            {tag}
          </span>
        </div>
        <div style={{ color: "#e6dcc7" }}>{current.message}</div>
        {retryHint && (
          <div
            style={{
              marginTop: 6,
              color: "#a8d5bd",
              fontSize: 12.5,
              fontStyle: "normal",
            }}
          >
            {retryHint}
          </div>
        )}
      </div>
      <button
        onClick={() => setDismissed(current.id)}
        aria-label="Dismiss"
        style={{
          background: "transparent",
          border: "none",
          color: "#a8b5a8",
          cursor: "pointer",
          fontSize: 18,
          lineHeight: 1,
          padding: "0 4px",
        }}
      >
        ×
      </button>
    </div>
  );
}
