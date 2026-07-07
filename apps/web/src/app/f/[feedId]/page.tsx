import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFeedById, getSharedFeedPosts, type FeedPreviewPost } from "@/lib/pg";
import "./shared-feed.css";

/**
 * Public, read-only view of a feed — the link the Share button hands out.
 * No session required; serves the cached post list (cold path = vector
 * order only, same as the Bluesky skeleton).
 */

export const dynamic = "force-dynamic";

function avatarUrl(did: string, cid: string | null): string | null {
  if (!cid) return null;
  return `https://cdn.bsky.app/img/avatar/plain/${did}/${cid}@jpeg`;
}

function bskyPostUrl(uri: string): string | null {
  const m = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
}

function externalHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ feedId: string }>;
}): Promise<Metadata> {
  const { feedId } = await params;
  const id = parseInt(feedId, 10);
  const feed = Number.isFinite(id) ? await getFeedById(id) : null;
  const name = feed?.name || "A curated feed";
  return {
    alternates: { canonical: `/f/${feedId}` },
    title: `${name} — amadi`,
    description: `A feed curated on amadi${
      feed?.subqueries.length ? `: ${feed.subqueries.slice(0, 3).join(", ")}` : ""
    }. Built with AI, served from Bluesky.`,
  };
}

export default async function SharedFeedPage({
  params,
}: {
  params: Promise<{ feedId: string }>;
}) {
  const { feedId } = await params;
  const id = parseInt(feedId, 10);
  if (!Number.isFinite(id)) notFound();

  const feed = await getFeedById(id);
  if (!feed || feed.subqueries.length === 0) notFound();

  let posts: FeedPreviewPost[] = [];
  try {
    posts = await getSharedFeedPosts(id);
  } catch {
    /* show the empty state rather than erroring the share link */
  }

  return (
    <div className="sf-root">
      <div className="sf-shell">
        <div className="sf-topbar">
          <Link href="/" className="sf-wordmark">
            amadi
          </Link>
          <Link href="/curator" className="sf-cta">
            Build your own
          </Link>
        </div>

        <div className="sf-kicker">A shared feed</div>
        <h1 className="sf-title">{feed.name}</h1>
        <p className="sf-sub">
          Curated on amadi · {posts.length} post{posts.length === 1 ? "" : "s"}
        </p>
        {feed.subqueries.length > 0 && (
          <div className="sf-chips">
            {feed.subqueries.slice(0, 6).map((s) => (
              <span key={s} className="sf-chip">
                {s}
              </span>
            ))}
          </div>
        )}

        {posts.length === 0 ? (
          <div className="sf-empty">
            This feed is still warming up — check back in a bit.
          </div>
        ) : (
          posts.map((post) => {
            const avatar = avatarUrl(post.author_did, post.author_avatar_cid);
            const url = bskyPostUrl(post.uri);
            const host = externalHost(post.external_uri);
            const name =
              post.author_display_name?.trim() ||
              post.author_handle ||
              post.author_did.slice(0, 16) + "…";
            return (
              <article key={post.uri} className="sf-post">
                <header className="sf-post-head">
                  {avatar ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={avatar} alt="" className="sf-avatar" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="sf-avatar-fallback" aria-hidden />
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div className="sf-name">{name}</div>
                    {post.author_handle && (
                      <div className="sf-handle">@{post.author_handle}</div>
                    )}
                  </div>
                </header>
                {post.text && <p className="sf-text">{post.text}</p>}
                {post.image_urls.length > 0 && (
                  <div className={`sf-images${post.image_urls.length === 1 ? " one" : ""}`}>
                    {post.image_urls.slice(0, 4).map((u, i) => (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        key={i}
                        src={u}
                        alt={post.image_alts[i] || ""}
                        className="sf-img"
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                    ))}
                  </div>
                )}
                {post.external_uri && (
                  <a
                    className="sf-link-card"
                    href={post.external_uri}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <div className="sf-link-host">{host || "link"}</div>
                    {post.external_title && (
                      <div className="sf-link-title">{post.external_title}</div>
                    )}
                  </a>
                )}
                {url && (
                  <a href={url} target="_blank" rel="noopener noreferrer" className="sf-open">
                    Open on Bluesky ↗
                  </a>
                )}
              </article>
            );
          })
        )}

        <div className="sf-footer">
          <p>This feed was curated on amadi. Describe what you want to read, and AI builds the feed.</p>
          <Link href="/curator" className="sf-cta">
            Make your own feed
          </Link>
        </div>
      </div>
    </div>
  );
}
