"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
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
import VoiceCards, { type Voice } from "@/components/VoiceCards";
import ImportMemoryModal from "@/components/ImportMemoryModal";
import FilterPanel from "@/components/FilterPanel";
import ShaderLogo from "@/components/ShaderLogo";
import ShaderSendButton from "@/components/ShaderSendButton";
import { authedFetch } from "@/lib/authed-fetch";
import type { MechanicalFilters, SemanticConfig } from "@/lib/types";

interface Message { role: "user" | "assistant"; content: string; }
interface FeedCriteria {
  topics: string[]; keywords: string[];
  exclude_topics: string[]; exclude_keywords: string[];
  vibes: string;
}
interface Preferences { description: string; criteria: FeedCriteria; }
interface Post {
  uri: string; author_did: string; text: string;
  score: number; indexed_at: string;
}

interface SavedFeed {
  id: string;
  name: string;
  color: string;
  criteria: FeedCriteria;
  createdAt: string;
}

const FEED_COLORS = ["var(--aurora)", "var(--amber)", "var(--ember)", "var(--rose)", "var(--aurora-deep)", "var(--mist)"];

function parseMessage(content: string) {
  const lines = content.split("\n");
  const options: { key: string; label: string }[] = [];
  const textLines: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(\d)\.\s+(.+)/);
    if (m) options.push({ key: m[1], label: m[2] });
    else textLines.push(line);
  }
  return { text: textLines.join("\n").trim(), options };
}


export default function CuratorPage() {
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

  return <CuratorApp profile={profile!} />;
}

