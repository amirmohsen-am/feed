"use client";

import { useState, useEffect } from "react";
import { auth, googleProvider } from "@/lib/firebase";
import { signInWithPopup, onAuthStateChanged, User } from "firebase/auth";
import { authedFetch } from "@/lib/authed-fetch";

export interface UserProfile {
  uid: string;
  name: string;
  email: string;
  photoURL: string;
  blueskyHandle: string;
  blueskyDid: string;
  onboardedAt: string;
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfileState] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        // localStorage acts as a fast cache; Postgres is the source of truth
        const saved = localStorage.getItem(`ripple_profile_${u.uid}`);
        if (saved) {
          setProfileState(JSON.parse(saved));
        }
        try {
          const res = await authedFetch("/api/user");
          if (res.ok) {
            const data = await res.json();
            const row = data.user;
            if (row && row.bluesky_handle) {
              const p: UserProfile = {
                uid: u.uid,
                name: row.name || u.displayName || "Friend",
                email: row.email || u.email || "",
                photoURL: row.photo_url || u.photoURL || "",
                blueskyHandle: row.bluesky_handle || "",
                blueskyDid: row.bluesky_did || "",
                onboardedAt: (row.created_at && typeof row.created_at === "string") ? row.created_at : new Date().toISOString(),
              };
              localStorage.setItem(`ripple_profile_${u.uid}`, JSON.stringify(p));
              setProfileState(p);
            }
          }
        } catch { /* ignore */ }
      } else {
        setProfileState(null);
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  function setProfile(p: UserProfile) {
    localStorage.setItem(`ripple_profile_${p.uid}`, JSON.stringify(p));
    setProfileState(p);
    authedFetch("/api/user", {
      method: "POST",
      body: JSON.stringify({
        name: p.name,
        email: p.email,
        photoUrl: p.photoURL,
        blueskyHandle: p.blueskyHandle,
        blueskyDid: p.blueskyDid,
      }),
    }).catch(() => {});
  }

  function clearProfile() {
    if (user) localStorage.removeItem(`ripple_profile_${user.uid}`);
    setProfileState(null);
  }

  return { user, profile, setProfile, clearProfile, loading, isOnboarded: !!profile };
}

