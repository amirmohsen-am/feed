"use client";

/**
 * Auth gate for /introspect. Mirrors how the rest of the app treats
 * identity: every visitor has an anonymous session, but the meaningful
 * sign-in is connecting a Bluesky account (sets users.bluesky_did). This
 * gate requires that connection before rendering any introspect content,
 * reusing the same /api/bsky/oauth/authorize flow as the curator.
 *
 * This is a backstop for direct navigation to /introspect — the primary
 * entry point is the curator topbar, which opens the Bluesky connect dialog
 * inline. After authorizing, the OAuth callback returns the user to wherever
 * they started (threaded via the `returnTo` cookie).
 */

import { useCallback, useEffect, useState } from "react";
import { authedFetch } from "@/lib/authed-fetch";
import IntrospectBackLink from "./IntrospectBackLink";

type GateStatus = "checking" | "gated" | "allowed";

export default function IntrospectGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<GateStatus>("checking");
  const [handleInput, setHandleInput] = useState("");
  const [connecting, setConnecting] = useState(false);
  // Surface any error handed back by the OAuth callback (?bsky_error=...).
  // Read during render so the effect doesn't have to setState synchronously.
  const [error, setError] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("bsky_error");
  });

  useEffect(() => {
    // If we just came back from Bluesky OAuth, strip the transient params
    // from the URL before checking the session.
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("bsky_connected") === "1" || params.get("bsky_error")) {
        const url = new URL(window.location.href);
        url.searchParams.delete("bsky_connected");
        url.searchParams.delete("bsky_error");
        window.history.replaceState({}, "", url.pathname + url.search);
      }
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch("/api/user");
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        setStatus(res.ok && data.user?.bluesky_did ? "allowed" : "gated");
      } catch {
        if (!cancelled) setStatus("gated");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(() => {
    const h = handleInput.replace(/^@/, "").trim();
    if (!h) return;
    setConnecting(true);
    setError(null);
    authedFetch("/api/bsky/oauth/authorize", {
      method: "POST",
      body: JSON.stringify({
        handle: h,
        returnTo:
          typeof window !== "undefined"
            ? window.location.pathname + window.location.search
            : "/introspect",
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.url) {
          window.location.href = data.url;
        } else {
          setError(data.error || "Could not start sign-in. Try again?");
          setConnecting(false);
        }
      })
      .catch(() => {
        setError("Could not start sign-in. Try again?");
        setConnecting(false);
      });
  }, [handleInput]);

  if (status === "allowed") return <>{children}</>;

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#fafafa] text-[#1a1a1a]">
      <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6 sm:py-24">
        <IntrospectBackLink />
        <h1 className="mb-3 font-serif text-3xl tracking-tight sm:text-4xl">
          introspect
        </h1>

        {status === "checking" ? (
          <p className="text-[#666]">Checking your session…</p>
        ) : (
          <>
            <p className="mb-8 leading-relaxed text-[#666]">
              A natural-language self-portrait built from Bluesky engagements —
              likes, reposts, quotes, posts, and replies. Connect your Bluesky
              account to continue.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                connect();
              }}
              className="flex flex-col gap-2 sm:flex-row"
            >
              <input
                type="text"
                value={handleInput}
                onChange={(e) => {
                  setHandleInput(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="yourname.bsky.social"
                aria-label="Your Bluesky handle"
                className="min-h-11 flex-1 rounded border border-[#ddd] bg-white px-3 py-2 text-base focus:border-[#1a1a1a] focus:outline-none sm:text-sm"
                autoFocus
                disabled={connecting}
              />
              <button
                type="submit"
                disabled={!handleInput.trim() || connecting}
                className="min-h-11 rounded bg-[#1a1a1a] px-4 py-2 text-white disabled:opacity-50 sm:min-h-0"
              >
                {connecting ? "Connecting…" : "Connect Bluesky"}
              </button>
            </form>
            <p className="mt-3 text-sm text-[#999]">
              You&rsquo;ll be redirected to Bluesky to authorize access.
            </p>
            {error && <p className="mt-4 text-sm text-[#a44a3b]">{error}</p>}
          </>
        )}
      </div>
    </main>
  );
}
