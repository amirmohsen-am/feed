// Engagement counter increments — monotonic (we ignore unlike / unrepost).
// Both like and repost flow through here. Reply / quote counters are
// maintained by post-repo as a side effect of post inserts.

import { withClient } from '../pg.js'
import type { LikeRecord, RepostRecord } from '../jetstream-extract.js'

type Kind = 'like' | 'repost'

const bumpCounters = async (rows: LikeRecord[], kind: Kind): Promise<void> => {
  if (rows.length === 0) return
  // Aggregate by subject_uri so a single batch with N likes on the same post
  // only touches one row.
  const tally = new Map<string, number>()
  for (const r of rows) tally.set(r.subject_uri, (tally.get(r.subject_uri) ?? 0) + 1)

  // Sort by uri so concurrent writers to bsky.post_engagement (post-consumer
  // reply/quote bumps, post deletes) acquire row locks in the same order.
  const sorted = [...tally.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const uris: string[] = []
  const deltas: number[] = []
  for (const [uri, d] of sorted) {
    uris.push(uri)
    deltas.push(d)
  }

  const column = kind === 'like' ? 'like_count' : 'repost_count'

  // The JOIN drops engagement for posts we never indexed (skipped language,
  // nothing to embed, already pruned) — without it, orphan counter rows for
  // unindexed posts grow to dwarf the real ones (93% of the table by
  // 2026-07-14) and nothing ever reads them (the read side always joins
  // bsky.posts). Cost: a like that lands before its post is indexed is lost,
  // which is within the accepted monotonic-counter drift.
  await withClient((c) =>
    c.query(
      `INSERT INTO bsky.post_engagement (uri, ${column}, updated_at)
       SELECT u.uri, u.d, now()
       FROM unnest($1::text[], $2::int[]) AS u(uri, d)
       JOIN bsky.posts p ON p.uri = u.uri
       ON CONFLICT (uri) DO UPDATE SET
         ${column} = bsky.post_engagement.${column} + EXCLUDED.${column},
         updated_at = now()`,
      [uris, deltas],
    ),
  )
}

export const bumpLikeCounters = (rows: LikeRecord[]) => bumpCounters(rows, 'like')
export const bumpRepostCounters = (rows: RepostRecord[]) => bumpCounters(rows, 'repost')
