"use client";

/**
 * Bluesky-style placeholder cards shown while a feed is curating and there are
 * no posts on screen yet (initial open, feed switch, chat-driven re-curation,
 * branch load). Sits below the PipelineLoader note. An in-place refresh of a
 * feed that already has posts dims the existing posts instead (see FeedView),
 * so this never replaces visible results.
 *
 * Pure presentational shimmer — styled entirely by the .cur-skel-* rules in
 * curator.css. aria-hidden: the PipelineLoader already announces loading.
 */
export function FeedSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="cur-skel-wrap" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="cur-skel-card">
          <div className="cur-skel-head">
            <div className="cur-skel-av" />
            <div style={{ flex: 1 }}>
              <div className="cur-skel-line" style={{ width: "38%" }} />
              <div className="cur-skel-line" style={{ width: "22%", marginBottom: 0 }} />
            </div>
          </div>
          <div className="cur-skel-line" />
          <div className="cur-skel-line" style={{ width: "92%" }} />
          <div className="cur-skel-line" style={{ width: "66%", marginBottom: 0 }} />
        </div>
      ))}
    </div>
  );
}
