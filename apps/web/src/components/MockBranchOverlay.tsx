"use client";

import { useState, useEffect, type RefObject } from "react";
import BranchTopicsHeader from "@/components/BranchTopicsHeader";
import FeedPipelineLoader from "@/components/FeedPipelineLoader";
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
  inline = false,
}: {
  options: BranchOption[] | null;
  branchFeedId?: number;
  feedName?: string;
  panelRef?: RefObject<HTMLDivElement | null>;
  onBack: () => void;
  // Inline mode renders the overlay in normal document flow (the fold model)
  // rather than inside a fixed panel that slides up from the bottom.
  inline?: boolean;
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
    // Start at "searching" immediately so the pipeline loader appears in the
    // overlay right away — prevents the parent feed's post count badge from
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
          // The endpoint emits NDJSON (one JSON object per line) — NOT SSE, so
          // there is no "data: " prefix. Parse each complete line directly;
          // keep the trailing partial line buffered for the next chunk.
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;
            try {
              const ev = JSON.parse(line);
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
                // "skipped_rerank" needs no handling — the "done" event follows.
              } else if (ev.event === "done") {
                setPipelineStage(ev.cached ? "idle" : "done");
                if (Array.isArray(ev.posts)) setBranchPosts(ev.posts);
              } else if (ev.event === "error") {
                // Don't leave the loader pinned at "searching" if the pipeline
                // failed — surface idle so the UI isn't stuck.
                console.warn("[branch-overlay] stream error:", ev.message);
                setPipelineStage("idle");
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
    // Inline (fold model): no fixed panel to slide away — the parent restores
    // the feed and animates the receded posts back in.
    if (inline) {
      onBack();
      return;
    }
    const el = panelRef?.current;
    if (el) {
      // Panel is position:fixed — translateY(100vh) always exits below the viewport.
      el.style.transition = `transform ${BRANCH_OVERLAY_CLOSE_MS}ms cubic-bezier(0.4,0,1,1)`;
      el.style.transform = "translateY(100vh)";
    }
    setTimeout(() => {
      if (el) { el.style.transition = ""; el.style.transform = ""; el.style.display = "none"; }
      onBack();
    }, BRANCH_OVERLAY_CLOSE_MS);
  }

  return (
    <div className={`cur-mock-branch-overlay${inline ? " cur-mock-branch-inline" : ""}`}>
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

      {/* Same pipeline loader as the main feed — driven by the shared pipeline
          state this overlay sets while streaming the branch preview. */}
      <FeedPipelineLoader />

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
