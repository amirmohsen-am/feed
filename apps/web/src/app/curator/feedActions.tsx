"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { authedFetch } from "@/lib/authed-fetch";
import type { PendingAction } from "@/lib/pending-action";
import { useCurator } from "./curatorContext";
import type { Post } from "./feedTypes";

// Cross-cutting, feed-agnostic actions + caches shared by every PostCard,
// regardless of which (possibly nested) FeedView renders it. Lifted out of
// CuratorWorkbench so the recursive feed tree has a single owner for Bluesky
// engagement, the image lightbox, the on-demand auth prompt, and the
// URI-keyed quote + AI-label caches.

interface LikeEntry { liked: boolean; likeUri?: string; pending: boolean }
interface RepostEntry { reposted: boolean; repostUri?: string; pending: boolean }
interface CountDelta { replies?: number; quotes?: number }
interface QuotedExternal { uri: string; title: string; desc: string; thumb: string | null }
interface QuotedPost {
  text: string;
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
  // The quoted post's own media, so the quote block mirrors a real Bluesky post.
  images: string[];
  imageAlts: string[];
  videoThumbnail: string | null;
  videoPlaylist: string | null;
  external: QuotedExternal | null;
}
interface AiLabel { ai_generated: boolean; scores: number[] }

// Hydrated embed view returned by app.bsky.feed.getPosts for a quoted post.
interface BskyEmbedView {
  $type?: string;
  external?: { uri?: string; title?: string; description?: string; thumb?: string };
  images?: Array<{ thumb?: string; fullsize?: string; alt?: string }>;
  thumbnail?: string;
  playlist?: string;
  // recordWithMedia nests the media one level deeper.
  media?: {
    $type?: string;
    external?: { uri?: string; title?: string; description?: string; thumb?: string };
    images?: Array<{ thumb?: string; fullsize?: string; alt?: string }>;
    thumbnail?: string;
    playlist?: string;
  };
}

// Pull images / video / external link out of a quoted post's hydrated embed.
function parseQuotedEmbed(embed: BskyEmbedView | undefined): {
  images: string[];
  imageAlts: string[];
  videoThumbnail: string | null;
  videoPlaylist: string | null;
  external: QuotedExternal | null;
} {
  const empty = { images: [], imageAlts: [], videoThumbnail: null, videoPlaylist: null, external: null };
  if (!embed) return empty;
  const media = embed.media ?? embed;
  const type = media.$type;

  const imgs = media.images ?? [];
  const images = imgs
    .map((i) => i.thumb ?? i.fullsize ?? null)
    .filter((u): u is string => typeof u === "string" && u.length > 0);
  const imageAlts = imgs.map((i) => i.alt ?? "");

  let videoThumbnail: string | null = null;
  let videoPlaylist: string | null = null;
  if (type === "app.bsky.embed.video#view") {
    videoThumbnail = media.thumbnail ?? null;
    videoPlaylist = media.playlist ?? null;
  }

  let external: QuotedExternal | null = null;
  if (type === "app.bsky.embed.external#view" && media.external?.uri) {
    external = {
      uri: media.external.uri,
      title: media.external.title ?? "",
      desc: media.external.description ?? "",
      thumb: media.external.thumb ?? null,
    };
  }

  return { images, imageAlts, videoThumbnail, videoPlaylist, external };
}

interface FeedActionsValue {
  // Bluesky engagement
  likeState: Record<string, LikeEntry>;
  repostState: Record<string, RepostEntry>;
  countDelta: Record<string, CountDelta>;
  toggleLike: (uri: string, currentlyLiked: boolean, currentLikeUri?: string) => void;
  toggleRepost: (uri: string, currentlyReposted: boolean, currentRepostUri?: string) => void;
  openComposer: (uri: string, kind: "reply" | "quote") => void;
  // Image lightbox
  openLightbox: (urls: string[], index: number) => void;
  // URI-keyed hydration caches
  quotedPosts: Record<string, QuotedPost | null>;
  aiLabels: Record<string, AiLabel>;
  // A FeedView registers its posts here so quotes + AI labels get hydrated.
  trackPosts: (posts: Post[]) => void;
}

const FeedActionsContext = createContext<FeedActionsValue | null>(null);

export function useFeedActions(): FeedActionsValue {
  const v = useContext(FeedActionsContext);
  if (!v) throw new Error("useFeedActions must be used inside <FeedActionsProvider>");
  return v;
}

