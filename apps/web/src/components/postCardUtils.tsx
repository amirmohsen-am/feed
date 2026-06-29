"use client";

import { useEffect, useRef } from "react";

// Presentational helpers + the Bluesky embed host, lifted out of
// CuratorWorkbench so PostCard and the feed shell can share them.

export function avatarUrl(did: string, cid: string | null): string | null {
  if (!cid) return null;
  return `https://cdn.bsky.app/img/avatar_thumbnail/plain/${did}/${cid}@jpeg`;
}

export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d`;
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function formatAbsoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function externalHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function bskyUrlFromUri(uri: string): string | undefined {
  const m = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : undefined;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

declare global {
  interface Window {
    bluesky?: { scan: (root?: Element | Document) => void };
  }
}

const HASHTAG_RE = /(#[\wÀ-ɏ]+)/g;

export function renderPostText(text: string): React.ReactNode[] {
  const parts = text.split(HASHTAG_RE);
  return parts.map((part, i) => {
    if (HASHTAG_RE.test(part)) {
      const tag = part.slice(1);
      return (
        <a
          key={i}
          href={`https://bsky.app/hashtag/${encodeURIComponent(tag)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="cur-post-hashtag"
        >
          {part}
        </a>
      );
    }
    return part;
  });
}

// Bluesky's embed.js replaces the `.bluesky-embed` node with an <iframe>. If
// React owns that node, swapping view modes makes React try to remove a node
// the script already replaced → "removeChild: not a child" crash. So we render
// only an empty host <div> that React controls and inject the embed markup
// imperatively — React never reconciles the script-mutated node.
export function BlueskyEmbed({
  uri,
  text,
  url,
}: {
  uri: string;
  text: string;
  url: string | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const link = url
      ? `<p><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">View on Bluesky</a></p>`
      : "";
    host.innerHTML =
      `<div class="bluesky-embed" data-bluesky-uri="${escapeHtml(uri)}" data-bluesky-embed-color-mode="light">` +
      `<p>${escapeHtml(text)}</p>${link}</div>`;
    const t = setTimeout(() => window.bluesky?.scan?.(host), 0);
    return () => {
      clearTimeout(t);
      host.innerHTML = "";
    };
  }, [uri, text, url]);
  return <div ref={hostRef} />;
}
