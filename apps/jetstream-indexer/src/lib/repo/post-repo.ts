// Postgres writes for the posts table + engagement-counter side effects
// (reply_count++ on parent, quote_count++ on target). All UPSERTs so retries
// are idempotent.

import { withClient } from '../pg.js'
import type { PostRecord } from '../jetstream-extract.js'

type PostUpsertRow = PostRecord & { embedding_vec: Buffer | null }

const escapeArrayLiteral = (xs: string[]): string =>
  '{' +
  xs
    .map((s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"')
    .join(',') +
  '}'

export const upsertPosts = async (rows: PostUpsertRow[]): Promise<void> => {
  if (rows.length === 0) return
  // Dedupe by uri (keep last — most recent state) before building the multi-row
  // INSERT. Postgres rejects ON CONFLICT DO UPDATE when two rows in the same
  // statement target the same conflict key ("cannot affect row a second time").
  // Edits and Jetstream replays both produce same-uri pairs.
  // Sort by uri so concurrent transactions acquire row locks in the same order
  // and don't deadlock against bumpReplyAndQuoteCounters / delete decrements.
  const byUri = new Map<string, PostUpsertRow>()
  for (const r of rows) byUri.set(r.uri, r)
  rows = [...byUri.values()].sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0))
  // One multi-row INSERT keeps round-trips low; the per-row $N placeholder
  // count maxes out at ~600 for a 200-post batch which Postgres handles fine.
  const cols = [
    'uri', 'did', 'rkey', 'text', 'created_at', 'created_at_us', 'ingested_at_us',
    'langs', 'reply_parent_uri', 'reply_parent_did', 'reply_root_uri', 'is_self_thread',
    'embed_type', 'image_alts', 'image_count', 'video_alt', 'is_gif',
    'external_uri', 'external_title', 'external_desc', 'quote_uri', 'quote_did',
    'has_images', 'has_video', 'has_quote', 'has_external_link',
    'hashtags', 'mention_dids', 'links', 'domains', 'self_labels', 'raw_facets',
    'embedding_vec',
  ]
  const N = cols.length
  const values: unknown[] = []
  const placeholders: string[] = []
  rows.forEach((p, i) => {
    const base = i * N
    placeholders.push('(' + cols.map((_, j) => `$${base + j + 1}`).join(', ') + ')')
    values.push(
      p.uri, p.did, p.rkey, p.text, p.created_at, p.created_at_us, p.ingested_at_us,
      escapeArrayLiteral(p.langs),
      p.reply_parent_uri, p.reply_parent_did, p.reply_root_uri, p.is_self_thread,
      p.embed_type, escapeArrayLiteral(p.image_alts), p.image_count, p.video_alt, p.is_gif,
      p.external_uri, p.external_title, p.external_desc, p.quote_uri, p.quote_did,
      p.has_images, p.has_video, p.has_quote, p.has_external_link,
      escapeArrayLiteral(p.hashtags),
      escapeArrayLiteral(p.mention_dids),
      escapeArrayLiteral(p.links),
      escapeArrayLiteral(p.domains),
      escapeArrayLiteral(p.self_labels),
      p.raw_facets ? JSON.stringify(p.raw_facets) : null,
      p.embedding_vec,
    )
  })
  const sql = `
    INSERT INTO bsky.posts (${cols.join(', ')})
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (uri) DO UPDATE SET
      text             = EXCLUDED.text,
      langs            = EXCLUDED.langs,
      reply_parent_uri = EXCLUDED.reply_parent_uri,
      reply_parent_did = EXCLUDED.reply_parent_did,
      reply_root_uri   = EXCLUDED.reply_root_uri,
      is_self_thread   = EXCLUDED.is_self_thread,
      embed_type       = EXCLUDED.embed_type,
      image_alts       = EXCLUDED.image_alts,
      image_count      = EXCLUDED.image_count,
      video_alt        = EXCLUDED.video_alt,
      is_gif           = EXCLUDED.is_gif,
      external_uri     = EXCLUDED.external_uri,
      external_title   = EXCLUDED.external_title,
      external_desc    = EXCLUDED.external_desc,
      quote_uri        = EXCLUDED.quote_uri,
      quote_did        = EXCLUDED.quote_did,
      has_images       = EXCLUDED.has_images,
      has_video        = EXCLUDED.has_video,
      has_quote        = EXCLUDED.has_quote,
      has_external_link = EXCLUDED.has_external_link,
      hashtags         = EXCLUDED.hashtags,
      mention_dids     = EXCLUDED.mention_dids,
      links            = EXCLUDED.links,
      domains          = EXCLUDED.domains,
      self_labels      = EXCLUDED.self_labels,
      raw_facets       = EXCLUDED.raw_facets,
      embedding_vec    = EXCLUDED.embedding_vec,
      indexed_at       = now()
  `
  await withClient((c) => c.query(sql, values))
}

