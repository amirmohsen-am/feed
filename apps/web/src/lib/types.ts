// --- Mechanical Filters (Stage 1: free, fast, deterministic) ---

export interface MechanicalFilters {
  lang_allow: string[];           // e.g. ["en", "es"] — empty = allow all
  lang_block: string[];           // e.g. ["ja"] — takes precedence over allow
  min_length: number;             // minimum character count (default 20)
  max_length: number;             // 0 = unlimited
  post_type: "all" | "top_level" | "replies";
  require_media: boolean;         // post must have images
  require_video: boolean;         // post must have video
  require_link: boolean;
  require_quote: boolean;
  exclude_media: boolean;         // reject posts with images
  exclude_video: boolean;         // reject posts with video
  exclude_links: boolean;
  hashtag_include: string[];      // post must contain at least one (case-insensitive)
  hashtag_exclude: string[];      // reject if post contains any
  regex_include: string[];        // post text must match at least one pattern
  regex_exclude: string[];        // reject if post text matches any pattern
  author_allowlist: string[];     // DIDs — if non-empty, ONLY these authors pass
  author_blocklist: string[];     // DIDs — reject these authors
  author_max_per_hour: number;    // 0 = unlimited
  block_labels: string[];         // Bluesky self-labels to reject (e.g. ["porn","sexual","nudity","graphic-media"])
}

// --- Semantic Config (Stage 2: embeddings + LLM judge) ---

export interface SemanticConfig {
  topics: string[];
  keywords: string[];
  exclude_topics: string[];
  exclude_keywords: string[];
  vibes: string;
  embedding_threshold: number;    // scaled similarity score cutoff (default 0.50)
  judge_enabled: boolean;
  judge_strictness: "lenient" | "moderate" | "strict";
}

// --- Combined Feed Config ---

export interface FeedConfig {
  mechanical: MechanicalFilters;
  semantic: SemanticConfig;
}

