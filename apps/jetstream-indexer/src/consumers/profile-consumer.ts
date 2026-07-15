// profileConsumer: app.bsky.actor.profile (creates + updates) + Jetstream
// identity events (handle changes).

import type { Jetstream } from '@skyware/jetstream'
import type { Config } from '../config.js'
import { writeCursor } from '../lib/cursor-store.js'
import {
  extractIdentity,
  extractProfile,
  type IdentityRecord,
  type JetstreamCommitEvent,
  type JetstreamIdentityEvent,
  type ProfileRecord,
} from '../lib/jetstream-extract.js'
import {
  recordEventsConsumed,
  recordEventsFlushed,
  recordFlushDropped,
  recordFlushFailed,
  registerCursorLagUs,
  registerQueueDepth,
} from '../lib/otel-metrics.js'
import { applyIdentityEvents, upsertProfiles } from '../lib/repo/author-repo.js'
import { writeIdentity, writeProfiles } from '../lib/storage.js'
import { makeQueueHarness, runJetstreamLoop } from './shared.js'

const CONSUMER_KEY = 'profile'

type Queued =
  | { kind: 'profile'; r: ProfileRecord }
  | { kind: 'identity'; r: IdentityRecord }

const log = (event: string, fields: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ event, consumer: CONSUMER_KEY, ...fields }))
}

export const startProfileConsumer = async (cfg: Config, workerId: string, initialCursorUs: number): Promise<void> => {
  let latestCursorUs = initialCursorUs

  const harness = makeQueueHarness<Queued>({
    batchMax: cfg.profileBatchMax,
    flushMs: cfg.profileFlushMs,
    queueMax: 5_000,
    onDrop: (n) => log('queue_drop', { dropped: n }),
    onFailure: (batch, err) => {
      recordFlushFailed(1, { kind: 'profile', worker: workerId })
      log('flush_failed', { n: batch.length, error: String(err) })
    },
    onPoison: (batch, err) => {
      recordFlushDropped(batch.length, { kind: 'profile', worker: workerId })
      log('flush_poison_dropped', { n: batch.length, error: String(err) })
    },
    flush: async (batch) => {
      const t0 = Date.now()
      const profiles: ProfileRecord[] = []
      const ids: IdentityRecord[] = []
      let maxCursor = 0
      for (const q of batch) {
        if (q.kind === 'profile') profiles.push(q.r)
        else ids.push(q.r)
        if (q.r.time_us > maxCursor) maxCursor = q.r.time_us
      }

      await Promise.all([
        upsertProfiles(profiles),
        applyIdentityEvents(ids),
        writeProfiles(cfg, profiles, workerId),
        writeIdentity(cfg, ids, workerId),
      ])

      if (maxCursor > latestCursorUs) {
        latestCursorUs = maxCursor
        await writeCursor(CONSUMER_KEY, maxCursor, cfg.jetstreamHost)
      }

      recordEventsFlushed(batch.length, { kind: 'profile', worker: workerId })

      log('flush', {
        n: batch.length,
        profiles: profiles.length,
        identity: ids.length,
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
    wantedCollections: ['app.bsky.actor.profile'],
    initialCursorUs,
    log,
    getCursorUs: () => latestCursorUs,
    setupHandlers: (js) => {
      const anyJs = js as unknown as Jetstream<string, string>
      anyJs.onCreate('app.bsky.actor.profile', (ev) => {
        recordEventsConsumed(1, { kind: 'profiles', worker: workerId })
        const r = extractProfile(ev as unknown as JetstreamCommitEvent)
        if (r) harness.push({ kind: 'profile', r })
      })
      anyJs.onUpdate('app.bsky.actor.profile', (ev) => {
        recordEventsConsumed(1, { kind: 'profiles', worker: workerId })
        const r = extractProfile(ev as unknown as JetstreamCommitEvent)
        if (r) harness.push({ kind: 'profile', r })
      })
      anyJs.on('identity', (ev) => {
        recordEventsConsumed(1, { kind: 'identity', worker: workerId })
        const r = extractIdentity(ev as unknown as JetstreamIdentityEvent)
        harness.push({ kind: 'identity', r })
      })
    },
  })
}