export default function Onboarding({ onComplete }: { onComplete: (profile: UserProfile) => void }) {
  const [step, setStep] = useState(0);
  const [user, setUser] = useState<User | null>(null);
  const [handle, setHandle] = useState("");
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");
  const [did, setDid] = useState("");
  const [signingIn, setSigningIn] = useState(false);

  async function signIn() {
    setSigningIn(true);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      setUser(result.user);
      setStep(1);
    } catch (e: any) {
      setError(e.message || "Sign in failed");
    } finally {
      setSigningIn(false);
    }
  }

  async function resolveHandle() {
    if (!handle.trim()) return;
    setResolving(true);
    setError("");
    const h = handle.trim().replace(/^@/, "");
    try {
      const res = await fetch(
        `https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(h)}`
      );
      if (!res.ok) throw new Error("Handle not found");
      const data = await res.json();
      setDid(data.did);
      setStep(2);
    } catch {
      setError("Couldn\u2019t find that handle. Make sure it\u2019s your full Bluesky handle (e.g. name.bsky.social).");
    } finally {
      setResolving(false);
    }
  }

  function skipBluesky() {
    setStep(2);
  }

  function finish() {
    if (!user) return;
    const profile: UserProfile = {
      uid: user.uid,
      name: user.displayName || "Friend",
      email: user.email || "",
      photoURL: user.photoURL || "",
      blueskyHandle: handle.trim().replace(/^@/, ""),
      blueskyDid: did,
      onboardedAt: new Date().toISOString(),
    };
    onComplete(profile);
  }

  const firstName = user?.displayName?.split(" ")[0] || "there";

  return (
    <div className="onboarding">
      <div className="onboarding-bg" />

      <div className="onboarding-card">
        <div className="onboarding-steps">
          {[0, 1, 2].map((s) => (
            <div key={s} className={`onboarding-step-dot ${step >= s ? "active" : ""}`} />
          ))}
        </div>

        {step === 0 && (
          <div className="onboarding-content">
            <div className="onboarding-icon">
              <svg viewBox="0 0 40 40" fill="none" width={48} height={48}>
                <circle cx="20" cy="20" r="4" fill="currentColor" />
                <circle cx="20" cy="20" r="10" stroke="currentColor" strokeWidth="0.8" opacity="0.7" />
                <circle cx="20" cy="20" r="16" stroke="currentColor" strokeWidth="0.6" opacity="0.45" />
                <circle cx="20" cy="20" r="19" stroke="currentColor" strokeWidth="0.5" opacity="0.22" />
              </svg>
            </div>
            <h2>Welcome to Willow</h2>
            <p>A quieter, more intentional feed — built on Bluesky. Let&apos;s get you set up in under a minute.</p>

            <button
              className="onboarding-btn google"
              onClick={signIn}
              disabled={signingIn}
            >
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
              {signingIn ? "Signing in..." : "Continue with Google"}
            </button>

            {error && <div className="onboarding-error">{error}</div>}
          </div>
        )}

        {step === 1 && (
          <div className="onboarding-content">
            <h2>Hey {firstName} — connect your Bluesky</h2>
            <p>
              Link your Bluesky account so we can personalize your feeds. Just your public handle — no password needed.
            </p>
            <a
              href="https://bsky.app"
              target="_blank"
              rel="noopener noreferrer"
              className="onboarding-bsky-link"
            >
              <svg width="16" height="16" viewBox="0 0 600 530" fill="currentColor">
                <path d="M135.72 44.03C202.216 93.951 273.74 195.17 300 249.49c26.262-54.316 97.782-155.54 164.28-205.46C512.26 8.009 590-19.862 590 68.825c0 17.712-10.155 148.79-16.111 170.07-20.703 73.984-96.144 92.854-163.25 81.433 117.3 19.964 147.14 86.092 82.697 152.22-122.39 125.59-175.91-31.511-189.63-71.766-2.514-7.38-3.69-10.832-3.708-7.896-.017-2.936-1.193.516-3.707 7.896-13.714 40.255-67.233 197.36-189.63 71.766-64.444-66.128-34.605-132.256 82.697-152.22-67.108 11.421-142.549-7.449-163.25-81.433C20.15 217.613 10 86.536 10 68.824c0-88.687 77.742-60.816 125.72-24.795z" />
              </svg>
              Don&apos;t have Bluesky yet? Create an account →
            </a>
            <div className="onboarding-field">
              <label>Bluesky handle</label>
              <input
                type="text"
                value={handle}
                onChange={(e) => { setHandle(e.target.value); setError(""); }}
                placeholder="yourname.bsky.social"
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") resolveHandle(); }}
              />
              {error && <div className="onboarding-error">{error}</div>}
            </div>
            <div className="onboarding-actions">
              <button className="onboarding-btn ghost" onClick={skipBluesky}>
                Skip for now
              </button>
              <button
                className="onboarding-btn primary"
                onClick={resolveHandle}
                disabled={!handle.trim() || resolving}
              >
                {resolving ? "Verifying..." : "Connect"}
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="onboarding-content">
            <div className="onboarding-check">✓</div>
            <h2>You&apos;re all set, {firstName}.</h2>

            {did ? (
              <div className="onboarding-connected">
                <div className="onboarding-connected-row">
                  <span className="onboarding-connected-dot" />
                  <span>@{handle.trim().replace(/^@/, "")}</span>
                </div>
                <div className="onboarding-connected-did">{did}</div>
              </div>
            ) : (
              <div className="onboarding-connected">
                <div className="onboarding-connected-row">
                  <span className="onboarding-connected-dot" style={{ background: "var(--amber)" }} />
                  <span>Bluesky not connected — you can link it later in your profile.</span>
                </div>
              </div>
            )}

            <p>Time to curate your first feed. Tell our AI what you want to see, and it&apos;ll build a feed from that conversation alone.</p>
            <button className="onboarding-btn primary" onClick={finish}>
              Start curating →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
