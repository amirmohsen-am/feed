"use client";

import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import "./curator.css";
import "./tour.css";
import CuratorTour from "./CuratorTour";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import type { UserProfile } from "@/lib/types";
import FeedbackModal from "@/components/FeedbackModal";
import EditableFeedName from "@/components/EditableFeedName";
import PublishFeedModal from "@/components/PublishFeedModal";
import FeedSearch from "@/components/FeedSearch";
import { type PipelineStage } from "@/components/PipelineLoader";
import { authedFetch } from "@/lib/authed-fetch";
import { useResizable } from "./useResizable";
import {
  CuratorProvider,
  feedIsComplete,
  type SavedFeed,
  type MobileTab,
  type ViewMode,
} from "./curatorContext";

const SIDEBAR_W_KEY = "curator:sidebarWidth";
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;

const VIEW_MODE_KEY = "curator:viewMode";
const HIDE_UNAVAIL_KEY = "curator:hideUnavailable";
const SHOW_DEBUG_KEY = "curator:showDebug";

const ANON_PROFILE: UserProfile = {
  uid: "",
  name: "Anonymous",
  email: "",
  photoURL: "",
  blueskyHandle: "",
  blueskyDid: "",
  bskyAppPassword: "",
  onboardedAt: new Date().toISOString(),
};

