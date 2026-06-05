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
const RIGHT_MIN = 320;
const RIGHT_MAX = 720;

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
    feeds,
    reloadFeeds,
    setActivePostCount,
    mobileTab,
    setOptionsUnread,
    viewMode,
    showDebug,
    hideUnavailable,
    setUnavailableCount,
  } = useCurator();

  const [rightPane, setRightPane] = useState<"chat" | "tune">("chat");
  const [rightWidth, startRightDrag] = useResizable(
    RIGHT_W_KEY, 380, RIGHT_MIN, RIGHT_MAX, "right"
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
  const [postsLoading, setPostsLoading] = useState(false);
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


  const loadChat = useCallback(async (id: number) => {
    setChatLoading(true);
    try {
      const res = await authedFetch(`/api/chat?feedId=${id}`);
      const data = await res.json();
      const msgs: Message[] = data.messages || [];
      setSourcePost(data.sourcePost ?? null);
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
    } catch { /* ignore */ }
    finally {
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
    }
  }, [setActivePostCount]);

  // On mount (i.e. on feed switch via URL change), hydrate chat + posts.
  // Deferred a tick so the fetch kickoff (which flips loading flags) runs
  // outside the synchronous effect body, avoiding a cascading render.
  useEffect(() => {
    const t = setTimeout(() => {
      loadChat(feedId);
      loadPosts(feedId);
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
    const interview = interviewModeRef.current;
    // Interview flag is consumed once: after a single nudged turn, the model
    // picks up the question/options pattern from history on its own.
    interviewModeRef.current = false;
    try {
      const res = await authedFetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message: text.trim(), feedId, interview }),
      });
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
        }
      }
      const last = msgs[msgs.length - 1];
      if (last?.role === "assistant" && parseMessage(last.content).options.length > 0) {
        if (mobileTab !== "chat") setOptionsUnread(true);
      }
      if (d.done) {
        loadPosts(feedId);
        reloadFeeds();
      }
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "Something went wrong." }]);
    } finally { setLoading(false); }
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
        // The rerank prompt now exists → re-query so the feed is reranked.
        loadPosts(feedId);
      }
    } catch { /* ignore — user can still chat normally */ }
    finally { setLoading(false); }
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

  // Branch button + panel, shared by both the custom-card and embed views so
  // the affordance is identical in either mode.
  function branchButton(postUri: string) {
    return (
      <button
        type="button"
        className={`cur-post-branch${branchPanelUri === postUri ? " active" : ""}`}
        onClick={() => openBranch(postUri)}
        title="Branch into a new feed"
        aria-expanded={branchPanelUri === postUri}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="6" cy="18" r="2.5" />
          <circle cx="18" cy="9" r="2.5" />
          <path d="M6 8.5v7" />
          <path d="M6 14c0-3 1.5-5 5-5h4.5" />
        </svg>
        Branch
      </button>
    );
  }

  function branchPanel(postUri: string) {
    if (branchPanelUri !== postUri) return null;
    return (
      <div className="cur-branch-panel">
        {branchOptionsLoading ? (
          <div className="cur-branch-status">
            <span className="cur-dots-inline"><span /><span /><span /></span>
            Finding directions to branch into…
          </div>
        ) : branchOptions && branchOptions.length > 0 ? (
          <>
            <div className="cur-branch-hint">
              Pick up to {MAX_BRANCH_TOPICS} directions — we&rsquo;ll spin up a new feed.
            </div>
            <div className="cur-branch-chips">
              {branchOptions.map((opt, i) => {
                const checked = branchSelected.has(i);
                const atCap = !checked && branchSelected.size >= MAX_BRANCH_TOPICS;
                return (
                  <button
                    key={i}
                    type="button"
                    className={`cur-branch-chip${checked ? " selected" : ""}`}
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
          <div className="cur-feed-posts-inner">
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
                  </div>
                    <div className="cur-post-branch-row">{branchButton(post.uri)}</div>
                    {branchPanel(post.uri)}
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
                        className="cur-post-embed"
                        href={post.external_uri}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <div className="cur-post-embed-host">{extHost || "link"}</div>
                        {post.external_title && (
                          <div className="cur-post-embed-title">{post.external_title}</div>
                        )}
                        {post.external_desc && (
                          <div className="cur-post-embed-desc">{post.external_desc}</div>
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

                    <footer className="cur-post-stats">
                      <span className="cur-post-stat" title="Replies">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                        </svg>
                        {formatCount(post.reply_count)}
                      </span>
                      <span className="cur-post-stat" title="Reposts">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <polyline points="17 1 21 5 17 9" />
                          <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                          <polyline points="7 23 3 19 7 15" />
                          <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                        </svg>
                        {formatCount(post.repost_count)}
                      </span>
                      <span className="cur-post-stat" title="Likes">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                        </svg>
                        {formatCount(post.like_count)}
                      </span>
                      <span className="cur-post-stat" title="Quotes">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M3 21c3 0 5-2 5-5V7H3v8h4" />
                          <path d="M14 21c3 0 5-2 5-5V7h-5v8h4" />
                        </svg>
                        {formatCount(post.quote_count)}
                      </span>
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
                  </article>
                    <div className="cur-post-branch-row">{branchButton(post.uri)}</div>
                    {branchPanel(post.uri)}
                  </div>
                );
              })
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
                    <span className="cur-mode-hint">
                      let Claude ask you step-by-step questions
                    </span>
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
    </>
  );
}
