"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Script from "next/script";
import BranchTopicsHeader from "@/components/BranchTopicsHeader";
import FilterPanel from "@/components/FilterPanel";
import SendButton from "@/components/SendButton";
import { authedFetch } from "@/lib/authed-fetch";
import type { MechanicalFilters } from "@/lib/types";
import {
  DEFAULT_CANDIDATE_BUDGET,
  DEFAULT_RERANK_MODEL,
  DEFAULT_ENGAGEMENT_WEIGHT,
  DEFAULT_RECENCY_WEIGHT,
  DEFAULT_RECENCY_HALFLIFE_H,
} from "@/lib/defaults";
import type { BranchOption } from "@/lib/branch";
import { useResizable } from "../useResizable";
import { useCurator } from "../curatorContext";
import { FeedActionsProvider } from "../feedActions";
import type { Post, ChatSourcePost } from "../feedTypes";
import { BlueskyEmbed, bskyUrlFromUri } from "@/components/postCardUtils";
import FeedView, { type FeedViewHandle, type StreamedConfig } from "./FeedView";
import "../swipe-card.css";

// Passed across client-side navigations so the destination branch feed can
// show the full set of topic chips without an extra round-trip.
let incomingBranchOptions: BranchOption[] | null = null;

// When the user navigates away from a feed, we snapshot its posts here so
// navigating back restores them instantly — avoiding the blank-then-load flash.
let parentFeedSnapshot: { feedId: string | number; posts: unknown[] } | null = null;

interface Message { role: "user" | "assistant"; content: string; }

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
  const m = content.match(/^⟦swipe:(approve|reject):(.+?)⟧\s*(.*)$/s);
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

