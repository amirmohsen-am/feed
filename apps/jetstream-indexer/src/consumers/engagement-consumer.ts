// engagementConsumer: app.bsky.feed.like + app.bsky.feed.repost (creates only).
// Monotonic counters — we ignore delete events.

import type { Config } from '../config.js'
import { writeCursor } from '../lib/cursor-store.js'
import {
  extractLike,
  extractRepost,
  type JetstreamCommitEvent,
  type LikeRecord,
  type RepostRecord,
} from '../lib/jetstream-extract.js'
import {
  recordEngagementApplied,
  recordEventsConsumed,
  recordEventsFlushed,
  recordFlushDropped,
  recordFlushFailed,
  registerCursorLagUs,
  registerQueueDepth,
} from '../lib/otel-metrics.js'
import { bumpLikeCounters, bumpRepostCounters } from '../lib/repo/engagement-repo.js'
import { writeLikes, writeReposts } from '../lib/storage.js'
import { makeQueueHarness, runJetstreamLoop } from './shared.js'

const CONSUMER_KEY = 'engagement'

type Queued =
  | { kind: 'like'; r: LikeRecord }
  | { kind: 'repost'; r: RepostRecord }

const log = (event: string, fields: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ event, consumer: CONSUMER_KEY, ...fields }))
}

export const startEngagementConsumer = async (cfg: Config, workerId: string, initialCursorUs: number): Promise<void> => {
  let latestCursorUs = initialCursorUs

  const harness = makeQueueHarness<Queued>({
    batchMax: cfg.engagementBatchMax,
    flushMs: cfg.engagementFlushMs,
    queueMax: 100_000,
    onDrop: (n) => log('queue_drop', { dropped: n }),
    onFailure: (batch, err) => {
      recordFlushFailed(1, { kind: 'engagement', worker: workerId })
      log('flush_failed', { n: batch.length, error: String(err) })
    },
    onPoison: (batch, err) => {
      recordFlushDropped(batch.length, { kind: 'engagement', worker: workerId })
      log('flush_poison_dropped', { n: batch.length, error: String(err) })
    },
    flush: async (batch) => {
      const t0 = Date.now()
      const likes: LikeRecord[] = []
      const reposts: RepostRecord[] = []
      let maxCursor = 0
      for (const q of batch) {
        if (q.kind === 'like') likes.push(q.r)
        else reposts.push(q.r)
        if (q.r.time_us > maxCursor) maxCursor = q.r.time_us
      }

      await Promise.all([
        bumpLikeCounters(likes),
        bumpRepostCounters(reposts),
        writeLikes(cfg, likes, workerId),
        writeReposts(cfg, reposts, workerId),
      ])

      if (maxCursor > latestCursorUs) {
        latestCursorUs = maxCursor
        await writeCursor(CONSUMER_KEY, maxCursor, cfg.jetstreamHost)
      }

      if (likes.length) recordEngagementApplied(likes.length, { kind: 'like', worker: workerId })
      if (reposts.length) recordEngagementApplied(reposts.length, { kind: 'repost', worker: workerId })
      recordEventsFlushed(batch.length, { kind: 'engagement', worker: workerId })

      log('flush', {
        n: batch.length,
        likes: likes.length,
        reposts: reposts.length,
        cursor_us: maxCursor,
        cursor_lag_us: Date.now() * 1000 - maxCursor,
        ms: Date.now() - t0,
      })
    },
  })

  registerQueueDepth(CONSUMER_KEY, () => harness.size())
  registerCursorLagUs(CONSUMER_KEY, () => Date.now() * 1000 - latestCursorUs)

  harness.start()

  await runJetstreamLoop({
    cfg,
    wantedCollections: ['app.bsky.feed.like', 'app.bsky.feed.repost'],
    initialCursorUs,
    log,
    getCursorUs: () => latestCursorUs,
    setupHandlers: (js) => {
      js.onCreate('app.bsky.feed.like', (ev) => {
        recordEventsConsumed(1, { kind: 'likes', worker: workerId })
        const r = extractLike(ev as unknown as JetstreamCommitEvent)
        if (!r) return
        harness.push({ kind: 'like', r })
      })
      js.onCreate('app.bsky.feed.repost', (ev) => {
        recordEventsConsumed(1, { kind: 'reposts', worker: workerId })
        const r = extractRepost(ev as unknown as JetstreamCommitEvent)
        if (!r) return
        harness.push({ kind: 'repost', r })
      })
    },
  })
}
