"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  onAuthStateChanged,
  signInWithPopup,
  type User,
} from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebase";

/**
 * Global Firebase auth gate. Wraps every page except the landing route
 * (`/`) and waits for Firebase to confirm the user before rendering. This
 * eliminates per-page auth races (e.g. authedFetch firing before
 * auth.currentUser is set on cold load) and gives a single place to show
 * the sign-in UI.
 *
 * Bypassed routes:
 *  - `/`     — landing
 *  - `/api/*` — server routes, never rendered through this component anyway
 */
export default function AuthGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPublic =
    pathname === "/" ||
    pathname?.startsWith("/api") ||
    pathname?.startsWith("/introspect") ||
    pathname?.startsWith("/oauth");

  useEffect(() => {
    if (isPublic) {
      setReady(true);
      return;
    }
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setReady(true);
    });
    return () => unsub();
  }, [isPublic]);

  async function signIn() {
    setSigningIn(true);
    setError(null);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      setUser(result.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign in failed");
    } finally {
      setSigningIn(false);
    }
  }

  if (isPublic) return <>{children}</>;

  if (!ready) {
    return (
      <div
        style={{
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 20,
          background: "#fbfaf6",
          color: "#6a7570",
          fontFamily: "var(--rf-display), 'Instrument Serif', serif",
          fontStyle: "normal",
          fontSize: 18,
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            border: "2px solid #ece8de",
            borderTopColor: "#3e8a6c",
            borderRadius: "50%",
            animation: "authgate-spin 0.8s linear infinite",
          }}
        />
        Checking session&hellip;
        <style>{`@keyframes authgate-spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    );
  }

  if (!user) {
    return (
      <div
        style={{
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#fbfaf6",
          padding: 24,
        }}
      >
        <div
          style={{
            background: "#fff",
            border: "1px solid rgba(11,24,20,0.08)",
            borderRadius: 16,
            padding: "36px 32px",
            maxWidth: 420,
            width: "100%",
            boxShadow: "0 4px 24px rgba(11,24,20,0.06)",
            textAlign: "center",
            color: "#0b1814",
          }}
        >
          <div
            style={{
              fontFamily: "var(--rf-display), 'Instrument Serif', serif",
              fontSize: 28,
              marginBottom: 8,
              letterSpacing: "-0.01em",
            }}
          >
            Sign in to Willow
          </div>
          <p
            style={{
              fontFamily: "var(--rf-body), 'Newsreader', serif",
              color: "#3a4a44",
              fontSize: 14.5,
              lineHeight: 1.55,
              margin: "0 0 24px",
            }}
          >
            This page is members-only. Sign in to continue, or head back to{" "}
            <a
              href="/"
              style={{
                color: "#3e8a6c",
                textDecoration: "none",
                borderBottom: "1px dotted #3e8a6c",
              }}
            >
              the landing page
            </a>
            .
          </p>
          <button
            onClick={signIn}
            disabled={signingIn}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              padding: "11px 22px",
              borderRadius: 999,
              background: "#0b1814",
              color: "#fbfaf6",
              border: "none",
              fontFamily:
                "var(--rf-mono), 'JetBrains Mono', ui-monospace, monospace",
              fontSize: 11,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              cursor: signingIn ? "not-allowed" : "pointer",
              fontWeight: 600,
              opacity: signingIn ? 0.5 : 1,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            {signingIn ? "Signing in…" : "Continue with Google"}
          </button>
          {error && (
            <div
              style={{
                marginTop: 16,
                fontSize: 13,
                color: "#a44a3b",
              }}
            >
              {error}
            </div>
          )}
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
