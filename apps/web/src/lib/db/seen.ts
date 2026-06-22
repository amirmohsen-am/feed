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

/** The set of post URIs this user has already seen in this feed. */
export async function getSeenUris(
  userId: string,
  feedId: number
): Promise<Set<string>> {
  const res = await query(
    `SELECT post_uri FROM seen_posts WHERE user_id = $1 AND feed_id = $2`,
    [userId, feedId]
  );
  return new Set(res.rows.map((r) => r.post_uri as string));
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
