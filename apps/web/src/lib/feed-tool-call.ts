// The tool-call payload for one curator turn: what update_feed_config (and/or
// finalize_feed) set that turn. Persisted on the assistant chat_messages row
// (tool_calls jsonb) and rendered as the in-chat "feed updated" row. This is NOT
// a diff — it's what the tool gave us, scoped to the fields the agent chose to
// set. The Claude context uses role + content only, so this never reaches the
// model. See DECISIONS.md.

import type { MechanicalFilters } from "./types";

export interface FeedToolCall {
  v: 1;
  finalize?: boolean;
  name?: string;
  topics?: string[]; // subqueries the agent set
  steer?: string; // rerank_prompt set (may be an empty string = rerank disabled)
  filters?: string[]; // plain-language lines for the mechanical fields touched
  ranking?: string[]; // plain-language lines for the ranking weights touched
}

// The fields a turn actually set, as gathered in /api/chat.
export interface FeedToolArgs {
  finalize: boolean;
  name?: string;
  subqueries?: string[];
  rerank_prompt?: string;
  mechanical_filters?: Partial<MechanicalFilters>;
  engagement_weight?: number;
  recency_weight?: number;
  recency_halflife_h?: number;
}

const LANG_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", pt: "Portuguese", fr: "French", de: "German",
  ja: "Japanese", ko: "Korean", zh: "Chinese", it: "Italian", nl: "Dutch",
};

function phrasePostType(t: MechanicalFilters["post_type"]): string {
  if (t === "top_level") return "top-level posts only";
  if (t === "replies") return "replies only";
  return "all post types";
}

function phraseWindow(w: MechanicalFilters["time_window"]): string {
  if (w === "1h") return "last hour";
  if (w === "24h") return "last 24 hours";
  if (w === "3d") return "last 3 days";
  return "custom date range";
}

// Phrase the mechanical fields the agent touched (present in the raw partial),
// in a stable priority order — the first line is what the collapsed row shows
// when filters lead.
function phraseFilters(mf: Partial<MechanicalFilters>): string[] {
  const out: string[] = [];
  const has = (k: keyof MechanicalFilters) => mf[k] !== undefined;

  if (has("require_media")) out.push(mf.require_media ? "requires media" : "media not required");
  if (has("min_like_count")) {
    const n = mf.min_like_count!;
    out.push(n > 0 ? `≥${n} likes` : "no like minimum");
  }
  if (has("post_type")) out.push(phrasePostType(mf.post_type!));
  if (has("time_window")) out.push(phraseWindow(mf.time_window!));
  if (has("lang_allow")) {
    const codes = mf.lang_allow!;
    out.push(codes.length === 0 ? "all languages" : `${codes.map((c) => LANG_NAMES[c] ?? c).join(", ")} only`);
  }
  if (has("require_video")) out.push(mf.require_video ? "requires video" : "video not required");
  if (has("require_link")) out.push(mf.require_link ? "requires a link" : "link not required");
  if (has("require_quote")) out.push(mf.require_quote ? "requires a quote post" : "quote not required");
  if (has("exclude_media")) out.push(mf.exclude_media ? "excludes media" : "media allowed");
  if (has("exclude_video")) out.push(mf.exclude_video ? "excludes video" : "video allowed");
  if (has("exclude_links")) out.push(mf.exclude_links ? "excludes links" : "links allowed");
  if (has("exclude_likely_nsfw")) out.push(mf.exclude_likely_nsfw ? "hides likely adult content" : "shows all content");
  if (has("hashtag_include")) {
    const tags = mf.hashtag_include!;
    out.push(tags.length === 0 ? "no hashtag filter" : tags.map((h) => `#${h}`).join(", "));
  }
  if (has("min_repost_count")) {
    const n = mf.min_repost_count!;
    out.push(n > 0 ? `≥${n} reposts` : "no repost minimum");
  }
  if (has("min_reply_count")) {
    const n = mf.min_reply_count!;
    out.push(n > 0 ? `≥${n} replies` : "no reply minimum");
  }
  return out;
}

function phraseRanking(args: FeedToolArgs): string[] {
  const out: string[] = [];
  if (args.engagement_weight !== undefined) out.push(`engagement weight ${args.engagement_weight}`);
  if (args.recency_weight !== undefined) out.push(`recency weight ${args.recency_weight}`);
  if (args.recency_halflife_h !== undefined) out.push(`recency half-life ${args.recency_halflife_h}h`);
  return out;
}

// Build the stored payload for a turn, or null when the turn set nothing and
// didn't finalize (a pure chat/question turn gets no row).
export function buildFeedToolCall(args: FeedToolArgs): FeedToolCall | null {
  const tc: FeedToolCall = { v: 1 };
  if (args.finalize) tc.finalize = true;
  if (args.name !== undefined) tc.name = args.name;
  if (args.subqueries !== undefined) tc.topics = args.subqueries;
  if (args.rerank_prompt !== undefined) tc.steer = args.rerank_prompt;
  if (args.mechanical_filters) {
    const f = phraseFilters(args.mechanical_filters);
    if (f.length > 0) tc.filters = f;
  }
  const r = phraseRanking(args);
  if (r.length > 0) tc.ranking = r;

  const hasContent =
    tc.name !== undefined || tc.topics !== undefined || tc.steer !== undefined ||
    tc.filters !== undefined || tc.ranking !== undefined;
  if (!hasContent && !tc.finalize) return null;
  return tc;
}

export function parseFeedToolCall(value: unknown): FeedToolCall | null {
  // The jsonb column comes back already parsed; tolerate a string too.
  let obj: unknown = value;
  if (typeof value === "string") {
    try { obj = JSON.parse(value); } catch { return null; }
  }
  if (!obj || typeof obj !== "object") return null;
  const tc = obj as FeedToolCall;
  return tc.v === 1 ? tc : null;
}

export function feedToolCallHasDetail(tc: FeedToolCall): boolean {
  return (
    tc.name !== undefined ||
    (tc.topics?.length ?? 0) > 0 ||
    tc.steer !== undefined ||
    (tc.filters?.length ?? 0) > 0 ||
    (tc.ranking?.length ?? 0) > 0
  );
}

// The collapsed one-line summary: up to two priority-ordered tokens plus an
// overflow count of the remaining set values.
export function feedToolCallHeadline(tc: FeedToolCall): { tokens: string[]; more: number } {
  const leaves: string[] = [];
  if (tc.name !== undefined) leaves.push(`“${tc.name}”`);
  if (tc.topics && tc.topics.length > 0) {
    leaves.push(`${tc.topics.length} topic${tc.topics.length > 1 ? "s" : ""}`);
  }
  if (tc.filters) for (const f of tc.filters) leaves.push(f);
  if (tc.ranking) for (const r of tc.ranking) leaves.push(r);
  if (tc.steer !== undefined) leaves.push("ranking steer");

  const tokens = leaves.slice(0, 2);
  return { tokens, more: leaves.length - tokens.length };
}
