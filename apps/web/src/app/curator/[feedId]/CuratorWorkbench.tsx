"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Script from "next/script";
import FilterPanel from "@/components/FilterPanel";
import ShaderSendButton from "@/components/ShaderSendButton";
import PipelineLoader, { type PipelineStage } from "@/components/PipelineLoader";
import { authedFetch } from "@/lib/authed-fetch";
import type { MechanicalFilters } from "@/lib/types";
import { DEFAULT_CANDIDATE_BUDGET, DEFAULT_RERANK_MODEL } from "@/lib/defaults";
import { MAX_BRANCH_TOPICS, type BranchOption } from "@/lib/branch";
import { useResizable } from "../useResizable";
import { useCurator, feedIsComplete } from "../curatorContext";

interface Message { role: "user" | "assistant"; content: string; }

// Source post embedded in a branched feed's chat (from /api/chat).
interface ChatSourcePost {
  uri: string;
  bsky_url: string | null;
  text: string;
  author_handle: string | null;
  author_display_name: string | null;
}
interface Post {
  uri: string;
  author_did: string;
  text: string;
  score: number;
  rerank_score?: number;
  rerank_reason?: string;
  like_nsfw?: boolean;
  indexed_at: string;
  author_handle: string | null;
  author_display_name: string | null;
  author_avatar_cid: string | null;
  like_count: number;
  repost_count: number;
  reply_count: number;
  quote_count: number;
  external_uri: string | null;
  external_title: string | null;
  external_desc: string | null;
  external_thumb: string | null;
  quote_uri: string | null;
  has_images: boolean;
  image_count: number;
  image_alts: string[];
  image_urls: string[];
  is_reply: boolean;
  reply_parent_uri: string | null;
}

function avatarUrl(did: string, cid: string | null): string | null {
  if (!cid) return null;
  return `https://cdn.bsky.app/img/avatar_thumbnail/plain/${did}/${cid}@jpeg`;
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d`;
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function formatAbsoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function externalHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

declare global {
  interface Window {
    bluesky?: { scan: (root?: Element | Document) => void };
  }
}

const HASHTAG_RE = /(#[\w\u00C0-\u024F]+)/g;

function renderPostText(text: string): React.ReactNode[] {
  const parts = text.split(HASHTAG_RE);
  return parts.map((part, i) => {
    if (HASHTAG_RE.test(part)) {
      const tag = part.slice(1);
      return (
        <a
          key={i}
          href={`https://bsky.app/hashtag/${encodeURIComponent(tag)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="cur-post-hashtag"
        >
          {part}
        </a>
      );
    }
    return part;
  });
}

const RIGHT_W_KEY = "curator:rightWidth";
const RIGHT_MIN = 280;
const RIGHT_MAX = 960;

function parseMessage(content: string) {
  // Server stores the agent's question text + numbered option lines (rendered
  // from a present_options tool call). Pull those numbered lines out so we
  // can render them as chips.
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Bluesky's embed.js replaces the `.bluesky-embed` node with an <iframe>. If
// React owns that node, swapping view modes makes React try to remove a node
// the script already replaced → "removeChild: not a child" crash. So we render
// only an empty host <div> that React controls and inject the embed markup
// imperatively — React never reconciles the script-mutated node.
function BlueskyEmbed({
  uri,
  text,
  url,
}: {
  uri: string;
  text: string;
  url: string | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const link = url
      ? `<p><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">View on Bluesky</a></p>`
      : "";
    host.innerHTML =
      `<div class="bluesky-embed" data-bluesky-uri="${escapeHtml(uri)}" data-bluesky-embed-color-mode="light">` +
      `<p>${escapeHtml(text)}</p>${link}</div>`;
    const t = setTimeout(() => window.bluesky?.scan?.(host), 0);
    return () => {
      clearTimeout(t);
      host.innerHTML = "";
    };
  }, [uri, text, url]);
  return <div ref={hostRef} />;
}

