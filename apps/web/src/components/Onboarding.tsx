"use client";

import { useState, useEffect, useRef } from "react";
import { auth, googleProvider } from "@/lib/firebase";
import { signInWithPopup, onAuthStateChanged, User } from "firebase/auth";
import { authedFetch } from "@/lib/authed-fetch";
import type { Stats } from "@/lib/introspect/types";
import type { FeedPreviewPost } from "@/lib/pg";

export interface UserProfile {
  uid: string;
  name: string;
  email: string;
  photoURL: string;
  blueskyHandle: string;
  blueskyDid: string;
  onboardedAt: string;
}

export interface OnboardingResult {
  profile: UserProfile;
  feedId: number | null;
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

  function setProfile(result: OnboardingResult) {
    const p = result.profile;
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

// ── Types ────────────────────────────────────────────────

type OnboardingStep =
  | "welcome"
  | "bluesky"
  | "fetching"
  | "summary"
  | "questions"
  | "building"
  | "preview";

interface GeneratedQuestion {
  id: string;
  text: string;
  options: string[];
  allowFreeText: boolean;
}

interface Answer {
  questionId: string;
  selectedOptions: string[];
  freeText: string | null;
}

const INTEREST_CATEGORIES = [
  "AI & machine learning",
  "Climate & environment",
  "Art & design",
  "Science & research",
  "Politics & policy",
  "Indie games & dev",
  "Music & audio",
  "Books & literature",
  "Tech industry",
  "Philosophy & ideas",
  "Sports & fitness",
  "Film & TV",
];

const STEP_LABELS: Record<OnboardingStep, number> = {
  welcome: 0,
  bluesky: 1,
  fetching: 1,
  summary: 2,
  questions: 3,
  building: 4,
  preview: 5,
};

const TOTAL_STEPS = 6;

// ── Component ────────────────────────────────────────────

export default function Onboarding({
  onComplete,
}: {
  onComplete: (result: OnboardingResult) => void;
}) {
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [user, setUser] = useState<User | null>(null);
  const [handle, setHandle] = useState("");
  const [did, setDid] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");

  // Engagement data
  const [stats, setStats] = useState<Stats | null>(null);
  const topAccountsRef = useRef<Array<{ handle: string; total: number }>>([]);

  // Questions
  const [questions, setQuestions] = useState<GeneratedQuestion[]>([]);
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [questionsFreeText, setQuestionsFreeText] = useState("");
  const questionsLoadedRef = useRef(false);

  // Category selection (for skip-bluesky path)
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);

  // Building phase
  const [buildPhase, setBuildPhase] = useState(0);

  // Preview
  const [feedResult, setFeedResult] = useState<{
    feed: { id: number; name: string; subqueries: string[] };
    previewPosts: FeedPreviewPost[];
  } | null>(null);

  const firstName = user?.displayName?.split(" ")[0] || "there";
  const cleanHandle = handle.trim().replace(/^@/, "");

  // ── Step 0: Google Sign-In ──

  async function signIn() {
    setSigningIn(true);
    setError("");
    try {
      const result = await signInWithPopup(auth, googleProvider);
      setUser(result.user);
      setStep("bluesky");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Sign in failed";
      setError(msg);
    } finally {
      setSigningIn(false);
    }
  }

  // ── Step 1: Bluesky Handle Resolution ──

  async function resolveHandle() {
    if (!cleanHandle) return;
    setResolving(true);
    setError("");
    try {
      const res = await fetch(
        `https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(cleanHandle)}`
      );
      if (!res.ok) throw new Error("Handle not found");
      const data = await res.json();
      setDid(data.did);
      // Start fetching engagements + questions in parallel
      setStep("fetching");
      fetchEngagementsAndQuestions(cleanHandle);
    } catch {
      setError(
        "Couldn\u2019t find that handle. Make sure it\u2019s your full Bluesky handle (e.g. name.bsky.social)."
      );
    } finally {
      setResolving(false);
    }
  }

  function skipBluesky() {
    // Fire generic questions request, skip to questions with category grid
    setStep("fetching");
    fetchGenericQuestions();
  }

  // ── Data Fetching ──

  async function fetchEngagementsAndQuestions(bskyHandle: string) {
    try {
      // Fetch engagements from introspect
      const fetchRes = await fetch("/api/introspect/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: bskyHandle }),
      });

      if (fetchRes.ok) {
        const data = await fetchRes.json();
        const snapshot = data.snapshot;
        if (snapshot?.stats) {
          setStats(snapshot.stats);
          topAccountsRef.current = snapshot.stats.topAccounts?.slice(0, 5) || [];
        }

        // Now fetch personalized questions
        const topHandles = (snapshot?.stats?.topAccounts || [])
          .slice(0, 5)
          .map((a: { handle: string }) => a.handle);
        await fetchQuestions(snapshot?.stats || null, topHandles, bskyHandle);
        setStep("summary");
      } else {
        // Engagements failed — fall back to generic questions
        await fetchGenericQuestions();
      }
    } catch {
      await fetchGenericQuestions();
    }
  }