function CuratorApp({ profile }: { profile: UserProfile }) {
  const [view, setView] = useState<"chat" | "feed">("chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [postCount, setPostCount] = useState(0);
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsStage, setPostsStage] = useState<"idle" | "searching" | "ranking">("idle");
  const [chatLoading, setChatLoading] = useState(false);
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set());
  const [initialized, setInitialized] = useState(false);
  const [feeds, setFeeds] = useState<SavedFeed[]>([]);
  const [activeFeedId, setActiveFeedId] = useState<string | null>(null);
  const [prevCriteriaJson, setPrevCriteriaJson] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [showVoices, setShowVoices] = useState(false);
  const [addedVoices, setAddedVoices] = useState<Voice[]>([]);
  const [showImportMemory, setShowImportMemory] = useState(false);
  const [mechanicalFilters, setMechanicalFilters] = useState<MechanicalFilters | null>(null);
  const [semanticConfig, setSemanticConfig] = useState<SemanticConfig | null>(null);
  const serverFeedIdRef = useRef<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Save mechanical filters to the server
  async function saveMechanicalFilters(filters: MechanicalFilters) {
    const feedId = serverFeedIdRef.current;
    if (!feedId) return;
    setMechanicalFilters(filters);
    try {
      await authedFetch("/api/feeds", {
        method: "PATCH",
        body: JSON.stringify({ id: feedId, mechanical_filters: filters }),
      });
    } catch {
      // ignore
    }
  }

  // Save semantic config to the server
  async function saveSemanticConfig(config: SemanticConfig) {
    const feedId = serverFeedIdRef.current;
    if (!feedId) return;
    setSemanticConfig(config);
    try {
      await authedFetch("/api/feeds", {
        method: "PATCH",
        body: JSON.stringify({ id: feedId, semantic_config: config }),
      });
    } catch {
      // ignore
    }
  }

  // Pull all of the user's feeds from Postgres and project to sidebar shape.
  // Single source of truth — called on mount and after any feed-modifying write.
  // Shows in-progress feeds (no criteria yet) too — they get a "drafting" tag
  // and click-through to chat instead of the post view.
  const reloadFeeds = useCallback(async () => {
    try {
      const res = await authedFetch("/api/feeds");
      const data = await res.json();
      const serverFeeds: { id: number; name: string; semantic_config: SemanticConfig; created_at: string }[] = data.feeds || [];
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
    } catch { /* ignore */ }
  }, []);

  function feedIsComplete(feed: { criteria: FeedCriteria }): boolean {
    return (
      (feed.criteria.topics?.length ?? 0) > 0 ||
      (feed.criteria.keywords?.length ?? 0) > 0
    );
  }

  useEffect(() => { reloadFeeds(); }, [reloadFeeds, profile.uid]);

  // Fetch chat history for a feed.
  const loadChat = useCallback(async (feedId: number) => {
    setChatLoading(true);
    try {
      const res = await authedFetch(`/api/chat?feedId=${feedId}`);
      const data = await res.json();
      const msgs: Message[] = data.messages || [];
      if (data.feed?.criteria) {
        setPrefs({ description: data.feed.description, criteria: data.feed.criteria });
        setPrevCriteriaJson(JSON.stringify(data.feed.criteria));
      }
      if (msgs.length === 0) {
        // First time — kick off the agent's opening message.
        const initRes = await authedFetch("/api/chat", {
          method: "POST",
          body: JSON.stringify({ message: "__init__", feedId }),
        });
        const d = await initRes.json();
        setMessages(d.messages || []);
        if (d.feed?.criteria) {
          setPrefs({ description: d.feed.description, criteria: d.feed.criteria });
        }
      } else {
        setMessages(msgs);
      }
    } catch { /* ignore */ }
    finally {
      setChatLoading(false);
    }
  }, []);

  // Fetch ranked posts for a feed via happy-feed.
  const loadPosts = useCallback(async (feedId: number) => {
    setPostsLoading(true);
    setPostsStage("searching");
    try {
      const res = await authedFetch(`/api/feed-preview?feedId=${feedId}`);
      const d = await res.json();
      setPosts(d.posts || []);
      setPostCount(d.total_stored || (d.posts?.length ?? 0));
      if (d.mechanical_filters) setMechanicalFilters(d.mechanical_filters);
      if (d.semantic_config) setSemanticConfig(d.semantic_config);
    } catch { /* ignore */ }
    finally {
      setPostsLoading(false);
      setPostsStage("idle");
    }
  }, []);

  // Get the active server-side feed. Reuses the user's most recent feed
  // instead of creating a new row on every page load.
  async function ensureServerFeed(): Promise<number> {
    if (serverFeedIdRef.current) return serverFeedIdRef.current;
    const listRes = await authedFetch("/api/feeds");
    const listData = await listRes.json();
    const list: { id: number }[] = listData.feeds || [];
    if (list.length > 0) {
      // Server orders by updated_at DESC
      serverFeedIdRef.current = list[0].id;
      return list[0].id;
    }
    const res = await authedFetch("/api/feeds", {
      method: "POST",
      body: JSON.stringify({ name: "New Feed" }),
    });
    const data = await res.json();
    const id = data.feed?.id || data.id;
    serverFeedIdRef.current = id;
    return id;
  }

  // Init: pick the active feed and fire chat + posts fetches in parallel.
  useEffect(() => {
    (async () => {
      try {
        const feedId = await ensureServerFeed();
        setActiveFeedId(String(feedId));
        // Don't await — let chat and posts hydrate independently.
        loadChat(feedId);
        loadPosts(feedId);
      } catch { /* ignore */ }
      setInitialized(true);
    })();
  }, [loadChat, loadPosts]);

  // Watch for new criteria — re-sync the sidebar from the server (Postgres is
  // the source of truth; the chat route already PATCHed the feed before
  // returning new criteria here).
  const checkNewFeed = useCallback((newPrefs: Preferences) => {
    const newJson = JSON.stringify(newPrefs.criteria);
    const hasCriteria = (newPrefs.criteria.topics?.length ?? 0) > 0 ||
      (newPrefs.criteria.keywords?.length ?? 0) > 0;

    if (hasCriteria && newJson !== prevCriteriaJson) {
      setPrevCriteriaJson(newJson);
      const id = activeFeedId ?? (serverFeedIdRef.current ? String(serverFeedIdRef.current) : null);
      if (!activeFeedId && id) setActiveFeedId(id);
      setShowVoices(true);
      reloadFeeds();
    }
  }, [prevCriteriaJson, activeFeedId, reloadFeeds]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // Auto-grow the chat textarea as the user types.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [input]);

  async function send(text: string) {
    if (!text.trim() || loading) return;
    setInput("");
    setSelectedOptions(new Set());
    setMessages(prev => [...prev, { role: "user", content: text.trim() }]);
    setLoading(true);
    try {
      const feedId = await ensureServerFeed();
      const res = await authedFetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message: text.trim(), feedId }),
      });
      const d = await res.json();
      const msgs = d.messages || [];
      setMessages(msgs);
      if (d.feed?.criteria) {
        const p = { description: d.feed.description, criteria: d.feed.criteria };
        setPrefs(p);
        checkNewFeed(p);
      }
      // Agent emitted FEED_DONE — the feed is finalized server-side.
      // Hand off to the post view and refresh the sidebar so the entry loses
      // its "drafting" badge.
      if (d.done) {
        const fid = serverFeedIdRef.current;
        setView("feed");
        if (fid) loadPosts(fid);
        reloadFeeds();
      }
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "Something went wrong." }]);
    } finally { setLoading(false); }
  }

  // "Make this feed now" — sent when the user wants to skip the rest of the
  // interview. Phrased as a natural reply so the system prompt's finalize
  // path kicks in and Claude saves the FEED_CONFIG_JSON with what it has.
  function finalizeNow() {
    if (loading) return;
    send("Just go ahead and make my feed now with what you've got — pick reasonable defaults for anything we haven't covered yet.");
  }

  // Compose the chat reply from any selected options + the comment box.
  function submitChat() {
    const lastOptions = lastParsed?.options || [];
    const picks = lastOptions.filter((opt) => selectedOptions.has(opt.key));
    const comment = input.trim();
    if (picks.length === 0 && !comment) return;

    let composed = "";
    if (picks.length > 0) {
      composed = picks.map((p) => `${p.key}. ${p.label}`).join(", ");
    }
    if (comment) {
      composed = composed ? `${composed} — ${comment}` : comment;
    }
    send(composed);
  }

  async function startNewFeed() {
    // Clear all per-feed state synchronously so the panels go blank instantly.
    setMessages([]);
    setPosts([]);
    setPrefs(null);
    setAddedVoices([]);
    setShowVoices(false);
    setMechanicalFilters(null);
    setSemanticConfig(null);
    setSelectedOptions(new Set());
    setView("chat");
    setPrevCriteriaJson("");

    // Create a fresh server-side feed.
    const createRes = await authedFetch("/api/feeds", {
      method: "POST",
      body: JSON.stringify({ name: "Untitled" }),
    });
    if (!createRes.ok) {
      console.error("Failed to create feed", await createRes.text());
      return;
    }
    const createData = await createRes.json();
    const newServerId = createData.feed?.id ?? createData.id;
    if (newServerId == null) {
      console.error("No feed id in response", createData);
      return;
    }
    serverFeedIdRef.current = newServerId;
    setActiveFeedId(newServerId.toString());

    // Refresh sidebar so the new (drafting) entry appears immediately.
    reloadFeeds();

    // Kick off the chat — same path as the init effect uses for a fresh feed.
    loadChat(newServerId);
  }

  function selectFeed(feed: SavedFeed) {
    const id = parseInt(feed.id) || null;
    // Clear stale content synchronously — the panels blank instantly.
    setMessages([]);
    setPosts([]);
    setPrefs(null);
    setSelectedOptions(new Set());
    setActiveFeedId(feed.id);
    serverFeedIdRef.current = id;
    // If the feed is configured (has criteria), open the post view. Otherwise
    // resume the chat where they left off.
    const complete = feedIsComplete(feed);
    setView(complete ? "feed" : "chat");
    if (id) {
      loadChat(id);
      if (complete) loadPosts(id);
    }
  }

  function confirmDeleteFeed() {
    if (!deleteTarget) return;
    const id = parseInt(deleteTarget);
    // Optimistic removal so the sidebar updates instantly.
    setFeeds(feeds.filter(f => f.id !== deleteTarget));
    if (id) {
      authedFetch("/api/feeds", {
        method: "DELETE",
        body: JSON.stringify({ id }),
      }).then(() => reloadFeeds()).catch(() => {});
    }
    if (activeFeedId === deleteTarget) {
      setActiveFeedId(null);
      serverFeedIdRef.current = null;
      setView("chat");
    }
    setDeleteTarget(null);
  }

  function handleMemoryImported(importedFeed: { id: number; name: string; description: string; criteria: FeedCriteria; created_at: string; updated_at: string }) {
    setActiveFeedId(importedFeed.id.toString());
    serverFeedIdRef.current = importedFeed.id;
    setShowImportMemory(false);
    setView("feed");
    reloadFeeds();
    loadPosts(importedFeed.id);
  }

  const hasCriteria =
    (prefs?.criteria &&
      ((prefs.criteria.topics?.length ?? 0) > 0 || (prefs.criteria.keywords?.length ?? 0) > 0)) ||
    (semanticConfig &&
      ((semanticConfig.topics?.length ?? 0) > 0 || (semanticConfig.keywords?.length ?? 0) > 0));

  const activeFeed = feeds.find(f => f.id === activeFeedId);
  const lastMsg = messages[messages.length - 1];
  const lastParsed = lastMsg?.role === "assistant" ? parseMessage(lastMsg.content) : null;

  // Show the early-exit "Make this feed" button once the agent has asked
  // at least 3 questions (assistant messages with options) and the feed
  // hasn't been finalized yet.
  const questionCount = messages.filter(
    (m) => m.role === "assistant" && parseMessage(m.content).options.length > 0
  ).length;
  const showFinalize = questionCount >= 3 && !hasCriteria;

  if (!initialized) {
    return (
      <div className="curator-shell" style={{ alignItems: "center", justifyContent: "center" }}>
        <div className="cur-dots"><span /><span /><span /></div>
      </div>
    );
  }

  return (
    <div className="curator-shell">
      {/* SIDEBAR */}
      <div className="cur-sidebar">
        <div className="cur-sidebar-head">
          <Link href="/">
            <ShaderLogo height={32} />
          </Link>
        </div>

        <div className="cur-sidebar-label">Your Feeds · {feeds.length.toString().padStart(2, "0")}</div>

        <div className="cur-feed-list">
          {feeds.map((feed) => {
            const isActive = activeFeedId === feed.id;
            const isComplete = feedIsComplete(feed);
            return (
              <div
                key={feed.id}
                className={`cur-feed-item${isActive ? " active" : ""}${!isComplete ? " drafting" : ""}`}
                onClick={() => selectFeed(feed)}
              >
                <span className="swatch" style={{ background: feed.color }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="fi-name">{feed.name}</div>
                  <div className="fi-sub">
                    {!isComplete
                      ? "drafting · resume chat"
                      : isActive && view === "feed"
                      ? `${postCount} posts · viewing`
                      : `created ${new Date(feed.createdAt).toLocaleDateString()}`}
                  </div>
                </div>
                <button
                  className="cur-feed-delete"
                  onClick={(e) => { e.stopPropagation(); setDeleteTarget(feed.id); }}
                  title="Delete feed"
                >
                  ×
                </button>
              </div>
            );
          })}

          {feeds.length === 0 && (
            <div style={{
              padding: "20px 12px",
              fontFamily: "var(--rf-body)",
              fontSize: 13,
              color: "var(--sage)",
              fontStyle: "italic",
            }}>
              No feeds yet — create your first one.
            </div>
          )}
        </div>

        <button className="cur-new-feed" onClick={startNewFeed}>
          + New feed
        </button>

        <div className="cur-sidebar-foot" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Link href="/">← Home</Link>
          <Dialog>
            <DialogTrigger className="cur-profile-btn" title="Profile">
              {profile.photoURL ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={profile.photoURL} alt="" className="cur-profile-photo" referrerPolicy="no-referrer" />
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
                  <span className="profile-val">{profile.blueskyHandle ? `@${profile.blueskyHandle}` : "Not connected"}</span>
                </div>
                <div className="profile-row">
                  <span className="profile-key">Connection</span>
                  <span className="profile-val" style={{ color: profile.blueskyHandle ? "var(--aurora)" : "var(--amber)" }}>
                    {profile.blueskyHandle ? "● Connected" : "○ Not linked"}
                  </span>
                </div>
                <div className="profile-row">
                  <span className="profile-key">Feed status</span>
                  <span className="profile-val">{hasCriteria ? "Active" : "Not configured"}</span>
                </div>
              </div>
              <Separator />
              <div className="profile-section">
                <div className="profile-label">Usage</div>
                <div className="profile-row">
                  <span className="profile-key">Posts scored</span>
                  <span className="profile-val">{postCount}</span>
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

      {/* DELETE CONFIRMATION */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent className="profile-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle style={{ fontFamily: "var(--rf-display)", fontSize: 22, fontWeight: 400, color: "var(--cream)" }}>
              Delete this feed?
            </AlertDialogTitle>
            <AlertDialogDescription style={{ color: "var(--parchment-dim)", fontFamily: "var(--rf-body)", fontSize: 14 }}>
              This will permanently remove &ldquo;{feeds.find(f => f.id === deleteTarget)?.name}&rdquo; and its preferences. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel style={{
              background: "transparent", border: "1px solid var(--hair-strong)",
              color: "var(--parchment)", fontFamily: "var(--rf-mono)", fontSize: 10,
              letterSpacing: "0.1em", textTransform: "uppercase", borderRadius: 999,
            }}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteFeed}
              style={{
                background: "var(--rose)", color: "var(--void)",
                fontFamily: "var(--rf-mono)", fontSize: 10,
                letterSpacing: "0.1em", textTransform: "uppercase", borderRadius: 999,
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* MAIN */}
      <div className="cur-main">
        <div className="cur-topbar">
          <div className="cur-topbar-left">
            <h2>
              {view === "chat" ? "Curate a feed" : (activeFeed?.name || "Your Feed")}
            </h2>
            {view === "feed" && (
              <span className="live-badge">live</span>
            )}
          </div>
          <div className="cur-topbar-right">
            {view === "chat" && hasCriteria && (
              <button
                onClick={() => setView("feed")}
                className="cur-topbar-btn filled"
              >
                View feed →
              </button>
            )}
            {view === "feed" && (
              <button
                onClick={() => setView("chat")}
                className="cur-topbar-btn ghost"
              >
                Edit preferences
              </button>
            )}
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

        {view === "chat" ? (
          <>
            <div className="cur-chat-area">
              <div className="cur-chat-inner">
                {messages.map((msg, i) => {
                  const isUser = msg.role === "user";
                  const isLast = i === messages.length - 1;
                  const parsed = !isUser ? parseMessage(msg.content) : null;

                  return (
                    <div key={i} className="cur-msg">
                      {isUser ? (
                        <div className="cur-msg-user">{msg.content}</div>
                      ) : (
                        <div className="cur-msg-assistant">
                          {parsed!.text.split("\n\n").map((para, j) => (
                            <p key={j}>{para}</p>
                          ))}
                          {parsed!.options.length > 0 && (
                            <div className="cur-options">
                              {parsed!.options.map((opt) => {
                                const checked = selectedOptions.has(opt.key);
                                const interactive = isLast && !loading;
                                return (
                                  <button
                                    key={opt.key}
                                    type="button"
                                    className={`cur-opt${checked ? " cur-opt-selected" : ""}`}
                                    disabled={!interactive}
                                    onClick={() => {
                                      if (!interactive) return;
                                      setSelectedOptions((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(opt.key)) next.delete(opt.key);
                                        else next.add(opt.key);
                                        return next;
                                      });
                                    }}
                                  >
                                    <span className="cur-opt-key">{checked ? "✓" : opt.key}</span>
                                    {opt.label}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {(loading || chatLoading) && (
                  <div className="cur-dots"><span /><span /><span /></div>
                )}

                {showVoices && (
                  <VoiceCards
                    onAddVoices={(voices) => {
                      setAddedVoices(voices);
                      setShowVoices(false);
                      // Send a message about the added voices
                      const names = voices.map(v => v.name).join(", ");
                      send(`Add these voices to my feed: ${names}`);
                    }}
                    onDismiss={() => {
                      setShowVoices(false);
                      setView("feed");
                    }}
                  />
                )}

                {addedVoices.length > 0 && !showVoices && (
                  <div className="cur-msg">
                    <div className="cur-msg-assistant">
                      <p style={{ fontSize: 13, color: "var(--aurora)" }}>
                        Added {addedVoices.length} voice{addedVoices.length !== 1 ? "s" : ""} to your feed: {addedVoices.map(v => v.name).join(", ")}
                      </p>
                    </div>
                  </div>
                )}

                <div ref={endRef} />
              </div>
            </div>

            <div className="cur-input-bar">
              {showFinalize && (
                <div className="cur-finalize-row">
                  <button
                    type="button"
                    className="cur-finalize"
                    onClick={finalizeNow}
                    disabled={loading}
                  >
                    ✦ Make this feed now
                  </button>
                  <span className="cur-finalize-hint">
                    skip the rest — Claude will use sensible defaults
                  </span>
                </div>
              )}
              <form
                className="cur-input-wrap"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (lastParsed?.options.length) submitChat();
                  else send(input);
                }}
              >
                <textarea
                  ref={inputRef}
                  className="cur-input"
                  rows={1}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter submits; Shift+Enter inserts a newline.
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      if (lastParsed?.options.length) submitChat();
                      else send(input);
                    }
                  }}
                  placeholder={
                    lastParsed?.options.length
                      ? selectedOptions.size > 0
                        ? "Add a comment (optional)…"
                        : "Tap the options above, or describe it in your own words…"
                      : "Describe your ideal feed…"
                  }
                  disabled={loading}
                />
                <ShaderSendButton
                  disabled={
                    loading ||
                    (lastParsed?.options.length
                      ? selectedOptions.size === 0 && !input.trim()
                      : !input.trim())
                  }
                />
              </form>
            </div>
          </>
        ) : (
          <div className="cur-feed-layout">
            {/* Posts column */}
            <div className="cur-feed-posts">
              <div className="cur-feed-posts-header">
                <div className="cur-feed-stage">
                  {postsLoading && (
                    <>
                      <span className="pulse-dot" />
                      <span>
                        {postsStage === "ranking"
                          ? "Ranking results…"
                          : "Searching for posts that match your feed…"}
                      </span>
                    </>
                  )}
                </div>
                {(() => {
                  const fid = activeFeedId ? parseInt(activeFeedId) || null : null;
                  return (
                    <button
                      type="button"
                      className="cur-refresh"
                      disabled={postsLoading || !fid}
                      onClick={() => fid && loadPosts(fid)}
                      title="Refresh posts"
                    >
                      ↻ Refresh
                    </button>
                  );
                })()}
              </div>
              <div className="cur-feed-posts-inner">
                {posts.length === 0 ? (
                  <div className="cur-empty">
                    {postsLoading ? (
                      <p><span className="pulse-dot" />Loading posts…</p>
                    ) : (
                      <>
                        <p>No posts yet.</p>
                        <p className="sub">
                          {!semanticConfig
                            ? "Complete the feed setup first — your preferences are what we search against."
                            : "Try Refresh, or refine the feed criteria in the chat."}
                        </p>
                      </>
                    )}
                  </div>
                ) : (
                  posts.map((post) => {
                    const bskyUrl = (() => {
                      const m = post.uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
                      return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
                    })();
                    return (
                      <div key={post.uri} className="cur-post">
                        <div className="cur-post-head">
                          <div className="avatar" />
                          <span className="handle">{post.author_did.slice(0, 24)}...</span>
                          <span className={`score ${post.score >= 0.6 ? "high" : post.score >= 0.4 ? "mid" : "low"}`}>
                            {(post.score * 100).toFixed(0)}%
                          </span>
                          {bskyUrl && (
                            <a
                              href={bskyUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="cur-post-link"
                              title="Open in Bluesky"
                              aria-label="Open in Bluesky"
                            >
                              ↗
                            </a>
                          )}
                        </div>
                        <div className="cur-post-body">{post.text}</div>
                        <div className="cur-post-time">{post.indexed_at}</div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Control tower */}
            {(mechanicalFilters || semanticConfig) && (
              <FilterPanel
                mechanicalFilters={mechanicalFilters || ({} as MechanicalFilters)}
                semanticConfig={semanticConfig || ({} as SemanticConfig)}
                onMechanicalChange={saveMechanicalFilters}
                onSemanticChange={saveSemanticConfig}
                postCount={postCount}
              />
            )}
          </div>
        )}
      </div>

      {showImportMemory && (
        <ImportMemoryModal
          onClose={() => setShowImportMemory(false)}
          onImported={handleMemoryImported}
        />
      )}

    </div>
  );
}
