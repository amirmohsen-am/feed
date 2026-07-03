"use client";

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { authedFetch } from "@/lib/authed-fetch";
import { stashPendingAction, type PendingAction } from "@/lib/pending-action";

// The connect/create popup: one dialog, three pages (design: Toby's
// "Connect flow: one chooser, two paths" artifact). Page 1 explains Bluesky
// and offers two routes; create sends the user to Bluesky's hosted signup via
// OAuth prompt=create, connect is the existing handle flow one level deep.
//
// Variants: "default" (action or settings triggered), "nudge" (usage
// threshold crossed, dismissible), "wall" (grace period over, NOT
// dismissible — the server enforces this too, the modal is just the UI).

export type ConnectVariant = "default" | "nudge" | "wall";

type Page = "choice" | "create" | "connect";

interface ConnectBlueskyModalProps {
  open: boolean;
  variant: ConnectVariant;
  /** Contextual first line, e.g. "Connect to like posts from here." */
  reason?: string;
  /** Action to resume after the OAuth round trip completes. */
  pendingAction?: PendingAction | null;
  /** Same-origin path to land back on; defaults to the current path. */
  returnTo?: string;
  onClose: () => void;
}

const pillButton = (enabled: boolean): React.CSSProperties => ({
  background: enabled ? "var(--aurora-deep)" : "var(--hair-strong)",
  color: "#fff",
  fontFamily: "var(--rf-mono)",
  fontSize: 10,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  borderRadius: 999,
  padding: "8px 16px",
  border: "none",
  cursor: enabled ? "pointer" : "not-allowed",
  opacity: enabled ? 1 : 0.5,
});

