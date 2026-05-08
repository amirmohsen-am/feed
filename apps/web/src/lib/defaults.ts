import type { MechanicalFilters, SemanticConfig, FeedConfig } from "./types";

export const DEFAULT_MECHANICAL_FILTERS: MechanicalFilters = {
  lang_allow: ["en"],
  lang_block: [],
  min_length: 20,
  max_length: 0,
  post_type: "all",
  require_media: false,
  require_link: false,
  require_quote: false,
  exclude_media: false,
  exclude_links: false,
  hashtag_include: [],
  hashtag_exclude: [],
  regex_include: [],
  regex_exclude: [],
  author_allowlist: [],
  author_blocklist: [],
  author_max_per_hour: 0,
};

export const DEFAULT_SEMANTIC_CONFIG: SemanticConfig = {
  topics: [],
  keywords: [],
  exclude_topics: [],
  exclude_keywords: [],
  vibes: "",
  embedding_threshold: 0.72,
  judge_enabled: true,
  judge_strictness: "moderate",
};

export const DEFAULT_FEED_CONFIG: FeedConfig = {
  mechanical: DEFAULT_MECHANICAL_FILTERS,
  semantic: DEFAULT_SEMANTIC_CONFIG,
};

/** Merge partial mechanical filters with defaults */
export function withMechanicalDefaults(
  partial: Partial<MechanicalFilters>
): MechanicalFilters {
  return { ...DEFAULT_MECHANICAL_FILTERS, ...partial };
}

/** Merge partial semantic config with defaults */
export function withSemanticDefaults(
  partial: Partial<SemanticConfig>
): SemanticConfig {
  return { ...DEFAULT_SEMANTIC_CONFIG, ...partial };
}

/** Merge partial feed config with defaults */
export function withFeedConfigDefaults(
  partial: Partial<FeedConfig>
): FeedConfig {
  return {
    mechanical: withMechanicalDefaults(partial.mechanical ?? {}),
    semantic: withSemanticDefaults(partial.semantic ?? {}),
  };
}
