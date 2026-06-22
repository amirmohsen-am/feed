/**
 * Per-user, per-feed "seen" tracking (feed-db `seen_posts`).
 *
 * Exact rows, not a probabilistic filter: false-positive-free, inspectable,
 * and pruned with a single DELETE. "seen" is scoped per feed so a post seen in
 * one feed does not suppress it in another.
 *
 * Applied at SERVE TIME on both paths — never baked into the shared
 * feed_result_cache snapshot (that row is served verbatim to every published
 * subscriber, so personalizing it would leak one viewer's history to all).
 */

import { query } from "./connection";

/**
 * The set of post URIs this user has already seen in this feed. Pass `candidate`
 * URIs (the snapshot we're about to filter) to bound the read to those rows —
 * the query then returns at most `candidate.length` rows instead of the user's
 * whole retention-window history.
 */
export async function getSeenUris(
  userId: string,
  feedId: number,
  candidate?: string[]
): Promise<Set<string>> {
  if (candidate && candidate.length === 0) return new Set();
  const res = candidate
    ? await query(
        `SELECT post_uri FROM seen_posts
         WHERE user_id = $1 AND feed_id = $2 AND post_uri = ANY($3::text[])`,
        [userId, feedId, candidate]
      )
    : await query(
        `SELECT post_uri FROM seen_posts WHERE user_id = $1 AND feed_id = $2`,
        [userId, feedId]
      );
  return new Set(res.rows.map((r) => r.post_uri as string));
}

/**
 * Serve-time seen filter shared by the curator preview and the published
 * skeleton: read the viewer's seen set (bounded to this snapshot's URIs) and
 * drop already-seen posts. Fail-soft — a read error serves the snapshot
 * unfiltered rather than breaking the feed. Records nothing; the caller decides
 * whether to recordSeen the posts it actually serves.
 */
export async function filterUnseen<T extends { uri: string }>(
  userId: string,
  feedId: number,
  posts: T[]
): Promise<{ visible: T[]; seenFiltered: number }> {
  try {
    const seen = await getSeenUris(
      userId,
      feedId,
      posts.map((p) => p.uri)
    );
    if (seen.size === 0) return { visible: posts, seenFiltered: 0 };
    const visible = posts.filter((p) => !seen.has(p.uri));
    return { visible, seenFiltered: posts.length - visible.length };
  } catch (e) {
    console.warn(
      "[seen] read failed, serving unfiltered:",
      e instanceof Error ? e.message : String(e)
    );
    return { visible: posts, seenFiltered: 0 };
  }
}

/**
 * Record post URIs as seen for (user, feed). Idempotent — re-recording a URI
 * keeps its original seen_at (ON CONFLICT DO NOTHING), so prune windows are
 * anchored to first-seen, not last-served.
 */
export async function recordSeen(
  userId: string,
  feedId: number,
  uris: string[]
): Promise<void> {
  if (uris.length === 0) return;
  await query(
    `INSERT INTO seen_posts (user_id, feed_id, post_uri)
     SELECT $1, $2, UNNEST($3::text[])
     ON CONFLICT (user_id, feed_id, post_uri) DO NOTHING`,
    [userId, feedId, uris]
  );
}

/**
 * Delete seen rows older than the retention window. Run from the refresh cron.
 * `interval` is a Postgres interval literal (default matches bsky post
 * retention — a URI we can no longer serve never needs a seen row).
 */
export async function pruneSeen(interval: string = "14 days"): Promise<number> {
  const res = await query(
    `DELETE FROM seen_posts WHERE seen_at < now() - $1::interval`,
    [interval]
  );
  return res.rowCount ?? 0;
}
