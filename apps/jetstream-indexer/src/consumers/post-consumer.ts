// postConsumer: app.bsky.feed.post (creates + deletes).
// Creates: extract -> embed -> upsert bsky.posts (full record + halfvec
// embedding + cached float32 bytea) + bsky.post_engagement.
// Deletes: drop from bsky.posts, decrement parent counters.

import type { Config } from '../config.js'
import { composeEmbedInput } from '../lib/compose-embed-input.js'
import { writeCursor } from '../lib/cursor-store.js'
import { embedTexts } from '../lib/embed.js'
import {
  extractPost,
  type JetstreamCommitEvent,
  type PostRecord,
} from '../lib/jetstream-extract.js'
import {
  recordEmbedCostUsd,
  recordEmbedTokensEstimated,
  recordEngagementApplied,
  recordEventsConsumed,
  recordEventsFlushed,
  recordFlushDropped,
  recordFlushFailed,
  recordPostsIndexed,
  registerCursorLagUs,
  registerQueueDepth,
} from '../lib/otel-metrics.js'
import { bumpReplyAndQuoteCounters, deletePostsBatch, upsertPosts } from '../lib/repo/post-repo.js'
import { writePosts } from '../lib/storage.js'
import { guardHandler, makeQueueHarness, runJetstreamLoop, sleep } from './shared.js'

const CONSUMER_KEY = 'post'
const EMBED_USD_PER_1K_TOKENS = 0.00015
const CHARS_PER_TOKEN = 4
const EMBED_BATCH = 100

type Queued = { post: PostRecord; cursorUs: number }

const log = (event: string, fields: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ event, consumer: CONSUMER_KEY, ...fields }))
}

const packFloat32 = (vec: number[]): Buffer => {
  const a = new Float32Array(vec)
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength)
}

// pgvector text input format; float32→float16 happens server-side on
// assignment to the halfvec(768) column.
const toHalfvecLiteral = (vec: number[]): string => '[' + vec.join(',') + ']'

