"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import PostCard from "./PostCard";
import { useFeedActions } from "@/app/curator/feedActions";
import type { Post } from "@/app/curator/feedTypes";
import { settleFoldEls } from "./postFold";

// A PostCard that mounts folded into the same compact preview as the pinned
// branch-source post (measured max-height + dissolve mask + shrunken avatar),
// with PostCard's built-in chevron to expand/collapse. Used by the chat to
// render the posts a swipe reacted to.
export default function CollapsedPostCard({ post }: { post: Post }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(true);
  const { trackPosts } = useFeedActions();

  // Register with the shared per-URI caches so quoted posts + AI labels
  // hydrate exactly like they do for feed posts.
  useEffect(() => {
    trackPosts([post]);
  }, [post, trackPosts]);

  const applyFold = useCallback((c: boolean, opts?: { instant?: boolean }) => {
    const wrap = wrapRef.current;
    const foldable = wrap?.querySelector(".cur-post-foldable") as HTMLElement | null;
    const avatar = wrap?.querySelector(".cur-post-avatar") as HTMLElement | null;
    if (!foldable) return;
    settleFoldEls(foldable, avatar, c, opts);
  }, []);

  // Land the folded state before first paint — no open→fold flash.
  useLayoutEffect(() => {
    applyFold(true, { instant: true });
  }, [applyFold]);

  return (
    <div ref={wrapRef} className="cur-chat-postcard">
      <PostCard
        post={post}
        collapsible
        collapsed={collapsed}
        onToggleCollapse={() => {
          const next = !collapsed;
          setCollapsed(next);
          applyFold(next);
        }}
      />
    </div>
  );
}
