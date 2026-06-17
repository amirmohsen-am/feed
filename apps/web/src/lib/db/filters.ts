import type { MechanicalFilters } from "../types";
import type { SearchFilter } from "../vector-search";

// Translation of a feed's stored MechanicalFilters into the vector-search
// SearchFilter shape. This is feed-config domain logic, deliberately kept out
// of the data-access modules — the DB layer stores/reads MechanicalFilters
// verbatim; only the preview pipeline needs the search-filter projection.

const PRESET_WINDOW_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
};

export function timeWindowToBounds(m: MechanicalFilters): {
  afterUs?: number;
  beforeUs?: number;
} {
  const window = m.time_window;
  if (!window) return {};
  if (window === "custom") {
    const out: { afterUs?: number; beforeUs?: number } = {};
    if (m.created_after_iso) {
      const t = Date.parse(m.created_after_iso);
      if (!Number.isNaN(t)) out.afterUs = t * 1000;
    }
    if (m.created_before_iso) {
      const t = Date.parse(m.created_before_iso);
      if (!Number.isNaN(t)) out.beforeUs = t * 1000;
    }
    return out;
  }
  const delta = PRESET_WINDOW_MS[window];
  if (!delta) return {};
  return { afterUs: (Date.now() - delta) * 1000 };
}

// Translate MechanicalFilters → vector SearchFilter. Only wired fields remain
// after the curator redesign. `post_type` "all" leaves the reply restrict off
// so both replies and top-level posts come back.
export function mechanicalToSearchFilter(
  m?: MechanicalFilters
): SearchFilter | undefined {
  if (!m) return undefined;
  const f: SearchFilter = {};
  let any = false;
  if (m.lang_allow?.length) { f.lang = m.lang_allow; any = true; }
  if (m.post_type === "top_level") { f.isReply = false; any = true; }
  if (m.post_type === "replies") { f.isReply = true; any = true; }
  if (m.require_media) { f.hasImages = true; any = true; }
  else if (m.exclude_media) { f.hasImages = false; any = true; }
  if (m.require_video) { f.hasVideo = true; any = true; }
  else if (m.exclude_video) { f.hasVideo = false; any = true; }
  if (m.require_link) { f.hasExternalLink = true; any = true; }
  else if (m.exclude_links) { f.hasExternalLink = false; any = true; }
  if (m.require_quote) { f.hasQuote = true; any = true; }
  if (m.hashtag_include?.length) {
    f.hashtags = m.hashtag_include.map((t) => t.toLowerCase());
    any = true;
  }
  if (m.block_labels?.length) { f.selfLabelsDeny = m.block_labels; any = true; }
  if (m.exclude_likely_nsfw) { f.excludeLikelyNsfw = true; any = true; }
  if (m.min_like_count > 0) { f.minLikeCount = m.min_like_count; any = true; }
  if (m.min_repost_count > 0) { f.minRepostCount = m.min_repost_count; any = true; }
  if (m.min_reply_count > 0) { f.minReplyCount = m.min_reply_count; any = true; }

  const bounds = timeWindowToBounds(m);
  if (bounds.afterUs !== undefined) { f.createdAfterUs = bounds.afterUs; any = true; }
  if (bounds.beforeUs !== undefined) { f.createdBeforeUs = bounds.beforeUs; any = true; }

  return any ? f : undefined;
}
