"use client";

import { useState, useEffect, type RefObject } from "react";
import BranchTopicsHeader from "@/components/BranchTopicsHeader";
import type { BranchOption } from "@/lib/branch";
import { authedFetch } from "@/lib/authed-fetch";
import { useCurator } from "@/app/curator/curatorContext";

const BRANCH_OVERLAY_CLOSE_MS = 240; // keep in sync with .cur-mock-branch-out in curator.css

interface Post {
  uri: string;
  author_handle: string | null;
  author_display_name: string | null;
  author_did: string;
  text: string;
}

export default function MockBranchOverlay({
  options,
  branchFeedId,
  feedName,
  panelRef,
  onBack,
}: {
  options: BranchOption[] | null;
  branchFeedId?: number;
  feedName?: string;
  panelRef: RefObject<HTMLDivElement | null>;
  onBack: () => void;
}) {
  const {
    setPipelineStage,
    setPipelineCandidates,
    setPipelineHits,
    setPipelineImages,
    setPipelineModel,
    setPipelineThinkingEnabled,
    setBranchOverlayName,
    setActivePostCount,
  } = useCurator();

  const [branchPosts, setBranchPosts] = useState<Post[] | null>(null);

  // Update the topbar title when the feed name is known.
  useEffect(() => {
    if (feedName) setBranchOverlayName(feedName);
  }, [feedName, setBranchOverlayName]);

  useEffect(() => {
    if (!branchFeedId) return;
    // Start at "searching" immediately so the PipelineLoader appears in the
    // topbar right away — prevents the parent feed's post count badge from
    // flashing during the gap before the first SSE event arrives.
    setPipelineStage("searching");
    setActivePostCount(0);
    setPipelineCandidates(undefined); setPipelineHits(undefined); setPipelineImages(undefined);
    setPipelineModel(undefined); setPipelineThinkingEnabled(undefined);
    setBranchPosts(null);

    const controller = new AbortController();

    authedFetch(`/api/feed-preview/stream?feedId=${branchFeedId}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        const reader = res.body?.getReader();
        if (!reader) return;
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.event === "stage") {
                if (ev.stage === "searching") {
                  setPipelineStage("searching");
                } else if (ev.stage === "thinking" || ev.stage === "ranking") {
                  setPipelineStage(ev.stage);
                  if (typeof ev.candidates === "number") setPipelineCandidates(ev.candidates);
                  if (typeof ev.hits === "number") setPipelineHits(ev.hits);
                  if (typeof ev.images === "number") setPipelineImages(ev.images);
                  if (typeof ev.model === "string") setPipelineModel(ev.model);
                  if (typeof ev.thinking_enabled === "boolean") setPipelineThinkingEnabled(ev.thinking_enabled);
                }
              } else if (ev.event === "done") {
                setPipelineStage(ev.cached ? "idle" : "done");
                if (Array.isArray(ev.posts)) setBranchPosts(ev.posts);
              }
            } catch { /* skip malformed */ }
          }
        }
      })
      .catch((err) => {
        if (err?.name !== "AbortError") setPipelineStage("idle");
      });

    return () => controller.abort();
  }, [branchFeedId]);

  function handleBack() {
    const el = panelRef.current;
    if (el) {
      el.style.transition = `transform ${BRANCH_OVERLAY_CLOSE_MS}ms cubic-bezier(0.4,0,1,1)`;
      el.style.transform = "translateY(100vh)";
    }
    setTimeout(() => {
      if (el) { el.style.transition = ""; el.style.transform = ""; }
      onBack();
    }, BRANCH_OVERLAY_CLOSE_MS);
  }

  return (
    <div className="cur-mock-branch-overlay">
      <button type="button" className="cur-branch-back" onClick={handleBack} aria-label="Back to feed">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Back
      </button>

      {options === null ? (
        <div className="cur-branch-posts-loading">
          Finding topics<span className="cur-dots-inline"><span /><span /><span /></span>
        </div>
      ) : (
        <BranchTopicsHeader options={options} />
      )}

      {branchPosts && (
        <div className="cur-mock-branch-posts">
          {branchPosts.map((post) => {
            const author = post.author_display_name?.trim() || post.author_handle || post.author_did.slice(0, 12) + "…";
            return (
              <div key={post.uri} className="cur-mock-branch-post">
                <p className="cur-mock-branch-author">{author}</p>
                <p className="cur-mock-branch-text">{post.text}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