  async function fetchQuestions(
    engagementStats: Stats | null,
    topHandles: string[],
    bskyHandle: string | null
  ) {
    try {
      const res = await authedFetch("/api/onboarding/questions", {
        method: "POST",
        body: JSON.stringify({
          stats: engagementStats,
          topAccountHandles: topHandles,
          handle: bskyHandle,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setQuestions(data.questions || []);
        questionsLoadedRef.current = true;
      }
    } catch {
      // Questions failed — we'll use a simple fallback
    }
  }

  async function fetchGenericQuestions() {
    try {
      const res = await authedFetch("/api/onboarding/questions", {
        method: "POST",
        body: JSON.stringify({
          stats: null,
          topAccountHandles: [],
          handle: null,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setQuestions(data.questions || []);
        questionsLoadedRef.current = true;
      }
    } catch {
      // Fallback handled below
    }
    // For skip-bluesky path, go straight to questions (with category grid first)
    setStep("questions");
  }

  // ── Step 3: Answer Questions ──

  function selectOption(questionId: string, option: string) {
    setAnswers((prev) => {
      const existing = prev.find((a) => a.questionId === questionId);
      if (existing) {
        const alreadySelected = existing.selectedOptions.includes(option);
        return prev.map((a) =>
          a.questionId === questionId
            ? {
                ...a,
                selectedOptions: alreadySelected
                  ? a.selectedOptions.filter((o) => o !== option)
                  : [...a.selectedOptions, option],
              }
            : a
        );
      }
      return [...prev, { questionId, selectedOptions: [option], freeText: null }];
    });
  }

  function advanceQuestion() {
    // Save free text if present
    if (questionsFreeText.trim()) {
      const q = questions[currentQuestion];
      if (q) {
        setAnswers((prev) => {
          const existing = prev.find((a) => a.questionId === q.id);
          if (existing) {
            return prev.map((a) =>
              a.questionId === q.id ? { ...a, freeText: questionsFreeText.trim() } : a
            );
          }
          return [
            ...prev,
            { questionId: q.id, selectedOptions: [], freeText: questionsFreeText.trim() },
          ];
        });
      }
    }
    setQuestionsFreeText("");

    if (currentQuestion < questions.length - 1) {
      setCurrentQuestion((c) => c + 1);
    } else {
      startBuilding();
    }
  }

  // ── Step 4: Build Feed ──

  async function startBuilding() {
    setStep("building");
    setBuildPhase(0);

    // Animated phases
    const t1 = setTimeout(() => setBuildPhase(1), 2000);
    const t2 = setTimeout(() => setBuildPhase(2), 4500);

    try {
      // Include category selections as an answer if Bluesky was skipped
      let allAnswers = [...answers];
      if (selectedCategories.length > 0) {
        allAnswers = [
          {
            questionId: "categories",
            selectedOptions: selectedCategories,
            freeText: null,
          },
          ...allAnswers,
        ];
      }

      const res = await authedFetch("/api/onboarding/analyze", {
        method: "POST",
        body: JSON.stringify({
          answers: allAnswers,
          stats,
          topAccounts: topAccountsRef.current,
          handle: cleanHandle || null,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setFeedResult(data);
        // Wait for at least phase 2 to show before transitioning
        setTimeout(() => setStep("preview"), 1500);
      } else {
        setError("Something went wrong creating your feed. Let\u2019s skip to the curator.");
        setTimeout(() => skipToCurator(), 2000);
      }
    } catch {
      setError("Something went wrong. Let\u2019s skip to the curator.");
      setTimeout(() => skipToCurator(), 2000);
    }

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }

  // ── Step 5: Complete ──

  function finish() {
    if (!user) return;
    const profile: UserProfile = {
      uid: user.uid,
      name: user.displayName || "Friend",
      email: user.email || "",
      photoURL: user.photoURL || "",
      blueskyHandle: cleanHandle,
      blueskyDid: did,
      onboardedAt: new Date().toISOString(),
    };
    onComplete({ profile, feedId: feedResult?.feed?.id ?? null });
  }

  async function skipToCurator() {
    if (!user) return;
    // Create a bare feed
    let feedId: number | null = null;
    try {
      const res = await authedFetch("/api/feeds", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        feedId = data.id;
      }
    } catch { /* proceed without feed */ }

    const profile: UserProfile = {
      uid: user.uid,
      name: user.displayName || "Friend",
      email: user.email || "",
      photoURL: user.photoURL || "",
      blueskyHandle: cleanHandle,
      blueskyDid: did,
      onboardedAt: new Date().toISOString(),
    };
    onComplete({ profile, feedId });
  }

  // ── Category grid helpers ──

  function toggleCategory(cat: string) {
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : prev.length < 5 ? [...prev, cat] : prev
    );
  }

  function categoriesDone() {
    if (selectedCategories.length === 0) return;
    // Feed selected categories as a pseudo-answer
    setCurrentQuestion(0);
    if (questions.length > 0) {
      // Show the AI questions
    } else {
      // No questions loaded — go straight to building
      startBuilding();
    }
  }

  // ── Rendering ──

  const stepIndex = STEP_LABELS[step];
  // Whether to show category grid first in questions step (skip-bluesky path)
  const showCategoryGrid = step === "questions" && !stats && currentQuestion === 0 && questions.length > 0;
  const showCategoryGridOnly = step === "questions" && !stats && questions.length === 0;

  return (
    <div className="onboarding">
      <div className="onboarding-bg" />

      <div className={`onboarding-card ${step === "summary" || step === "preview" ? "onboarding-card--wide" : ""}`}>
        {/* Step dots */}
        <div className="onboarding-steps">
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <div
              key={i}
              className={`onboarding-step-dot ${i <= stepIndex ? "active" : ""}`}
            />
          ))}
        </div>

        {/* ── WELCOME ── */}
        {step === "welcome" && (
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
            <p>
              A quieter, more intentional feed — built on Bluesky. Let&apos;s get
              you set up in under a minute.
            </p>
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
              {signingIn ? "Signing in\u2026" : "Continue with Google"}
            </button>
            {error && <div className="onboarding-error">{error}</div>}
          </div>
        )}

        {/* ── BLUESKY ── */}
        {step === "bluesky" && (
          <div className="onboarding-content">
            <h2>Hey {firstName} — connect your Bluesky</h2>
            <p>
              Link your Bluesky account so we can learn from your engagement
              history and build a personalized feed. Just your public handle — no
              password needed.
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
              Don&apos;t have Bluesky yet? Create an account &rarr;
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
                {resolving ? "Verifying\u2026" : "Connect"}
              </button>
            </div>
          </div>
        )}

        {/* ── FETCHING ── */}
        {step === "fetching" && (
          <div className="onboarding-content onboarding-content--center">
            <div className="onboarding-loading-ring" />
            <h2>Reading your Bluesky history</h2>
            <p>
              {stats
                ? "Generating your personalized questions\u2026"
                : "Pulling your recent likes, reposts, and posts\u2026"}
            </p>
          </div>
        )}

        {/* ── SUMMARY ── */}
        {step === "summary" && stats && (
          <div className="onboarding-content">
            <h2>Here&apos;s your Bluesky at a glance</h2>
            <p>
              {stats.total.toLocaleString()} engagements over {stats.spanDays} days
              ({stats.avgPerDay.toFixed(1)}/day)
            </p>

            <div className="onboarding-summary">
              {(["like", "repost", "quote", "post", "reply"] as const).map((type) => {
                const data = stats.byType[type];
                if (!data || data.count === 0) return null;
                return (
                  <div className="onboarding-stat-row" key={type}>
                    <span className="onboarding-stat-label">{type}s</span>
                    <div className="onboarding-stat-bar-track">
                      <div
                        className={`onboarding-stat-bar onboarding-stat-bar--${type}`}
                        style={{ width: `${Math.max(data.pct, 2)}%` }}
                      />
                    </div>
                    <span className="onboarding-stat-count">{data.count.toLocaleString()}</span>
                  </div>
                );
              })}
            </div>

            {topAccountsRef.current.length > 0 && (
              <div className="onboarding-top-accounts">
                <div className="onboarding-top-accounts-label">Your most-engaged accounts</div>
                <div className="onboarding-account-list">
                  {topAccountsRef.current.slice(0, 5).map((acct) => (
                    <div className="onboarding-account-pill" key={acct.handle}>
                      <span className="onboarding-account-handle">@{acct.handle}</span>
                      <span className="onboarding-account-count">{acct.total}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button
              className="onboarding-btn primary"
              onClick={() => setStep("questions")}
              style={{ marginTop: 24, alignSelf: "flex-end" }}
            >
              Continue
            </button>
          </div>
        )}

        {/* ── QUESTIONS ── */}
        {step === "questions" && (
          <div className="onboarding-content">
            {/* Category grid for skip-bluesky path */}
            {(showCategoryGrid || showCategoryGridOnly) && currentQuestion === 0 && (
              <>
                <h2>What pulls you in?</h2>
                <p>Pick 3-5 topics you gravitate toward.</p>
                <div className="onboarding-category-grid">
                  {INTEREST_CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      className={`onboarding-category-tile ${selectedCategories.includes(cat) ? "selected" : ""}`}
                      onClick={() => toggleCategory(cat)}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
                {showCategoryGridOnly ? (
                  <button
                    className="onboarding-btn primary"
                    onClick={() => startBuilding()}
                    disabled={selectedCategories.length === 0}
                    style={{ marginTop: 20, alignSelf: "flex-end" }}
                  >
                    Build my feed
                  </button>
                ) : (
                  <button
                    className="onboarding-btn primary"
                    onClick={categoriesDone}
                    disabled={selectedCategories.length === 0}
                    style={{ marginTop: 20, alignSelf: "flex-end" }}
                  >
                    Continue
                  </button>
                )}
              </>
            )}

            {/* AI-generated questions */}
            {!showCategoryGrid && !showCategoryGridOnly && questions[currentQuestion] && (
              <>
                <div className="onboarding-question-counter">
                  {currentQuestion + 1} of {questions.length}
                </div>
                <h2>{questions[currentQuestion].text}</h2>
                <div className="onboarding-question-options">
                  {questions[currentQuestion].options.map((opt) => {
                    const isSelected = answers
                      .find((a) => a.questionId === questions[currentQuestion].id)
                      ?.selectedOptions.includes(opt);
                    return (
                      <button
                        key={opt}
                        className={`onboarding-option-btn ${isSelected ? "selected" : ""}`}
                        onClick={() =>
                          selectOption(questions[currentQuestion].id, opt)
                        }
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
                {questions[currentQuestion].allowFreeText && (
                  <div className="onboarding-field" style={{ marginTop: 16 }}>
                    <input
                      type="text"
                      value={questionsFreeText}
                      onChange={(e) => setQuestionsFreeText(e.target.value)}
                      placeholder="Or type your own..."
                      onKeyDown={(e) => { if (e.key === "Enter") advanceQuestion(); }}
                    />
                  </div>
                )}
                <button
                  className="onboarding-btn primary"
                  onClick={advanceQuestion}
                  style={{ marginTop: 16, alignSelf: "flex-end" }}
                  disabled={
                    !answers.find((a) => a.questionId === questions[currentQuestion].id)
                      ?.selectedOptions.length && !questionsFreeText.trim()
                  }
                >
                  {currentQuestion === questions.length - 1
                    ? "Build my feed"
                    : "Next"}
                </button>
              </>
            )}

            {/* Fallback if questions haven't loaded */}
            {!showCategoryGrid &&
              !showCategoryGridOnly &&
              !questions[currentQuestion] &&
              stats && (
                <div className="onboarding-content--center">
                  <div className="onboarding-loading-ring" />
                  <p>Preparing your questions&hellip;</p>
                </div>
              )}
          </div>
        )}

        {/* ── BUILDING ── */}
        {step === "building" && (
          <div className="onboarding-content onboarding-content--center">
            <div className="onboarding-building">
              <div
                className={`onboarding-building-phase ${buildPhase >= 0 ? "active" : ""}`}
              >
                <span className="onboarding-building-dot" />
                Analyzing your taste&hellip;
              </div>
              <div
                className={`onboarding-building-phase ${buildPhase >= 1 ? "active" : ""}`}
              >
                <span className="onboarding-building-dot" />
                Crafting your feed&hellip;
              </div>
              <div
                className={`onboarding-building-phase ${buildPhase >= 2 ? "active" : ""}`}
              >
                <span className="onboarding-building-dot" />
                Finding posts&hellip;
              </div>
            </div>
            {error && (
              <div className="onboarding-error" style={{ marginTop: 16 }}>
                {error}
              </div>
            )}
          </div>
        )}

        {/* ── PREVIEW ── */}
        {step === "preview" && feedResult && (
          <div className="onboarding-content">
            <div className="onboarding-check">&#10003;</div>
            <h2>Your first feed is ready</h2>
            <div className="onboarding-feed-name">{feedResult.feed.name}</div>

            {feedResult.previewPosts.length > 0 ? (
              <div className="onboarding-preview">
                {feedResult.previewPosts.slice(0, 6).map((post) => (
                  <div className="onboarding-preview-card" key={post.uri}>
                    <div className="onboarding-preview-author">
                      {post.author_display_name || post.author_handle || "Unknown"}
                      {post.author_handle && (
                        <span className="onboarding-preview-handle">
                          @{post.author_handle}
                        </span>
                      )}
                    </div>
                    <div className="onboarding-preview-text">
                      {post.text.length > 180
                        ? post.text.slice(0, 180) + "\u2026"
                        : post.text}
                    </div>
                    <div className="onboarding-preview-engagement">
                      {post.like_count > 0 && <span>{post.like_count} likes</span>}
                      {post.repost_count > 0 && <span>{post.repost_count} reposts</span>}
                      {post.reply_count > 0 && <span>{post.reply_count} replies</span>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p>
                We&apos;ll keep looking for posts that match. Head into the curator
                to refine your feed.
              </p>
            )}

            <button
              className="onboarding-btn primary"
              onClick={finish}
              style={{ marginTop: 20, alignSelf: "flex-end" }}
            >
              Start curating &rarr;
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
