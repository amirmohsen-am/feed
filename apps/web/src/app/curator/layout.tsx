"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import "./curator.css";
import "./onboarding.css";
import "./voices.css";
import "./onboarding-flow.css";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import Onboarding, { useAuth, type UserProfile } from "@/components/Onboarding";
import ImportMemoryModal from "@/components/ImportMemoryModal";
import ShaderLogo from "@/components/ShaderLogo";
import { authedFetch } from "@/lib/authed-fetch";
import type { SemanticConfig } from "@/lib/types";
import { useResizable } from "./useResizable";
import {
  CuratorProvider,
  feedIsComplete,
  type SavedFeed,
  type FeedCriteria,
  type MobileTab,
} from "./curatorContext";

const SIDEBAR_W_KEY = "curator:sidebarWidth";
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;

const FEED_COLORS = [
  "var(--aurora)",
  "var(--amber)",
  "var(--ember)",
  "var(--rose)",
  "var(--aurora-deep)",
  "var(--mist)",
];

export default function CuratorLayout({ children }: { children: React.ReactNode }) {
  const { profile, setProfile, isOnboarded, loading: authLoading } = useAuth();

  if (authLoading) {
    return (
      <div className="curator-shell" style={{ alignItems: "center", justifyContent: "center" }}>
        <div className="cur-dots"><span /><span /><span /></div>
      </div>
    );
  }

  if (!isOnboarded) {
    return <Onboarding onComplete={setProfile} />;
  }

  return <CuratorShell profile={profile!}>{children}</CuratorShell>;
}

