"use client";

import { memo } from "react";
import { useCurator } from "@/app/curator/curatorContext";
import { useFeedActions } from "@/app/curator/feedActions";
import type { Post } from "@/app/curator/feedTypes";
import VideoPlayer from "./VideoPlayer";
import {
  avatarUrl,
  externalHost,
  formatAbsoluteTime,
  formatCount,
  formatRelativeTime,
  renderPostText,
} from "./postCardUtils";

// The engagement footer (reply / repost / like / quote / open) — shared by the
// card view here and the Bluesky-embed view in FeedView.
export function EngageFooter({ post, bskyUrl }: { post: Post; bskyUrl: string | null }) {
  const { likeState, repostState, countDelta, toggleLike, toggleRepost, openComposer } = useFeedActions();
  return (
    <footer className="cur-post-stats">
      <button
        type="button"
        className="cur-post-stat cur-post-engage-btn"
        title="Reply"
        onClick={() => openComposer(post.uri, "reply")}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
        {formatCount(post.reply_count + (countDelta[post.uri]?.replies ?? 0))}
      </button>
      <button
        type="button"
        className={`cur-post-stat cur-post-engage-btn${repostState[post.uri]?.reposted ? " cur-post-reposted" : ""}`}
        title={repostState[post.uri]?.reposted ? "Undo repost" : "Repost"}
        disabled={repostState[post.uri]?.pending}
        onClick={() => toggleRepost(post.uri, !!repostState[post.uri]?.reposted, repostState[post.uri]?.repostUri)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="17 1 21 5 17 9" />
          <path d="M3 11V9a4 4 0 0 1 4-4h14" />
          <polyline points="7 23 3 19 7 15" />
          <path d="M21 13v2a4 4 0 0 1-4 4H3" />
        </svg>
        {formatCount(post.repost_count + (repostState[post.uri]?.reposted ? 1 : 0))}
      </button>
      <button
        type="button"
        className={`cur-post-stat cur-post-engage-btn cur-post-like-btn ${likeState[post.uri]?.liked ? "cur-post-liked" : ""}`}
        title={likeState[post.uri]?.liked ? "Unlike" : "Like"}
        disabled={likeState[post.uri]?.pending}
        onClick={() => toggleLike(post.uri, !!likeState[post.uri]?.liked, likeState[post.uri]?.likeUri)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill={likeState[post.uri]?.liked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
        </svg>
        {formatCount(post.like_count + (likeState[post.uri]?.liked ? 1 : 0))}
      </button>
      <button
        type="button"
        className="cur-post-stat cur-post-engage-btn"
        title="Quote"
        onClick={() => openComposer(post.uri, "quote")}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 21c3 0 5-2 5-5V7H3v8h4" />
          <path d="M14 21c3 0 5-2 5-5V7h-5v8h4" />
        </svg>
        {formatCount(post.quote_count + (countDelta[post.uri]?.quotes ?? 0))}
      </button>
      {bskyUrl && (
        <a
          href={bskyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="cur-post-open"
          title="Open in Bluesky"
        >
          Open ↗
        </a>
      )}
    </footer>
  );
}

// The card-view post UI, shared by the main feed and every nested branch feed
// so a branch renders identical cards (avatar, embeds, images, engagement) —
// not a stripped-down mockup. Memoized so a feed-level re-render (e.g. starting
// a swipe) doesn't re-render every card's subtree — keeps the gesture smooth.
function PostCard({
  post,
  branchBanner = false,
  branchLeaving = false,
  collapsible = false,
  collapsed = false,
  onToggleCollapse,
  onBranch,
}: {
  post: Post;
  branchBanner?: boolean;
  branchLeaving?: boolean;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onBranch?: () => void;
}) {
  const { showDebug } = useCurator();
  const { quotedPosts, aiLabels, openLightbox } = useFeedActions();

  const bskyUrl = (() => {
    const m = post.uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
    return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
  })();
  const profileUrl = post.author_handle
    ? `https://bsky.app/profile/${post.author_handle}`
    : `https://bsky.app/profile/${post.author_did}`;
  const avatar = avatarUrl(post.author_did, post.author_avatar_cid);
  const displayName =
    post.author_display_name?.trim() ||
    post.author_handle ||
    post.author_did.slice(0, 16) + "…";
  const handleLabel = post.author_handle
    ? `@${post.author_handle}`
    : post.author_did.slice(0, 20) + "…";
  const extHost = externalHost(post.external_uri);
  const replyParentUrl = (() => {
    if (!post.reply_parent_uri) return null;
    const m = post.reply_parent_uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
    return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
  })();

  return (
    <article className={`cur-post-card${collapsible && collapsed ? " cur-post-card-collapsed" : ""}`}>
      {onBranch && (
        <button
          type="button"
          className="cur-post-branch-fab"
          onClick={(e) => { e.stopPropagation(); onBranch(); }}
          aria-label="Dive deeper into this post"
          title="Dive deeper"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="6" cy="6" r="2.4" />
            <circle cx="6" cy="18" r="2.4" />
            <circle cx="18" cy="9" r="2.4" />
            <path d="M6 8.4v7.2M8.2 7 16 8.6M8 17l8-6.6" />
          </svg>
        </button>
      )}
      {branchBanner && (
        <div className={`cur-post-branch-banner${branchLeaving ? " cur-post-branch-banner-leaving" : ""}`}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="6" cy="6" r="2.4" />
            <circle cx="6" cy="18" r="2.4" />
            <circle cx="18" cy="9" r="2.4" />
            <path d="M6 8.4v7.2M8.2 7 16 8.6M8 17l8-6.6" />
          </svg>
          Branched from this post
        </div>
      )}
      {post.is_reply && (
        <div className="cur-post-reply-banner">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="9 17 4 12 9 7" />
            <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
          </svg>
          {replyParentUrl ? (
            <a href={replyParentUrl} target="_blank" rel="noopener noreferrer">
              Replying to a post
            </a>
          ) : (
            <span>Reply</span>
          )}
        </div>
      )}
      <header className="cur-post-card-head">
        <a
          href={profileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="cur-post-avatar"
          aria-label={`Open ${displayName} on Bluesky`}
        >
          {avatar ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={avatar}
              alt=""
              referrerPolicy="no-referrer"
              loading="lazy"
            />
          ) : (
            <span className="cur-post-avatar-fallback" aria-hidden>
              {(displayName[0] || "?").toUpperCase()}
            </span>
          )}
        </a>
        <div className="cur-post-author">
          <a
            href={profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="cur-post-name"
          >
            {displayName}
          </a>
          <span className="cur-post-meta">
            <a
              href={profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="cur-post-handle"
            >
              {handleLabel}
            </a>
            <span className="cur-post-meta-sep" aria-hidden>·</span>
            <time
              className="cur-post-time"
              dateTime={post.indexed_at}
              title={formatAbsoluteTime(post.indexed_at)}
            >
              {formatRelativeTime(post.indexed_at)}
            </time>
          </span>
        </div>
      </header>

      {/* Everything below the header collapses as one unit when the card
          folds, so the card keeps its own padding (no text on the border). */}
      <div className="cur-post-foldable">
        <div className="cur-post-card-body">{renderPostText(post.text)}</div>

        {post.external_uri && (
          <a
            className={`cur-post-embed${post.external_thumb ? " has-thumb" : ""}`}
            href={post.external_uri}
            target="_blank"
            rel="noopener noreferrer"
          >
            <div className="cur-post-embed-body">
              <div className="cur-post-embed-host">{extHost || "link"}</div>
              {post.external_title && (
                <div className="cur-post-embed-title">{post.external_title}</div>
              )}
              {post.external_desc && (
                <div className="cur-post-embed-desc">{post.external_desc}</div>
              )}
            </div>
            {post.external_thumb && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={post.external_thumb}
                alt=""
                className="cur-post-embed-thumb"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            )}
          </a>
        )}

        {post.quote_uri && !post.external_uri && (() => {
          const q = quotedPosts[post.quote_uri];
          const m = post.quote_uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
          const qUrl = m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : "#";
          return (
            <div className="cur-post-embed quote">
              {q ? (
                <>
                  {/* Author + text link to the quoted post; media below is
                      interactive on its own (lightbox / inline video). */}
                  <a
                    className="cur-post-quote-link"
                    href={qUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <div className="cur-post-quote-author">
                      {q.avatar && (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={q.avatar}
                          alt=""
                          className="cur-post-quote-avatar"
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      )}
                      <span className="cur-post-quote-name">
                        {q.displayName?.trim() || (q.handle ? `@${q.handle}` : "Quoted post")}
                      </span>
                      {q.handle && q.displayName?.trim() && (
                        <span className="cur-post-quote-handle">@{q.handle}</span>
                      )}
                    </div>
                    {q.text && (
                      <div className="cur-post-quote-text">{q.text}</div>
                    )}
                  </a>

                  {q.images.length > 0 && (
                    <div className={`cur-post-images cur-post-quote-images cur-post-images-${Math.min(q.images.length, 4)}`}>
                      {q.images.slice(0, 4).map((url, i) => (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          key={i}
                          src={url}
                          alt={q.imageAlts[i] || ""}
                          className="cur-post-img"
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          onClick={() => openLightbox(q.images, i)}
                        />
                      ))}
                    </div>
                  )}

                  {q.videoPlaylist && (
                    <VideoPlayer playlist={q.videoPlaylist} thumbnail={q.videoThumbnail} compact />
                  )}

                  {q.external && (
                    <a
                      className={`cur-post-embed cur-post-quote-external${q.external.thumb ? " has-thumb" : ""}`}
                      href={q.external.uri}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <div className="cur-post-embed-body">
                        <div className="cur-post-embed-host">{externalHost(q.external.uri) || "link"}</div>
                        {q.external.title && (
                          <div className="cur-post-embed-title">{q.external.title}</div>
                        )}
                        {q.external.desc && (
                          <div className="cur-post-embed-desc">{q.external.desc}</div>
                        )}
                      </div>
                      {q.external.thumb && (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={q.external.thumb}
                          alt=""
                          className="cur-post-embed-thumb"
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      )}
                    </a>
                  )}
                </>
              ) : q === null ? (
                <a className="cur-post-quote-link" href={qUrl} target="_blank" rel="noopener noreferrer">
                  <div className="cur-post-embed-host">↳ quoted post</div>
                  <div className="cur-post-embed-desc">
                    Quoted post unavailable — open on Bluesky.
                  </div>
                </a>
              ) : (
                <div className="cur-post-embed-host">↳ quoted post…</div>
              )}
            </div>
          );
        })()}

        {post.has_images && post.image_urls.length > 0 && (
          <div className="cur-post-images-wrap">
            {aiLabels[post.uri]?.ai_generated && (
              <span className="cur-ai-label">AI Generated</span>
            )}
            <div className={`cur-post-images cur-post-images-${Math.min(post.image_urls.length, 4)}`}>
              {post.image_urls.slice(0, 4).map((url, i) => (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  key={i}
                  src={url}
                  alt={post.image_alts[i] || ""}
                  className="cur-post-img"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onClick={() => openLightbox(post.image_urls, i)}
                />
              ))}
            </div>
          </div>
        )}
        {post.has_images && post.image_urls.length === 0 && post.image_count > 0 && (
          <div className="cur-post-images-note">
            {post.image_count} image{post.image_count === 1 ? "" : "s"}
          </div>
        )}

        {/* Video — inline HLS player with the AI label overlaid on the poster. */}
        {post.has_video && post.video_playlist && (
          <VideoPlayer playlist={post.video_playlist} thumbnail={post.video_thumbnail}>
            {aiLabels[post.uri]?.ai_generated && (
              <span className="cur-ai-label">AI Generated</span>
            )}
          </VideoPlayer>
        )}
        {/* AI label for a video we can't play inline (no playlist URL). */}
        {post.has_video && !post.video_playlist && aiLabels[post.uri]?.ai_generated && (
          <span className="cur-ai-label cur-ai-label-inline">AI Generated</span>
        )}

        {showDebug && (
          <div className="cur-post-debug cur-post-debug-card">
            <span className="cur-post-debug-row">
              <span className="cur-post-debug-label">vec</span>
              <span>{(post.score * 100).toFixed(1)}%</span>
              {typeof post.rerank_score === "number" && (
                <>
                  <span className="cur-post-debug-label">rr</span>
                  <span>{post.rerank_score}</span>
                </>
              )}
            </span>
            {post.rerank_reason && (
              <span className="cur-post-debug-reason">
                &ldquo;{post.rerank_reason}&rdquo;
              </span>
            )}
          </div>
        )}

        <EngageFooter post={post} bskyUrl={bskyUrl} />
      </div>
      {collapsible && (
        <button
          type="button"
          className={`cur-post-fold-toggle${collapsed ? "" : " expanded"}`}
          onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
          aria-label={collapsed ? "Expand post" : "Collapse post"}
          aria-expanded={!collapsed}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}
    </article>
  );
}

export default memo(PostCard);
