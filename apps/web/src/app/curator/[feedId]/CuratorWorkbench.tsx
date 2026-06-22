"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Script from "next/script";
import SwipeableCard, { type SwipeVerdict } from "@/components/SwipeableCard";
import SwipeFollowupCard from "@/components/SwipeFollowupCard";
import BranchTopicsHeader from "@/components/BranchTopicsHeader";
import MockBranchOverlay from "@/components/MockBranchOverlay";
import "../swipe-card.css";

// Passed across client-side navigations so the destination branch feed can
// show the full set of topic chips without an extra round-trip.
let incomingBranchOptions: import("@/lib/branch").BranchOption[] | null = null;

// When the user right-swipes to create a branch feed, we snapshot the parent
// feed's posts here so the component can restore them instantly on back
// navigation — avoiding the blank-then-load flash.
let parentFeedSnapshot: { feedId: string | number; posts: unknown[] } | null = null;
import FilterPanel from "@/components/FilterPanel";
import SendButton from "@/components/SendButton";
import PipelineLoader, { type PipelineStage } from "@/components/PipelineLoader";
import { authedFetch } from "@/lib/authed-fetch";
import type { MechanicalFilters } from "@/lib/types";
import {
  DEFAULT_CANDIDATE_BUDGET,
  DEFAULT_RERANK_MODEL,
  DEFAULT_ENGAGEMENT_WEIGHT,
  DEFAULT_RECENCY_WEIGHT,
  DEFAULT_RECENCY_HALFLIFE_H,
} from "@/lib/defaults";
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
  has_video: boolean;
  image_count: number;
  image_alts: string[];
  image_urls: string[];
  video_thumbnail: string | null;
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

// Branch overlay timing — keep in sync with the CSS animation durations in
// .cur-mock-branch-in (BRANCH_OVERLAY_OPEN_MS) and .cur-mock-branch-out (in
// MockBranchOverlay.tsx BRANCH_OVERLAY_CLOSE_MS).
const BRANCH_CARD_EXIT_MS = 140;   // time for the card to clear the frame before overlay appears
const BRANCH_OVERLAY_OPEN_MS = 380; // matches .cur-mock-branch-in animation duration

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

// A swipe sends a user message prefixed with ⟦swipe:<verdict>:<uri>⟧ so the
// chat can render the reacted-to post as a card (instead of the raw text the
// agent reads). Author + snippet are parsed from the body as a reload-safe
// fallback when the in-session post cache is gone.
function parseSwipeMessage(content: string): {
  verdict: "approve" | "reject";
  uri: string;
  displayName: string | null;
  text: string | null;
} | null {
  const m = content.match(/^\u27e6swipe:(approve|reject):(.+?)\u27e7\s*(.*)$/s);
  if (!m) return null;
  const body = m[3];
  const b = body.match(/ by (.+?): "([\s\S]*?)"\./);
  return {
    verdict: m[1] as "approve" | "reject",
    uri: m[2],
    displayName: b ? b[1] : null,
    text: b ? b[2] : null,
  };
}

