export interface Post {
  uri: string;
  text: string;
  author_did: string;
  author_handle: string | null;
  author_display_name: string | null;
  author_avatar_cid: string | null;
  score: number;
  rerank_score?: number;
  rerank_reason?: string;
  like_count: number;
  repost_count: number;
  reply_count: number;
  quote_count: number;
  external_uri: string | null;
  external_title: string | null;
  external_desc: string | null;
  external_thumb: string | null;
  has_images: boolean;
  has_video: boolean;
  image_count: number;
  image_alts: string[];
  image_urls: string[];
  video_thumbnail: string | null;
  is_reply: boolean;
  reply_parent_uri: string | null;
  indexed_at: string;
}

export interface MechanicalFilters {
  post_type: 'all' | 'top_level' | 'replies';
  lang_allow: string[];
  require_media: boolean;
  exclude_media: boolean;
  require_video: boolean;
  exclude_video: boolean;
  require_link: boolean;
  exclude_links: boolean;
  require_quote: boolean;
  hashtag_include: string[];
  min_like_count: number;
  min_repost_count: number;
  min_reply_count: number;
  time_window: '1h' | '24h' | '3d' | 'custom';
  created_after_iso?: string;
  created_before_iso?: string;
}

export interface Feed {
  id: number;
  name: string;
  subqueries: string[];
  rerank_prompt: string;
  mechanical_filters: MechanicalFilters;
  candidate_budget: number;
  rerank_model: string;
  rerank_thinking_enabled: boolean;
  published_rkey: string | null;
  is_active: boolean;
  color: string | null;
  parent_feed_id: number | null;
  source_post_uri: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type FeedStage = 'searching' | 'thinking' | 'ranking' | 'skipped_rerank';