export default function CuratorWorkbench({ feedId }: { feedId: number }) {
  const {
    profile,
    bskyOAuthReady,
    feeds,
    reloadFeeds,
    setActivePostCount,
    mobileTab,
    setOptionsUnread,
    viewMode,
    showDebug,
    hideUnavailable,
    setUnavailableCount,
    openPublish,
  } = useCurator();

  const [rightPane, setRightPane] = useState<"chat" | "tune">("chat");
  const [rightWidth, startRightDrag] = useResizable(
    RIGHT_W_KEY, 560, RIGHT_MIN, RIGHT_MAX, "right"
  );

  // Per-feed: unavailable URIs from the Bluesky availability probe. Lives
  // inside the workbench so it resets atomically when the feedId-keyed
  // component remounts on URL change. The count is mirrored up to the curator
  // context so the top-bar settings dialog can show it.
  const [unavailableUris, setUnavailableUris] = useState<Set<string>>(() => new Set());
  const bskyAvailabilityCache = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    setUnavailableCount(unavailableUris.size);
  }, [unavailableUris, setUnavailableCount]);
  useEffect(() => {
    return () => setUnavailableCount(0);
  }, [setUnavailableCount]);

  // ?prompt=<text> on the URL — set by /introspect's suggested-feed cards.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const promptParam = searchParams.get("prompt");

  const [messages, setMessages] = useState<Message[]>([]);
  // Seed the input from ?prompt= via the initializer (not an effect) so it's
  // there on first paint and we don't trigger a cascading render.
  const [input, setInput] = useState(() => promptParam ?? "");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [loading, setLoading] = useState(false);

  // Consume the seed once: focus the textarea and drop ?prompt= from the URL
  // so a remount doesn't re-seed. No setState here — the value is already in.
  const promptConsumedRef = useRef(false);
  useEffect(() => {
    if (promptConsumedRef.current || !promptParam) return;
    promptConsumedRef.current = true;
    setTimeout(() => inputRef.current?.focus(), 0);
    router.replace(pathname);
  }, [promptParam, pathname, router]);

  // Interview mode is a hint to the agent for the *next* request only; the
  // agent picks up the pattern from history after that. Set true by the
  // "Help me build my prompt" button, false by "Cancel questions".
  const interviewModeRef = useRef(false);
  const [posts, setPosts] = useState<Post[]>([]);
  const [postCount, setPostCount] = useState(0);
  const [aiLabels, setAiLabels] = useState<Record<string, { ai_generated: boolean; scores: number[] }>>({});
  const [lightbox, setLightbox] = useState<{ urls: string[]; index: number } | null>(null);
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
      else if (e.key === "ArrowLeft") setLightbox((lb) => lb ? { ...lb, index: (lb.index - 1 + lb.urls.length) % lb.urls.length } : null);
      else if (e.key === "ArrowRight") setLightbox((lb) => lb ? { ...lb, index: (lb.index + 1) % lb.urls.length } : null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  // Fetch AI-generated labels for posts with images
  useEffect(() => {
    if (posts.length === 0) return;
    const imagePosts = posts.filter((p) => p.has_images && p.image_urls.length > 0);
    if (imagePosts.length === 0) return;
    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        imagePosts.map(async (p) => {
          try {
            const params = new URLSearchParams({
              uri: p.uri,
              image_urls: p.image_urls.join(","),
            });
            const res = await authedFetch(`/api/ai-label?${params}`);
            if (!res.ok) return null;
            const data = await res.json();
            return { uri: p.uri, ai_generated: data.ai_generated as boolean, scores: data.scores as number[] };
          } catch {
            return null;
          }
        })
      );
      if (cancelled) return;
      const next: Record<string, { ai_generated: boolean; scores: number[] }> = {};
      for (const r of results) {
        if (r) next[r.uri] = { ai_generated: r.ai_generated, scores: r.scores };
      }
      setAiLabels(next);
    })();
    return () => { cancelled = true; };
  }, [posts]);

  // Bluesky like state: uri → { liked, likeUri, pending }
  const [likeState, setLikeState] = useState<Record<string, { liked: boolean; likeUri?: string; pending: boolean }>>({});
  const [engagePending, setEngagePending] = useState<
    Record<string, Partial<Record<"reply" | "repost" | "quote", boolean>>>
  >({});
  const [countDelta, setCountDelta] = useState<
    Record<string, { replies?: number; reposts?: number; quotes?: number }>
  >({});
  const [composer, setComposer] = useState<{ uri: string; kind: "reply" | "quote" } | null>(null);
  const [composerText, setComposerText] = useState("");
  const [composerError, setComposerError] = useState("");
  const [composerPending, setComposerPending] = useState(false);
  // OAuth session required for repo writes; app password is a legacy fallback.
  const hasBskyAuth = bskyOAuthReady || !!profile.bskyAppPassword;

  function ensureBskyAuth(): boolean {
    if (!hasBskyAuth) {
      setShowBskyAuth(true);
      return false;
    }
    return true;
  }

  async function handleRepost(postUri: string) {
    if (!ensureBskyAuth()) return;
    setEngagePending((s) => ({ ...s, [postUri]: { ...s[postUri], repost: true } }));
    try {
      const res = await authedFetch("/api/bsky/repost", {
        method: "POST",
        body: JSON.stringify({ uri: postUri }),
      });
      if (res.ok) {
        setCountDelta((s) => ({
          ...s,
          [postUri]: { ...s[postUri], reposts: (s[postUri]?.reposts ?? 0) + 1 },
        }));
      }
    } finally {
      setEngagePending((s) => ({ ...s, [postUri]: { ...s[postUri], repost: false } }));
    }
  }

  function openComposer(postUri: string, kind: "reply" | "quote") {
    if (!ensureBskyAuth()) return;
    setComposer({ uri: postUri, kind });
    setComposerText("");
    setComposerError("");
  }

  async function submitComposer() {
    if (!composer || !composerText.trim()) return;
    setComposerPending(true);
    setComposerError("");
    try {
      const res = await authedFetch("/api/bsky/compose", {
        method: "POST",
        body: JSON.stringify({
          uri: composer.uri,
          kind: composer.kind,
          text: composerText,
        }),
        suppressErrorToast: true,
      });
      const data = await res.json();
      if (!res.ok) {
        setComposerError(data.error || "Failed to post");
        return;
      }
      const field = composer.kind === "reply" ? "replies" : "quotes";
      setCountDelta((s) => ({
        ...s,
        [composer.uri]: {
          ...s[composer.uri],
          [field]: (s[composer.uri]?.[field] ?? 0) + 1,
        },
      }));
      setComposer(null);
      setComposerText("");
    } finally {
      setComposerPending(false);
    }
  }

  // On-demand Bluesky auth prompt
  const [showBskyAuth, setShowBskyAuth] = useState(false);
  const [bskyHandle, setBskyHandle] = useState("");
  const [bskyAuthLoading, setBskyAuthLoading] = useState(false);
  const [bskyAuthError, setBskyAuthError] = useState("");

  async function startBskyAuth() {
    if (!bskyHandle.trim()) return;
    setBskyAuthLoading(true);
    setBskyAuthError("");
    try {
      const res = await authedFetch("/api/bsky/oauth/authorize", {
        method: "POST",
        body: JSON.stringify({ handle: bskyHandle.trim().replace(/^@/, "") }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to start sign-in");
      }
      const { url } = await res.json();
      window.location.href = url;
    } catch (e) {
      setBskyAuthError(e instanceof Error ? e.message : "Sign-in failed");
      setBskyAuthLoading(false);
    }
  }

  async function toggleLike(postUri: string, currentlyLiked: boolean, currentLikeUri?: string) {
    if (!ensureBskyAuth()) return;
    const prev = likeState[postUri];
    // Optimistic update
    setLikeState((s) => ({
      ...s,
      [postUri]: { liked: !currentlyLiked, likeUri: currentlyLiked ? undefined : currentLikeUri, pending: true },
    }));
    try {
      const res = await authedFetch("/api/bsky/like", {
        method: "POST",
        body: JSON.stringify({
          uri: postUri,
          action: currentlyLiked ? "unlike" : "like",
          ...(currentlyLiked && currentLikeUri ? { likeUri: currentLikeUri } : {}),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setLikeState((s) => ({
          ...s,
          [postUri]: { liked: !currentlyLiked, likeUri: data.likeUri, pending: false },
        }));
      } else {
        // Revert on failure
        setLikeState((s) => ({ ...s, [postUri]: prev ?? { liked: currentlyLiked, likeUri: currentLikeUri, pending: false } }));
      }
    } catch {
      setLikeState((s) => ({ ...s, [postUri]: prev ?? { liked: currentlyLiked, likeUri: currentLikeUri, pending: false } }));
    }
  }

  function renderEngageFooter(post: Post, bskyUrl: string | null) {
    return (
      <footer className="cur-post-stats">
        <button
          type="button"
          className="cur-post-stat cur-post-engage-btn"
          title="Reply"
          disabled={engagePending[post.uri]?.reply}
          onClick={() => openComposer(post.uri, "reply")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
          {formatCount(post.reply_count + (countDelta[post.uri]?.replies ?? 0))}
        </button>
        <button
          type="button"
          className={`cur-post-stat cur-post-engage-btn${(countDelta[post.uri]?.reposts ?? 0) > 0 ? " cur-post-reposted" : ""}`}
          title="Repost"
          disabled={engagePending[post.uri]?.repost}
          onClick={() => handleRepost(post.uri)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="17 1 21 5 17 9" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <polyline points="7 23 3 19 7 15" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
          {formatCount(post.repost_count + (countDelta[post.uri]?.reposts ?? 0))}
        </button>
        <button
          type="button"
          className={`cur-post-stat cur-post-engage-btn cur-post-like-btn ${likeState[post.uri]?.liked ? "cur-post-liked" : ""}`}
          title={likeState[post.uri]?.liked ? "Unlike" : "Like"}
          disabled={likeState[post.uri]?.pending}
          onClick={() => toggleLike(post.uri, !!likeState[post.uri]?.liked, likeState[post.uri]?.likeUri)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill={likeState[post.uri]?.liked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
          {formatCount(post.like_count + (likeState[post.uri]?.liked ? 1 : 0))}
        </button>
        <button
          type="button"
          className="cur-post-stat cur-post-engage-btn"
          title="Quote"
          disabled={engagePending[post.uri]?.quote}
          onClick={() => openComposer(post.uri, "quote")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 21c3 0 5-2 5-5V7H3v8h4" />
            <path d="M14 21c3 0 5-2 5-5V7h-5v8h4" />
          </svg>
          {formatCount(post.quote_count + (countDelta[post.uri]?.quotes ?? 0))}
        </button>
        {bskyUrl && (
          <a
            href={bskyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="cur-post-open"
            title="Open in Bluesky"
          >
            Open ↗
          </a>
        )}
      </footer>
    );
  }

  const [postsLoading, setPostsLoading] = useState(false);
  // Set true when a chat message is sent while posts are on screen, so we can
  // fade the feed to signal it's changing; cleared once posts finish loading
  // (or when the turn ends without triggering a re-query).
  const [feedRefreshing, setFeedRefreshing] = useState(false);
  const [pipelineStage, setPipelineStage] = useState<PipelineStage>("idle");
  const [pipelineCandidates, setPipelineCandidates] = useState<number | undefined>(undefined);
  const [pipelineHits, setPipelineHits] = useState<number | undefined>(undefined);
  const [pipelineImages, setPipelineImages] = useState<number | undefined>(undefined);
  const [pipelineModel, setPipelineModel] = useState<string | undefined>(undefined);
  const [pipelineThinkingEnabled, setPipelineThinkingEnabled] = useState<boolean | undefined>(undefined);
  const [chatLoading, setChatLoading] = useState(false);
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set());
  const [mechanicalFilters, setMechanicalFilters] = useState<MechanicalFilters | null>(null);
  const [subqueries, setSubqueries] = useState<string[]>([]);
  const [candidateBudget, setCandidateBudget] = useState<number>(DEFAULT_CANDIDATE_BUDGET);
  const [rerankPrompt, setRerankPrompt] = useState<string>("");
  const [rerankModel, setRerankModel] = useState<string>(DEFAULT_RERANK_MODEL);
  const [rerankThinkingEnabled, setRerankThinkingEnabled] = useState<boolean>(false);

  // Branch flow. sourcePost is set when this feed was branched off a post (it
  // renders an embedded card atop the chat). The auto-fired branch-init turn
  // (guarded by branchInitFiredRef) makes the agent write the rerank prompt +
  // name. The branch* panel state drives the inline "Branch" affordance on
  // each post card. See BRANCHING_PRD.md.
  const [sourcePost, setSourcePost] = useState<ChatSourcePost | null>(null);
  const branchInitFiredRef = useRef(false);
  const [branchPanelUri, setBranchPanelUri] = useState<string | null>(null);
  const [branchOptions, setBranchOptions] = useState<BranchOption[] | null>(null);
  const [branchOptionsLoading, setBranchOptionsLoading] = useState(false);
  const [branchSelected, setBranchSelected] = useState<Set<number>>(new Set());
  const [branchCreating, setBranchCreating] = useState(false);
  // Refs for the "Explore" branching-tree reveal: a trunk grows down the
  // centre of the tree canvas and boughs curl out to each topic chip.
  const branchTreeRef = useRef<HTMLDivElement | null>(null);
  const branchWiresRef = useRef<SVGSVGElement | null>(null);
  const branchTracePlayedRef = useRef<string>("");

  const endRef = useRef<HTMLDivElement>(null);
  // Single signature of the fields that, when changed, should re-fetch posts.
  // Updated by both the user (Tune panel saves) and the agent (chat replies).
  const feedSignatureRef = useRef<string>("");
  const postsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function feedSignature(f: {
    subqueries?: string[];
    mechanical_filters?: MechanicalFilters;
    candidate_budget?: number;
    rerank_prompt?: string;
  }): string {
    return JSON.stringify({
      s: f.subqueries ?? [],
      m: f.mechanical_filters ?? null,
      b: f.candidate_budget ?? null,
      r: f.rerank_prompt ?? "",
    });
  }

  // On unmount (i.e. when the user switches feeds), clear the layout's
  // mirrored post count so the sidebar doesn't briefly show stale numbers
  // for the next feed. The active value is pushed up directly from
  // loadPosts (and from send() when FEED_DONE triggers a reload).
  useEffect(() => {
    return () => setActivePostCount(0);
  }, [setActivePostCount]);

  // Patches that originate from the Tune panel. We update local state and
  // the signature in sync so the next chat reply doesn't trigger a redundant
  // post-refresh just because the server echoed back our own write.
  async function patchFeed(patch: {
    mechanical_filters?: MechanicalFilters;
    subqueries?: string[];
    candidate_budget?: number;
    rerank_model?: string;
    rerank_thinking_enabled?: boolean;
  }) {
    if (patch.mechanical_filters) setMechanicalFilters(patch.mechanical_filters);
    if (patch.subqueries) setSubqueries(patch.subqueries);
    if (patch.candidate_budget !== undefined) setCandidateBudget(patch.candidate_budget);
    if (patch.rerank_model) setRerankModel(patch.rerank_model);
    if (patch.rerank_thinking_enabled !== undefined) setRerankThinkingEnabled(patch.rerank_thinking_enabled);
    feedSignatureRef.current = feedSignature({
      subqueries: patch.subqueries ?? subqueries,
      mechanical_filters: patch.mechanical_filters ?? mechanicalFilters ?? undefined,
      candidate_budget: patch.candidate_budget ?? candidateBudget,
      rerank_prompt: rerankPrompt,
    });
    try {
      await authedFetch("/api/feeds", {
        method: "PATCH",
        body: JSON.stringify({ id: feedId, ...patch }),
      });
    } catch { /* ignore */ }
  }

  const saveMechanicalFilters = (filters: MechanicalFilters) =>
    patchFeed({ mechanical_filters: filters });
  const saveSubqueries = (subs: string[]) => patchFeed({ subqueries: subs });
  const saveCandidateBudget = (n: number) => patchFeed({ candidate_budget: n });
  const saveRerankModel = (model: string) => patchFeed({ rerank_model: model });
  const saveRerankThinkingEnabled = (v: boolean) =>
    patchFeed({ rerank_thinking_enabled: v });


  const loadChat = useCallback(async (id: number): Promise<{
    sourcePost: ChatSourcePost | null;
    messages: Message[];
  }> => {
    setChatLoading(true);
    try {
      const res = await authedFetch(`/api/chat?feedId=${id}`);
      const data = await res.json();
      const msgs: Message[] = data.messages || [];
      const src: ChatSourcePost | null = data.sourcePost ?? null;
      setSourcePost(src);
      const f = data.feed;
      if (f) {
        if (Array.isArray(f.subqueries)) setSubqueries(f.subqueries);
        if (typeof f.candidate_budget === "number") setCandidateBudget(f.candidate_budget);
        if (f.mechanical_filters) setMechanicalFilters(f.mechanical_filters);
        setRerankPrompt(f.rerank_prompt ?? "");
        if (typeof f.rerank_model === "string" && f.rerank_model.length > 0) {
          setRerankModel(f.rerank_model);
        }
        if (typeof f.rerank_thinking_enabled === "boolean") {
          setRerankThinkingEnabled(f.rerank_thinking_enabled);
        }
        feedSignatureRef.current = feedSignature(f);
      }
      setMessages(msgs);
      return { sourcePost: src, messages: msgs };
    } catch {
      return { sourcePost: null, messages: [] };
    } finally {
      setChatLoading(false);
    }
  }, []);

  const loadPosts = useCallback(async (id: number, opts?: { force?: boolean }) => {
    setPostsLoading(true);
    setPipelineStage("searching");
    setPipelineCandidates(undefined);
    setPipelineHits(undefined);
    setPipelineImages(undefined);
    setPipelineModel(undefined);
    setPipelineThinkingEnabled(undefined);
    try {
      // force=true (Refresh button) bypasses the 1h backend result cache and
      // recomputes; all other loads are cache-eligible.
      const url = `/api/feed-preview/stream?feedId=${id}${opts?.force ? "&refresh=1" : ""}`;
      const res = await authedFetch(url);
      if (!res.ok || !res.body) {
        setPostsLoading(false);
        setPipelineStage("idle");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Each event is one line of NDJSON. Process full lines; keep the
        // last partial line in the buffer until the next chunk completes it.
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line) as {
              event?: string;
              stage?: string;
              candidates?: number;
              hits?: number;
              images?: number;
              model?: string;
              thinking_enabled?: boolean;
              posts?: Post[];
              cached?: boolean;
              total_stored?: number;
              mechanical_filters?: MechanicalFilters;
              subqueries?: string[];
              candidate_budget?: number;
              rerank_prompt?: string;
              rerank_model?: string;
              rerank_thinking_enabled?: boolean;
              message?: string;
            };
            if (ev.event === "stage" && ev.stage) {
              if (ev.stage === "skipped_rerank") {
                // No rerank prompt: jump straight past thinking/ranking;
                // the "done" event will arrive immediately after with posts.
              } else if (
                ev.stage === "searching" ||
                ev.stage === "thinking" ||
                ev.stage === "ranking" ||
                ev.stage === "done"
              ) {
                setPipelineStage(ev.stage);
                if (ev.stage === "thinking") {
                  if (typeof ev.candidates === "number") setPipelineCandidates(ev.candidates);
                  if (typeof ev.hits === "number") setPipelineHits(ev.hits);
                  if (typeof ev.images === "number") setPipelineImages(ev.images);
                  if (typeof ev.model === "string") setPipelineModel(ev.model);
                  if (typeof ev.thinking_enabled === "boolean") setPipelineThinkingEnabled(ev.thinking_enabled);
                }
              }
            } else if (ev.event === "done") {
              // Cache hits ran no pipeline — hide the loader entirely rather
              // than leaving the "done" summary with empty "queued" steps.
              setPipelineStage(ev.cached ? "idle" : "done");
              const nextCount = ev.total_stored || (ev.posts?.length ?? 0);
              setPosts(ev.posts || []);
              setPostCount(nextCount);
              setActivePostCount(nextCount);
              if (ev.mechanical_filters) setMechanicalFilters(ev.mechanical_filters);
              if (Array.isArray(ev.subqueries)) setSubqueries(ev.subqueries);
              if (typeof ev.candidate_budget === "number") setCandidateBudget(ev.candidate_budget);
              if (typeof ev.rerank_prompt === "string") setRerankPrompt(ev.rerank_prompt);
              if (typeof ev.rerank_model === "string" && ev.rerank_model.length > 0) {
                setRerankModel(ev.rerank_model);
              }
              if (typeof ev.rerank_thinking_enabled === "boolean") {
                setRerankThinkingEnabled(ev.rerank_thinking_enabled);
              }
              feedSignatureRef.current = feedSignature({
                subqueries: ev.subqueries,
                mechanical_filters: ev.mechanical_filters,
                candidate_budget: ev.candidate_budget,
                rerank_prompt: ev.rerank_prompt,
              });
            } else if (ev.event === "error") {
              console.warn("[feed-preview/stream] error:", ev.message);
            }
          } catch {
            /* ignore malformed line */
          }
        }
      }
    } catch { /* ignore */ }
    finally {
      setPostsLoading(false);
      setFeedRefreshing(false);
    }
  }, [setActivePostCount]);

  // On mount (i.e. on feed switch via URL change), hydrate chat + posts.
  // Deferred a tick so the fetch kickoff (which flips loading flags) runs
  // outside the synchronous effect body, avoiding a cascading render.
  useEffect(() => {
    const t = setTimeout(async () => {
      const chat = await loadChat(feedId);
      // A freshly-branched feed (has a source post but no chat yet) loads its
      // posts via the branch-init turn (see branchInit), which first writes the
      // rerank prompt and only then queries. Firing loadPosts here too would
      // run the pipeline prematurely — before the rerank prompt exists — and
      // pre-populate feed_result_cache, so the branch-init reload gets served a
      // stale, non-reranked cached result instead of recomputing. Skip it and
      // let branchInit own the first load.
      const isFreshBranch = !!chat.sourcePost && chat.messages.length === 0;
      if (!isFreshBranch) loadPosts(feedId);
    }, 0);
    return () => clearTimeout(t);
  }, [feedId, loadChat, loadPosts]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // Re-scan Bluesky embeds when the visible post set changes.
  useEffect(() => {
    if (viewMode !== "embed") return;
    const scan = () => window.bluesky?.scan?.();
    scan();
    const t = setTimeout(scan, 300);
    return () => clearTimeout(t);
  }, [viewMode, posts, hideUnavailable, unavailableUris]);

  // Detect unavailable posts via the public AT Proto API.
  useEffect(() => {
    if (viewMode !== "embed") return;
    if (posts.length === 0) return;

    const ac = new AbortController();
    const cache = bskyAvailabilityCache.current;

    async function check(uri: string) {
      const cached = cache.get(uri);
      if (cached !== undefined) {
        if (cached === false) {
          setUnavailableUris((prev) =>
            prev.has(uri) ? prev : new Set(prev).add(uri)
          );
        }
        return;
      }
      try {
        const res = await fetch(
          `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(
            uri
          )}&depth=0&parentHeight=0`,
          { signal: ac.signal }
        );
        if (!res.ok) {
          cache.set(uri, false);
          setUnavailableUris((prev) =>
            prev.has(uri) ? prev : new Set(prev).add(uri)
          );
          return;
        }
        const data = (await res.json()) as {
          thread?: {
            post?: {
              labels?: { val?: string }[];
              author?: { labels?: { val?: string }[] };
            };
          };
        };
        const post = data.thread?.post;
        const hasNoUnauth =
          post?.labels?.some((l) => l.val === "!no-unauthenticated") ||
          post?.author?.labels?.some((l) => l.val === "!no-unauthenticated") ||
          false;
        if (!post || hasNoUnauth) {
          cache.set(uri, false);
          setUnavailableUris((prev) =>
            prev.has(uri) ? prev : new Set(prev).add(uri)
          );
        } else {
          cache.set(uri, true);
        }
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") return;
      }
    }

    posts.forEach((p) => { check(p.uri); });

    return () => ac.abort();
  }, [viewMode, posts]);

  async function send(text: string) {
    if (!text.trim() || loading) return;
    setInput("");
    setSelectedOptions(new Set());
    setMessages(prev => [...prev, { role: "user", content: text.trim() }]);
    setLoading(true);
    // Fade the current feed to signal it may be changing. Only when posts are
    // actually on screen; cleared on posts load (or below if no re-query fires).
    if (posts.length > 0) setFeedRefreshing(true);
    let willReload = false;
    const interview = interviewModeRef.current;
    // Interview flag is consumed once: after a single nudged turn, the model
    // picks up the question/options pattern from history on its own.
    interviewModeRef.current = false;
    try {
      const res = await authedFetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message: text.trim(), feedId, interview }),
      });
      // On a non-OK response (e.g. 429 rate limit) the body has no `messages`;
      // bail before setMessages so we don't wipe the visible transcript. The
      // global ServerErrorToast already surfaces the reason. Keep the user's
      // optimistic message on screen so they can retry.
      if (!res.ok) return;
      const d = await res.json();
      const msgs = d.messages || [];
      setMessages(msgs);
      const f = d.feed;
      if (f) {
        const prevSubs = subqueries;
        if (Array.isArray(f.subqueries)) setSubqueries(f.subqueries);
        if (f.mechanical_filters) setMechanicalFilters(f.mechanical_filters);
        if (typeof f.candidate_budget === "number") setCandidateBudget(f.candidate_budget);
        if (typeof f.rerank_prompt === "string") setRerankPrompt(f.rerank_prompt);

        const nextSig = feedSignature(f);
        const subsChanged =
          Array.isArray(f.subqueries) &&
          JSON.stringify(f.subqueries) !== JSON.stringify(prevSubs);
        if (nextSig !== feedSignatureRef.current) {
          feedSignatureRef.current = nextSig;
          if (subsChanged) reloadFeeds();
          if (postsDebounceRef.current) clearTimeout(postsDebounceRef.current);
          postsDebounceRef.current = setTimeout(() => loadPosts(feedId), 600);
          willReload = true;
        }
      }
      const last = msgs[msgs.length - 1];
      if (last?.role === "assistant" && parseMessage(last.content).options.length > 0) {
        if (mobileTab !== "chat") setOptionsUnread(true);
      }
      if (d.done) {
        loadPosts(feedId);
        reloadFeeds();
        willReload = true;
      }
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "Something went wrong." }]);
    } finally {
      setLoading(false);
      // No re-query was triggered → nothing will clear the fade, so do it here.
      if (!willReload) setFeedRefreshing(false);
    }
  }

  // Cancel any pending debounce on unmount so a stale timer doesn't fire
  // after the user has navigated away.
  useEffect(() => {
    return () => {
      if (postsDebounceRef.current) {
        clearTimeout(postsDebounceRef.current);
        postsDebounceRef.current = null;
      }
    };
  }, []);

  function finalizeNow() {
    if (loading) return;
    interviewModeRef.current = false;
    send("Go ahead and finalize the feed now with what you've got — pick reasonable defaults for anything we haven't covered.");
  }

  function askForQuestions() {
    if (loading) return;
    interviewModeRef.current = true;
    send("Help me build my feed — walk me through it step by step.");
  }

  function cancelQuestions() {
    if (loading) return;
    interviewModeRef.current = false;
    send("Actually, let's just chat — no more options lists.");
  }

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

  // Auto-fire the branch-init turn: on a branched feed with no chat yet, ask
  // the agent to write the rerank prompt + name from the embedded source post.
  const branchInit = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authedFetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message: "__branch_init__", feedId }),
      });
      const d = await res.json();
      if (Array.isArray(d.messages)) setMessages(d.messages);
      if (d.sourcePost !== undefined) setSourcePost(d.sourcePost);
      const f = d.feed;
      if (f) {
        if (Array.isArray(f.subqueries)) setSubqueries(f.subqueries);
        if (f.mechanical_filters) setMechanicalFilters(f.mechanical_filters);
        if (typeof f.rerank_prompt === "string") setRerankPrompt(f.rerank_prompt);
        feedSignatureRef.current = feedSignature(f);
        reloadFeeds(); // the agent renamed the feed → refresh the sidebar
      }
    } catch { /* ignore — user can still chat normally */ }
    finally {
      setLoading(false);
      // branchInit owns the first post load for a branched feed (the mount
      // effect deliberately skips it). Run it here — after the rerank prompt is
      // written above — so the query reflects the final config, and run it even
      // if the turn failed so the feed isn't left empty.
      loadPosts(feedId);
    }
  }, [feedId, reloadFeeds, loadPosts]);

  useEffect(() => {
    if (!sourcePost || messages.length > 0) return;
    if (branchInitFiredRef.current || chatLoading || loading) return;
    branchInitFiredRef.current = true;
    void branchInit();
  }, [sourcePost, messages.length, chatLoading, loading, branchInit]);


  // --- Branch panel (inline "Branch" affordance on each post card) ---
  const fetchBranchOptions = useCallback(async (postUri: string) => {
    setBranchOptionsLoading(true);
    setBranchOptions(null);
    try {
      const res = await authedFetch("/api/branch/options", {
        method: "POST",
        body: JSON.stringify({ feedId, postUri }),
      });
      const d = await res.json();
      setBranchOptions(Array.isArray(d.options) ? d.options : []);
    } catch {
      setBranchOptions([]);
    } finally {
      setBranchOptionsLoading(false);
    }
  }, [feedId]);

  function openBranch(postUri: string) {
    branchTracePlayedRef.current = "";
    if (branchPanelUri === postUri) {
      setBranchPanelUri(null);
      return;
    }
    setBranchPanelUri(postUri);
    setBranchSelected(new Set());
    setBranchOptions(null);
    fetchBranchOptions(postUri);
  }

  function toggleBranchSelect(i: number) {
    setBranchSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else if (next.size < MAX_BRANCH_TOPICS) next.add(i);
      return next;
    });
  }

  async function createBranch(postUri: string) {
    if (!branchOptions || branchSelected.size === 0 || branchCreating) return;
    const picked = [...branchSelected].map((i) => branchOptions[i]).filter(Boolean);
    setBranchCreating(true);
    try {
      const res = await authedFetch("/api/feeds/branch", {
        method: "POST",
        body: JSON.stringify({
          parentFeedId: feedId,
          sourcePostUri: postUri,
          subqueries: picked.map((o) => o.subquery),
          labels: picked.map((o) => o.label),
        }),
      });
      const d = await res.json();
      if (d.feed?.id) {
        reloadFeeds();
        setBranchPanelUri(null);
        router.push(`/curator/${d.feed.id}`);
      }
    } catch { /* ignore */ }
    finally { setBranchCreating(false); }
  }

  // Sequential "Explore" reveal. Once the topic chips render, a trunk grows
  // down the centre of the tree canvas, then boughs curl out to each chip in
  // turn — chips are paired right/left descending row by row, each in its own
  // row+side so a line never runs under another card. Chip positions are set
  // imperatively (need the measured canvas width) and survive React re-renders
  // because they're applied as inline styles, not via React props; the side
  // class lives in the rendered className. Honours prefers-reduced-motion.
  // Runs once per (post + options) load, guarded by branchTracePlayedRef.
  useEffect(() => {
    const NS = "http://www.w3.org/2000/svg";
    const tree = branchTreeRef.current;
    const svg = branchWiresRef.current;
    if (!branchPanelUri || !branchOptions || branchOptions.length === 0) return;
    if (!tree || !svg) return;

    const key = `${branchPanelUri}:${branchOptions.length}`;
    if (branchTracePlayedRef.current === key) return;
    branchTracePlayedRef.current = key;

    const chips = Array.from(
      tree.querySelectorAll<HTMLElement>(".cur-branch-chip")
    );
    if (chips.length === 0) return;

    const reduce = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    const W = tree.clientWidth || 480;
    // Two chips per row when there's room; on narrow/mobile widths stack one
    // per row (alternating sides). The trunk stays centred either way so it
    // lines up under the button.
    const single = W < 420;
    const perRow = single ? 1 : 2;
    const centerX = W / 2;
    // Keep the boughs in a tight central channel — short horizontal reach.
    const OFFSET = single ? Math.min(20, W * 0.06) : Math.min(38, W * 0.08);
    const chipMaxW = Math.min(240, Math.floor(W / 2 - OFFSET - 10));
    const HEAD = 14; // top margin inside the canvas
    const GAP = 16; // vertical gap between rows
    const TRUNK = 260, BOUGH = 320, STEP = 280;
    const rowCount = Math.ceil(chips.length / perRow);

    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const drawPath = (
      d: string,
      width: number,
      dur: number,
      delay: number
    ) => {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", "var(--aurora-deep)");
      p.setAttribute("stroke-width", String(width));
      p.setAttribute("stroke-linecap", "round");
      svg.appendChild(p);
      if (reduce) return;
      const len = p.getTotalLength();
      p.style.strokeDasharray = String(len);
      p.style.strokeDashoffset = String(len);
      p.animate(
        [{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
        { duration: dur, delay, easing: "cubic-bezier(.5,.05,.2,1)", fill: "forwards" }
      );
    };

    // Phase 1: size + horizontally place each chip, then measure its rendered
    // height (chips wrap, so rows can't use a fixed step or they'd overlap).
    const meta = chips.map((chip, i) => {
      const side = i % 2 === 0 ? 1 : -1; // even → right, odd → left
      const chipX = centerX + side * OFFSET; // chip inner edge
      chip.style.left = `${chipX}px`;
      chip.style.maxWidth = `${chipMaxW}px`;
      return { chip, i, side, chipX, row: Math.floor(i / perRow) };
    });
    const heights = meta.map((m) => m.chip.offsetHeight || 44);

    // Phase 2: stack each row by its tallest chip, centring chips on the row.
    const rowH: number[] = [];
    for (let r = 0; r < rowCount; r++) {
      let h = 0;
      for (let k = r * perRow; k < Math.min((r + 1) * perRow, chips.length); k++) {
        h = Math.max(h, heights[k]);
      }
      rowH[r] = h;
    }
    const rowCenterY: number[] = [];
    let cursor = HEAD;
    for (let r = 0; r < rowCount; r++) {
      rowCenterY[r] = cursor + rowH[r] / 2;
      cursor += rowH[r] + GAP;
    }
    const trunkEndY = rowCenterY[rowCount - 1];
    tree.style.height = `${cursor + 4}px`; // exact height for this layout

    // trunk grows down the spine (starts above the canvas, reaching the button)
    drawPath(`M ${centerX} -30 L ${centerX} ${trunkEndY}`, 2.6, TRUNK, 0);

    meta.forEach(({ chip, i, side, chipX, row }) => {
      const chipY = rowCenterY[row];
      const y0 = chipY - 22; // bough taps the trunk a little above the chip
      const delay = TRUNK + i * STEP;

      chip.style.top = `${chipY}px`;

      // Bough leaves the trunk going straight down, then curls out and arrives
      // HORIZONTALLY into the chip's inner edge (no vertical end-curl).
      const d = `M ${centerX} ${y0} C ${centerX} ${chipY}, ${centerX} ${chipY}, ${chipX} ${chipY}`;
      drawPath(d, 2.1, BOUGH, delay);

      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("cx", String(chipX));
      dot.setAttribute("cy", String(chipY));
      dot.setAttribute("fill", "var(--aurora)");
      svg.appendChild(dot);

      const base =
        side > 0 ? "translate(0,-50%)" : "translate(-100%,-50%)";
      if (reduce) {
        dot.setAttribute("r", "3.2");
        chip.style.opacity = "1";
        chip.style.transform = base;
        return;
      }
      dot.setAttribute("r", "0");
      dot.animate([{ r: 0 }, { r: 3.2 }], {
        duration: 200,
        delay: delay + BOUGH * 0.82,
        easing: "ease-out",
        fill: "forwards",
      });
      chip.animate(
        [
          { opacity: 0, transform: `${base} scale(.7)` },
          { opacity: 1, transform: `${base} scale(1.06)`, offset: 0.7 },
          { opacity: 1, transform: `${base} scale(1)` },
        ],
        {
          duration: 320,
          delay: delay + BOUGH * 0.84,
          easing: "cubic-bezier(.2,.8,.3,1.2)",
          fill: "forwards",
        }
      );
    });
  }, [branchPanelUri, branchOptions]);

  // Branch button + panel, shared by both the custom-card and embed views so
  // the affordance is identical in either mode.
  function branchButton(postUri: string) {
    return (
      <button
        type="button"
        className={`cur-post-branch${branchPanelUri === postUri ? " active" : ""}`}
        onClick={() => openBranch(postUri)}
        title="Explore from this post"
        aria-expanded={branchPanelUri === postUri}
      >
        <svg className="cur-branch-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          {/* a node that diverges into branches; the boughs unfurl on click */}
          <circle cx="12" cy="5" r="2.2" />
          <path d="M12 7v4" />
          <path className="cur-ex-sprout" d="M12 11 C 12 15, 6 14, 5.5 18.5" />
          <path className="cur-ex-sprout" d="M12 11 V 18.5" />
          <path className="cur-ex-sprout" d="M12 11 C 12 15, 18 14, 18.5 18.5" />
        </svg>
        {branchOptionsLoading && branchPanelUri === postUri ? (
          <>Loading<span className="cur-dots-inline"><span /><span /><span /></span></>
        ) : (
          "Explore"
        )}
      </button>
    );
  }

  function branchPanel(postUri: string) {
    if (branchPanelUri !== postUri) return null;
    // While options load, the Explore button itself shows the loading state —
    // no separate panel/status until we have directions to show.
    if (branchOptionsLoading) return null;
    return (
      <div className="cur-branch-panel">
        {branchOptions && branchOptions.length > 0 ? (
          <>
            <div
              className="cur-branch-tree"
              ref={branchTreeRef}
              style={{
                // Pre-layout reservation only — the trace effect sets the exact
                // height once chips are measured (see branchTreeRef effect). Keep
                // this at/below the single-line content height so it never adds
                // dead space below the chips before the button.
                minHeight: Math.ceil(branchOptions.length / 2) * 62 + 14,
              }}
            >
              <svg className="cur-branch-wires" ref={branchWiresRef} aria-hidden />
              {branchOptions.map((opt, i) => {
                const checked = branchSelected.has(i);
                const atCap = !checked && branchSelected.size >= MAX_BRANCH_TOPICS;
                const side = i % 2 === 0 ? "right" : "left";
                return (
                  <button
                    key={i}
                    type="button"
                    className={`cur-branch-chip ${side}${checked ? " selected" : ""}`}
                    data-kind={opt.kind}
                    disabled={atCap || branchCreating}
                    onClick={() => toggleBranchSelect(i)}
                    title={opt.subquery}
                  >
                    <span className="cur-branch-chip-kind">
                      {opt.kind === "deeper" ? "↳ deeper" : "→ adjacent"}
                    </span>
                    <span className="cur-branch-chip-label">
                      {checked ? "✓ " : ""}{opt.label}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="cur-branch-actions">
              <button
                type="button"
                className="cur-branch-create"
                disabled={branchSelected.size === 0 || branchCreating}
                onClick={() => createBranch(postUri)}
              >
                {branchCreating
                  ? "Creating…"
                  : branchSelected.size > 0
                    ? `Create feed from ${branchSelected.size} topic${branchSelected.size === 1 ? "" : "s"}`
                    : "Create feed"}
              </button>
              <button
                type="button"
                className="cur-branch-cancel"
                onClick={() => setBranchPanelUri(null)}
                disabled={branchCreating}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className="cur-branch-status">
            Couldn&rsquo;t find directions.{" "}
            <button
              type="button"
              className="cur-branch-retry"
              onClick={() => fetchBranchOptions(postUri)}
            >
              Retry
            </button>
          </div>
        )}
      </div>
    );
  }

  // The branch zone is just the Explore button + its panel. The tree SVG that
  // draws the trunk + boughs lives inside the panel's .cur-branch-tree canvas.
  function branchZone(postUri: string) {
    return (
      <div className="cur-branch-zone">
        <div className="cur-post-branch-row">{branchButton(postUri)}</div>
        {branchPanel(postUri)}
      </div>
    );
  }

  const hasCriteria = subqueries.length > 0;

  const activeFeed = feeds.find(f => f.id === String(feedId));
  const lastMsg = messages[messages.length - 1];
  const lastParsed = lastMsg?.role === "assistant" ? parseMessage(lastMsg.content) : null;

  const questionCount = messages.filter(
    (m) => m.role === "assistant" && parseMessage(m.content).options.length > 0
  ).length;
  const showFinalize = questionCount >= 3 && !hasCriteria;

  // Suppress unused-warning for activeFeed if we don't end up using it in JSX
  // (kept around in case future UI needs it).
  void activeFeed;
  void feedIsComplete;

  return (
    <>
      <Script
        src="https://embed.bsky.app/static/embed.js"
        strategy="afterInteractive"
        onLoad={() => window.bluesky?.scan?.()}
      />
      <div className="cur-workbench" data-right-pane={rightPane}>
        {/* POSTS PANE (middle) */}
        <div className="cur-feed-posts">
          {pipelineStage !== "idle" && (
            <div className="cur-feed-loader">
              <PipelineLoader
                stage={pipelineStage}
                candidates={pipelineCandidates}
                hits={pipelineHits}
                images={pipelineImages}
                model={pipelineModel}
                thinkingEnabled={pipelineThinkingEnabled}
                topK={25}
              />
            </div>
          )}
          <div className="cur-feed-posts-header">
            <span className="cur-toolbar-count">
              {posts.length > 0 && `${posts.length} post${posts.length === 1 ? "" : "s"}`}
            </span>
            <div className="cur-toolbar">
              <button
                type="button"
                className="cur-toolbar-btn"
                disabled={postsLoading}
                onClick={() => loadPosts(feedId, { force: true })}
                title="Refresh posts"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                Refresh
              </button>
            </div>
          </div>
          <div className={`cur-feed-posts-inner${feedRefreshing ? " refreshing" : ""}`}>
            {posts.length === 0 ? (
              <div className="cur-empty">
                {postsLoading ? (
                  // The PipelineLoader in the header already shows live progress;
                  // leave the empty area quiet.
                  null
                ) : (
                  <>
                    <p>No posts yet.</p>
                    <p className="sub">
                      {!hasCriteria
                        ? "Posts will appear here as we figure out what you're into."
                        : "Try Refresh, or refine the subqueries in chat or the Tune panel."}
                    </p>
                  </>
                )}
              </div>
            ) : viewMode === "embed" ? (
              posts.map((post) => {
                const bskyUrl = (() => {
                  const m = post.uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
                  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
                })();
                const replyParentUrl = (() => {
                  if (!post.reply_parent_uri) return null;
                  const m = post.reply_parent_uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
                  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
                })();
                if (hideUnavailable && unavailableUris.has(post.uri)) {
                  return null;
                }
                return (
                  <div key={post.uri} className="cur-post-item cur-post-item-embed">
                  <div
                    className="cur-post-embed-wrap"
                    data-bsky-uri={post.uri}
                  >
                    <div className="cur-post-embed-frame">
                      {post.is_reply && (
                        <div className="cur-post-reply-banner cur-post-reply-banner-embed">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <polyline points="9 17 4 12 9 7" />
                            <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
                          </svg>
                          {replyParentUrl ? (
                            <a href={replyParentUrl} target="_blank" rel="noopener noreferrer">
                              Replying to a post
                            </a>
                          ) : (
                            <span>Reply</span>
                          )}
                        </div>
                      )}
                      <div className="cur-post-embed-meta">
                        {bskyUrl && (
                          <a
                            href={bskyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="cur-post-open"
                            title="Open in Bluesky"
                          >
                            Open ↗
                          </a>
                        )}
                      </div>
                      {showDebug && (
                        <div className="cur-post-debug">
                          <span className="cur-post-debug-row">
                            <span className="cur-post-debug-label">vec</span>
                            <span>{(post.score * 100).toFixed(1)}%</span>
                            {typeof post.rerank_score === "number" && (
                              <>
                                <span className="cur-post-debug-label">rr</span>
                                <span>{post.rerank_score}</span>
                              </>
                            )}
                            {post.like_nsfw && (
                              <span className="cur-post-debug-flag">nsfw?</span>
                            )}
                          </span>
                          {post.rerank_reason && (
                            <span className="cur-post-debug-reason">
                              &ldquo;{post.rerank_reason}&rdquo;
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <BlueskyEmbed uri={post.uri} text={post.text} url={bskyUrl} />
                    {renderEngageFooter(post, bskyUrl)}
                  </div>
                    {branchZone(post.uri)}
                  </div>
                );
              })
            ) : (
              posts.map((post) => {
                const bskyUrl = (() => {
                  const m = post.uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
                  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
                })();
                const profileUrl = post.author_handle
                  ? `https://bsky.app/profile/${post.author_handle}`
                  : `https://bsky.app/profile/${post.author_did}`;
                const avatar = avatarUrl(post.author_did, post.author_avatar_cid);
                const displayName =
                  post.author_display_name?.trim() ||
                  post.author_handle ||
                  post.author_did.slice(0, 16) + "…";
                const handleLabel = post.author_handle
                  ? `@${post.author_handle}`
                  : post.author_did.slice(0, 20) + "…";
                const extHost = externalHost(post.external_uri);
                const replyParentUrl = (() => {
                  if (!post.reply_parent_uri) return null;
                  const m = post.reply_parent_uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
                  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
                })();
                return (
                  <div key={post.uri} className="cur-post-item">
                  <article className="cur-post-card">
                    {post.is_reply && (
                      <div className="cur-post-reply-banner">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <polyline points="9 17 4 12 9 7" />
                          <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
                        </svg>
                        {replyParentUrl ? (
                          <a href={replyParentUrl} target="_blank" rel="noopener noreferrer">
                            Replying to a post
                          </a>
                        ) : (
                          <span>Reply</span>
                        )}
                      </div>
                    )}
                    <header className="cur-post-card-head">
                      <a
                        href={profileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="cur-post-avatar"
                        aria-label={`Open ${displayName} on Bluesky`}
                      >
                        {avatar ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img
                            src={avatar}
                            alt=""
                            referrerPolicy="no-referrer"
                            loading="lazy"
                          />
                        ) : (
                          <span className="cur-post-avatar-fallback" aria-hidden>
                            {(displayName[0] || "?").toUpperCase()}
                          </span>
                        )}
                      </a>
                      <div className="cur-post-author">
                        <a
                          href={profileUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="cur-post-name"
                        >
                          {displayName}
                        </a>
                        <span className="cur-post-meta">
                          <a
                            href={profileUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="cur-post-handle"
                          >
                            {handleLabel}
                          </a>
                          <span className="cur-post-meta-sep" aria-hidden>·</span>
                          <time
                            className="cur-post-time"
                            dateTime={post.indexed_at}
                            title={formatAbsoluteTime(post.indexed_at)}
                          >
                            {formatRelativeTime(post.indexed_at)}
                          </time>
                        </span>
                      </div>
                    </header>

                    <div className="cur-post-card-body">{renderPostText(post.text)}</div>

                    {post.external_uri && (
                      <a
                        className={`cur-post-embed${post.external_thumb ? " has-thumb" : ""}`}
                        href={post.external_uri}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <div className="cur-post-embed-body">
                          <div className="cur-post-embed-host">{extHost || "link"}</div>
                          {post.external_title && (
                            <div className="cur-post-embed-title">{post.external_title}</div>
                          )}
                          {post.external_desc && (
                            <div className="cur-post-embed-desc">{post.external_desc}</div>
                          )}
                        </div>
                        {post.external_thumb && (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img
                            src={post.external_thumb}
                            alt=""
                            className="cur-post-embed-thumb"
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        )}
                      </a>
                    )}

                    {post.quote_uri && !post.external_uri && (
                      <a
                        className="cur-post-embed quote"
                        href={(() => {
                          const m = post.quote_uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
                          return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : "#";
                        })()}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <div className="cur-post-embed-host">↳ quoted post</div>
                        <div className="cur-post-embed-desc">Open on Bluesky to view the quoted post.</div>
                      </a>
                    )}

                    {post.has_images && post.image_urls.length > 0 && (
                      <div className="cur-post-images-wrap">
                        {aiLabels[post.uri]?.ai_generated && (
                          <span className="cur-ai-label">AI Generated</span>
                        )}
                        <div className={`cur-post-images cur-post-images-${Math.min(post.image_urls.length, 4)}`}>
                          {post.image_urls.slice(0, 4).map((url, i) => (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img
                              key={i}
                              src={url}
                              alt={post.image_alts[i] || ""}
                              className="cur-post-img"
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              onClick={() => setLightbox({ urls: post.image_urls, index: i })}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                    {post.has_images && post.image_urls.length === 0 && post.image_count > 0 && (
                      <div className="cur-post-images-note">
                        {post.image_count} image{post.image_count === 1 ? "" : "s"}
                      </div>
                    )}

                    {showDebug && (
                      <div className="cur-post-debug cur-post-debug-card">
                        <span className="cur-post-debug-row">
                          <span className="cur-post-debug-label">vec</span>
                          <span>{(post.score * 100).toFixed(1)}%</span>
                          {typeof post.rerank_score === "number" && (
                            <>
                              <span className="cur-post-debug-label">rr</span>
                              <span>{post.rerank_score}</span>
                            </>
                          )}
                        </span>
                        {post.rerank_reason && (
                          <span className="cur-post-debug-reason">
                            &ldquo;{post.rerank_reason}&rdquo;
                          </span>
                        )}
                      </div>
                    )}

                    {renderEngageFooter(post, bskyUrl)}
                  </article>
                    {branchZone(post.uri)}
                  </div>
                );
              })
            )}
            {posts.length > 0 && !postsLoading && (
              <div className="cur-feed-end-prompt">
                <p className="cur-feed-end-title">You&rsquo;ve reached the end</p>
                <p className="cur-feed-end-sub">Like what you see? Take your feed to Bluesky.</p>
                <div className="cur-feed-end-actions">
                  <button
                    type="button"
                    className="cur-feed-end-btn cur-feed-end-publish"
                    onClick={openPublish}
                  >
                    Publish to Bluesky
                  </button>
                  <button
                    type="button"
                    className="cur-feed-end-btn cur-feed-end-refresh"
                    onClick={() => {
                      document.querySelector('.cur-feed-posts')?.scrollTo({ top: 0 });
                      setTimeout(() => loadPosts(feedId, { force: true }), 50);
                    }}
                  >
                    Refresh feed
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* WORKBENCH RESIZER */}
        <div
          className="cur-resizer cur-resizer-workbench"
          onPointerDown={startRightDrag}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize right pane"
        />

        {/* CHAT PANE (right, when rightPane === "chat") */}
        <div className="cur-chat-pane" style={{ ["--cur-right-w" as string]: `${rightWidth}px` }}>
          <div className="cur-right-toggle" role="tablist" aria-label="Workbench mode">
            <button
              type="button"
              role="tab"
              aria-selected={rightPane === "chat"}
              className={`cur-right-seg${rightPane === "chat" ? " active" : ""}`}
              onClick={() => setRightPane("chat")}
            >
              Chat
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rightPane === "tune"}
              className={`cur-right-seg${rightPane === "tune" ? " active" : ""}`}
              onClick={() => setRightPane("tune")}
            >
              Tune
            </button>
          </div>
          <div className="cur-chat-area">
            <div className="cur-chat-inner">
              {sourcePost && (
                <div className="cur-branch-source">
                  <div className="cur-branch-source-label">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <circle cx="6" cy="6" r="2.5" />
                      <circle cx="6" cy="18" r="2.5" />
                      <circle cx="18" cy="9" r="2.5" />
                      <path d="M6 8.5v7" />
                      <path d="M6 14c0-3 1.5-5 5-5h4.5" />
                    </svg>
                    Branched from this post
                  </div>
                  {viewMode === "embed" ? (
                    <BlueskyEmbed
                      uri={sourcePost.uri}
                      text={sourcePost.text}
                      url={sourcePost.bsky_url}
                    />
                  ) : (
                    <a
                      className="cur-branch-source-card"
                      href={sourcePost.bsky_url ?? undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <div className="cur-branch-source-author">
                        {sourcePost.author_display_name?.trim() ||
                          (sourcePost.author_handle ? `@${sourcePost.author_handle}` : "Unknown")}
                        {sourcePost.author_handle && sourcePost.author_display_name?.trim() && (
                          <span className="cur-branch-source-handle">@{sourcePost.author_handle}</span>
                        )}
                      </div>
                      <div className="cur-branch-source-text">{sourcePost.text}</div>
                    </a>
                  )}
                </div>
              )}
              {messages.length === 0 && !sourcePost && !chatLoading && !loading && (
                <div className="cur-empty">
                  <p>Describe your ideal feed</p>
                  <p className="sub">a topic you&rsquo;re interested in, hobbies, etc.</p>
                </div>
              )}
              {messages.map((msg, i) => {
                const isUser = msg.role === "user";
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
                      </div>
                    )}
                  </div>
                );
              })}
              {(loading || chatLoading) && (
                <div className="cur-dots"><span /><span /><span /></div>
              )}

              <div ref={endRef} />
            </div>
          </div>

          <div className="cur-input-bar">
            {lastParsed?.options.length ? (
              <div className="cur-pinned-options">
                {lastParsed.options.map((opt) => {
                  const checked = selectedOptions.has(opt.key);
                  const interactive = !loading;
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
            ) : null}
            {!hasCriteria && (
              <div className="cur-mode-row">
                {lastParsed?.options.length ? (
                  <>
                    <button
                      type="button"
                      className="cur-mode-toggle is-active"
                      onClick={cancelQuestions}
                      disabled={loading}
                    >
                      ✕ Cancel questions
                    </button>
                    <span className="cur-mode-hint">
                      go back to free-form chat
                    </span>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="cur-mode-toggle"
                      onClick={askForQuestions}
                      disabled={loading}
                    >
                      ✦ Help me build my prompt
                    </button>
                  </>
                )}
              </div>
            )}
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
        </div>

        {/* TUNE PANEL (right, when rightPane === "tune") */}
        <FilterPanel
          mechanicalFilters={mechanicalFilters || ({} as MechanicalFilters)}
          subqueries={subqueries}
          candidateBudget={candidateBudget}
          rerankPrompt={rerankPrompt}
          rerankModel={rerankModel}
          rerankThinkingEnabled={rerankThinkingEnabled}
          onMechanicalChange={saveMechanicalFilters}
          onSubqueriesChange={saveSubqueries}
          onCandidateBudgetChange={saveCandidateBudget}
          onRerankModelChange={saveRerankModel}
          onRerankThinkingChange={saveRerankThinkingEnabled}
          postCount={postCount}
          rightPane={rightPane}
          onRightPaneChange={setRightPane}
          style={{ ["--cur-right-w" as string]: `${rightWidth}px` }}
        />
      </div>

      {/* Image lightbox */}
      {lightbox && (
        <div className="cur-lightbox" onClick={() => setLightbox(null)}>
          <button
            className="cur-lightbox-close"
            onClick={() => setLightbox(null)}
            aria-label="Close lightbox"
          >
            ✕
          </button>
          {lightbox.urls.length > 1 && (
            <>
              <button
                className="cur-lightbox-nav cur-lightbox-prev"
                aria-label="Previous image"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightbox((lb) =>
                    lb ? { ...lb, index: (lb.index - 1 + lb.urls.length) % lb.urls.length } : null
                  );
                }}
              >
                ‹
              </button>
              <button
                className="cur-lightbox-nav cur-lightbox-next"
                aria-label="Next image"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightbox((lb) =>
                    lb ? { ...lb, index: (lb.index + 1) % lb.urls.length } : null
                  );
                }}
              >
                ›
              </button>
            </>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox.urls[lightbox.index]}
            alt=""
            className="cur-lightbox-img"
            referrerPolicy="no-referrer"
            onClick={(e) => e.stopPropagation()}
          />
          {lightbox.urls.length > 1 && (
            <div className="cur-lightbox-counter">
              {lightbox.index + 1} / {lightbox.urls.length}
            </div>
          )}
        </div>
      )}
      {composer && (
        <div className="cur-bsky-auth-overlay" onClick={() => !composerPending && setComposer(null)}>
          <div className="cur-bsky-auth-modal cur-compose-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{composer.kind === "reply" ? "Reply on Bluesky" : "Quote on Bluesky"}</h3>
            <p>
              {composer.kind === "reply"
                ? "Your reply will be posted to Bluesky from your connected account."
                : "Add your commentary — the original post will be embedded in your quote."}
            </p>
            <textarea
              value={composerText}
              onChange={(e) => {
                setComposerText(e.target.value.slice(0, 300));
                setComposerError("");
              }}
              placeholder={composer.kind === "reply" ? "Write a reply…" : "Add a quote comment…"}
              rows={4}
              autoFocus
              className="cur-compose-textarea"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submitComposer();
                }
              }}
            />
            <div className="cur-compose-meta">
              <span>{composerText.length}/300</span>
            </div>
            {composerError && <div className="cur-bsky-auth-error">{composerError}</div>}
            <div className="cur-bsky-auth-actions">
              <button
                type="button"
                className="cur-bsky-auth-cancel"
                onClick={() => setComposer(null)}
                disabled={composerPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cur-bsky-auth-submit"
                onClick={submitComposer}
                disabled={composerPending || !composerText.trim()}
              >
                {composerPending ? "Posting…" : composer.kind === "reply" ? "Reply" : "Quote"}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Bluesky auth prompt */}
      {showBskyAuth && (
        <div className="cur-bsky-auth-overlay" onClick={() => setShowBskyAuth(false)}>
          <div className="cur-bsky-auth-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Sign in with Bluesky</h3>
            <p>Connect your Bluesky account to reply, repost, quote, and like from here.</p>
            <input
              type="text"
              value={bskyHandle}
              onChange={(e) => { setBskyHandle(e.target.value); setBskyAuthError(""); }}
              placeholder="yourname.bsky.social"
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") startBskyAuth(); }}
              className="cur-bsky-auth-input"
            />
            {bskyAuthError && <div className="cur-bsky-auth-error">{bskyAuthError}</div>}
            <div className="cur-bsky-auth-actions">
              <button className="cur-bsky-auth-cancel" onClick={() => setShowBskyAuth(false)}>
                Cancel
              </button>
              <button
                className="cur-bsky-auth-submit"
                onClick={startBskyAuth}
                disabled={!bskyHandle.trim() || bskyAuthLoading}
              >
                {bskyAuthLoading ? "Redirecting\u2026" : "Sign in"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
