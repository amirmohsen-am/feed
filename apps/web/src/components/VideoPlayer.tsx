"use client";

import { useEffect, useRef, useState } from "react";

// Inline HLS video player for Bluesky video embeds. Shows the poster frame with
// a play overlay; on first play it lazy-loads hls.js (or uses native HLS on
// Safari) and attaches the .m3u8 playlist. Used by both the main post card and
// the nested quoted-post block.
//
// `compact` renders the smaller variant used inside a quote embed.
export default function VideoPlayer({
  playlist,
  thumbnail,
  compact = false,
  children,
}: {
  playlist: string;
  thumbnail: string | null;
  compact?: boolean;
  // Overlay content (e.g. the AI-generated badge), rendered above the poster.
  children?: React.ReactNode;
}) {
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!playing) return;
    const video = videoRef.current;
    if (!video) return;

    // Safari (and iOS) play HLS natively — no library needed.
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = playlist;
      video.play().catch(() => { /* autoplay may be blocked; controls remain */ });
      return;
    }

    let hls: import("hls.js").default | null = null;
    let cancelled = false;
    (async () => {
      const { default: Hls } = await import("hls.js");
      if (cancelled || !videoRef.current) return;
      if (Hls.isSupported()) {
        hls = new Hls();
        hls.loadSource(playlist);
        hls.attachMedia(videoRef.current);
        videoRef.current.play().catch(() => { /* controls remain */ });
      } else {
        // No MSE and no native HLS — fall back to the raw URL.
        videoRef.current.src = playlist;
      }
    })();

    return () => {
      cancelled = true;
      if (hls) hls.destroy();
    };
  }, [playing, playlist]);

  return (
    // Stop pointer events from bubbling to the swipe handler so scrubbing the
    // video timeline doesn't start a card swipe.
    <div
      className={`cur-post-video${compact ? " compact" : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
      {playing ? (
        /* eslint-disable-next-line jsx-a11y/media-has-caption */
        <video
          ref={videoRef}
          className="cur-post-video-el"
          poster={thumbnail ?? undefined}
          controls
          playsInline
        />
      ) : (
        <button
          type="button"
          className="cur-post-video-poster"
          onClick={(e) => {
            e.preventDefault();
            setPlaying(true);
          }}
          aria-label="Play video"
        >
          {thumbnail && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
          )}
          <span className="cur-post-video-play" aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </button>
      )}
    </div>
  );
}
