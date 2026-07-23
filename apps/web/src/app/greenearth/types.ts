// Shared types for the Green Earth feed prototype (throwaway).
// Type-only module so both the server route and the client page can import it
// without pulling server-only code into the browser bundle.

import type { Post } from "@/app/curator/feedTypes";

export interface GeneratorSpec {
  name: string;
  weight: number;
}

export interface GEFeedRequest {
  handle: string;
  generators: GeneratorSpec[];
  ranker: string | null;
  diversify: boolean;
  numCandidates: number;
  videoOnly: boolean;
}

// Posts come back in the curator's own `Post` shape so we can render them with
// the real <PostCard>. Green Earth's recommendation metadata is folded in:
//   score        → candidate score
//   rerank_score → ranker score (when a ranker ran)
//   rerank_reason→ the generator that produced the post
// (all three surface in PostCard's debug row when showDebug is on).
export interface GEFeedResponse {
  did: string;
  stages: string[];
  posts: Post[];
}
