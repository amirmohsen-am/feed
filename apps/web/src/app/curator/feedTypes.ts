// Shared feed types, lifted out of CuratorWorkbench so the feed shell
// (CuratorWorkbench), the recursive FeedView, the PostCard, and the
// FeedActionsProvider can all reference them without import cycles.

export interface Post {
  uri: string;
  author_did: string;
  text: string;
  score: number;
  rerank_score?: number;
  rerank_reason?: string;
  like_nsfw?: boolean;
  indexed_at: string;
  author_handle: string | null;
  author_display_name: string | null;
  author_avatar_cid: string | null;
  like_count: number;
  repost_count: number;
  reply_count: number;
  quote_count: number;
  external_uri: string | null;
  external_title: string | null;
  external_desc: string | null;
  external_thumb: string | null;
  quote_uri: string | null;
  has_images: boolean;
  has_video: boolean;
  image_count: number;
  image_alts: string[];
  image_urls: string[];
  video_thumbnail: string | null;
  is_reply: boolean;
  reply_parent_uri: string | null;
}

// Source post embedded in a branched feed's chat (from /api/chat).
export interface ChatSourcePost {
  uri: string;
  bsky_url: string | null;
  text: string;
  author_handle: string | null;
  author_display_name: string | null;
}
