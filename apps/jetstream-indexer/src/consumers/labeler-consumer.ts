// labelerConsumer: app.bsky.labeler.service (creates + updates + deletes).
//
// Keeps the labeler directory (bsky.labelers) fresh going forward. The existing
// universe is bootstrapped once by scripts/seed-labelers.ts; this consumer
// catches labelers created/updated/torn down after we start consuming.
//
// Labeler records are extremely rare network-wide, so this runs on its own slow
// queue. No parquet replay log is written (unlike the other consumers): the DID
// set is cheaply re-seedable from the public directory and bsky.labelers is the
// source of truth.

import type { Jetstream } from '@skyware/jetstream'
import type { Config } from '../config.js'
import { writeCursor } from '../lib/cursor-store.js'
import {
  extractLabelerService,
  type JetstreamCommitEvent,
} from '../lib/jetstream-extract.js'
import {
  recordEventsConsumed,
  recordEventsFlushed,
  recordFlushDropped,
  recordFlushFailed,
  registerCursorLagUs,
  registerQueueDepth,
} from '../lib/otel-metrics.js'
import { deleteLabelers, upsertLabelers } from '../lib/repo/labeler-repo.js'
import { makeQueueHarness, runJetstreamLoop } from './shared.js'

const CONSUMER_KEY = 'labeler'

type Queued =
  | { kind: 'upsert'; did: string; time_us: number }
  | { kind: 'delete'; did: string; time_us: number }

const log = (event: string, fields: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ event, consumer: CONSUMER_KEY, ...fields }))
}

export const startLabelerConsumer = async (cfg: Config, workerId: string, initialCursorUs: number): Promise<void> => {
  let latestCursorUs = initialCursorUs

  const harness = makeQueueHarness<Queued>({
    batchMax: cfg.labelerBatchMax,
    flushMs: cfg.labelerFlushMs,
    queueMax: 5_000,
    onDrop: (n) => log('queue_drop', { dropped: n }),
    onFailure: (batch, err) => {
      recordFlushFailed(1, { kind: 'labeler', worker: workerId })
      log('flush_failed', { n: batch.length, error: String(err) })
    },
    onPoison: (batch, err) => {
      recordFlushDropped(batch.length, { kind: 'labeler', worker: workerId })
      log('flush_poison_dropped', { n: batch.length, error: String(err) })
    },
    flush: async (batch) => {
      const t0 = Date.now()
      const upserts: string[] = []
      const deletes: string[] = []
      let maxCursor = 0
      for (const q of batch) {
        if (q.kind === 'upsert') upserts.push(q.did)
        else deletes.push(q.did)
        if (q.time_us > maxCursor) maxCursor = q.time_us
      }

      // Upsert before delete so a delete in the same batch wins for a DID that
      // also has an upsert (the labeler is gone either way).
      await upsertLabelers(upserts)
      await deleteLabelers(deletes)

      if (maxCursor > latestCursorUs) {
        latestCursorUs = maxCursor
        await writeCursor(CONSUMER_KEY, maxCursor, cfg.jetstreamHost)
      }

      recordEventsFlushed(batch.length, { kind: 'labeler', worker: workerId })

      log('flush', {
        n: batch.length,
        upserts: upserts.length,
        deletes: deletes.length,
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
    wantedCollections: ['app.bsky.labeler.service'],
    initialCursorUs,
    log,
    onCursorAdvance: () => {},
    setupHandlers: (js) => {
      const anyJs = js as unknown as Jetstream<string, string>
      const onUpsert = (ev: unknown) => {
        recordEventsConsumed(1, { kind: 'labelers', worker: workerId })
        const r = extractLabelerService(ev as JetstreamCommitEvent)
        if (r) harness.push({ kind: 'upsert', did: r.did, time_us: r.time_us })
      }
      anyJs.onCreate('app.bsky.labeler.service', onUpsert)
      anyJs.onUpdate('app.bsky.labeler.service', onUpsert)
      anyJs.onDelete('app.bsky.labeler.service', (ev) => {
        recordEventsConsumed(1, { kind: 'labelers', worker: workerId })
        const e = ev as unknown as JetstreamCommitEvent
        harness.push({ kind: 'delete', did: e.did, time_us: e.time_us })
      })
    },
  })
}