// Reply and quote create events come through postConsumer. For each
// reply, increment reply_count of the parent; for each quote, increment
// quote_count of the target. Multiple posts can target the same parent so we
// aggregate first.
export const bumpReplyAndQuoteCounters = async (posts: PostRecord[]): Promise<void> => {
  const replyParents = new Map<string, number>()
  const quoteTargets = new Map<string, number>()
  for (const p of posts) {
    if (p.reply_parent_uri) {
      replyParents.set(p.reply_parent_uri, (replyParents.get(p.reply_parent_uri) ?? 0) + 1)
    }
    if (p.quote_uri) {
      quoteTargets.set(p.quote_uri, (quoteTargets.get(p.quote_uri) ?? 0) + 1)
    }
  }
  if (replyParents.size === 0 && quoteTargets.size === 0) return

  const bump = async (
    target: Map<string, number>,
    column: 'reply_count' | 'quote_count',
  ): Promise<void> => {
    if (target.size === 0) return
    // Sort by uri so concurrent writers to bsky.post_engagement (engagement
    // consumer, post deletes) acquire row locks in the same order.
    const sorted = [...target.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    const uris: string[] = []
    const deltas: number[] = []
    for (const [uri, d] of sorted) {
      uris.push(uri)
      deltas.push(d)
    }
    // Single statement using UNNEST for atomic batch upsert.
    await withClient((c) =>
      c.query(
        `INSERT INTO bsky.post_engagement (uri, ${column}, updated_at)
         SELECT u.uri, u.d, now()
         FROM unnest($1::text[], $2::int[]) AS u(uri, d)
         ON CONFLICT (uri) DO UPDATE SET
           ${column} = bsky.post_engagement.${column} + EXCLUDED.${column},
           updated_at = now()`,
        [uris, deltas],
      ),
    )
  }

  await bump(replyParents, 'reply_count')
  await bump(quoteTargets, 'quote_count')
}

// Batched delete: one transaction handles many URIs at once. Returns the set
// of (reply_parent_uri, quote_uri) we should decrement counters for.
export const deletePostsBatch = async (uris: string[]): Promise<void> => {
  if (uris.length === 0) return
  await withClient(async (c) => {
    const res = await c.query<{ reply_parent_uri: string | null; quote_uri: string | null }>(
      `DELETE FROM bsky.posts
         WHERE uri = ANY($1::text[])
       RETURNING reply_parent_uri, quote_uri`,
      [uris],
    )
    const replyParents = new Map<string, number>()
    const quoteTargets = new Map<string, number>()
    for (const r of res.rows) {
      if (r.reply_parent_uri) {
        replyParents.set(r.reply_parent_uri, (replyParents.get(r.reply_parent_uri) ?? 0) + 1)
      }
      if (r.quote_uri) {
        quoteTargets.set(r.quote_uri, (quoteTargets.get(r.quote_uri) ?? 0) + 1)
      }
    }
    const decrement = async (m: Map<string, number>, column: 'reply_count' | 'quote_count') => {
      if (m.size === 0) return
      const sorted = [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      const uris2: string[] = []
      const deltas: number[] = []
      for (const [u, d] of sorted) {
        uris2.push(u)
        deltas.push(d)
      }
      await c.query(
        `UPDATE bsky.post_engagement pe
            SET ${column} = GREATEST(0, ${column} - u.d), updated_at = now()
           FROM unnest($1::text[], $2::int[]) AS u(uri, d)
          WHERE pe.uri = u.uri`,
        [uris2, deltas],
      )
    }
    await decrement(replyParents, 'reply_count')
    await decrement(quoteTargets, 'quote_count')
  })
}