export function FeedActionsProvider({ children }: { children: React.ReactNode }) {
  const { profile, bskyOAuthReady, viewMode, openConnectModal, resumeAction, clearResumeAction } = useCurator();
  // OAuth session required for repo writes; app password is a legacy fallback.
  const hasBskyAuth = bskyOAuthReady || !!profile.bskyAppPassword;

  // ── Bluesky engagement ──────────────────────────────────────────
  const [likeState, setLikeState] = useState<Record<string, LikeEntry>>({});
  const [repostState, setRepostState] = useState<Record<string, RepostEntry>>({});
  const [countDelta, setCountDelta] = useState<Record<string, CountDelta>>({});

  // Refs so the optimistic-revert closures read current state without
  // re-creating the callbacks on every engagement change.
  const likeStateRef = useRef(likeState);
  const repostStateRef = useRef(repostState);
  useEffect(() => { likeStateRef.current = likeState; }, [likeState]);
  useEffect(() => { repostStateRef.current = repostState; }, [repostState]);

  // ── On-demand Bluesky auth prompt ───────────────────────────────
  // Unauthenticated engagement opens the shared connect/create modal (owned
  // by CuratorShell) with the attempted action stashed for auto-resume after
  // the OAuth round trip.
  const ACTION_REASONS: Record<PendingAction["type"], string> = {
    like: "Connect to like posts from here.",
    repost: "Connect to repost from here.",
    reply: "Connect to reply from here.",
    quote: "Connect to quote posts from here.",
    publish: "Connect to publish this feed to Bluesky.",
  };

  const ensureBskyAuth = useCallback(
    (pending?: PendingAction): boolean => {
      if (!hasBskyAuth) {
        openConnectModal({
          reason: pending ? ACTION_REASONS[pending.type] : undefined,
          pendingAction: pending ?? null,
        });
        return false;
      }
      return true;
    },
    // ACTION_REASONS is a per-render constant of literals.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasBskyAuth, openConnectModal]
  );

  const toggleLike = useCallback(
    async (postUri: string, currentlyLiked: boolean, currentLikeUri?: string) => {
      if (!ensureBskyAuth(currentlyLiked ? undefined : { type: "like", uri: postUri })) return;
      const prev = likeStateRef.current[postUri];
      setLikeState((s) => ({
        ...s,
        [postUri]: { liked: !currentlyLiked, likeUri: currentlyLiked ? undefined : currentLikeUri, pending: true },
      }));
      try {
        const res = await authedFetch("/api/bsky/like", {
          method: "POST",
          body: JSON.stringify({
            uri: postUri,
            action: currentlyLiked ? "unlike" : "like",
            ...(currentlyLiked && currentLikeUri ? { likeUri: currentLikeUri } : {}),
          }),
        });
        if (res.ok) {
          const data = await res.json();
          setLikeState((s) => ({
            ...s,
            [postUri]: { liked: !currentlyLiked, likeUri: data.likeUri, pending: false },
          }));
        } else {
          setLikeState((s) => ({ ...s, [postUri]: prev ?? { liked: currentlyLiked, likeUri: currentLikeUri, pending: false } }));
        }
      } catch {
        setLikeState((s) => ({ ...s, [postUri]: prev ?? { liked: currentlyLiked, likeUri: currentLikeUri, pending: false } }));
      }
    },
    [ensureBskyAuth]
  );

  const toggleRepost = useCallback(
    async (postUri: string, currentlyReposted: boolean, currentRepostUri?: string) => {
      if (!ensureBskyAuth(currentlyReposted ? undefined : { type: "repost", uri: postUri })) return;
      const prev = repostStateRef.current[postUri];
      setRepostState((s) => ({
        ...s,
        [postUri]: { reposted: !currentlyReposted, repostUri: currentlyReposted ? undefined : currentRepostUri, pending: true },
      }));
      try {
        const res = await authedFetch("/api/bsky/repost", {
          method: "POST",
          body: JSON.stringify({
            uri: postUri,
            action: currentlyReposted ? "unrepost" : "repost",
            ...(currentlyReposted && currentRepostUri ? { repostUri: currentRepostUri } : {}),
          }),
        });
        if (res.ok) {
          const data = await res.json();
          setRepostState((s) => ({
            ...s,
            [postUri]: { reposted: !currentlyReposted, repostUri: data.repostUri, pending: false },
          }));
        } else {
          setRepostState((s) => ({ ...s, [postUri]: prev ?? { reposted: currentlyReposted, repostUri: currentRepostUri, pending: false } }));
        }
      } catch {
        setRepostState((s) => ({ ...s, [postUri]: prev ?? { reposted: currentlyReposted, repostUri: currentRepostUri, pending: false } }));
      }
    },
    [ensureBskyAuth]
  );

  // ── Reply / quote composer ──────────────────────────────────────
  const [composer, setComposer] = useState<{ uri: string; kind: "reply" | "quote" } | null>(null);
  const [composerText, setComposerText] = useState("");
  const [composerError, setComposerError] = useState("");
  const [composerPending, setComposerPending] = useState(false);

  const openComposer = useCallback(
    (postUri: string, kind: "reply" | "quote") => {
      if (!ensureBskyAuth({ type: kind, uri: postUri })) return;
      setComposer({ uri: postUri, kind });
      setComposerText("");
      setComposerError("");
    },
    [ensureBskyAuth]
  );

  // ── Resume the action stashed before the OAuth redirect ─────────
  // Fires once, only after the refreshed profile confirms auth. Reply/quote
  // reopen the composer (never auto-post text); publish is handled by the
  // shell. The stash was already consumed from sessionStorage by the layout,
  // so this can never double-fire across reloads.
  useEffect(() => {
    if (!resumeAction || resumeAction.type === "publish") return;
    if (!hasBskyAuth) return;
    clearResumeAction();
    if (resumeAction.type === "like") {
      toggleLike(resumeAction.uri, false);
    } else if (resumeAction.type === "repost") {
      toggleRepost(resumeAction.uri, false);
    } else {
      openComposer(resumeAction.uri, resumeAction.type);
    }
  }, [resumeAction, hasBskyAuth, clearResumeAction, toggleLike, toggleRepost, openComposer]);

  async function submitComposer() {
    if (!composer || !composerText.trim()) return;
    setComposerPending(true);
    setComposerError("");
    try {
      const res = await authedFetch("/api/bsky/compose", {
        method: "POST",
        body: JSON.stringify({ uri: composer.uri, kind: composer.kind, text: composerText }),
        suppressErrorToast: true,
      });
      const data = await res.json();
      if (!res.ok) {
        setComposerError(data.error || "Failed to post");
        return;
      }
      const field = composer.kind === "reply" ? "replies" : "quotes";
      setCountDelta((s) => ({
        ...s,
        [composer.uri]: { ...s[composer.uri], [field]: (s[composer.uri]?.[field] ?? 0) + 1 },
      }));
      setComposer(null);
      setComposerText("");
    } finally {
      setComposerPending(false);
    }
  }

  // ── Image lightbox ──────────────────────────────────────────────
  const [lightbox, setLightbox] = useState<{ urls: string[]; index: number } | null>(null);
  const openLightbox = useCallback((urls: string[], index: number) => setLightbox({ urls, index }), []);
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
      else if (e.key === "ArrowLeft") setLightbox((lb) => lb ? { ...lb, index: (lb.index - 1 + lb.urls.length) % lb.urls.length } : null);
      else if (e.key === "ArrowRight") setLightbox((lb) => lb ? { ...lb, index: (lb.index + 1) % lb.urls.length } : null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  // ── Quote + AI-label hydration ──────────────────────────────────
  // Every FeedView registers its posts via trackPosts; the caches are keyed by
  // URI so the root feed and every nested branch share one fetch per post.
  const [tracked, setTracked] = useState<Map<string, Post>>(() => new Map());
  const trackPosts = useCallback((posts: Post[]) => {
    setTracked((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const p of posts) {
        if (!next.has(p.uri)) { next.set(p.uri, p); changed = true; }
      }
      return changed ? next : prev;
    });
  }, []);

  // Quoted posts: hydrated via the public AppView so the quote block shows the
  // actual quoted content. null = unavailable; undefined = not loaded yet. Only
  // card view renders the custom quote block (embed view uses Bluesky's embed).
  const [quotedPosts, setQuotedPosts] = useState<Record<string, QuotedPost | null>>({});
  useEffect(() => {
    if (viewMode !== "card") return;
    const missing = [
      ...new Set(
        [...tracked.values()]
          .map((p) => p.quote_uri)
          .filter((u): u is string => !!u && quotedPosts[u] === undefined)
      ),
    ];
    if (missing.length === 0) return;

    const ac = new AbortController();
    (async () => {
      // app.bsky.feed.getPosts caps at 25 URIs per call
      for (let i = 0; i < missing.length; i += 25) {
        const batch = missing.slice(i, i + 25);
        const params = new URLSearchParams();
        for (const u of batch) params.append("uris", u);
        try {
          const res = await fetch(
            `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?${params}`,
            { signal: ac.signal }
          );
          const data = res.ok
            ? ((await res.json()) as {
                posts?: {
                  uri: string;
                  author?: { handle?: string; displayName?: string; avatar?: string };
                  record?: { text?: string };
                  embed?: BskyEmbedView;
                }[];
              })
            : { posts: [] };
          setQuotedPosts((prev) => {
            const next = { ...prev };
            for (const u of batch) next[u] = null; // default: unavailable
            for (const p of data.posts ?? []) {
              next[p.uri] = {
                text: p.record?.text ?? "",
                handle: p.author?.handle ?? null,
                displayName: p.author?.displayName ?? null,
                avatar: p.author?.avatar ?? null,
                ...parseQuotedEmbed(p.embed),
              };
            }
            return next;
          });
        } catch {
          if (ac.signal.aborted) return;
        }
      }
    })();
    return () => ac.abort();
  }, [viewMode, tracked, quotedPosts]);

  // AI-generated labels for posts with images or video.
  const [aiLabels, setAiLabels] = useState<Record<string, AiLabel>>({});
  useEffect(() => {
    const mediaPosts = [...tracked.values()].filter(
      (p) => (p.has_images && p.image_urls.length > 0) || (p.has_video && p.video_thumbnail)
    );
    const pending = mediaPosts.filter((p) => aiLabels[p.uri] === undefined);
    if (pending.length === 0) return;
    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        pending.map(async (p) => {
          try {
            const params = new URLSearchParams({ uri: p.uri });
            if (p.image_urls.length > 0) params.set("image_urls", p.image_urls.join(","));
            if (p.has_video && p.video_thumbnail) params.set("video_thumbnail", p.video_thumbnail);
            const res = await authedFetch(`/api/ai-label?${params}`);
            if (!res.ok) return null;
            const data = await res.json();
            return { uri: p.uri, ai_generated: data.ai_generated as boolean, scores: data.scores as number[] };
          } catch {
            return null;
          }
        })
      );
      if (cancelled) return;
      setAiLabels((prev) => {
        const next = { ...prev };
        for (const r of results) {
          if (r) next[r.uri] = { ai_generated: r.ai_generated, scores: r.scores };
        }
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [tracked, aiLabels]);

  const value: FeedActionsValue = {
    likeState,
    repostState,
    countDelta,
    toggleLike,
    toggleRepost,
    openComposer,
    openLightbox,
    quotedPosts,
    aiLabels,
    trackPosts,
  };

  return (
    <FeedActionsContext.Provider value={value}>
      {children}

      {/* Image lightbox */}
      {lightbox && (
        <div className="cur-lightbox" onClick={() => setLightbox(null)}>
          <button
            className="cur-lightbox-close"
            onClick={() => setLightbox(null)}
            aria-label="Close lightbox"
          >
            ✕
          </button>
          {lightbox.urls.length > 1 && (
            <>
              <button
                className="cur-lightbox-nav cur-lightbox-prev"
                aria-label="Previous image"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightbox((lb) =>
                    lb ? { ...lb, index: (lb.index - 1 + lb.urls.length) % lb.urls.length } : null
                  );
                }}
              >
                ‹
              </button>
              <button
                className="cur-lightbox-nav cur-lightbox-next"
                aria-label="Next image"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightbox((lb) =>
                    lb ? { ...lb, index: (lb.index + 1) % lb.urls.length } : null
                  );
                }}
              >
                ›
              </button>
            </>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox.urls[lightbox.index]}
            alt=""
            className="cur-lightbox-img"
            referrerPolicy="no-referrer"
            onClick={(e) => e.stopPropagation()}
          />
          {lightbox.urls.length > 1 && (
            <div className="cur-lightbox-counter">
              {lightbox.index + 1} / {lightbox.urls.length}
            </div>
          )}
        </div>
      )}

      {/* Reply / quote composer */}
      {composer && (
        <div className="cur-bsky-auth-overlay" onClick={() => !composerPending && setComposer(null)}>
          <div className="cur-bsky-auth-modal cur-compose-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{composer.kind === "reply" ? "Reply on Bluesky" : "Quote on Bluesky"}</h3>
            <p>
              {composer.kind === "reply"
                ? "Your reply will be posted to Bluesky from your connected account."
                : "Add your commentary — the original post will be embedded in your quote."}
            </p>
            <textarea
              value={composerText}
              onChange={(e) => {
                setComposerText(e.target.value.slice(0, 300));
                setComposerError("");
              }}
              placeholder={composer.kind === "reply" ? "Write a reply…" : "Add a quote comment…"}
              rows={4}
              autoFocus
              className="cur-compose-textarea"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submitComposer();
                }
              }}
            />
            <div className="cur-compose-meta">
              <span>{composerText.length}/300</span>
            </div>
            {composerError && <div className="cur-bsky-auth-error">{composerError}</div>}
            <div className="cur-bsky-auth-actions">
              <button
                type="button"
                className="cur-bsky-auth-cancel"
                onClick={() => setComposer(null)}
                disabled={composerPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cur-bsky-auth-submit"
                onClick={submitComposer}
                disabled={composerPending || !composerText.trim()}
              >
                {composerPending ? "Posting…" : composer.kind === "reply" ? "Reply" : "Quote"}
              </button>
            </div>
          </div>
        </div>
      )}

    </FeedActionsContext.Provider>
  );
}