export const startPostConsumer = async (cfg: Config, workerId: string, initialCursorUs: number): Promise<void> => {
  let latestCursorUs = initialCursorUs

  const harness = makeQueueHarness<Queued>({
    batchMax: cfg.postBatchMax,
    flushMs: cfg.postFlushMs,
    queueMax: 20_000,
    onDrop: (n) => log('queue_drop', { dropped: n }),
    onFailure: (batch, err) => {
      recordFlushFailed(1, { kind: 'posts', worker: workerId })
      log('flush_failed', { n: batch.length, error: String(err) })
    },
    onPoison: (batch, err) => {
      recordFlushDropped(batch.length, { kind: 'posts', worker: workerId })
      log('flush_poison_dropped', { n: batch.length, error: String(err) })
    },
    flush: async (batch) => {
      const t0 = Date.now()
      const posts = batch.map((b) => b.post)
      const maxCursor = batch.reduce((m, b) => (b.cursorUs > m ? b.cursorUs : m), 0)

      // Compose embedding inputs + call Gemini in chunks.
      const inputs = posts.map(composeEmbedInput)
      const vectors: number[][] = []
      for (let i = 0; i < inputs.length; i += EMBED_BATCH) {
        const chunk = inputs.slice(i, i + EMBED_BATCH)
        let attempt = 0
        // Inline backoff for embed-side 429s.
        while (true) {
          try {
            const v = await embedTexts(cfg, chunk, 'RETRIEVAL_DOCUMENT')
            vectors.push(...v)
            break
          } catch (err: any) {
            const msg = String(err?.message ?? err)
            if (!/429|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(msg)) throw err
            attempt++
            const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6))
            log('embed_backoff', { delay_ms: delay, attempt })
            await sleep(delay)
          }
        }
      }

      // Build DB upsert rows. embedding_vec (float32 bytea) is kept alongside
      // the halfvec column until pgvector is validated in prod, so the
      // backfill can be re-run (see PGVECTOR_MIGRATION_PLAN.md Rollback).
      const pgRows = posts.map((p, i) => ({
        ...p,
        embedding_vec: packFloat32(vectors[i]!),
        embedding: toHalfvecLiteral(vectors[i]!),
      }))

      // Persist: Postgres, parquet, reply/quote counters.
      await upsertPosts(pgRows)
      await bumpReplyAndQuoteCounters(posts)
      await writePosts(cfg, posts, workerId)

      // Cursor.
      if (maxCursor > latestCursorUs) {
        latestCursorUs = maxCursor
        await writeCursor(CONSUMER_KEY, maxCursor, cfg.jetstreamHost)
      }

      // Cost / metrics.
      const chars = inputs.reduce((s, t) => s + t.length, 0)
      const tokens = Math.ceil(chars / CHARS_PER_TOKEN)
      const usd = (tokens / 1000) * EMBED_USD_PER_1K_TOKENS
      recordEmbedCostUsd(usd, { worker: workerId })
      recordEmbedTokensEstimated(tokens, { worker: workerId })
      recordPostsIndexed(posts.length, { worker: workerId })
      recordEventsFlushed(posts.length, { kind: 'posts', worker: workerId })
      const replyN = posts.filter((p) => p.reply_parent_uri).length
      const quoteN = posts.filter((p) => p.quote_uri).length
      if (replyN) recordEngagementApplied(replyN, { kind: 'reply', worker: workerId })
      if (quoteN) recordEngagementApplied(quoteN, { kind: 'quote', worker: workerId })

      log('flush', {
        n: posts.length,
        cursor_us: maxCursor,
        cursor_lag_us: Date.now() * 1000 - maxCursor,
        ms: Date.now() - t0,
        embed_chars: chars,
        embed_cost_usd: usd,
      })
    },
  })

  // Separate batched delete queue keeps the firehose's delete bursts from
  // opening one PG connection per event.
  const deleteHarness = makeQueueHarness<string>({
    batchMax: 500,
    flushMs: cfg.postFlushMs,
    queueMax: 20_000,
    onDrop: (n) => log('delete_queue_drop', { dropped: n }),
    onFailure: (batch, err) => {
      recordFlushFailed(1, { kind: 'post_deletes', worker: workerId })
      log('delete_flush_failed', { n: batch.length, error: String(err) })
    },
    onPoison: (batch, err) => {
      recordFlushDropped(batch.length, { kind: 'post_deletes', worker: workerId })
      log('delete_flush_poison_dropped', { n: batch.length, error: String(err) })
    },
    flush: async (uris) => {
      const t0 = Date.now()
      await deletePostsBatch(uris)
      log('delete_flush', { n: uris.length, ms: Date.now() - t0 })
    },
  })

  registerQueueDepth(CONSUMER_KEY, () => harness.size())
  registerQueueDepth('post_deletes', () => deleteHarness.size())
  registerCursorLagUs(CONSUMER_KEY, () => Date.now() * 1000 - latestCursorUs)

  harness.start()
  deleteHarness.start()

  await runJetstreamLoop({
    cfg,
    wantedCollections: ['app.bsky.feed.post'],
    initialCursorUs,
    log,
    getCursorUs: () => latestCursorUs,
    setupHandlers: (js) => {
      js.onCreate('app.bsky.feed.post', guardHandler({ kind: 'posts', workerId, log }, async (ev) => {
        recordEventsConsumed(1, { kind: 'posts', worker: workerId })
        const post = extractPost(ev as unknown as JetstreamCommitEvent)
        if (!post) return
        // Drop posts with nothing semantic to embed (image-only with no alt
        // text, no link card). Gemini rejects empty input. These posts wouldn't
        // be findable by semantic search anyway.
        if (composeEmbedInput(post).length === 0) return
        harness.push({ post, cursorUs: (ev as unknown as JetstreamCommitEvent).time_us })
      }))
      js.onDelete('app.bsky.feed.post', guardHandler({ kind: 'posts', workerId, log }, (ev) => {
        recordEventsConsumed(1, { kind: 'posts', worker: workerId })
        const e = ev as unknown as JetstreamCommitEvent
        const uri = `at://${e.did}/${e.commit.collection}/${e.commit.rkey}`
        deleteHarness.push(uri)
      }))
    },
  })
}
