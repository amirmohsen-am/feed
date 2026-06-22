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
// floor(DEFAULT_CANDIDATE_BUDGET / subqueries.length). Bumped 150 → 200 to
// give the reranker a wider net and leave headroom once serve-time seen
// filtering removes posts from the snapshot.
export const DEFAULT_CANDIDATE_BUDGET = 200;
export const MIN_CANDIDATE_BUDGET = 50;
export const MAX_CANDIDATE_BUDGET = 500;

export const DEFAULT_SUBQUERIES: string[] = [];

// --- Ranking bias (deterministic, bake-time blend after rerank) ---
// final = w_q·(rerank/100) + w_e·engagement + w_r·recency, with
// w_q = 1 - w_e - w_r (clamped ≥ 0). Weights are per-feed and surfaced in the
// Tune panel's "Ranking bias" section. Defaults are relevance-led: the blend
// nudges, it does not override the reranker's editorial judgment.
export const DEFAULT_ENGAGEMENT_WEIGHT = 0.2;
export const DEFAULT_RECENCY_WEIGHT = 0.1;
export const DEFAULT_RECENCY_HALFLIFE_H = 24;

export const MIN_RANKING_WEIGHT = 0;
export const MAX_RANKING_WEIGHT = 1;
// The blend nudges, it does not override the reranker: relevance keeps at least
// this share of the final score. engagement_weight + recency_weight is capped
// at (1 - MIN_RELEVANCE_WEIGHT) so w_q can never collapse to 0. Enforced at the
// write boundary (api/feeds) and defensively in blendedScore for legacy rows.
export const MIN_RELEVANCE_WEIGHT = 0.1;
export const MAX_BIAS_WEIGHT_SUM = 1 - MIN_RELEVANCE_WEIGHT;
// Half-life range for the recency decay knob. 1h → "only the last few hours
// matter" (breaking news); 30d → "age barely matters" (evergreen). The Tune
// slider is logarithmic across this range (fine control at the short end).
export const MIN_RECENCY_HALFLIFE_H = 1;
export const MAX_RECENCY_HALFLIFE_H = 24 * 30;

// Reference engagement for log-normalization: the engagement score saturates
// toward 1 as a post's weighted interaction count approaches this. Set near a
// "strong but not viral" post so the score discriminates across the body of
// the distribution rather than being pinned by a handful of viral outliers.
export const ENGAGEMENT_REF = 500;

// The reranker is always on. Feeds without a curator-authored editorial prompt
// fall back to this generic editorial ranker so there is a single ranking path
// (no raw-vector-order branch).
export const DEFAULT_RERANK_PROMPT =
  "You are an editorial ranker for a topical discovery feed. Keep posts that " +
  "are genuinely relevant to the query, substantive, and worth reading. Drop " +
  "spam, engagement bait, near-duplicates, and off-topic posts. Rank the most " +
  "relevant, highest-quality posts first.";

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
