// --- User Profile ---

export interface UserProfile {
  uid: string;
  name: string;
  email: string;
  photoURL: string;
  blueskyHandle: string;
  blueskyDid: string;
  bskyAppPassword: string;
  onboardedAt: string;
}

// --- Mechanical Filters ---
// Only fields wired to a read-path action live here. Everything else was
// removed in the curator redesign (see DECISIONS.md).

export interface MechanicalFilters {
  lang_allow: string[];           // e.g. ["en", "es"] — empty = allow all
  post_type: "all" | "top_level" | "replies";
  require_media: boolean;
  require_video: boolean;
  require_link: boolean;
  require_quote: boolean;
  exclude_media: boolean;
  exclude_video: boolean;
  exclude_links: boolean;
  hashtag_include: string[];      // post must contain at least one (case-insensitive)
  block_labels: string[];         // Bluesky self-labels to reject (NSFW gate)
  exclude_likely_nsfw: boolean;   // drop posts from authors whose description matches LIKE_NSFW_DESCRIPTION_KEYWORDS
  min_like_count: number;         // SQL filter on post_engagement.like_count
  min_repost_count: number;
  min_reply_count: number;
  time_window: TimeWindow;
  created_after_iso: string;      // only used when time_window === "custom"
  created_before_iso: string;
}

// Capped at the indexer's retention (RETENTION_DAYS, currently 7 — the
// partial HNSW index covers the whole retained table). A window longer than
// retention would silently return only what's retained. "custom" is not
// clamped — older bounds just match nothing beyond retention.
export type TimeWindow = "1h" | "24h" | "3d" | "7d" | "custom";