function bskyUrlFromUri(uri: string): string | undefined {
  const m = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : undefined;
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
    setMobileTab,
    setOptionsUnread,
    viewMode,
    showDebug,
    hideUnavailable,
    setUnavailableCount,
    openPublish,
    registerOpenTune,
    setPipelineStage,
    setPipelineCandidates,
    setPipelineHits,
    setPipelineImages,
    setPipelineModel,
    setPipelineThinkingEnabled,
    setPipelineSeenFiltered,
    setBranchOverlayName,
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

  // Pull-to-refresh (mobile): drag down from the top of the feed to re-query,
  // with rubber-band resistance and a springy snap-back. Replaces the toolbar
  // Refresh button on small screens.
  const feedPaneRef = useRef<HTMLDivElement | null>(null);
  const ptrSpinnerRef = useRef<HTMLDivElement | null>(null);
  const ptrRefreshingRef = useRef(false);
  const [ptrRefreshing, setPtrRefreshing] = useState(false);

  // Register the openTune callback so the top-bar tune icon can switch to the
  // tune pane from outside the workbench (especially on mobile).
  useEffect(() => {
    registerOpenTune(() => {
      setRightPane("tune");
      setMobileTab("chat");
    });
    return () => registerOpenTune(() => {});
  }, [registerOpenTune, setMobileTab]);

  // On mobile the chat input bar is always pinned at the bottom of the screen
  // (it IS the box you see over the feed). Focusing it raises the frosted
  // chat overlay behind it — same input, no hand-off between two boxes.
  function openMobileChat() {
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches &&
      mobileTab !== "chat"
    ) {
      setMobileTab("chat");
      setOptionsUnread(false);
    }
  }

  // Interview mode is a hint to the agent for the *next* request only; the
  // agent picks up the pattern from history after that. Set true by the
  // "Help me build my prompt" button, false by "Cancel questions".
  const interviewModeRef = useRef(false);
  const [posts, setPosts] = useState<Post[]>([]);
  const [postCount, setPostCount] = useState(0);

  // Swipe-to-tune: cards in the feed can be dragged left (skip) or right
  // (keep). A swiped card is hidden and its context is pulled straight into the
  // main chat (the same one that opens from "Describe your ideal feed").
  const [swipedUris, setSwipedUris] = useState<Set<string>>(() => new Set());
  // Keyed by post URI: null = loading, array = done.
  const [followupTopics, setFollowupTopics] = useState<
    Map<string, BranchOption[] | null>
  >(() => new Map());
  // Right-swipe branch options (prefetched on first rightward drag).
  const [swipeRightTopics, setSwipeRightTopics] = useState<
    Map<string, BranchOption[] | null>
  >(() => new Map());
  // URI of card whose right-swipe is waiting for options before creating branch.
  const [branchPendingUri, setBranchPendingUri] = useState<string | null>(null);
  // Branch topic chips consumed once on mount by the destination branch feed.
  const [branchHeaderOptions] = useState<BranchOption[] | null>(() => {
    const opts = incomingBranchOptions;
    incomingBranchOptions = null;
    return opts;
  });
  // Set on first rightward drag. options=null means topics are still loading.
  const [pendingBranch, setPendingBranch] = useState<{
    post: Post;
    options: BranchOption[] | null;
    branchFeedId?: number;
    branchFeedName?: string;
  } | null>(null);
  // Ref to the rising panel so onRightProgress can drive it imperatively.
  const risingPanelRef = useRef<HTMLDivElement>(null);
  // Feed pane rect captured at first rightward drag; used to position the
  // fixed panel over exactly the feed column.
  const branchPanelRectRef = useRef<{ left: number; right: number; top: number } | null>(null);
  // Set to true when a right swipe commits so the drag callback stops
  // fighting the CSS spring-to-open animation.
  const branchCommittedRef = useRef(false);
  // Incremented per post URI when returning from the branch overlay — forces
  // SwipeableCard to re-mount with fresh x=0 state (invisible, overlay covers it).
  const [branchReturnKeys, setBranchReturnKeys] = useState<Map<string, number>>(() => new Map());
  // In-session lookup so swipe messages can render the reacted post as a card.
  const [swipedPostCache, setSwipedPostCache] = useState<
    Record<string, { displayName: string; handle: string | null; text: string }>
  >({});

  function authorLabel(post: Post): string {
    return (
      post.author_display_name?.trim() ||
      (post.author_handle ? `@${post.author_handle}` : "someone")
    );
  }

  function handleCardSwipe(post: Post, verdict: SwipeVerdict) {
    if (verdict === "reject") return;
    // Spring the panel open.
    branchCommittedRef.current = true;
    const el = risingPanelRef.current;
    if (el) {
      // Ensure the rect is applied (drag may not have started if topic fetch was slow).
      if (!branchPanelRectRef.current && feedPaneRef.current) {
        const r = feedPaneRef.current.getBoundingClientRect();
        branchPanelRectRef.current = { left: r.left, right: window.innerWidth - r.right, top: 0 };
        el.style.left = `${r.left}px`;
        el.style.right = `${window.innerWidth - r.right}px`;
        el.style.top = "var(--cur-header-h)";
        el.style.bottom = "0";
      }
      el.style.display = "block";
      el.style.transition = "transform 0.45s cubic-bezier(0.34, 1.4, 0.64, 1)";
      el.style.transform = "translateY(0)";
      setTimeout(() => { if (el) el.style.transition = ""; }, 450);
    }
    setTimeout(() => {
      setBranchReturnKeys((prev) => {
        const next = new Map(prev);
        next.set(post.uri, (prev.get(post.uri) ?? 0) + 1);
        return next;
      });
    }, BRANCH_CARD_EXIT_MS + 60);
    // If topics are ready, create the branch feed now; otherwise defer until they arrive.
    const options = swipeRightTopics.get(post.uri);
    if (Array.isArray(options) && options.length > 0) {
      void createBranchForOverlay(post, options);
    } else {
      setBranchPendingUri(post.uri);
    }
  }

  function fetchSwipeRightTopics(post: Post) {
    if (swipeRightTopics.has(post.uri)) return;
    setSwipeRightTopics((prev) => { const next = new Map(prev); next.set(post.uri, null); return next; });
    void authedFetch("/api/branch/options", {
      method: "POST",
      body: JSON.stringify({ feedId, postUri: post.uri }),
    })
      .then(async (res) => {
        const d = await res.json();
        const topics: BranchOption[] = Array.isArray(d.options) ? d.options : [];
        setSwipeRightTopics((prev) => { const next = new Map(prev); next.set(post.uri, topics); return next; });
      })
      .catch(() => {
        setSwipeRightTopics((prev) => { const next = new Map(prev); next.set(post.uri, []); return next; });
      });
  }

  // Creates the branch feed in the background and updates pendingBranch with
  // the new feedId so the panel can load real posts. Does NOT navigate.
  async function createBranchForOverlay(post: Post, options: BranchOption[]) {
    const effective: BranchOption[] = options.length > 0 ? options : [{
      kind: "deeper",
      label: post.text.slice(0, 40).trim() || "this topic",
      subquery: post.text.replace(/\s+/g, " ").trim().slice(0, 200),
    }];
    try {
      const res = await authedFetch("/api/feeds/branch", {
        method: "POST",
        body: JSON.stringify({
          parentFeedId: feedId,
          sourcePostUri: post.uri,
          subqueries: effective.map((o) => o.subquery),
          labels: effective.map((o) => o.label),
        }),
      });
      const d = await res.json();
      if (d.feed?.id) {
        reloadFeeds();
        setPendingBranch((prev) => prev ? { ...prev, branchFeedId: d.feed.id, branchFeedName: d.feed.name } : prev);
      }
    } catch { /* panel still shows topics; posts can be loaded on retry */ }
  }

  async function createBranchFromSwipe(_post: Post, _options: BranchOption[]) {
    // TODO: uncomment when re-enabling real branch creation:
    // const effective: BranchOption[] = options.length > 0 ? options : [{
    //   kind: "deeper",
    //   label: post.text.slice(0, 40).trim() || "this topic",
    //   subquery: post.text.replace(/\s+/g, " ").trim().slice(0, 200),
    // }];
    // setSwipedUris((prev) => { const next = new Set(prev); next.add(post.uri); return next; });
    // try {
    //   const res = await authedFetch("/api/feeds/branch", {
    //     method: "POST",
    //     body: JSON.stringify({
    //       parentFeedId: feedId,
    //       sourcePostUri: post.uri,
    //       subqueries: effective.map((o) => o.subquery),
    //       labels: effective.map((o) => o.label),
    //     }),
    //   });
    //   const d = await res.json();
    //   if (d.feed?.id) {
    //     incomingBranchOptions = effective;
    //     parentFeedSnapshot = { feedId, posts: postsRef.current };
    //     reloadFeeds();
    //     router.push(`/curator/${d.feed.id}`);
    //   }
    // } catch { /* user can retry via branch button */ }
  }

  // When topics arrive, update the panel's topic chips and (if a swipe committed
  // before topics were ready) kick off branch feed creation.
  useEffect(() => {
    if (!pendingBranch) return;
    const uri = pendingBranch.post.uri;
    const topics = swipeRightTopics.get(uri);
    if (!Array.isArray(topics) || topics.length === 0) return;
    // Update panel chips if still loading.
    if (pendingBranch.options === null) {
      setPendingBranch((prev) => prev ? { ...prev, options: topics } : prev);
    }
    // Trigger deferred branch creation if the swipe already committed.
    if (branchPendingUri === uri) {
      setBranchPendingUri(null);
      void createBranchForOverlay(pendingBranch.post, topics);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swipeRightTopics]);

  // Legacy pending-branch effect (kept for the commented-out navigation path).
  useEffect(() => {
    if (!branchPendingUri) return;
    const options = swipeRightTopics.get(branchPendingUri);
    if (!Array.isArray(options)) return;
    const post = posts.find((p) => p.uri === branchPendingUri);
    if (!post) return;
    setBranchPendingUri(null);
    void createBranchFromSwipe(post, options);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swipeRightTopics, branchPendingUri]);

  function fetchFollowupTopics(post: Post) {
    // Kick off once on the first leftward drag for this card.
    if (followupTopics.has(post.uri)) return;
    setFollowupTopics((prev) => { const next = new Map(prev); next.set(post.uri, null); return next; });
    void authedFetch("/api/branch/options", {
      method: "POST",
      body: JSON.stringify({ feedId, postUri: post.uri }),
    })
      .then(async (res) => {
        const d = await res.json();
        const topics: BranchOption[] = Array.isArray(d.options)
          ? (d.options as BranchOption[]).filter((o) => o.kind === "deeper")
          : [];
        setFollowupTopics((prev) => { const next = new Map(prev); next.set(post.uri, topics); return next; });
      })
      .catch(() => {
        setFollowupTopics((prev) => { const next = new Map(prev); next.set(post.uri, []); return next; });
      });
  }

  function sendFollowupMessage(post: Post, reason: string) {
    const token = `\u27e6swipe:reject:${post.uri}\u27e7`;
    setSwipedPostCache((prev) => ({
      ...prev,
      [post.uri]: {
        displayName:
          post.author_display_name?.trim() ||
          post.author_handle ||
          post.author_did.slice(0, 16) + "\u2026",
        handle: post.author_handle,
        text: post.text,
      },
    }));
    void send(`${token} ${reason} Update my feed to show less of this.`);
  }

  function handleFollowupChipSend(post: Post, reason: string) {
    sendFollowupMessage(post, reason);
    setSwipedUris((prev) => { const next = new Set(prev); next.add(post.uri); return next; });
  }

  function handleFollowupTextSend(post: Post, reason: string) {
    sendFollowupMessage(post, reason);
  }

  function handleFollowupDismiss(uri: string) {
    setSwipedUris((prev) => { const next = new Set(prev); next.add(uri); return next; });
  }
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

  // Fetch AI-generated labels for posts with images or video
  useEffect(() => {
    if (posts.length === 0) return;
    const mediaPosts = posts.filter(
      (p) => (p.has_images && p.image_urls.length > 0) || (p.has_video && p.video_thumbnail)
    );
    if (mediaPosts.length === 0) return;
    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        mediaPosts.map(async (p) => {
          try {
            const params = new URLSearchParams({ uri: p.uri });
            if (p.image_urls.length > 0) {
              params.set("image_urls", p.image_urls.join(","));
            }
            if (p.has_video && p.video_thumbnail) {
              params.set("video_thumbnail", p.video_thumbnail);
            }
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
  const [repostState, setRepostState] = useState<Record<string, { reposted: boolean; repostUri?: string; pending: boolean }>>({});
  const [countDelta, setCountDelta] = useState<
    Record<string, { replies?: number; quotes?: number }>
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

  async function toggleRepost(postUri: string, currentlyReposted: boolean, currentRepostUri?: string) {
    if (!ensureBskyAuth()) return;
    const prev = repostState[postUri];
    // Optimistic update
    setRepostState((s) => ({
      ...s,
      [postUri]: { reposted: !currentlyReposted, repostUri: currentlyReposted ? undefined : currentRepostUri, pending: true },
    }));
    try {
      const res = await authedFetch("/api/bsky/repost", {
        method: "POST",
        body: JSON.stringify({
          uri: postUri,
          action: currentlyReposted ? "unrepost" : "repost",
          ...(currentlyReposted && currentRepostUri ? { repostUri: currentRepostUri } : {}),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setRepostState((s) => ({
          ...s,
          [postUri]: { reposted: !currentlyReposted, repostUri: data.repostUri, pending: false },
        }));
      } else {
        // Revert on failure
        setRepostState((s) => ({ ...s, [postUri]: prev ?? { reposted: currentlyReposted, repostUri: currentRepostUri, pending: false } }));
      }
    } catch {
      setRepostState((s) => ({ ...s, [postUri]: prev ?? { reposted: currentlyReposted, repostUri: currentRepostUri, pending: false } }));
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
          onClick={() => openComposer(post.uri, "reply")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
          {formatCount(post.reply_count + (countDelta[post.uri]?.replies ?? 0))}
        </button>
        <button
          type="button"
          className={`cur-post-stat cur-post-engage-btn${repostState[post.uri]?.reposted ? " cur-post-reposted" : ""}`}
          title={repostState[post.uri]?.reposted ? "Undo repost" : "Repost"}
          disabled={repostState[post.uri]?.pending}
          onClick={() => toggleRepost(post.uri, !!repostState[post.uri]?.reposted, repostState[post.uri]?.repostUri)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="17 1 21 5 17 9" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <polyline points="7 23 3 19 7 15" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
          {formatCount(post.repost_count + (repostState[post.uri]?.reposted ? 1 : 0))}
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
  const [chatLoading, setChatLoading] = useState(false);
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set());
  const [mechanicalFilters, setMechanicalFilters] = useState<MechanicalFilters | null>(null);
  const [subqueries, setSubqueries] = useState<string[]>([]);
  const [candidateBudget, setCandidateBudget] = useState<number>(DEFAULT_CANDIDATE_BUDGET);
  const [rerankPrompt, setRerankPrompt] = useState<string>("");
  const [rerankModel, setRerankModel] = useState<string>(DEFAULT_RERANK_MODEL);
  const [rerankThinkingEnabled, setRerankThinkingEnabled] = useState<boolean>(false);
  const [engagementWeight, setEngagementWeight] = useState<number>(DEFAULT_ENGAGEMENT_WEIGHT);
  const [recencyWeight, setRecencyWeight] = useState<number>(DEFAULT_RECENCY_WEIGHT);
  const [recencyHalflifeH, setRecencyHalflifeH] = useState<number>(DEFAULT_RECENCY_HALFLIFE_H);
  const [seenFilterEnabled, setSeenFilterEnabled] = useState<boolean>(false);

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
    engagement_weight?: number;
    recency_weight?: number;
    recency_halflife_h?: number;
  }): string {
    return JSON.stringify({
      s: f.subqueries ?? [],
      m: f.mechanical_filters ?? null,
      b: f.candidate_budget ?? null,
      r: f.rerank_prompt ?? "",
      // Ranking-bias weights reorder the snapshot, so a change must re-query.
      ew: f.engagement_weight ?? null,
      rw: f.recency_weight ?? null,
      rh: f.recency_halflife_h ?? null,
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
    engagement_weight?: number;
    recency_weight?: number;
    recency_halflife_h?: number;
    seen_filter_enabled?: boolean;
  }) {
    if (patch.mechanical_filters) setMechanicalFilters(patch.mechanical_filters);
    if (patch.subqueries) setSubqueries(patch.subqueries);
    if (patch.candidate_budget !== undefined) setCandidateBudget(patch.candidate_budget);
    if (patch.rerank_model) setRerankModel(patch.rerank_model);
    if (patch.rerank_thinking_enabled !== undefined) setRerankThinkingEnabled(patch.rerank_thinking_enabled);
    if (patch.engagement_weight !== undefined) setEngagementWeight(patch.engagement_weight);
    if (patch.recency_weight !== undefined) setRecencyWeight(patch.recency_weight);
    if (patch.recency_halflife_h !== undefined) setRecencyHalflifeH(patch.recency_halflife_h);
    if (patch.seen_filter_enabled !== undefined) setSeenFilterEnabled(patch.seen_filter_enabled);
    feedSignatureRef.current = feedSignature({
      subqueries: patch.subqueries ?? subqueries,
      mechanical_filters: patch.mechanical_filters ?? mechanicalFilters ?? undefined,
      candidate_budget: patch.candidate_budget ?? candidateBudget,
      rerank_prompt: rerankPrompt,
      engagement_weight: patch.engagement_weight ?? engagementWeight,
      recency_weight: patch.recency_weight ?? recencyWeight,
      recency_halflife_h: patch.recency_halflife_h ?? recencyHalflifeH,
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
  const saveEngagementWeight = (n: number) => patchFeed({ engagement_weight: n });
  const saveRecencyWeight = (n: number) => patchFeed({ recency_weight: n });
  const saveRecencyHalflife = (n: number) => patchFeed({ recency_halflife_h: n });
  const saveSeenFilterEnabled = (v: boolean) => patchFeed({ seen_filter_enabled: v });


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
        if (typeof f.engagement_weight === "number") setEngagementWeight(f.engagement_weight);
        if (typeof f.recency_weight === "number") setRecencyWeight(f.recency_weight);
        if (typeof f.recency_halflife_h === "number") setRecencyHalflifeH(f.recency_halflife_h);
        if (typeof f.seen_filter_enabled === "boolean") setSeenFilterEnabled(f.seen_filter_enabled);
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
    setPipelineSeenFiltered(undefined);
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
              seen_filtered?: number;
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
              if (typeof ev.seen_filtered === "number") setPipelineSeenFiltered(ev.seen_filtered);
              const nextCount = ev.total_stored || (ev.posts?.length ?? 0);
              const incoming = ev.posts || [];
              // The "done" event carries the full recomputed snapshot in its
              // final reranked+blended order, so replace outright. Appending
              // (merging by URI) would hide the reordering — and any dropped
              // posts — on Refresh and after a weight edit, which is the whole
              // point of the preview.
              setPosts(incoming);
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
      // If we navigated back from a branch feed, restore the snapshotted posts
      // immediately so the View Transitions animation shows a fully-populated feed.
      const snap = parentFeedSnapshot;
      if (snap && String(snap.feedId) === String(feedId)) {
        parentFeedSnapshot = null;
        setPosts(snap.posts as Post[]);
        setPostsLoading(false);
        await loadChat(feedId);
        return;
      }
      const chat = await loadChat(feedId);
      void loadPosts(feedId);
      const isFreshBranch = !!chat.sourcePost && chat.messages.length === 0;
    }, 0);
    return () => clearTimeout(t);
  }, [feedId, loadChat, loadPosts]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // Sync ref so createBranchFromSwipe (and the snapshot cleanup) can read
  // posts without stale closures.
  const postsRef = useRef<Post[]>([]);
  useEffect(() => { postsRef.current = posts; }, [posts]);

  // Whenever the user navigates away from this feed, snapshot its posts so
  // navigating back (via router.back() or sidebar) restores them instantly.
  useEffect(() => {
    return () => {
      if (postsRef.current.length > 0) {
        parentFeedSnapshot = { feedId, posts: postsRef.current };
      }
    };
  // feedId is stable for the lifetime of this effect — the dep is intentional.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedId]);

  // Drives the rising panel position from the card's drag progress.
  // Stable (no deps): reads only from refs so the motion event never captures a stale closure.
  const handleRightProgress = useCallback((t: number) => {
    if (branchCommittedRef.current) return;
    const el = risingPanelRef.current;
    if (!el) return;
    if (t <= 0) {
      el.style.display = "none";
      branchPanelRectRef.current = null;
      return;
    }
    // On first rightward motion, lock in the feed column's horizontal extent.
    // Use var(--cur-header-h) for top — always below the topbar regardless of
    // how far the document has scrolled (getBoundingClientRect().top goes
    // negative on mobile when the document scrolls, which breaks the animation).
    if (!branchPanelRectRef.current && feedPaneRef.current) {
      const r = feedPaneRef.current.getBoundingClientRect();
      branchPanelRectRef.current = { left: r.left, right: window.innerWidth - r.right, top: 0 };
      el.style.left = `${r.left}px`;
      el.style.right = `${window.innerWidth - r.right}px`;
      el.style.top = "var(--cur-header-h)";
      el.style.bottom = "0";
    }
    el.style.display = "block";
    const eased = 1 - Math.pow(1 - t, 2);
    el.style.transform = `translateY(${(1 - eased) * 100}vh)`;
  }, []);

  // TODO: re-enable prefetch once rate limits allow.
  // const prefetchedRef = useRef(new Set<string>());
  // useEffect(() => {
  //   if (posts.length === 0) return;
  //   posts.forEach((post, i) => {
  //     if (prefetchedRef.current.has(post.uri)) return;
  //     prefetchedRef.current.add(post.uri);
  //     setTimeout(() => fetchSwipeRightTopics(post), i * 200);
  //   });
  // // eslint-disable-next-line react-hooks/exhaustive-deps
  // }, [posts]);


  // Pull-to-refresh gesture wiring (mobile only). Tracks a downward drag that
  // starts with the page at the top, rubber-bands the pane, and on release
  // past the threshold fires a forced reload; everything springs back when
  // it's done. On mobile the document is the scroller (so Safari's URL bar
  // collapses on scroll) — the pane itself never scrolls, so the at-top
  // check reads window.scrollY, not pane.scrollTop.
  useEffect(() => {
    const pane = feedPaneRef.current;
    const spin = ptrSpinnerRef.current;
    if (!pane || !spin) return;
    if (!window.matchMedia("(max-width: 767px)").matches) return;

    const THRESHOLD = 58; // post-resistance px needed to trigger
    const MAX = 110;
    const HOLD = 52; // pane offset held while refreshing
    const SPRING = "transform 0.5s cubic-bezier(0.2, 1.4, 0.4, 1)";
    // Keep the pane's CSS filter transition (chat-overlay gaussian blur)
    // alive while we drive transform inline.
    const FILTER_T = "filter 0.42s cubic-bezier(0.65, 0, 0.35, 1)";
    let startY = -1;
    let startX = -1;
    let axisLock: "none" | "horizontal" | "vertical" = "none";
    let pull = 0;
    let active = false;

    const paint = (px: number, spring: boolean) => {
      pane.style.transition = `${spring ? SPRING : "transform 0s"}, ${FILTER_T}`;
      pane.style.transform = px > 0 ? `translateY(${px}px)` : "";
      spin.style.transition = spring
        ? `${SPRING}, opacity 0.25s ease`
        : "opacity 0.15s ease";
      spin.style.opacity = px > 6 ? String(Math.min(1, px / THRESHOLD)) : "0";
      spin.style.transform =
        `translate(-50%, ${px * 0.7}px) rotate(${px * 2.6}deg) ` +
        `scale(${Math.min(1, 0.6 + (px / THRESHOLD) * 0.4)})`;
    };

    // <= 0: iOS reports negative scrollY mid rubber-band.
    const atTop = () => window.scrollY <= 0;

    const onStart = (e: TouchEvent) => {
      if (ptrRefreshingRef.current || !atTop()) {
        startY = -1;
        return;
      }
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      axisLock = "none";
      active = false;
      pull = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (startY < 0 || ptrRefreshingRef.current) return;
      const dy = e.touches[0].clientY - startY;
      // Lock the gesture to an axis on first meaningful movement. A
      // horizontal-dominant gesture is a card swipe (handled by framer-motion),
      // so bail out and never claim it for pull-to-refresh.
      if (axisLock === "none") {
        const dx = e.touches[0].clientX - startX;
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
          axisLock = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
        }
      }
      if (axisLock === "horizontal") return;
      if (dy <= 0 || !atTop()) {
        if (active) {
          active = false;
          paint(0, false);
        }
        return;
      }
      active = true;
      e.preventDefault(); // keep the browser from scrolling/native-refreshing
      pull = Math.min(dy * 0.45, MAX); // rubber-band resistance
      paint(pull, false);
    };
    const onEnd = () => {
      if (startY < 0) return;
      startY = -1;
      if (!active) return;
      active = false;
      if (pull >= THRESHOLD) {
        ptrRefreshingRef.current = true;
        setPtrRefreshing(true);
        paint(HOLD, true);
        spin.classList.add("spinning");
        loadPosts(feedId, { force: true });
      } else {
        paint(0, true);
      }
      pull = 0;
    };

    pane.addEventListener("touchstart", onStart, { passive: true });
    pane.addEventListener("touchmove", onMove, { passive: false });
    pane.addEventListener("touchend", onEnd, { passive: true });
    pane.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      pane.removeEventListener("touchstart", onStart);
      pane.removeEventListener("touchmove", onMove);
      pane.removeEventListener("touchend", onEnd);
      pane.removeEventListener("touchcancel", onEnd);
      pane.style.transform = "";
      pane.style.transition = "";
    };
  }, [feedId, loadPosts]);

  // When the forced reload finishes, spring the pane + spinner back.
  useEffect(() => {
    if (!ptrRefreshing || postsLoading) return;
    ptrRefreshingRef.current = false;
    setPtrRefreshing(false);
    const pane = feedPaneRef.current;
    const spin = ptrSpinnerRef.current;
    if (pane) {
      pane.style.transition =
        "transform 0.5s cubic-bezier(0.2, 1.4, 0.4, 1), filter 0.42s cubic-bezier(0.65, 0, 0.35, 1)";
      pane.style.transform = "";
    }
    if (spin) {
      spin.classList.remove("spinning");
      spin.style.opacity = "0";
      spin.style.transform = "translate(-50%, 0) scale(0.6)";
    }
  }, [ptrRefreshing, postsLoading]);

  // Re-scan Bluesky embeds when the visible post set changes.
  useEffect(() => {
    if (viewMode !== "embed") return;
    const scan = () => window.bluesky?.scan?.();
    scan();
    const t = setTimeout(scan, 300);
    return () => clearTimeout(t);
  }, [viewMode, posts, hideUnavailable, unavailableUris]);

  // Card view: hydrate quoted posts via the public AppView so the quote block
  // shows the actual quoted content (author + text), not just a link out.
  // null = fetch failed / post gone; undefined = not loaded yet.
  const [quotedPosts, setQuotedPosts] = useState<
    Record<string, { text: string; handle: string | null; displayName: string | null; avatar: string | null } | null>
  >({});
  useEffect(() => {
    if (viewMode !== "card") return;
    const missing = [
      ...new Set(
        posts
          .map((p) => p.quote_uri)
          .filter((u): u is string => !!u && quotedPosts[u] === undefined)
      ),
    ];
    if (missing.length === 0) return;

    const ac = new AbortController();
    (async () => {
      // app.bsky.feed.getPosts caps at 25 URIs per call
      for (let i = 0; i < missing.length; i += 25) {
        const batch = missing.slice(i, i + 25);
        const params = new URLSearchParams();
        for (const u of batch) params.append("uris", u);
        try {
          const res = await fetch(
            `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?${params}`,
            { signal: ac.signal }
          );
          const data = res.ok
            ? ((await res.json()) as {
                posts?: {
                  uri: string;
                  author?: { handle?: string; displayName?: string; avatar?: string };
                  record?: { text?: string };
                }[];
              })
            : { posts: [] };
          setQuotedPosts((prev) => {
            const next = { ...prev };
            for (const u of batch) next[u] = null; // default: unavailable
            for (const p of data.posts ?? []) {
              next[p.uri] = {
                text: p.record?.text ?? "",
                handle: p.author?.handle ?? null,
                displayName: p.author?.displayName ?? null,
                avatar: p.author?.avatar ?? null,
              };
            }
            return next;
          });
        } catch {
          if (ac.signal.aborted) return;
        }
      }
    })();
    return () => ac.abort();
  }, [viewMode, posts, quotedPosts]);

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

  // Branch affordance: a small icon button pinned to the card's top-right.
  // Clicking it floods the card with an overlay (clip-path circle expanding
  // from the button corner) that lists the potential branch directions.
  function branchZone(postUri: string) {
    const open = branchPanelUri === postUri;
    return (
      <>
        <button
          type="button"
          className={`cur-post-branch-fab${open ? " active" : ""}`}
          onClick={() => openBranch(postUri)}
          title="Explore branches from this post"
          aria-label="Explore branches from this post"
          aria-expanded={open}
        >
          {open ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="5" r="2.2" />
              <path d="M12 7v4" />
              <path d="M12 11 C 12 15, 6 14, 5.5 18.5" />
              <path d="M12 11 V 18.5" />
              <path d="M12 11 C 12 15, 18 14, 18.5 18.5" />
            </svg>
          )}
        </button>
        {open && (
          <div className="cur-branch-overlay">
            <div className="cur-branch-overlay-head">Branch into a new feed</div>
            {branchOptionsLoading ? (
              <div className="cur-branch-status">
                Finding directions
                <span className="cur-dots-inline"><span /><span /><span /></span>
              </div>
            ) : branchOptions && branchOptions.length > 0 ? (
              <>
                <div className="cur-branch-overlay-grid">
                  {branchOptions.map((opt, i) => {
                    const checked = branchSelected.has(i);
                    const atCap = !checked && branchSelected.size >= MAX_BRANCH_TOPICS;
                    return (
                      <button
                        key={i}
                        type="button"
                        className={`cur-branch-chip${checked ? " selected" : ""}`}
                        data-kind={opt.kind}
                        style={{ ["--i" as string]: i }}
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
        )}
      </>
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
        {/* MOBILE: pull-to-refresh indicator (fixed under the topbar; the
            gesture lives on the feed pane below) */}
        <div className="cur-ptr-spinner" ref={ptrSpinnerRef} aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </div>

        {/* POSTS PANE (middle) */}
        <div className="cur-feed-posts" ref={feedPaneRef} style={{ position: "relative" }}>
          <div className={`cur-feed-posts-inner${feedRefreshing ? " refreshing" : ""}`}>
            {(() => {
              const thisFeed = feeds.find((f) => f.id === String(feedId));
              if (thisFeed?.isHome) return null;
              const homeFeed = feeds.find((f) => f.isHome);
              const parentId = thisFeed?.parentFeedId ?? homeFeed?.id;
              if (!parentId) return null;
              return (
                <button
                  type="button"
                  className="cur-branch-back"
                  onClick={() => router.push(`/curator/${parentId}`)}
                  aria-label="Back"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  Back
                </button>
              );
            })()}
            {branchHeaderOptions && (
              <BranchTopicsHeader options={branchHeaderOptions} />
            )}
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
                    {branchZone(post.uri)}
                  </div>
                  </div>
                );
              })
            ) : (
              posts.filter(post => !swipedUris.has(post.uri)).map((post) => {
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
                  <SwipeableCard
                    key={`${post.uri}-${branchReturnKeys.get(post.uri) ?? 0}`}
                    onSwipe={(v) => handleCardSwipe(post, v)}
                    onFirstLeftDrag={() => fetchFollowupTopics(post)}
                    onFirstRightDrag={() => {
                      const prefetched = swipeRightTopics.get(post.uri);
                      const options = Array.isArray(prefetched) && prefetched.length > 0
                        ? prefetched : null;
                      setPendingBranch({ post, options });
                      fetchSwipeRightTopics(post);
                    }}
                    onRightProgress={handleRightProgress}
                    followupContent={
                      <SwipeFollowupCard
                        post={post}
                        topics={followupTopics.get(post.uri)}
                        onChipSend={(reason) => handleFollowupChipSend(post, reason)}
                        onTextSend={(reason) => handleFollowupTextSend(post, reason)}
                        onDismiss={() => handleFollowupDismiss(post.uri)}
                      />
                    }
                  >
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

                    {post.quote_uri && !post.external_uri && (() => {
                      const q = quotedPosts[post.quote_uri];
                      const m = post.quote_uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
                      const qUrl = m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : "#";
                      return (
                        <a
                          className="cur-post-embed quote"
                          href={qUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {q ? (
                            <>
                              <div className="cur-post-quote-author">
                                {q.avatar && (
                                  /* eslint-disable-next-line @next/next/no-img-element */
                                  <img
                                    src={q.avatar}
                                    alt=""
                                    className="cur-post-quote-avatar"
                                    loading="lazy"
                                    referrerPolicy="no-referrer"
                                  />
                                )}
                                <span className="cur-post-quote-name">
                                  {q.displayName?.trim() || (q.handle ? `@${q.handle}` : "Quoted post")}
                                </span>
                                {q.handle && q.displayName?.trim() && (
                                  <span className="cur-post-quote-handle">@{q.handle}</span>
                                )}
                              </div>
                              {q.text && (
                                <div className="cur-post-quote-text">{q.text}</div>
                              )}
                            </>
                          ) : q === null ? (
                            <>
                              <div className="cur-post-embed-host">↳ quoted post</div>
                              <div className="cur-post-embed-desc">
                                Quoted post unavailable — open on Bluesky.
                              </div>
                            </>
                          ) : (
                            <div className="cur-post-embed-host">↳ quoted post…</div>
                          )}
                        </a>
                      );
                    })()}

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

                    {/* AI label for video-only posts (image posts show it in the images-wrap above) */}
                    {!post.has_images && post.has_video && aiLabels[post.uri]?.ai_generated && (
                      <span className="cur-ai-label">AI Generated</span>
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
                    {branchZone(post.uri)}
                  </article>
                  </SwipeableCard>
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
                      // Desktop scrolls the pane; mobile scrolls the document.
                      document.querySelector('.cur-feed-posts')?.scrollTo({ top: 0 });
                      window.scrollTo({ top: 0 });
                      setTimeout(() => loadPosts(feedId, { force: true }), 50);
                    }}
                  >
                    Refresh feed
                  </button>
                </div>
              </div>
            )}
          </div>
          {/* Rising branch panel — position:absolute inside cur-feed-posts so it
              covers only the feed column, not the sidebar, topbar, or chat pane.
              translateY(100vh) keeps it below the fold until onRightProgress
              drives it up. ALWAYS mounted so risingPanelRef is valid from the
              very first rightward drag pixel. */}
          <div
            ref={risingPanelRef}
            className="cur-branch-rising-panel"
            aria-hidden={!pendingBranch}
          >
            {pendingBranch && (
              <MockBranchOverlay
                options={pendingBranch.options}
                branchFeedId={pendingBranch.branchFeedId}
                feedName={pendingBranch.branchFeedName}
                panelRef={risingPanelRef}
                onBack={() => {
                  branchCommittedRef.current = false;
                  branchPanelRectRef.current = null;
                  const el = risingPanelRef.current;
                  if (el) { el.style.left = ""; el.style.right = ""; el.style.top = ""; el.style.bottom = ""; }
                  setPendingBranch(null);
                  setBranchOverlayName(null);
                  setPipelineStage("idle");
                  setActivePostCount(postCount);
                }}
              />
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
          {/* MOBILE: dismiss the chat — blur first so the keyboard drops,
              then the overlay fades down. Down-arrow at the top centre,
              like a sheet's pull-down affordance. Acts on pointer-down:
              when the iOS keyboard is collapsing, the viewport shift between
              touchstart and touchend makes Safari cancel the click, so an
              onClick handler intermittently never fires. */}
          <button
            type="button"
            className="cur-chat-close"
            aria-label="Close chat"
            onPointerDown={(e) => {
              e.preventDefault(); // don't steal focus / fire a ghost click
              inputRef.current?.blur();
              setRightPane("chat");
              setMobileTab("feed");
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
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
                const swipe = isUser ? parseSwipeMessage(msg.content) : null;
                const parsed = !isUser ? parseMessage(msg.content) : null;
                if (isUser && swipe) {
                  const cached = swipedPostCache[swipe.uri];
                  const name = cached?.displayName ?? swipe.displayName;
                  const handle = cached?.handle ?? null;
                  const text = cached?.text ?? swipe.text;
                  const url = bskyUrlFromUri(swipe.uri);
                  return (
                    <div key={i} className="cur-msg cur-swipe-card">
                      <span
                        className={`cur-swipe-card-tag cur-swipe-card-tag-${swipe.verdict}`}
                      >
                        {swipe.verdict === "approve"
                          ? "\u2713 More like this"
                          : "\u2715 Less like this"}
                      </span>
                      <a
                        className="cur-branch-source-card"
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <div className="cur-branch-source-author">
                          {name || "A post"}
                          {handle && (
                            <span className="cur-branch-source-handle">
                              @{handle}
                            </span>
                          )}
                        </div>
                        {text && (
                          <div className="cur-branch-source-text">{text}</div>
                        )}
                      </a>
                    </div>
                  );
                }
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
                openMobileChat();
                if (lastParsed?.options.length) submitChat();
                else send(input);
              }}
            >
              <textarea
                ref={inputRef}
                className={`cur-input${lastParsed?.options.length ? " cur-input-hint" : ""}`}
                rows={1}
                value={input}
                onFocus={openMobileChat}
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
              <SendButton
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
          engagementWeight={engagementWeight}
          recencyWeight={recencyWeight}
          recencyHalflifeH={recencyHalflifeH}
          seenFilterEnabled={seenFilterEnabled}
          onMechanicalChange={saveMechanicalFilters}
          onSubqueriesChange={saveSubqueries}
          onCandidateBudgetChange={saveCandidateBudget}
          onRerankModelChange={saveRerankModel}
          onRerankThinkingChange={saveRerankThinkingEnabled}
          onEngagementWeightChange={saveEngagementWeight}
          onRecencyWeightChange={saveRecencyWeight}
          onRecencyHalflifeChange={saveRecencyHalflife}
          onSeenFilterChange={saveSeenFilterEnabled}
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