function CuratorShell({ profile, children }: { profile: UserProfile; children: React.ReactNode }) {
  const router = useRouter();
  const params = useParams<{ feedId?: string }>();
  const activeFeedId = params?.feedId ?? null;

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarWidth, startSidebarDrag] = useResizable(
    SIDEBAR_W_KEY, 264, SIDEBAR_MIN, SIDEBAR_MAX, "left"
  );
  const [feeds, setFeeds] = useState<SavedFeed[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [showImportMemory, setShowImportMemory] = useState(false);
  const [activePostCount, setActivePostCount] = useState(0);
  const [mobileTab, setMobileTab] = useState<MobileTab>("chat");
  const [optionsUnread, setOptionsUnread] = useState(false);

  const reloadFeeds = useCallback(async () => {
    try {
      const res = await authedFetch("/api/feeds");
      const data = await res.json();
      const serverFeeds: {
        id: number;
        name: string;
        semantic_config: SemanticConfig;
        created_at: string;
      }[] = data.feeds || [];
      const mapped: SavedFeed[] = serverFeeds.map((f, i) => ({
        id: String(f.id),
        name: f.name,
        color: FEED_COLORS[i % FEED_COLORS.length],
        criteria: {
          topics: f.semantic_config?.topics ?? [],
          keywords: f.semantic_config?.keywords ?? [],
          exclude_topics: f.semantic_config?.exclude_topics ?? [],
          exclude_keywords: f.semantic_config?.exclude_keywords ?? [],
          vibes: f.semantic_config?.vibes ?? "",
        },
        createdAt: f.created_at,
      }));
      setFeeds(mapped);
    } catch {
      /* ignore */
    }
  }, []);

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

  async function confirmDeleteFeed() {
    if (!deleteTarget) return;
    const id = parseInt(deleteTarget);
    const wasActive = activeFeedId === deleteTarget;
    const remaining = feeds.filter((f) => f.id !== deleteTarget);

    // Optimistic removal.
    setFeeds(remaining);
    setDeleteTarget(null);

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

  function handleMemoryImported(importedFeed: {
    id: number;
    name: string;
    description: string;
    criteria: FeedCriteria;
    created_at: string;
    updated_at: string;
  }) {
    setShowImportMemory(false);
    reloadFeeds();
    router.push(`/curator/${importedFeed.id}`);
  }

  const activeFeed = feeds.find((f) => f.id === activeFeedId);
  const activeHasCriteria = activeFeed ? feedIsComplete(activeFeed) : false;

  return (
    <CuratorProvider
      value={{
        profile,
        feeds,
        reloadFeeds,
        activePostCount,
        setActivePostCount,
        mobileTab,
        setMobileTab,
        optionsUnread,
        setOptionsUnread,
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
            <Link href="/">
              <ShaderLogo height={32} />
            </Link>
          </div>

          <div className="cur-sidebar-label">
            Your Feeds · {feeds.length.toString().padStart(2, "0")}
          </div>

          <div className="cur-feed-list">
            {feeds.map((feed) => {
              const isActive = activeFeedId === feed.id;
              const isComplete = feedIsComplete(feed);
              return (
                <Link
                  key={feed.id}
                  href={`/curator/${feed.id}`}
                  prefetch={false}
                  className={`cur-feed-item${isActive ? " active" : ""}${!isComplete ? " drafting" : ""}`}
                  onClick={handleFeedClick}
                >
                  <span className="swatch" style={{ background: feed.color }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="fi-name">{feed.name}</div>
                    <div className="fi-sub">
                      {!isComplete
                        ? "drafting · resume chat"
                        : isActive
                        ? `${activePostCount} posts · viewing`
                        : `created ${new Date(feed.createdAt).toLocaleDateString()}`}
                    </div>
                  </div>
                  <button
                    className="cur-feed-delete"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDeleteTarget(feed.id);
                    }}
                    title="Delete feed"
                  >
                    ×
                  </button>
                </Link>
              );
            })}

            {feeds.length === 0 && (
              <div
                style={{
                  padding: "20px 12px",
                  fontFamily: "var(--rf-body)",
                  fontSize: 13,
                  color: "var(--sage)",
                  fontStyle: "italic",
                }}
              >
                No feeds yet — create your first one.
              </div>
            )}
          </div>

          <button className="cur-new-feed" onClick={startNewFeed}>
            + New feed
          </button>

          <div
            className="cur-sidebar-foot"
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
          >
            <Link href="/">← Home</Link>
            <Dialog>
              <DialogTrigger className="cur-profile-btn" title="Profile">
                {profile.photoURL ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={profile.photoURL}
                    alt=""
                    className="cur-profile-photo"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="12" cy="8" r="4" />
                    <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
                  </svg>
                )}
              </DialogTrigger>
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
                    <span className="profile-key">Connection</span>
                    <span
                      className="profile-val"
                      style={{ color: profile.blueskyHandle ? "var(--aurora)" : "var(--amber)" }}
                    >
                      {profile.blueskyHandle ? "● Connected" : "○ Not linked"}
                    </span>
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
              </DialogContent>
            </Dialog>
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

        {/* DELETE CONFIRMATION */}
        <AlertDialog
          open={!!deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        >
          <AlertDialogContent className="profile-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle
                style={{ fontFamily: "var(--rf-display)", fontSize: 22, fontWeight: 400, color: "var(--cream)" }}
              >
                Delete this feed?
              </AlertDialogTitle>
              <AlertDialogDescription
                style={{ color: "var(--parchment-dim)", fontFamily: "var(--rf-body)", fontSize: 14 }}
              >
                This will permanently remove &ldquo;
                {feeds.find((f) => f.id === deleteTarget)?.name}
                &rdquo; and its preferences. This can&apos;t be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                style={{
                  background: "transparent",
                  border: "1px solid var(--hair-strong)",
                  color: "var(--parchment)",
                  fontFamily: "var(--rf-mono)",
                  fontSize: 10,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  borderRadius: 999,
                }}
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDeleteFeed}
                style={{
                  background: "var(--rose)",
                  color: "var(--void)",
                  fontFamily: "var(--rf-mono)",
                  fontSize: 10,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  borderRadius: 999,
                }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

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
              <h2>{activeFeed?.name || "Curate a feed"}</h2>
              {activeHasCriteria && <span className="live-badge">live</span>}
            </div>
            <div className="cur-topbar-right">
              <Link
                href="/search"
                className="cur-topbar-btn ghost"
                title="Open retrieval search lab"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="7" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                Search
              </Link>
              <button
                onClick={() => setShowImportMemory(true)}
                className="cur-topbar-icon"
                title="Import AI memory"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                </svg>
              </button>
            </div>
          </div>

          {children}

          {/* MOBILE TAB NAV */}
          <nav className="cur-mobile-tabs" aria-label="View tabs">
            <button
              type="button"
              className={`cur-mobile-tab${mobileTab === "chat" ? " active" : ""}`}
              onClick={() => { setMobileTab("chat"); setOptionsUnread(false); }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span>Chat</span>
              {optionsUnread && <span className="cur-mobile-tab-dot" aria-hidden />}
            </button>
            <button
              type="button"
              className={`cur-mobile-tab${mobileTab === "feed" ? " active" : ""}`}
              onClick={() => setMobileTab("feed")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
              </svg>
              <span>Feed</span>
              {activePostCount > 0 && <span className="cur-mobile-tab-badge">{activePostCount}</span>}
            </button>
            <button
              type="button"
              className={`cur-mobile-tab${mobileTab === "tune" ? " active" : ""}`}
              onClick={() => setMobileTab("tune")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>Tune</span>
            </button>
          </nav>
        </div>

        {showImportMemory && (
          <ImportMemoryModal
            onClose={() => setShowImportMemory(false)}
            onImported={handleMemoryImported}
          />
        )}
      </div>
    </CuratorProvider>
  );
}