export default function CuratorLayout({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<UserProfile>(ANON_PROFILE);
  const [bskyOAuthReady, setBskyOAuthReady] = useState(false);
  // Gate the app on session provisioning. A brand-new visitor's sid cookie has
  // no user row yet; rendering the shell would fire several /api/* calls in
  // parallel against a not-yet-created user. We block on the first /api/user
  // call (which runs requireAuth → ensureSessionUser and creates the row),
  // showing a loading boilerplate, then mount the shell so every later fetch
  // sees an existing user.
  const [ready, setReady] = useState(false);

  const fetchProfile = useCallback(async () => {
    try {
      const res = await authedFetch("/api/user");
      if (res.ok) {
        const data = await res.json();
        const row = data.user;
        if (row) {
          setProfile({
            uid: row.id || "",
            name: row.name || "Anonymous",
            email: row.email || "",
            photoURL: row.photo_url || "",
            blueskyHandle: row.bluesky_handle || "",
            blueskyDid: row.bluesky_did || "",
            bskyAppPassword: row.bsky_app_password ? "••••" : "",
            onboardedAt: row.created_at || new Date().toISOString(),
          });
          setBskyOAuthReady(!!data.oauthReady);
        }
      }
    } catch { /* use anonymous profile */ }
  }, []);

  // Fetch user info on mount. If we just returned from Bluesky OAuth,
  // clean up the URL param — the fetch will pick up the linked DID.
  useEffect(() => {
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
    // fetchProfile swallows its own errors, so this always resolves — we never
    // strand the user on the loading screen even if provisioning hiccups.
    fetchProfile().finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => { cancelled = true; };
  }, [fetchProfile]);

  if (!ready) return <CuratorBoot />;

  return <CuratorShell profile={profile} bskyOAuthReady={bskyOAuthReady} refreshProfile={fetchProfile}>{children}</CuratorShell>;
}

/** Loading boilerplate shown while the anonymous session/user is provisioned. */
function CuratorBoot() {
  return (
    <div className="cur-boot" role="status" aria-label="Loading">
      <span className="cur-boot-mark">amadi</span>
      <span className="cur-boot-dots" aria-hidden>
        <span /><span /><span />
      </span>
    </div>
  );
}

function CuratorShell({
  profile,
  bskyOAuthReady,
  refreshProfile,
  children,
}: {
  profile: UserProfile;
  bskyOAuthReady: boolean;
  refreshProfile: () => Promise<void>;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const params = useParams<{ feedId?: string }>();
  const activeFeedId = params?.feedId ?? null;

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarWidth, startSidebarDrag] = useResizable(
    SIDEBAR_W_KEY, 264, SIDEBAR_MIN, SIDEBAR_MAX, "left"
  );
  const [feeds, setFeeds] = useState<SavedFeed[]>([]);
  // Topics edit mode (mobile-first). Off by default: tapping a topic only opens
  // it. "Edit" at the top of the list reveals a delete control and inline
  // rename per row; one row renames at a time.
  const [editingTopics, setEditingTopics] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Tapping a row's "−" slides it open to reveal a "Delete" confirm button
  // (iOS style) — no modal. Only one row is open at a time.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [showBskyConnect, setShowBskyConnect] = useState(false);
  const [bskyHandle, setBskyHandle] = useState("");
  const [bskyConnecting, setBskyConnecting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const openTuneRef = useRef<(() => void) | null>(null);

  async function handleShare(feed: SavedFeed) {
    const url = `${window.location.origin}/f/${feed.id}`;
    const text = `Hey — check out this feed I made about "${feed.name}", maybe you'd like it too`;
    if (navigator.share) {
      try {
        await navigator.share({ title: feed.name, text, url });
      } catch {
        /* user dismissed the share sheet */
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(`${text}: ${url}`);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await authedFetch("/api/auth/logout", { method: "POST" });
      // Full reload: middleware mints a fresh anonymous session.
      window.location.href = "/curator";
    } catch {
      setLoggingOut(false);
    }
  }
  const [activePostCount, setActivePostCount] = useState(0);
  const [pipelineStage, setPipelineStage] = useState<PipelineStage>("idle");
  const [pipelineCandidates, setPipelineCandidates] = useState<number | undefined>(undefined);
  const [pipelineHits, setPipelineHits] = useState<number | undefined>(undefined);
  const [pipelineImages, setPipelineImages] = useState<number | undefined>(undefined);
  const [pipelineModel, setPipelineModel] = useState<string | undefined>(undefined);
  const [pipelineThinkingEnabled, setPipelineThinkingEnabled] = useState<boolean | undefined>(undefined);
  const [branchOverlayName, setBranchOverlayName] = useState<string | null>(null);
  // Feed-first on mobile: the chat is a slide-up overlay ("chat" = open).
  // Drafting feeds auto-open it via the tab-reset logic below.
  const [mobileTab, setMobileTab] = useState<MobileTab>("feed");
  const [optionsUnread, setOptionsUnread] = useState(false);

  // Display settings (persisted to localStorage), surfaced in the top-bar
  // settings dialog and consumed by the posts pane in CuratorWorkbench.
  // Initialized to the SSR defaults and hydrated from localStorage in an effect
  // after mount (below) — reading localStorage in the initializer makes the
  // first client render disagree with the server HTML → hydration mismatch.
  const [viewMode, setViewModeState] = useState<ViewMode>("card");
  const setViewMode = useCallback((next: ViewMode) => {
    setViewModeState(next);
    try { window.localStorage.setItem(VIEW_MODE_KEY, next); } catch { /* ignore */ }
  }, []);
  const [showDebug, setShowDebugState] = useState<boolean>(false);
  const setShowDebug = useCallback((next: boolean) => {
    setShowDebugState(next);
    try { window.localStorage.setItem(SHOW_DEBUG_KEY, String(next)); } catch { /* ignore */ }
  }, []);
  const [hideUnavailable, setHideUnavailableState] = useState<boolean>(true);
  const setHideUnavailable = useCallback((next: boolean) => {
    setHideUnavailableState(next);
    try { window.localStorage.setItem(HIDE_UNAVAIL_KEY, String(next)); } catch { /* ignore */ }
  }, []);
  // Hydrate display settings from localStorage once mounted (client-only).
  useEffect(() => {
    try {
      if (window.localStorage.getItem(VIEW_MODE_KEY) === "embed") setViewModeState("embed");
      if (window.localStorage.getItem(SHOW_DEBUG_KEY) === "true") setShowDebugState(true);
      if (window.localStorage.getItem(HIDE_UNAVAIL_KEY) === "false") setHideUnavailableState(false);
    } catch { /* ignore */ }
  }, []);
  const [unavailableCount, setUnavailableCount] = useState(0);

  const reloadFeeds = useCallback(async () => {
    try {
      const res = await authedFetch("/api/feeds");
      const data = await res.json();
      const serverFeeds: {
        id: number;
        name: string;
        subqueries?: string[];
        created_at: string;
        is_home?: boolean;
        parent_feed_id?: number | null;
      }[] = data.feeds || [];
      const mapped: SavedFeed[] = serverFeeds.map((f) => ({
        id: String(f.id),
        name: f.name,
        subqueries: f.subqueries ?? [],
        createdAt: f.created_at,
        isHome: f.is_home === true,
        parentFeedId: f.parent_feed_id != null ? String(f.parent_feed_id) : null,
      }));
      setFeeds(mapped);
    } catch {
      /* ignore */
    }
  }, []);

  const renameFeed = useCallback((feedId: string, name: string) => {
    setFeeds((prev) => prev.map((f) => (f.id === feedId ? { ...f, name } : f)));
  }, []);

  function startRename(feed: SavedFeed) {
    setConfirmDeleteId(null);
    setRenameDraft(feed.name);
    setRenamingId(feed.id);
  }

  async function commitRename(feed: SavedFeed) {
    const trimmed = renameDraft.trim().slice(0, 80);
    setRenamingId(null);
    if (!trimmed || trimmed === feed.name) return;
    renameFeed(feed.id, trimmed); // optimistic
    try {
      await authedFetch("/api/feeds", {
        method: "PATCH",
        body: JSON.stringify({ id: Number(feed.id), name: trimmed }),
      });
    } catch {
      /* ServerErrorToast surfaces failures; reloadFeeds on next mount corrects */
    }
  }

  useEffect(() => { reloadFeeds(); }, [reloadFeeds, profile.uid]);

  // When the URL changes to a different feed, jump mobile to the Feed tab
  // if the feed is already configured, otherwise back to Chat to resume the
  // interview. Mirrors the per-feed reset the old selectFeed did. Uses the
  // setState-during-render pattern (recommended by React 19 docs) to avoid
  // the cascade an effect would cause.
  const [tabResetKey, setTabResetKey] = useState<string | null>(null);
  if (activeFeedId && activeFeedId !== tabResetKey) {
    setTabResetKey(activeFeedId);
    const f = feeds.find((x) => x.id === activeFeedId);
    if (f) {
      setMobileTab(feedIsComplete(f) ? "feed" : "chat");
      setOptionsUnread(false);
    }
  }

  // Switching feeds = changing the URL. <Link> handles the click for us;
  // we just close the mobile drawer.
  function handleFeedClick() {
    setSidebarOpen(false);
  }

  async function startNewFeed() {
    setSidebarOpen(false);
    try {
      const res = await authedFetch("/api/feeds", {
        method: "POST",
        body: JSON.stringify({ name: "Untitled" }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const id = data.feed?.id ?? data.id;
      if (id == null) return;
      await reloadFeeds();
      router.push(`/curator/${id}`);
    } catch {
      /* ignore */
    }
  }

  async function deleteFeed(feedId: string) {
    const id = parseInt(feedId);
    const wasActive = activeFeedId === feedId;
    const remaining = feeds.filter((f) => f.id !== feedId);

    // Optimistic removal.
    setFeeds(remaining);
    setConfirmDeleteId(null);

    if (id) {
      authedFetch("/api/feeds", {
        method: "DELETE",
        body: JSON.stringify({ id }),
      })
        .then(() => reloadFeeds())
        .catch(() => {});
    }

    if (wasActive) {
      if (remaining.length > 0) {
        router.replace(`/curator/${remaining[0].id}`);
      } else {
        // No feeds left — create one and land there.
        try {
          const res = await authedFetch("/api/feeds", {
            method: "POST",
            body: JSON.stringify({ name: "Untitled" }),
          });
          const data = await res.json();
          const newId = data.feed?.id ?? data.id;
          if (newId != null) {
            await reloadFeeds();
            router.replace(`/curator/${newId}`);
          } else {
            router.replace("/curator");
          }
        } catch {
          router.replace("/curator");
        }
      }
    }
  }

  const activeFeed = feeds.find((f) => f.id === activeFeedId);
  const activeHasCriteria = activeFeed ? feedIsComplete(activeFeed) : false;

  // ── Lineage tree (Variant A) ──────────────────────────────
  // Home is the trunk; topic feeds branch off it. A normally-created topic has
  // no parent and so hangs directly off Home; a branched feed nests under the
  // feed it was branched from. The nesting carries the meaning — no per-row
  // jargon. Depth is unbounded but visually capped by the sidebar width.
  const homeFeed = feeds.find((f) => f.isHome);
  const homeId = homeFeed?.id;
  const topicFeeds = feeds.filter((f) => !f.isHome);
  // Direct children of `parentId`. A null/undefined parent (or a parent that
  // points at the deleted-and-nulled state) is treated as a child of Home.
  const childrenOf = (parentId: string | undefined): SavedFeed[] =>
    topicFeeds.filter((f) =>
      f.parentFeedId === parentId ||
      (parentId === homeId && (f.parentFeedId == null || f.parentFeedId === homeId))
    );

  // Renders a single topic-feed row (rename/delete/edit affordances intact).
  function renderFeedRow(feed: SavedFeed) {
    const isActive = activeFeedId === feed.id;
    const isComplete = feedIsComplete(feed);
    const isRenaming = renamingId === feed.id;
    const isConfirming = confirmDeleteId === feed.id;
    return (
      <div className={`cur-feed-row${isConfirming ? " confirming" : ""}`}>
        {editingTopics && (
          <button
            type="button"
            className="cur-feed-confirm-del"
            tabIndex={isConfirming ? 0 : -1}
            aria-hidden={!isConfirming}
            onClick={() => void deleteFeed(feed.id)}
          >
            Delete
          </button>
        )}
        <Link
          href={`/curator/${feed.id}`}
          prefetch={false}
          className={`cur-feed-item${isActive ? " active" : ""}${!isComplete ? " drafting" : ""}${editingTopics ? " is-editing" : ""}`}
          onClick={(e) => {
            if (!editingTopics) { handleFeedClick(); return; }
            e.preventDefault();
            if (isConfirming) setConfirmDeleteId(null);
          }}
        >
          {editingTopics && (
            <button
              type="button"
              className="cur-feed-edit-del"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setRenamingId(null);
                setConfirmDeleteId(isConfirming ? null : feed.id);
              }}
              aria-label={`Delete ${feed.name}`}
              title="Delete feed"
            >
              <span aria-hidden>−</span>
            </button>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            {isRenaming ? (
              <input
                autoFocus
                type="text"
                className="cur-feed-name-input cur-feed-name-input-sidebar fi-name"
                value={renameDraft}
                maxLength={80}
                aria-label="Feed name"
                onChange={(e) => setRenameDraft(e.target.value)}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitRename(feed);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setRenamingId(null);
                  }
                }}
                onBlur={() => void commitRename(feed)}
              />
            ) : (
              <div className="fi-name">{feed.name}</div>
            )}
            <div className="fi-sub">
              {!isComplete
                ? "drafting · resume chat"
                : isActive
                ? `${activePostCount} posts · viewing`
                : `created ${new Date(feed.createdAt).toLocaleDateString()}`}
            </div>
          </div>
          {editingTopics && !isRenaming && !isConfirming && (
            <button
              type="button"
              className="cur-feed-edit-rename"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                startRename(feed);
              }}
              aria-label={`Rename ${feed.name}`}
              title="Rename feed"
            >
              <span aria-hidden>✎</span>
            </button>
          )}
        </Link>
      </div>
    );
  }

  // Recursively renders the children of `parentId` as an indented branch.
  // `seen` guards against a cyclic parent chain so we never loop forever.
  function renderBranch(parentId: string | undefined, seen: Set<string>) {
    const kids = childrenOf(parentId);
    if (kids.length === 0) return null;
    return (
      <div className="cur-tree-children">
        {kids.map((kid) => {
          if (seen.has(kid.id)) return null;
          const nextSeen = new Set(seen).add(kid.id);
          return (
            <Fragment key={kid.id}>
              <div className="cur-tree-node">
                <span className="cur-tree-twig" aria-hidden />
                {renderFeedRow(kid)}
              </div>
              {renderBranch(kid.id, nextSeen)}
            </Fragment>
          );
        })}
      </div>
    );
  }

  return (
    <CuratorProvider
      value={{
        profile,
        bskyOAuthReady,
        refreshProfile,
        feeds,
        reloadFeeds,
        activePostCount,
        setActivePostCount,
        mobileTab,
        setMobileTab,
        optionsUnread,
        setOptionsUnread,
        viewMode,
        setViewMode,
        showDebug,
        setShowDebug,
        hideUnavailable,
        setHideUnavailable,
        unavailableCount,
        setUnavailableCount,
        openPublish: () => setShowPublish(true),
        openTune: () => openTuneRef.current?.(),
        registerOpenTune: (fn: () => void) => { openTuneRef.current = fn; },
        pipelineStage,
        setPipelineStage,
        pipelineCandidates,
        setPipelineCandidates,
        pipelineHits,
        setPipelineHits,
        pipelineImages,
        setPipelineImages,
        pipelineModel,
        setPipelineModel,
        pipelineThinkingEnabled,
        setPipelineThinkingEnabled,
        branchOverlayName,
        setBranchOverlayName,
      }}
    >
      <div className="curator-shell">
        {sidebarOpen && (
          <div
            className="cur-sidebar-backdrop"
            onClick={() => setSidebarOpen(false)}
            aria-hidden
          />
        )}

        {/* SIDEBAR */}
        <div
          className={`cur-sidebar${sidebarOpen ? " is-open" : ""}`}
          style={{ ["--cur-sidebar-w" as string]: `${sidebarWidth}px` }}
        >
          <div className="cur-sidebar-head">
            <Link href="/" className="cur-wordmark">amadi</Link>
          </div>

          <div className="cur-sidebar-label">
            <span>Your feeds</span>
            {topicFeeds.length > 0 && (
              <button
                type="button"
                className={`cur-topics-edit${editingTopics ? " is-editing" : ""}`}
                onClick={() => {
                  setRenamingId(null);
                  setConfirmDeleteId(null);
                  setEditingTopics((v) => !v);
                }}
              >
                {editingTopics ? "Done" : "Edit"}
              </button>
            )}
          </div>

          {/* Lineage tree (Variant A): Home is the trunk, topics branch off it. */}
          <div className="cur-feed-list cur-tree">
            {homeFeed && (() => {
              const isHomeActive = activeFeedId === homeFeed.id;
              return (
                <Link
                  href={`/curator/${homeFeed.id}`}
                  prefetch={false}
                  className={`cur-feed-item cur-feed-item-home cur-tree-root${isHomeActive ? " active" : ""}`}
                  onClick={handleFeedClick}
                >
                  <span className="cur-feed-home-icon" aria-hidden>⌂</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="fi-name">Home</div>
                  </div>
                </Link>
              );
            })()}

            {renderBranch(homeId, new Set<string>())}

            {topicFeeds.length === 0 && (
              <div
                style={{
                  padding: "16px 12px",
                  fontFamily: "var(--rf-body)",
                  fontSize: 13,
                  color: "var(--sage)",
                  fontStyle: "normal",
                }}
              >
                No topics yet — branch one off Home.
              </div>
            )}
          </div>

          <button className="cur-new-feed" onClick={startNewFeed}>
            + New Topic
          </button>

          <div
            className="cur-sidebar-foot"
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
          >
            <Link href="/">← Home</Link>
            <button
              type="button"
              className="cur-profile-btn cur-sidebar-gear"
              title="Settings"
              aria-label="Settings"
              onClick={() => {
                setSidebarOpen(false);
                setShowSettings(true);
              }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
        </div>

        {/* SIDEBAR RESIZER */}
        <div
          className="cur-resizer cur-resizer-sidebar"
          onPointerDown={startSidebarDrag}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
        />

        {/* BLUESKY CONNECT MODAL */}
        <Dialog open={showBskyConnect} onOpenChange={(open) => { if (!open) { setShowBskyConnect(false); setBskyHandle(""); } }}>
          <DialogContent className="settings-dialog">
            <DialogHeader>
              <DialogTitle style={{ fontFamily: "var(--rf-display)", fontSize: 22, fontWeight: 400, color: "var(--ink)" }}>
                Connect Bluesky
              </DialogTitle>
            </DialogHeader>
            <Separator />
            <div className="profile-section">
              <label className="profile-label" htmlFor="bsky-handle-input">
                Your Bluesky handle
              </label>
              <input
                id="bsky-handle-input"
                type="text"
                placeholder="yourname.bsky.social"
                value={bskyHandle}
                onChange={(e) => setBskyHandle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && bskyHandle.trim()) {
                    e.preventDefault();
                    setBskyConnecting(true);
                    authedFetch("/api/bsky/oauth/authorize", {
                      method: "POST",
                      body: JSON.stringify({ handle: bskyHandle.trim().replace(/^@/, "") }),
                    })
                      .then((r) => r.json())
                      .then((data) => { if (data.url) window.location.href = data.url; })
                      .catch(() => setBskyConnecting(false));
                  }
                }}
                autoFocus
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
              <p style={{ color: "var(--ink-3)", fontFamily: "var(--rf-body)", fontSize: 12, marginTop: 6 }}>
                You&apos;ll be redirected to Bluesky to authorize access.
              </p>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <button
                onClick={() => { setShowBskyConnect(false); setBskyHandle(""); }}
                style={{
                  background: "#fff",
                  border: "1px solid var(--hair-strong)",
                  color: "var(--ink-2)",
                  fontFamily: "var(--rf-mono)",
                  fontSize: 10,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  borderRadius: 999,
                  padding: "8px 16px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                disabled={!bskyHandle.trim() || bskyConnecting}
                onClick={() => {
                  setBskyConnecting(true);
                  authedFetch("/api/bsky/oauth/authorize", {
                    method: "POST",
                    body: JSON.stringify({ handle: bskyHandle.trim().replace(/^@/, "") }),
                  })
                    .then((r) => r.json())
                    .then((data) => { if (data.url) window.location.href = data.url; })
                    .catch(() => setBskyConnecting(false));
                }}
                style={{
                  background: bskyHandle.trim() && !bskyConnecting ? "var(--aurora-deep)" : "var(--hair-strong)",
                  color: "#fff",
                  fontFamily: "var(--rf-mono)",
                  fontSize: 10,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  borderRadius: 999,
                  padding: "8px 16px",
                  border: "none",
                  cursor: bskyHandle.trim() && !bskyConnecting ? "pointer" : "not-allowed",
                  opacity: bskyHandle.trim() && !bskyConnecting ? 1 : 0.5,
                }}
              >
                {bskyConnecting ? "Connecting…" : "Connect"}
              </button>
            </div>
          </DialogContent>
        </Dialog>

        {/* MAIN — topbar + page workbench + mobile tabs all live in cur-main
            so the data-mobile-tab CSS selectors can scope which pane shows. */}
        <div className="cur-main" data-mobile-tab={mobileTab}>
          <div className="cur-topbar">
            <button
              className="cur-topbar-burger"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open feeds menu"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <line x1="4" y1="7" x2="20" y2="7" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="17" x2="20" y2="17" />
              </svg>
            </button>
            <div className="cur-topbar-left">
              {branchOverlayName ? (
                <h2>{branchOverlayName}</h2>
              ) : activeFeed ? (
                <h2>
                  {activeFeed.isHome ? (
                    "Home"
                  ) : (
                    <EditableFeedName
                      feedId={activeFeed.id}
                      name={activeFeed.name}
                      variant="topbar"
                      onRenamed={(name) => renameFeed(activeFeed.id, name)}
                    />
                  )}
                </h2>
              ) : (
                <h2>Curate a feed</h2>
              )}
              {/* The pipeline loader now lives in the feed column itself
                  (CuratorWorkbench + the branch overlay), not pinned to the
                  topbar — so the topbar only carries the live post count. */}
              {activePostCount > 0 && <span className="live-badge">{activePostCount} post{activePostCount === 1 ? "" : "s"}</span>}
            </div>
            <div className="cur-topbar-right">
              {profile.blueskyHandle ? (
                <Link
                  href={`/introspect/${encodeURIComponent(profile.blueskyHandle.replace(/^@/, "").toLowerCase())}`}
                  className="cur-topbar-btn ghost"
                  prefetch={false}
                  title="Introspect my engagements"
                  aria-label="Introspect my engagements"
                >
                  <span aria-hidden>✦</span>
                  <span className="cur-topbar-btn-text">Introspect my engagements</span>
                </Link>
              ) : (
                <button
                  type="button"
                  className="cur-topbar-btn ghost"
                  onClick={() => setShowBskyConnect(true)}
                  title="Connect Bluesky to introspect your engagements"
                  aria-label="Connect Bluesky to introspect your engagements"
                >
                  <span aria-hidden>✦</span>
                  <span className="cur-topbar-btn-text">Introspect my engagements</span>
                </button>
              )}
              {activeFeed && activeHasCriteria && (
                <button
                  className="cur-topbar-btn publish"
                  onClick={() => setShowPublish(true)}
                  title="Publish this feed to Bluesky"
                  aria-label="Publish this feed to Bluesky"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                    <polyline points="16 6 12 2 8 6" />
                    <line x1="12" y1="2" x2="12" y2="15" />
                  </svg>
                  <span className="cur-topbar-btn-text">Publish to Bluesky</span>
                </button>
              )}
              <button
                onClick={() => setShowFeedback(true)}
                className="cur-topbar-icon"
                title="Send feedback"
                aria-label="Send feedback"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  <line x1="8" y1="10" x2="16" y2="10" />
                  <line x1="8" y1="13" x2="13" y2="13" />
                </svg>
              </button>
              <Dialog open={showSettings} onOpenChange={setShowSettings}>
                <DialogTrigger
                  className={`cur-topbar-icon${viewMode === "embed" ? " active" : ""}`}
                  title="Display settings"
                  aria-label="Display settings"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </DialogTrigger>
                <DialogContent className="settings-dialog">
                  <DialogHeader>
                    <DialogTitle style={{ fontFamily: "var(--rf-display)", fontSize: 22, fontWeight: 400 }}>
                      Display settings
                    </DialogTitle>
                  </DialogHeader>
                  <Separator />
                  <div className="settings-section">
                    <div className="settings-label">Post view</div>
                    <div className="cur-view-toggle" role="tablist" aria-label="Post view">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={viewMode === "card"}
                        className={`cur-view-seg${viewMode === "card" ? " active" : ""}`}
                        onClick={() => setViewMode("card")}
                      >
                        Cards
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={viewMode === "embed"}
                        className={`cur-view-seg${viewMode === "embed" ? " active" : ""}`}
                        onClick={() => setViewMode("embed")}
                      >
                        Bluesky embed
                      </button>
                    </div>
                    <p className="settings-hint">
                      Bluesky embed renders each post with Bluesky&rsquo;s own embed card.
                    </p>
                  </div>
                  <Separator />
                  <div className="settings-section">
                    <div className="settings-label">Options</div>
                    <label className="settings-toggle-row">
                      <span>
                        Debug scores
                        <span className="settings-toggle-sub">vector similarity, reranker score &amp; reason</span>
                      </span>
                      <input
                        type="checkbox"
                        className="settings-switch"
                        checked={showDebug}
                        onChange={(e) => setShowDebug(e.target.checked)}
                      />
                    </label>
                    {viewMode === "embed" && (
                      <label className="settings-toggle-row">
                        <span>
                          Hide unavailable
                          {unavailableCount > 0 && (
                            <span className="cur-unavail-count"> ({unavailableCount})</span>
                          )}
                          <span className="settings-toggle-sub">skip deleted or login-only posts</span>
                        </span>
                        <input
                          type="checkbox"
                          className="settings-switch"
                          checked={hideUnavailable}
                          onChange={(e) => setHideUnavailable(e.target.checked)}
                        />
                      </label>
                    )}
                  </div>
                  {/* Mobile-only: feedback + introspect fold in here since the
                      topbar icons are hidden on small screens. */}
                  <div className="settings-mobile-more">
                    <Separator />
                    <div className="settings-section">
                      <div className="settings-label">More</div>
                      <button
                        type="button"
                        className="settings-action-row"
                        onClick={() => {
                          setShowSettings(false);
                          setShowFeedback(true);
                        }}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                          <line x1="8" y1="10" x2="16" y2="10" />
                          <line x1="8" y1="13" x2="13" y2="13" />
                        </svg>
                        Send feedback
                      </button>
                      {profile.blueskyHandle ? (
                        <Link
                          href={`/introspect/${encodeURIComponent(profile.blueskyHandle.replace(/^@/, "").toLowerCase())}`}
                          className="settings-action-row"
                          prefetch={false}
                          onClick={() => setShowSettings(false)}
                        >
                          <span aria-hidden>✦</span>
                          Introspect my engagements
                        </Link>
                      ) : (
                        <button
                          type="button"
                          className="settings-action-row"
                          onClick={() => {
                            setShowSettings(false);
                            setShowBskyConnect(true);
                          }}
                        >
                          <span aria-hidden>✦</span>
                          Introspect my engagements
                        </button>
                      )}
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </div>

            {/* Tune + Publish + Share — outside cur-topbar-right so they stay visible on mobile
                (the other topbar icons are folded away on small screens). */}
            {activeFeed && activeHasCriteria && (
              <button
                type="button"
                className="cur-topbar-icon cur-topbar-tune"
                onClick={() => openTuneRef.current?.()}
                title="Tune feed"
                aria-label="Tune feed"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <line x1="4" y1="21" x2="4" y2="14" />
                  <line x1="4" y1="10" x2="4" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12" y2="3" />
                  <line x1="20" y1="21" x2="20" y2="16" />
                  <line x1="20" y1="12" x2="20" y2="3" />
                  <line x1="1" y1="14" x2="7" y2="14" />
                  <line x1="9" y1="8" x2="15" y2="8" />
                  <line x1="17" y1="16" x2="23" y2="16" />
                </svg>
              </button>
            )}
            {activeFeed && activeHasCriteria && (
              <button
                type="button"
                className="cur-topbar-icon cur-topbar-publish-bsky"
                onClick={() => setShowPublish(true)}
                title="Publish to Bluesky"
                aria-label="Publish to Bluesky"
              >
                <svg width="16" height="16" viewBox="0 0 600 530" fill="currentColor" aria-hidden>
                  <path d="M135.72 44.03C202.216 93.951 273.74 195.86 300 249.97c26.26-54.11 97.784-156.019 164.28-205.94C512.26 8.009 590-19.862 590 68.825c0 17.712-10.155 148.79-16.111 170.07-20.703 73.984-96.144 92.854-163.25 81.433 117.3 19.964 147.14 86.092 82.697 152.22-122.39 125.59-175.91-31.511-189.63-71.766-2.514-7.38-3.69-10.832-3.706-7.905-.017-2.927-1.192.525-3.706 7.905-13.72 40.255-67.24 197.356-189.63 71.766-64.444-66.128-34.604-132.256 82.697-152.22-67.106 11.421-142.547-7.449-163.25-81.433C20.155 217.615 10 86.537 10 68.825c0-88.687 77.74-60.816 125.72-24.795z" />
                </svg>
              </button>
            )}
            <button
              type="button"
              className="cur-topbar-icon cur-topbar-share"
              onClick={() => setProfileOpen(true)}
              title="Profile &amp; share"
              aria-label="Profile and share"
            >
              {profile.photoURL ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={profile.photoURL} alt="" className="cur-profile-photo" referrerPolicy="no-referrer" />
              ) : (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
                </svg>
              )}
            </button>
            <Dialog
              open={profileOpen}
              onOpenChange={setProfileOpen}
            >
              <DialogContent className="profile-dialog">
                <DialogHeader>
                  <DialogTitle style={{ fontFamily: "var(--rf-display)", fontSize: 24, fontWeight: 400 }}>
                    Profile
                  </DialogTitle>
                </DialogHeader>
                <Separator />
                <div className="profile-section">
                  <div className="profile-label">Account</div>
                  <div className="profile-row">
                    <span className="profile-key">Name</span>
                    <span className="profile-val">{profile.name}</span>
                  </div>
                  <div className="profile-row">
                    <span className="profile-key">Email</span>
                    <span className="profile-val">{profile.email}</span>
                  </div>
                </div>
                <Separator />
                <div className="profile-section">
                  <div className="profile-label">Bluesky</div>
                  <div className="profile-row">
                    <span className="profile-key">Handle</span>
                    <span className="profile-val">
                      {profile.blueskyHandle ? `@${profile.blueskyHandle}` : "Not connected"}
                    </span>
                  </div>
                  <div className="profile-row">
                    <span className="profile-key">Status</span>
                    {profile.blueskyDid ? (
                      bskyOAuthReady ? (
                        <span className="profile-val" style={{ color: "var(--aurora-deep)" }}>
                          ● Connected
                        </span>
                      ) : (
                        <button
                          className="cur-bsky-connect-btn"
                          onClick={() => {
                            setProfileOpen(false);
                            setShowBskyConnect(true);
                          }}
                        >
                          Reconnect Bluesky
                        </button>
                      )
                    ) : (
                      <button
                        className="cur-bsky-connect-btn"
                        onClick={() => {
                          setProfileOpen(false);
                          setShowBskyConnect(true);
                        }}
                      >
                        Connect Bluesky
                      </button>
                    )}
                  </div>
                  <div className="profile-row">
                    <span className="profile-key">Feed status</span>
                    <span className="profile-val">{activeHasCriteria ? "Active" : "Not configured"}</span>
                  </div>
                </div>
                <Separator />
                <div className="profile-section">
                  <div className="profile-label">Usage</div>
                  <div className="profile-row">
                    <span className="profile-key">Posts scored</span>
                    <span className="profile-val">{activePostCount}</span>
                  </div>
                  <div className="profile-row">
                    <span className="profile-key">Feeds created</span>
                    <span className="profile-val">{feeds.length}</span>
                  </div>
                </div>
                {activeFeed && activeHasCriteria && (
                  <>
                    <Separator />
                    <div className="profile-section">
                      <div className="profile-label">Share</div>
                      <div className="profile-row">
                        <span className="profile-key">This feed</span>
                        <button
                          type="button"
                          className="cur-bsky-connect-btn"
                          onClick={() => handleShare(activeFeed)}
                        >
                          {shareCopied ? "Link copied!" : "Copy link"}
                        </button>
                      </div>
                    </div>
                  </>
                )}
                <Separator />
                <div className="profile-section" style={{ paddingBottom: 0 }}>
                  {profile.blueskyDid ? (
                    <button
                      type="button"
                      className="profile-auth-btn logout"
                      disabled={loggingOut}
                      onClick={handleLogout}
                    >
                      {loggingOut ? "Logging out…" : "Log out"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="profile-auth-btn login"
                      onClick={() => {
                        setProfileOpen(false);
                        setShowBskyConnect(true);
                      }}
                    >
                      Log in with Bluesky
                    </button>
                  )}
                </div>
              </DialogContent>
            </Dialog>
          </div>

          {children}
        </div>

        {showFeedback && (
          <FeedbackModal
            onClose={() => setShowFeedback(false)}
            feedId={activeFeed ? Number(activeFeed.id) : null}
            feedName={activeFeed?.name ?? null}
          />
        )}

        {showPublish && activeFeed && (
          <PublishFeedModal
            onClose={() => setShowPublish(false)}
            blueskyHandle={profile.blueskyHandle}
            blueskyDid={profile.blueskyDid}
            feedName={activeFeed.name}
            feedId={Number(activeFeed.id)}
            onConnectBluesky={() => {
              setShowPublish(false);
              setShowBskyConnect(true);
            }}
          />
        )}

        <FeedSearch
          feeds={feeds}
          activeFeedId={activeFeedId}
          onNewFeed={startNewFeed}
        />

        <CuratorTour />
      </div>
    </CuratorProvider>
  );
}
