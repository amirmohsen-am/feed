// Shared utilities for all consumers: backoff, batching, the Jetstream
// reconnect loop, and a small queue+flush harness.

import { Jetstream } from '@skyware/jetstream'
import type { Config } from '../config.js'

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export type JetstreamLoopOpts = {
  cfg: Config
  wantedCollections?: string[]
  initialCursorUs: number
  setupHandlers: (js: Jetstream<string, string>) => void
  // Latest processed cursor, read before every reconnect so the new
  // subscription resumes where processing actually got to instead of
  // replaying from the boot-time cursor.
  getCursorUs: () => number
  log: (event: string, fields?: Record<string, unknown>) => void
}

// Reconnect loop with exponential backoff. Returns never (until process exits).
export const runJetstreamLoop = async (opts: JetstreamLoopOpts): Promise<void> => {
  let backoff = 1000
  let currentCursor = opts.initialCursorUs
  while (true) {
    const js = new Jetstream({
      endpoint: `wss://${opts.cfg.jetstreamHost}/subscribe`,
      wantedCollections: opts.wantedCollections,
      cursor: currentCursor,
    })
    js.on('open', () => {
      opts.log('ws_open', { cursor_us: currentCursor })
      backoff = 1000
    })
    js.on('error', (err) => opts.log('ws_error', { error: String(err) }))
    opts.setupHandlers(js as unknown as Jetstream<string, string>)

    const closed = new Promise<void>((resolve) => {
      js.on('close', () => {
        opts.log('ws_close', { backoff_ms: backoff })
        resolve()
      })
    })
    js.start()
    await closed

    await sleep(backoff)
    backoff = Math.min(30_000, backoff * 2)
    currentCursor = Math.max(currentCursor, opts.getCursorUs())
  }
}

// Queue + flush harness used by every consumer. Flushes when queue hits
// batchMax OR the timer ticks.
export type QueueHarness<T> = {
  push: (item: T) => void
  size: () => number
  start: () => void
  stop: () => void
  flushNow: () => Promise<void>
}

export const makeQueueHarness = <T>(opts: {
  batchMax: number
  flushMs: number
  queueMax: number
  flush: (items: T[]) => Promise<void>
  onDrop?: (n: number) => void
  // Called on every flush failure (transient or poison).
  onFailure?: (items: T[], err: unknown) => void
  // Called when a batch has failed maxRetries consecutive times and is being
  // dropped to unblock the queue. Without this, a deterministically-failing
  // batch (poison pill) would loop at the front of the queue forever.
  onPoison?: (items: T[], err: unknown) => void
  maxRetries?: number
  // A flush that exceeds this deadline is treated as failed (retry/poison
  // path) and the queue moves on. Without it, one hung downstream call (PG,
  // Vertex, GCS) leaves the `flushing` latch set forever and the queue drops
  // every event from then on.
  flushTimeoutMs?: number
}): QueueHarness<T> => {
  const queue: T[] = []
  let flushing = false
  let timer: ReturnType<typeof setInterval> | null = null
  let failStreak = 0
  const maxRetries = opts.maxRetries ?? 5
  const flushTimeoutMs = opts.flushTimeoutMs ?? 300_000

  const withDeadline = (p: Promise<void>): Promise<void> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`flush timed out after ${flushTimeoutMs}ms`)),
        flushTimeoutMs,
      )
      // The abandoned flush may still settle later; swallow it so an eventual
      // rejection doesn't become an unhandled rejection.
      p.then(() => { clearTimeout(t); resolve() }, (err) => { clearTimeout(t); reject(err) })
    })

  const doFlush = async () => {
    if (flushing) return
    if (queue.length === 0) return
    flushing = true
    const batch = queue.splice(0, opts.batchMax)
    try {
      await withDeadline(opts.flush(batch))
      failStreak = 0
    } catch (err) {
      failStreak++
      opts.onFailure?.(batch, err)
      if (failStreak >= maxRetries) {
        opts.onPoison?.(batch, err)
        failStreak = 0
      } else {
        // Put items back so a transient PG/Vertex error doesn't lose them.
        queue.unshift(...batch)
      }
      throw err
    } finally {
      flushing = false
    }
  }

  return {
    push: (item) => {
      if (queue.length >= opts.queueMax) {
        const drop = queue.length - opts.queueMax + 1
        queue.splice(0, drop)
        opts.onDrop?.(drop)
      }
      queue.push(item)
      if (queue.length >= opts.batchMax) {
        doFlush().catch((e) => console.error('[flush-trigger]', e))
      }
    },
    size: () => queue.length,
    start: () => {
      timer = setInterval(() => {
        doFlush().catch((e) => console.error('[flush-tick]', e))
      }, opts.flushMs)
    },
    stop: () => {
      if (timer) clearInterval(timer)
    },
    flushNow: doFlush,
  }
}
