"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Script from "next/script";
import BranchTopicsHeader from "@/components/BranchTopicsHeader";
import FilterPanel from "@/components/FilterPanel";
import SendButton from "@/components/SendButton";
import Capsule from "./Capsule";
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
import { FeedFocusProvider, type FeedFocusValue } from "../feedFocus";
import type { Post, ChatSourcePost } from "../feedTypes";
import { BlueskyEmbed, bskyUrlFromUri } from "@/components/postCardUtils";
import FeedView, { type FeedViewHandle, type StreamedConfig } from "./FeedView";
import OnboardingIntention from "./OnboardingIntention";
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

// The agent is asking a follow-up (vs. just acting/acknowledging) when it
// presents multiple-choice options, or its text ends with a question mark.
// We pop the conversation open in that case so the user can answer.
function isFollowUpQuestion(parsed: { text: string; options: { key: string; label: string }[] }) {
  if (parsed.options.length > 0) return true;
  return /\?\s*$/.test(parsed.text.trim());
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
    setShowOnboarding,
    setConfigReady: setContextConfigReady,
  } = useCurator();

  const [rightPane, setRightPane] = useState<"chat" | "tune">("chat");
  const [rightWidth, startRightDrag] = useResizable(
    RIGHT_W_KEY, 560, RIGHT_MIN, RIGHT_MAX, "right"
  );

  // ── Design E ("Capsule"): a floating input-only composer; the conversation is
  //    hidden behind it. `expanded` opens the side conversation (desktop) / sheet
  //    (mobile), `tuning` opens the Tune slide-over, `capState` drives the pill,
  //    `scrollCollapsed` tucks the capsule into the Refine pill on scroll. ──
  const [expanded, setExpanded] = useState(false);
  const [tuning, setTuning] = useState(false);
  const [capState, setCapState] = useState<"idle" | "thinking" | "updated">("idle");
  const [scrollCollapsed, setScrollCollapsed] = useState(false);
  // The capsule has its own draft field so it can send without mounting the
  // full side-chat input bar.
  const [capInput, setCapInput] = useState("");
  const [memoryImportMode, setMemoryImportMode] = useState(false);
  const capInputRef = useRef<HTMLInputElement | null>(null);
  // True while the on-screen keyboard is animating open/closed. The keyboard
  // resizes the visual viewport rather than scrolling content, but iOS Safari
  // emits a spurious `scroll` alongside it — we suppress collapse during this
  // window so opening the keyboard doesn't tuck the capsule back to the pill.
  const kbSettlingRef = useRef(false);
  // The structured options card can be dismissed (the X) to type free-form for
  // this turn; reset whenever a new turn lands so the next question's card shows.
  const [optionsDismissed, setOptionsDismissed] = useState(false);
  // The capsule composes inline on both breakpoints; `isMobile` only decides
  // where the conversation opens (desktop sidebar vs mobile full-screen sheet).
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

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

  // ── Leaf-feed focus stack ──────────────────────────────────────────────
  // Every FeedView (root + each inline nested branch) registers its handle here.
  // Mount order == nesting depth (a branch only mounts once its parent commits),
  // so the stack top is always the feed currently in view. User-initiated refresh
  // (mobile pull-to-refresh) targets that leaf rather than always hitting root.
  const leafStackRef = useRef<FeedViewHandle[]>([]);
  const registerLeaf = useCallback((handle: FeedViewHandle) => {
    leafStackRef.current.push(handle);
    return () => {
      const i = leafStackRef.current.lastIndexOf(handle);
      if (i !== -1) leafStackRef.current.splice(i, 1);
    };
  }, []);
  const refreshLeaf = useCallback((force?: boolean): Promise<void> => {
    const stack = leafStackRef.current;
    const target = stack[stack.length - 1] ?? rootFeedRef.current;
    return Promise.resolve(target?.reload(force));
  }, []);
  const feedFocusValue = useMemo<FeedFocusValue>(() => ({ registerLeaf }), [registerLeaf]);

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
    registerOpenTune(() => setTuning(true));
    return () => registerOpenTune(() => {});
  }, [registerOpenTune]);

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
  // Set once the root feed's first load settles, so the onboarding surface only
  // decides to show after we know whether this feed actually has criteria (no
  // flash of onboarding over a configured feed while it loads).
  const [configReady, setConfigReady] = useState(false);
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

  // Spring the pull-to-refresh pane + spinner back to rest. Called when the
  // refreshed leaf feed settles its reload (see the PTR gesture handler), not
  // tied to the root — pull-to-refresh can target an open branch.
  const springBackPtr = useCallback(() => {
    if (!ptrRefreshingRef.current) return;
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
  }, []);

  // Fires whenever the root feed settles a load: clear the chat-driven fade.
  const handleRootLoaded = useCallback(() => {
    setFeedRefreshing(false);
    setConfigReady(true);
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

  // Settings' "Clear seen history" wipes the viewer's seen rows server-side, then
  // fires this so the feed in view re-fetches and the now-unfiltered posts return.
  useEffect(() => {
    const onReload = () => { void rootFeedRef.current?.reload(); };
    window.addEventListener("ripple:reload-feed", onReload);
    return () => window.removeEventListener("ripple:reload-feed", onReload);
  }, []);

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
        // Refresh whichever feed is in view (deepest open branch, else root) and
        // spring back when ITS reload settles — not the root's onLoaded.
        void refreshLeaf(true).finally(springBackPtr);
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
  }, [feedId, refreshLeaf, springBackPtr]);

  async function send(text: string, opts?: { memoryImport?: boolean }) {
    if (!text.trim() || loading) return;
    setInput("");
    setSelectedOptions(new Set());
    setMessages(prev => [...prev, { role: "user", content: text.trim() }]);
    setLoading(true);
    setFeedRefreshing(true);
    let willReload = false;
    feedChangedRef.current = false;
    const interview = interviewModeRef.current;
    interviewModeRef.current = false;
    const memoryImport = opts?.memoryImport ?? false;
    try {
      const res = await authedFetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message: text.trim(), feedId, interview, memoryImport }),
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
          // A mid-session refinement (chat tune, swipe-left "less like this")
          // recomputes only the tail past the commit point, so the feed the user
          // is reading isn't yanked. Degrades to a full load when nothing's been
          // read yet (e.g. still building the feed during onboarding).
          postsDebounceRef.current = setTimeout(
            () => rootFeedRef.current?.reload({ tail: true }),
            600
          );
          willReload = true;
        }
      }
      if (d.done) {
        rootFeedRef.current?.reload();
        reloadFeeds();
        willReload = true;
      }
      // The feed config actually changed this turn (signature change or
      // finalize) → let the capsule flash "Feed updated".
      feedChangedRef.current = willReload;
      // Auto pop out the conversation (desktop right sidebar / mobile full-screen
      // sheet) when the user needs to see the agent's reply: either it's asking a
      // follow-up question, or the feed didn't change (otherwise the reply is
      // invisible behind the collapsed capsule and the user is left confused).
      const last = msgs[msgs.length - 1];
      const followUp = last?.role === "assistant" && isFollowUpQuestion(parseMessage(last.content));
      if (followUp || !willReload) {
        const alreadyOpen = isMobile ? mobileTab === "chat" : expanded;
        if (alreadyOpen) setOptionsUnread(false);
        else openConversation();
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

  // Send a nudge straight from the floating capsule (its own draft field).
  function sendFromCapsule() {
    const v = capInput.trim();
    if (!v) return;
    setCapInput("");
    send(v);
  }
  // Expand chevron: toggle the conversation. Desktop = right sidebar; mobile =
  // full-screen sheet. Typing in the capsule never triggers this.
  function toggleConversation() {
    if (isMobile) {
      if (mobileTab === "chat") {
        inputRef.current?.blur();
        setMobileTab("feed");
      } else {
        setMobileTab("chat");
        setOptionsUnread(false);
      }
    } else {
      setExpanded((v) => !v);
    }
  }
  // Open the conversation (from "Feed updated" / "see what changed").
  function openConversation() {
    setCapState("idle");
    if (isMobile) {
      setMobileTab("chat");
      setOptionsUnread(false);
    } else {
      setExpanded(true);
    }
  }

  // Keyboard avoidance (mobile): the fixed capsule would hide behind the
  // on-screen keyboard; lift it by the visualViewport overlap via --cap-kb-offset.
  useEffect(() => {
    if (!isMobile || typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty("--cap-kb-offset", `${overlap}px`);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--cap-kb-offset");
    };
  }, [isMobile]);

  // Drive the capsule's progress pill from the busy flags: while a turn or a
  // post re-query is in flight it shows the "thinking" goo; when it settles it
  // flashes "updated" (only after the user has conversed), then returns to idle.
  const busy = loading || feedRefreshing;
  const wasBusyRef = useRef(false);
  const updatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sawMessageRef = useRef(false);
  // Set by send() when a turn actually changed the feed config; consumed once by
  // the capState effect so "Feed updated" only flashes on a real change.
  const feedChangedRef = useRef(false);
  useEffect(() => { if (messages.length > 0) sawMessageRef.current = true; }, [messages.length]);
  useEffect(() => {
    if (busy) {
      if (updatedTimerRef.current) { clearTimeout(updatedTimerRef.current); updatedTimerRef.current = null; }
      wasBusyRef.current = true;
      setScrollCollapsed(false);
      setCapState("thinking");
      return;
    }
    if (wasBusyRef.current) {
      wasBusyRef.current = false;
      // Only flash "Feed updated" when the turn actually changed the feed
      // config; a pure acknowledgment (no change) just returns to idle.
      if (sawMessageRef.current && feedChangedRef.current) {
        setCapState("updated");
        updatedTimerRef.current = setTimeout(() => {
          setCapState("idle");
          setScrollCollapsed(true);
        }, 2600);
      } else {
        setCapState("idle");
      }
      feedChangedRef.current = false;
    }
  }, [busy]);
  useEffect(() => () => { if (updatedTimerRef.current) clearTimeout(updatedTimerRef.current); }, []);

  // Scroll-collapse (desktop): tuck the capsule into the Refine pill when the
  // feed pane scrolls, while idle and not expanded/tuning.
  useEffect(() => {
    const pane = feedPaneRef.current;
    if (!pane) return;
    if (!window.matchMedia("(min-width: 768px)").matches) return;
    let lastTop = pane.scrollTop;
    const onScroll = () => {
      const top = pane.scrollTop;
      const delta = top - lastTop;
      lastTop = top;
      if (expanded || tuning || capState !== "idle") return;
      // Ignore the spurious scroll the keyboard fires as it animates open/closed.
      if (kbSettlingRef.current) return;
      if (Math.abs(delta) > 4 && top > 60) {
        capInputRef.current?.blur();
        setScrollCollapsed(true);
      }
    };
    pane.addEventListener("scroll", onScroll, { passive: true });
    return () => pane.removeEventListener("scroll", onScroll);
  }, [expanded, tuning, capState]);

  // Scroll-collapse (mobile): the document is the scroller.
  useEffect(() => {
    if (!window.matchMedia("(max-width: 767px)").matches) return;
    if (mobileTab === "chat" || tuning) return;
    let last = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      const delta = y - last;
      last = y;
      if (capState !== "idle") return;
      // Ignore the spurious scroll the keyboard fires as it animates open/closed.
      if (kbSettlingRef.current) return;
      if (Math.abs(delta) > 4 && y > 60) {
        capInputRef.current?.blur();
        setScrollCollapsed(true);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [capState, tuning, mobileTab]);

  // Flag the visual-viewport resize the on-screen keyboard causes. Each resize
  // re-arms a short timer; while it's live the scroll-collapse handlers above
  // ignore the keyboard's accompanying spurious scroll. A genuine finger-scroll
  // (no recent viewport change) still collapses, even while the input is focused.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      kbSettlingRef.current = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { kbSettlingRef.current = false; }, 350);
    };
    vv.addEventListener("resize", onResize);
    return () => {
      vv.removeEventListener("resize", onResize);
      if (timer) clearTimeout(timer);
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

  function handleMemoryImport(memoryText: string) {
    if (!memoryText.trim() || loading) return;
    setMemoryImportMode(false);
    openMobileChat();
    send(
      `Here is an export of my AI chat memory about my interests and preferences:\n\n${memoryText}`,
      { memoryImport: true },
    );
  }

  function cancelQuestions() {
    if (loading) return;
    interviewModeRef.current = false;
    send("Actually, let's just chat — no more options lists.");
  }

  // ── Onboarding intents (the first-run "intention" cards) ──
  const ONBOARDING_STARTED_KEY = "curator:onboardingStarted";

  function markOnboardingStarted() {
    try { sessionStorage.setItem(ONBOARDING_STARTED_KEY, "1"); } catch { /* */ }
  }

  function onboardDescribe() {
    markOnboardingStarted();
    openConversation();
    setTimeout(() => inputRef.current?.focus(), 60);
  }
  function onboardMemory() {
    markOnboardingStarted();
    setMemoryImportMode(true);
    openConversation();
  }
  function onboardGuided() {
    markOnboardingStarted();
    openConversation();
    askForQuestions();
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

  // First-run "intention" surface: a brand-new / unconfigured feed the user
  // hasn't started shaping yet. Gate on configReady so it never flashes over a
  // configured feed while its first load is still in flight.
  const onboardingAlreadyStarted =
    typeof window !== "undefined" &&
    !!sessionStorage.getItem("curator:onboardingStarted");
  const showOnboarding =
    configReady && !hasCriteria && messages.length === 0 && !chatLoading && !onboardingAlreadyStarted;
  useEffect(() => { setShowOnboarding(showOnboarding); }, [showOnboarding, setShowOnboarding]);
  useEffect(() => { if (configReady) setContextConfigReady(true); }, [configReady, setContextConfigReady]);
  // Close the chat pane when the first feed criteria arrive (onboarding complete).
  const prevHasCriteriaRef = useRef(hasCriteria);
  useEffect(() => {
    if (!prevHasCriteriaRef.current && hasCriteria) {
      setExpanded(false);
      setMobileTab("feed");
    }
    prevHasCriteriaRef.current = hasCriteria;
  }, [hasCriteria, setMobileTab]);

  const lastMsg = messages[messages.length - 1];
  const lastParsed = lastMsg?.role === "assistant" ? parseMessage(lastMsg.content) : null;

  // Structured options card: shown when the latest assistant turn carries
  // numbered options, unless the user dismissed it to type free-form. Reset the
  // dismissal whenever a new turn lands so the next question's card shows.
  const hasPendingOptions = (lastParsed?.options.length ?? 0) > 0;
  const showOptionsCard = hasPendingOptions && !optionsDismissed;
  useEffect(() => { setOptionsDismissed(false); }, [messages.length]);

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
      <div
        className="cur-workbench"
        data-right-pane={rightPane}
        data-expanded={expanded ? "side" : undefined}
        data-tuning={tuning ? "" : undefined}
      >
        {/* MOBILE: pull-to-refresh indicator (fixed under the topbar; the
            gesture lives on the feed pane below) */}
        <div className="cur-ptr-spinner" ref={ptrSpinnerRef} aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </div>

        {/* STAGE — non-scrolling wrapper that anchors the floating capsule and
            the Tune slide-over over the feed column only. */}
        <div className="cur-stage">
        {/* POSTS PANE (middle) */}
        {/* POSTS PANE (middle) — recursive FeedView owns the post stream, swipe-to-
            tune / swipe-to-branch (inline fold model + today's lift fix), pipeline
            loader, and the inline nested branch. Workbench drives the initial load
            and reads config/posts/loading back via the callbacks below. */}
        <div className="cur-feed-posts" ref={feedPaneRef} style={{ position: "relative" }}>
          {/* Veil covers the feed until configReady so neither "No posts yet" nor
              a half-loaded feed flashes before we know whether to show onboarding. */}
          {!configReady && (
            <div style={{ position: "absolute", inset: 0, background: "var(--paper)", zIndex: 5, pointerEvents: "none" }} aria-hidden />
          )}
          <FeedFocusProvider value={feedFocusValue}>
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
          </FeedFocusProvider>
          {showOnboarding && (
            <OnboardingIntention
              onDescribe={onboardDescribe}
              onMemory={onboardMemory}
              onGuided={onboardGuided}
            />
          )}
        </div>{/* /.cur-feed-posts */}

          {/* ════ THE CAPSULE — floating, input-only curator (desktop + mobile) ════ */}
          <Capsule
            value={capInput}
            onValueChange={setCapInput}
            onSend={sendFromCapsule}
            state={capState}
            collapsed={scrollCollapsed && !tuning}
            expanded={isMobile ? mobileTab === "chat" : expanded}
            placeholder={hasCriteria ? "Make it more…" : "Describe the feed you want to read…"}
            onToggleExpand={toggleConversation}
            onReopen={() => {
              setScrollCollapsed(false);
              // Focus synchronously inside the tap so iOS opens the keyboard —
              // Safari ignores a focus() deferred outside the user gesture. The
              // field is opacity:0 mid-animation but already focusable.
              capInputRef.current?.focus();
            }}
            onUpdatedOpen={openConversation}
            inputRef={capInputRef}
          />
          {/* gooey filter for the metaballs progress style */}
          <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
            <defs>
              <filter id="cur-goo">
                <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur" />
                <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9" />
              </filter>
            </defs>
          </svg>

          {/* TUNE SLIDE-OVER scrim (the panel itself is the FilterPanel below) */}
          <div className="tune-scrim" onClick={() => setTuning(false)} aria-hidden />
        </div>{/* /.cur-stage */}

        {/* WORKBENCH RESIZER (between stage and side chat) */}
        <div
          className="cur-resizer cur-resizer-workbench"
          onPointerDown={startRightDrag}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize conversation"
        />

        {/* ════ SIDE CHAT — the expanded conversation (keeps cur-chat-pane so the
            existing mobile full-screen-sheet rules continue to apply) ════ */}
        <aside className="chat-side cur-chat-pane" style={{ ["--cur-right-w" as string]: `${rightWidth}px` }}>
          <div className="thread-head">
            <span className="h-glyph" aria-hidden />
            <div className="th-titles">
              <div className="th-t">Curator</div>
              <div className="th-s">conversation</div>
            </div>
            <button
              type="button"
              className="th-x"
              aria-label="Close conversation"
              onPointerDown={(e) => {
                e.preventDefault();
                inputRef.current?.blur();
                setExpanded(false);
                setMobileTab("feed");
              }}
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
          {/* MOBILE: pull-down affordance to dismiss the full-screen chat sheet.
              Acts on pointer-down so a collapsing iOS keyboard can't swallow the tap. */}
          <button
            type="button"
            className="cur-chat-close"
            aria-label="Close chat"
            onPointerDown={(e) => {
              e.preventDefault();
              inputRef.current?.blur();
              setExpanded(false);
              setMobileTab("feed");
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
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
                memoryImportMode ? (
                  <div className="cur-memory-inline">
                    <button
                      type="button"
                      className="cur-memory-back"
                      onClick={() => setMemoryImportMode(false)}
                      aria-label="Back"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></svg>
                    </button>
                    <p className="cur-memory-inline-title">Export your memory</p>
                    <p className="cur-memory-inline-desc">
                      We&rsquo;ll ask your AI to summarize what it knows about you. Pick one:
                    </p>
                    <div className="cur-memory-links">
                      <a
                        href={`https://chatgpt.com/?q=${encodeURIComponent("Please give me a concise summary of everything you know about me from our conversations — my interests, hobbies, what I like to read about, my profession, topics I'm curious about, opinions I've shared, and anything else that would help someone build a personalized content feed for me. Format it as a bullet-point list.")}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="cur-memory-link"
                      >
                        {/* OpenAI logo */}
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                          <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.998 5.998 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
                        </svg>
                        ChatGPT
                      </a>
                      <a
                        href={`https://claude.ai/new?q=${encodeURIComponent("Please give me a concise summary of everything you know about me from our conversations — my interests, hobbies, what I like to read about, my profession, topics I'm curious about, opinions I've shared, and anything else that would help someone build a personalized content feed for me. Format it as a bullet-point list.")}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="cur-memory-link"
                      >
                        {/* Claude/Anthropic logo */}
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                          <path d="M13.827 3.52h3.603L24 20.48h-3.603l-6.57-16.96zm-7.258 0h3.767L16.906 20.48h-3.674l-1.343-3.461H5.017l-1.344 3.46H0l6.57-16.96zm2.327 5.14L6.77 14.16h4.25L8.896 8.66z" />
                        </svg>
                        Claude
                      </a>
                    </div>
                    <p className="cur-memory-inline-hint">
                      Then paste the response below
                    </p>
                  </div>
                ) : (
                  <div className="cur-empty">
                    <p>Describe your ideal feed</p>
                    <p className="sub">a topic you&rsquo;re interested in, hobbies, etc.</p>
                  </div>
                )
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
            {showOptionsCard ? (
              /* Structured options card: numbered multi-select rows + an answer
                 field, pinned at the bottom of the conversation. */
              <div className="cur-opts-card">
                <div className="cur-opts-card-head">
                  <span className="cur-opts-card-lbl">Pick any that fit</span>
                  <button
                    type="button"
                    className="cur-opts-card-x"
                    aria-label="Dismiss options"
                    title="Dismiss — type freely instead"
                    onClick={() => setOptionsDismissed(true)}
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
                  </button>
                </div>
                <div className="cur-opts-rows">
                  {lastParsed!.options.map((opt) => {
                    const checked = selectedOptions.has(opt.key);
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        className="cur-opts-row"
                        data-selected={checked}
                        disabled={loading}
                        onClick={() => {
                          if (loading) return;
                          setSelectedOptions((prev) => {
                            const next = new Set(prev);
                            if (next.has(opt.key)) next.delete(opt.key);
                            else next.add(opt.key);
                            return next;
                          });
                        }}
                      >
                        <span className="cur-opts-num" aria-hidden>
                          {checked ? (
                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="m5 13 4 4L19 7" /></svg>
                          ) : opt.key}
                        </span>
                        <span className="cur-opts-label">{opt.label}</span>
                      </button>
                    );
                  })}
                </div>
                <form
                  className="cur-opts-answer"
                  onSubmit={(e) => { e.preventDefault(); submitChat(); }}
                >
                  <span className="cur-opts-pencil" aria-hidden>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                  </span>
                  <textarea
                    ref={inputRef}
                    className="cur-opts-input"
                    rows={1}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        submitChat();
                      }
                    }}
                    placeholder={selectedOptions.size > 0 ? "Add a comment (optional)…" : "Type your answer…"}
                    disabled={loading}
                  />
                  <SendButton disabled={loading || (selectedOptions.size === 0 && !input.trim())} />
                </form>
              </div>
            ) : (
              <>
                {!hasCriteria && (
                  <div className="cur-mode-row">
                    <button
                      type="button"
                      className="cur-mode-toggle"
                      onClick={askForQuestions}
                      disabled={loading}
                    >
                      ✦ Help me build my prompt
                    </button>
                    <button
                      type="button"
                      className="cur-memory-btn"
                      onClick={() => { setMemoryImportMode(true); openConversation(); }}
                      disabled={loading}
                    >
                      Build with my chat memory
                      <span className="cur-memory-btn-logos">
                        {/* OpenAI logo */}
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                          <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.998 5.998 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
                        </svg>
                        {/* Claude/Anthropic logo */}
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                          <path d="M13.827 3.52h3.603L24 20.48h-3.603l-6.57-16.96zm-7.258 0h3.767L16.906 20.48h-3.674l-1.343-3.461H5.017l-1.344 3.46H0l6.57-16.96zm2.327 5.14L6.77 14.16h4.25L8.896 8.66z" />
                        </svg>
                      </span>
                    </button>
                  </div>
                )}
                <form
                  className={`cur-input-wrap${busy ? " loading" : ""}`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    openMobileChat();
                    if (memoryImportMode) {
                      handleMemoryImport(input);
                    } else {
                      send(input);
                    }
                  }}
                >
                  {/* metaballs goo shown over the composer while a turn is in flight */}
                  <div className="cap-meta" aria-hidden><i /><i /><i /><i /><i /></div>
                  <textarea
                    ref={inputRef}
                    className="cur-input"
                    rows={memoryImportMode ? 4 : 1}
                    value={input}
                    onFocus={openMobileChat}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        if (memoryImportMode) {
                          handleMemoryImport(input);
                        } else {
                          send(input);
                        }
                      }
                    }}
                    placeholder={memoryImportMode ? "Paste the AI's response here…" : "Describe your ideal feed…"}
                    disabled={loading}
                  />
                  <SendButton disabled={loading || !input.trim()} />
                </form>
              </>
            )}
          </div>
        </aside>

        {/* TUNE PANEL — right slide-over, driven by data-tuning on the workbench */}
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
          onMechanicalChange={saveMechanicalFilters}
          onSubqueriesChange={saveSubqueries}
          onCandidateBudgetChange={saveCandidateBudget}
          onRerankModelChange={saveRerankModel}
          onRerankThinkingChange={saveRerankThinkingEnabled}
          onEngagementWeightChange={saveEngagementWeight}
          onRecencyWeightChange={saveRecencyWeight}
          onRecencyHalflifeChange={saveRecencyHalflife}
          postCount={activePostCount}
          onClose={() => setTuning(false)}
        />
      </div>

    </FeedActionsProvider>
  );
}