export default function ConnectBlueskyModal({
  open,
  variant,
  reason,
  pendingAction,
  returnTo,
  onClose,
}: ConnectBlueskyModalProps) {
  const [page, setPage] = useState<Page>("choice");
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const handleInputRef = useRef<HTMLInputElement>(null);

  // Fresh chooser every time the modal opens.
  useEffect(() => {
    if (open) {
      setPage("choice");
      setHandle("");
      setError("");
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    if (page === "connect") handleInputRef.current?.focus();
  }, [page]);

  async function startAuthorize(body: { handle?: string; mode?: "create" }) {
    setBusy(true);
    setError("");
    try {
      const res = await authedFetch("/api/bsky/oauth/authorize", {
        method: "POST",
        body: JSON.stringify({
          ...body,
          returnTo:
            returnTo ??
            window.location.pathname + window.location.search,
        }),
        suppressErrorToast: true,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        throw new Error(data.error || "Could not reach Bluesky. Try again.");
      }
      // Stash only once the redirect is certain; any curator mount without
      // ?bsky_connected=1 discards it, so an abandoned flow never fires it.
      if (pendingAction) stashPendingAction(pendingAction);
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  }

  const isWall = variant === "wall";
  const chooserTitle = isWall
    ? "Keep your feeds with a Bluesky account"
    : variant === "nudge"
      ? "We hope you're enjoying Amadi"
      : "Connect Bluesky";
  const chooserLede = isWall
    ? "Your free preview of Amadi has ended. Amadi builds your feed from Bluesky, an open social network. Connect an account to keep curating, and everything you made here stays."
    : "Amadi builds your feed from Bluesky, an open social network. Connecting an account lets you like, reply, and publish feeds without leaving Amadi.";

  const backLink = (
    <button
      type="button"
      onClick={() => { setPage("choice"); setError(""); }}
      style={{
        alignSelf: "flex-start",
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        border: "none",
        background: "transparent",
        color: "var(--ink-3)",
        fontFamily: "var(--rf-mono)",
        fontSize: 10,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        fontWeight: 600,
        cursor: "pointer",
        padding: "4px 6px",
        margin: "-4px 0 0 -6px",
        borderRadius: 6,
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m15 18-6-6 6-6" />
      </svg>
      Back
    </button>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !isWall) onClose();
      }}
    >
      <DialogContent className="settings-dialog" showCloseButton={!isWall}>
        {page === "choice" && (
          <>
            <DialogHeader>
              <DialogTitle style={{ fontFamily: "var(--rf-display)", fontSize: 22, fontWeight: 400, color: "var(--ink)", lineHeight: 1.15 }}>
                {chooserTitle}
              </DialogTitle>
            </DialogHeader>
            <Separator />
            {reason && !isWall && (
              <p style={{ fontSize: 13, color: "var(--aurora-deep)", fontFamily: "var(--rf-body)", fontWeight: 500, margin: 0 }}>
                {reason}
              </p>
            )}
            <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6, margin: 0 }}>
              {chooserLede}
            </p>
            <div>
              <span className="profile-label">Connect to Bluesky</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <button
                  type="button"
                  className="connect-option-card primary"
                  onClick={() => setPage("create")}
                  disabled={busy}
                >
                  <span className="connect-option-icon" aria-hidden>
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M19 8v6M22 11h-6" />
                    </svg>
                  </span>
                  <span className="connect-option-text">
                    <span className="connect-option-title">I&rsquo;m new to Bluesky</span>
                    <span className="connect-option-sub">
                      Create a free account in about a minute, then land right back here with it connected.
                    </span>
                  </span>
                  <svg className="connect-option-chev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="connect-option-card"
                  onClick={() => setPage("connect")}
                  disabled={busy}
                >
                  <span className="connect-option-icon" aria-hidden>
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                      <circle cx="12" cy="7" r="4" />
                    </svg>
                  </span>
                  <span className="connect-option-text">
                    <span className="connect-option-title">I already have an account</span>
                    <span className="connect-option-sub">
                      Sign in with your Bluesky handle to link it to Amadi.
                    </span>
                  </span>
                  <svg className="connect-option-chev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </button>
              </div>
            </div>
            <p style={{ fontSize: 11, color: "var(--ink-3)", lineHeight: 1.5, margin: 0 }}>
              Amadi only asks Bluesky for permission to act on your behalf. You
              can disconnect at any time.
            </p>
          </>
        )}

        {page === "create" && (
          <>
            {backLink}
            <DialogHeader>
              <DialogTitle style={{ fontFamily: "var(--rf-display)", fontSize: 22, fontWeight: 400, color: "var(--ink)", lineHeight: 1.15 }}>
                Create a Bluesky account
              </DialogTitle>
            </DialogHeader>
            <Separator />
            <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6, margin: 0 }}>
              We&rsquo;ll send you to Bluesky to sign up. When you finish,
              you&rsquo;ll land back in Amadi with your new account already
              connected.
            </p>
            <ul className="connect-check-list">
              <li>Free, and it takes about a minute</li>
              <li>Your email and password stay with Bluesky. Amadi never sees them</li>
              <li>You own your handle and can take it to any Bluesky app</li>
            </ul>
            {error && (
              <p style={{ fontSize: 12, color: "var(--rose)", margin: 0 }}>{error}</p>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <button
                type="button"
                disabled={busy}
                onClick={() => startAuthorize({ mode: "create" })}
                style={pillButton(!busy)}
              >
                {busy ? "Redirecting…" : <>Continue to Bluesky <span aria-hidden>↗</span></>}
              </button>
            </div>
          </>
        )}

        {page === "connect" && (
          <>
            {backLink}
            <DialogHeader>
              <DialogTitle style={{ fontFamily: "var(--rf-display)", fontSize: 22, fontWeight: 400, color: "var(--ink)", lineHeight: 1.15 }}>
                Sign in to Bluesky
              </DialogTitle>
            </DialogHeader>
            <Separator />
            <div className="profile-section">
              <label className="profile-label" htmlFor="connect-bsky-handle">
                Your Bluesky handle
              </label>
              <input
                id="connect-bsky-handle"
                ref={handleInputRef}
                type="text"
                placeholder="yourname.bsky.social"
                value={handle}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => { setHandle(e.target.value); setError(""); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && handle.trim() && !busy) {
                    e.preventDefault();
                    void startAuthorize({ handle: handle.trim().replace(/^@/, "") });
                  }
                }}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  background: "#fff",
                  border: "1px solid var(--hair-strong)",
                  borderRadius: 8,
                  color: "var(--ink)",
                  fontFamily: "var(--rf-body)",
                  fontSize: 14,
                  outline: "none",
                }}
              />
              <p style={{ color: "var(--ink-3)", fontFamily: "var(--rf-body)", fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
                You&rsquo;ll approve access on Bluesky and come right back
                here. Amadi never sees your password.
              </p>
              <p style={{ color: "var(--ink-3)", fontFamily: "var(--rf-body)", fontSize: 12, marginTop: 10 }}>
                New to Bluesky?{" "}
                <button
                  type="button"
                  className="connect-link-btn"
                  onClick={() => { setPage("create"); setError(""); }}
                >
                  Create an account instead
                </button>
              </p>
            </div>
            {error && (
              <p style={{ fontSize: 12, color: "var(--rose)", margin: 0 }}>{error}</p>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <button
                type="button"
                disabled={!handle.trim() || busy}
                onClick={() => void startAuthorize({ handle: handle.trim().replace(/^@/, "") })}
                style={pillButton(!!handle.trim() && !busy)}
              >
                {busy ? "Connecting…" : "Connect"}
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
