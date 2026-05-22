import type { MechanicalFilters } from "./types";

// Bluesky's standard self-applied content labels we filter by default.
// Posts whose `self_labels` Vertex restrict contains any of these are
// excluded from results.
export const DEFAULT_SENSITIVE_LABELS = [
  "porn",
  "sexual",
  "nudity",
  "graphic-media",
];

// Substring patterns we look for in `bsky.authors.description` to flag an
// account as likely-NSFW. Case-insensitive. Used to compute the `like_nsfw`
// boolean on each post hit at hydration time. The patterns and the SQL that
// reads them must stay in sync — see `LIKE_NSFW_SQL_EXPR` in vector-search.ts.
export const LIKE_NSFW_DESCRIPTION_KEYWORDS = [
  "nsfw",
  "n/sfw",
  "18+",
  "onlyfans",
  "xivmodarchive",
  "furry",
  "🔞",
  "minors dni",
  "minor dni",
  "dni minors",
  "dni minor",
];

export const DEFAULT_MECHANICAL_FILTERS: MechanicalFilters = {
  lang_allow: ["en"],
  post_type: "all",
  require_media: false,
  require_video: false,
  require_link: false,
  require_quote: false,
  exclude_media: false,
  exclude_video: false,
  exclude_links: false,
  hashtag_include: [],
  block_labels: DEFAULT_SENSITIVE_LABELS,
  exclude_likely_nsfw: true,
  min_like_count: 0,
  min_repost_count: 0,
  min_reply_count: 0,
  time_window: "24h",
  created_after_iso: "",
  created_before_iso: "",
};

// Total candidate budget across all subqueries. Per-subquery k is
// floor(DEFAULT_CANDIDATE_BUDGET / subqueries.length).
export const DEFAULT_CANDIDATE_BUDGET = 150;
export const MIN_CANDIDATE_BUDGET = 50;
export const MAX_CANDIDATE_BUDGET = 500;

export const DEFAULT_SUBQUERIES: string[] = [];

// Reranker config defaults. The model is per-feed configurable in the UI;
// allowed values are listed in RERANK_MODEL_OPTIONS for the dropdown.
export const DEFAULT_RERANK_MODEL = "claude-haiku-4-5-20251001";
export const RERANK_MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5 (fast, default)" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6 (better, ~5× cost)" },
];

// Hard cap on image blocks attached to a single rerank request. Anthropic
// limits content blocks per request, and per-image cost adds up fast. With
// 150 candidates × up to 4 images each, we'd blow past this — fall back to
// "iterate candidates in order, take each one's images until the cap fills."
export const MAX_RERANK_IMAGES = 100;

export function withMechanicalDefaults(
  partial: Partial<MechanicalFilters>
): MechanicalFilters {
  return { ...DEFAULT_MECHANICAL_FILTERS, ...partial };
}