export default function CuratorWorkbench({ feedId }: { feedId: number }) {
  const {
    viewMode,
    feeds,
    reloadFeeds,
    activePostCount,
    setActivePostCount,
    mobileTab,
    setMobileTab,
    setOptionsUnread,
    registerOpenTune,
  } = useCurator();

  const [rightPane, setRightPane] = useState<"chat" | "tune">("chat");
  const [rightWidth, startRightDrag] = useResizable(
    RIGHT_W_KEY, 560, RIGHT_MIN, RIGHT_MAX, "right"
  );

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const promptParam = searchParams.get("prompt");

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState(() => promptParam ?? "");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [loading, setLoading] = useState(false);

  // The root feed lives in a FeedView; the workbench drives its initial load,
  // reloads, and post snapshot through this handle.
  const rootFeedRef = useRef<FeedViewHandle | null>(null);
  // Mirror of the root feed's posts, kept for the navigation snapshot.
  const snapshotPostsRef = useRef<Post[]>([]);

  // Consume the ?prompt= seed once: focus the textarea + drop it from the URL.
  const promptConsumedRef = useRef(false);
  useEffect(() => {
    if (promptConsumedRef.current || !promptParam) return;
    promptConsumedRef.current = true;
    setTimeout(() => inputRef.current?.focus(), 0);
    router.replace(pathname);
  }, [promptParam, pathname, router]);

  // Pull-to-refresh (mobile).
  const feedPaneRef = useRef<HTMLDivElement | null>(null);
  const ptrSpinnerRef = useRef<HTMLDivElement | null>(null);
  const ptrRefreshingRef = useRef(false);
  const [ptrRefreshing, setPtrRefreshing] = useState(false);

  useEffect(() => {
    registerOpenTune(() => {
      setRightPane("tune");
      setMobileTab("chat");
    });
    return () => registerOpenTune(() => {});
  }, [registerOpenTune, setMobileTab]);

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

  const interviewModeRef = useRef(false);

  // Set true when a chat message is sent so the feed fades to signal it may be
  // changing; cleared when the root feed finishes (re)loading.
  const [feedRefreshing, setFeedRefreshing] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set());

  // ── Feed configuration (owned here; read by the Tune panel + chat, applied
  //    by the FeedView stream which echoes config back via onConfigLoaded) ──
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

  // Branch flow: sourcePost is set when this feed was branched off a post (it
  // renders an embedded card atop the chat). The auto-fired branch-init turn
  // (guarded by branchInitFiredRef) makes the agent write the rerank prompt +
  // name.
  const [sourcePost, setSourcePost] = useState<ChatSourcePost | null>(null);
  const branchInitFiredRef = useRef(false);

  // Branch topic chips consumed once on mount by a destination branch route.
  const [branchHeaderOptions] = useState<BranchOption[] | null>(() => {
    const opts = incomingBranchOptions;
    incomingBranchOptions = null;
    return opts;
  });

  // In-session lookup so swipe messages can render the reacted post as a card.
  const [swipedPostCache, setSwipedPostCache] = useState<
    Record<string, { displayName: string; handle: string | null; text: string }>
  >({});

  const endRef = useRef<HTMLDivElement>(null);
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
      ew: f.engagement_weight ?? null,
      rw: f.recency_weight ?? null,
      rh: f.recency_halflife_h ?? null,
    });
  }

  // Clear the layout's mirrored post count when switching feeds.
  useEffect(() => {
    return () => setActivePostCount(0);
  }, [setActivePostCount]);

  // Patches from the Tune panel. Update local state + signature in sync so the
  // next chat reply doesn't trigger a redundant refresh for our own write.
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

  const saveMechanicalFilters = (filters: MechanicalFilters) => patchFeed({ mechanical_filters: filters });
  const saveSubqueries = (subs: string[]) => patchFeed({ subqueries: subs });
  const saveCandidateBudget = (n: number) => patchFeed({ candidate_budget: n });
  const saveRerankModel = (model: string) => patchFeed({ rerank_model: model });
  const saveRerankThinkingEnabled = (v: boolean) => patchFeed({ rerank_thinking_enabled: v });
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
        if (typeof f.rerank_model === "string" && f.rerank_model.length > 0) setRerankModel(f.rerank_model);
        if (typeof f.rerank_thinking_enabled === "boolean") setRerankThinkingEnabled(f.rerank_thinking_enabled);
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

  // The FeedView stream echoes the feed's config back here so the Tune panel +
  // signature stay in sync with what was actually queried.
  const handleConfigLoaded = useCallback((cfg: StreamedConfig) => {
    if (cfg.mechanical_filters) setMechanicalFilters(cfg.mechanical_filters);
    if (Array.isArray(cfg.subqueries)) setSubqueries(cfg.subqueries);
    if (typeof cfg.candidate_budget === "number") setCandidateBudget(cfg.candidate_budget);
    if (typeof cfg.rerank_prompt === "string") setRerankPrompt(cfg.rerank_prompt);
    if (typeof cfg.rerank_model === "string" && cfg.rerank_model.length > 0) setRerankModel(cfg.rerank_model);
    if (typeof cfg.rerank_thinking_enabled === "boolean") setRerankThinkingEnabled(cfg.rerank_thinking_enabled);
    feedSignatureRef.current = feedSignature({
      subqueries: cfg.subqueries,
      mechanical_filters: cfg.mechanical_filters,
      candidate_budget: cfg.candidate_budget,
      rerank_prompt: cfg.rerank_prompt,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePostsChange = useCallback((p: Post[]) => { snapshotPostsRef.current = p; }, []);

  // Fires whenever the root feed settles a load: clear the fade, and if a
  // pull-to-refresh is pending, spring the pane + spinner back.
  const handleRootLoaded = useCallback(() => {
    setFeedRefreshing(false);
    if (ptrRefreshingRef.current) {
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
    }
  }, []);

  // Swipe-left tune from the root feed: stamp the post into the swipe cache
  // (so it renders as a card in chat) and run it through the chat agent.
  const handleRootTune = useCallback((message: string, post: Post) => {
    setSwipedPostCache((prev) => ({
      ...prev,
      [post.uri]: {
        displayName:
          post.author_display_name?.trim() ||
          post.author_handle ||
          post.author_did.slice(0, 16) + "…",
        handle: post.author_handle,
        text: post.text,
      },
    }));
    void send(message);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On feed switch (URL change), hydrate chat then drive the root feed's load.
  useEffect(() => {
    const t = setTimeout(async () => {
      // Navigated back from a branch feed: restore snapshotted posts instantly.
      const snap = parentFeedSnapshot;
      if (snap && String(snap.feedId) === String(feedId)) {
        parentFeedSnapshot = null;
        rootFeedRef.current?.setPosts(snap.posts as Post[]);
        await loadChat(feedId);
        return;
      }
      await loadChat(feedId);
      rootFeedRef.current?.reload();
    }, 0);
    return () => clearTimeout(t);
  }, [feedId, loadChat]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // On navigating away from this feed, snapshot its posts so a return restores
  // them instantly.
  useEffect(() => {
    return () => {
      if (snapshotPostsRef.current.length > 0) {
        parentFeedSnapshot = { feedId, posts: snapshotPostsRef.current };
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedId]);

  // Pull-to-refresh gesture wiring (mobile only). Tracks a downward drag that
  // starts at the top of the feed, rubber-bands the pane, and on release past
  // the threshold forces a reload; everything springs back when it's done.
  useEffect(() => {
    const pane = feedPaneRef.current;
    const spin = ptrSpinnerRef.current;
    if (!pane || !spin) return;
    if (!window.matchMedia("(max-width: 767px)").matches) return;

    const THRESHOLD = 58;
    const MAX = 110;
    const HOLD = 52;
    const SPRING = "transform 0.5s cubic-bezier(0.2, 1.4, 0.4, 1)";
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

    const atTop = () => window.scrollY <= 0;

    const onStart = (e: TouchEvent) => {
      if (ptrRefreshingRef.current || !atTop()) { startY = -1; return; }
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      axisLock = "none";
      active = false;
      pull = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (startY < 0 || ptrRefreshingRef.current) return;
      const dy = e.touches[0].clientY - startY;
      if (axisLock === "none") {
        const dx = e.touches[0].clientX - startX;
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
          axisLock = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
        }
      }
      if (axisLock === "horizontal") return;
      if (dy <= 0 || !atTop()) {
        if (active) { active = false; paint(0, false); }
        return;
      }
      active = true;
      e.preventDefault();
      pull = Math.min(dy * 0.45, MAX);
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
        rootFeedRef.current?.reload(true);
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
  }, [feedId]);

  async function send(text: string) {
    if (!text.trim() || loading) return;
    setInput("");
    setSelectedOptions(new Set());
    setMessages(prev => [...prev, { role: "user", content: text.trim() }]);
    setLoading(true);
    setFeedRefreshing(true);
    let willReload = false;
    const interview = interviewModeRef.current;
    interviewModeRef.current = false;
    try {
      const res = await authedFetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message: text.trim(), feedId, interview }),
      });
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
          postsDebounceRef.current = setTimeout(() => rootFeedRef.current?.reload(), 600);
          willReload = true;
        }
      }
      const last = msgs[msgs.length - 1];
      if (last?.role === "assistant" && parseMessage(last.content).options.length > 0) {
        if (mobileTab !== "chat") setOptionsUnread(true);
      }
      if (d.done) {
        rootFeedRef.current?.reload();
        reloadFeeds();
        willReload = true;
      }
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "Something went wrong." }]);
    } finally {
      setLoading(false);
      if (!willReload) setFeedRefreshing(false);
    }
  }

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
    if (picks.length > 0) composed = picks.map((p) => `${p.key}. ${p.label}`).join(", ");
    if (comment) composed = composed ? `${composed} — ${comment}` : comment;
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
        reloadFeeds();
      }
    } catch { /* ignore — user can still chat normally */ }
    finally {
      setLoading(false);
      // branchInit owns the first post load for a branched feed — run it after
      // the rerank prompt is written so the query reflects the final config.
      rootFeedRef.current?.reload();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedId, reloadFeeds]);

  useEffect(() => {
    if (!sourcePost || messages.length > 0) return;
    if (branchInitFiredRef.current || chatLoading || loading) return;
    branchInitFiredRef.current = true;
    void branchInit();
  }, [sourcePost, messages.length, chatLoading, loading, branchInit]);

  const hasCriteria = subqueries.length > 0;

  const lastMsg = messages[messages.length - 1];
  const lastParsed = lastMsg?.role === "assistant" ? parseMessage(lastMsg.content) : null;

  const questionCount = messages.filter(
    (m) => m.role === "assistant" && parseMessage(m.content).options.length > 0
  ).length;
  const showFinalize = questionCount >= 3 && !hasCriteria;

  // Root feed Back affordance: a branched route can go back to its parent.
  const thisFeed = feeds.find((f) => f.id === String(feedId));
  const homeFeed = feeds.find((f) => f.isHome);
  const rootParentId = thisFeed?.parentFeedId ?? homeFeed?.id;
  const rootOnBack =
    thisFeed && !thisFeed.isHome && rootParentId
      ? () => router.push(`/curator/${rootParentId}`)
      : undefined;

  return (
    <FeedActionsProvider>
      <Script
        src="https://embed.bsky.app/static/embed.js"
        strategy="afterInteractive"
        onLoad={() => window.bluesky?.scan?.()}
      />
      <div className="cur-workbench" data-right-pane={rightPane}>
        {/* MOBILE: pull-to-refresh indicator */}
        <div className="cur-ptr-spinner" ref={ptrSpinnerRef} aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </div>

        {/* POSTS PANE (middle) */}
        <div className="cur-feed-posts" ref={feedPaneRef} style={{ position: "relative" }}>
          <FeedView
            ref={rootFeedRef}
            feedId={feedId}
            isRoot
            refreshing={feedRefreshing}
            headerContent={branchHeaderOptions ? <BranchTopicsHeader options={branchHeaderOptions} /> : undefined}
            onBack={rootOnBack}
            onConfigLoaded={handleConfigLoaded}
            onPostsChange={handlePostsChange}
            onTune={handleRootTune}
            onLoaded={handleRootLoaded}
          />
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
          <button
            type="button"
            className="cur-chat-close"
            aria-label="Close chat"
            onPointerDown={(e) => {
              e.preventDefault();
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
                      <span className={`cur-swipe-card-tag cur-swipe-card-tag-${swipe.verdict}`}>
                        {swipe.verdict === "approve"
                          ? "✓ More like this"
                          : "✕ Less like this"}
                      </span>
                      <a
                        className="cur-branch-source-card"
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <div className="cur-branch-source-author">
                          {name || "A post"}
                          {handle && <span className="cur-branch-source-handle">@{handle}</span>}
                        </div>
                        {text && <div className="cur-branch-source-text">{text}</div>}
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
                    <span className="cur-mode-hint">go back to free-form chat</span>
                  </>
                ) : (
                  <button
                    type="button"
                    className="cur-mode-toggle"
                    onClick={askForQuestions}
                    disabled={loading}
                  >
                    ✦ Help me build my prompt
                  </button>
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
          postCount={activePostCount}
          rightPane={rightPane}
          onRightPaneChange={setRightPane}
          style={{ ["--cur-right-w" as string]: `${rightWidth}px` }}
        />
      </div>
    </FeedActionsProvider>
  );
}
