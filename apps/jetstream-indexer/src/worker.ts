// Orchestrates several loops in a single Node process on one Cloud Run instance:
//   - postConsumer       (app.bsky.feed.post creates + deletes)
//   - engagementConsumer (app.bsky.feed.like + app.bsky.feed.repost creates)
//   - profileConsumer    (app.bsky.actor.profile + identity events)
//   - labelerConsumer    (app.bsky.labeler.service creates + updates + deletes)
//   - prune              (daily retention sweep on bsky.posts)
//
// Cloud Run: --no-cpu-throttling --min=1 --max=1 --concurrency=1, CPU=2, memory=2Gi.

import http from 'http'
import { config } from './config.js'
import { startEngagementConsumer } from './consumers/engagement-consumer.js'
import { startLabelerConsumer } from './consumers/labeler-consumer.js'
import { startPostConsumer } from './consumers/post-consumer.js'
import { startProfileConsumer } from './consumers/profile-consumer.js'
import { startPrune } from './consumers/prune.js'
import { readCursor } from './lib/cursor-store.js'
import { runMigrations } from './lib/migrator.js'
import { recordWorkerError, shutdownMetrics } from './lib/otel-metrics.js'
import { closePool } from './lib/pg.js'

const cfg = config
const WORKER_ID = process.env.WORKER_ID ?? `w${process.pid}`
const HEALTH_PORT = parseInt(process.env.PORT ?? '8080', 10)

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, worker: WORKER_ID, ...fields }))

const startHealthServer = () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ worker: WORKER_ID, ok: true }))
      return
    }
    res.writeHead(404).end()
  })
  server.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`[health] listening on :${HEALTH_PORT}`)
  })
}

const cursorOrNow = async (key: string): Promise<number> => {
  const c = await readCursor(key)
  if (c) return c.cursor_us
  // No checkpoint: start from now - 60s grace.
  return Date.now() * 1000 - 60_000_000
}

const main = async () => {
  startHealthServer()
  log('worker_start', { project: cfg.gcpProject, bucket: cfg.gcsBucket })

  await runMigrations()

  const [postCursor, engCursor, profCursor, labelerCursor] = await Promise.all([
    cursorOrNow('post'),
    cursorOrNow('engagement'),
    cursorOrNow('profile'),
    cursorOrNow('labeler'),
  ])

  // Run all loops concurrently. None of them ever resolve under normal
  // operation; if any rejects we crash the process so Cloud Run restarts us.
  await Promise.all([
    startPostConsumer(cfg, WORKER_ID, postCursor),
    startEngagementConsumer(cfg, WORKER_ID, engCursor),
    startProfileConsumer(cfg, WORKER_ID, profCursor),
    startLabelerConsumer(cfg, WORKER_ID, labelerCursor),
    startPrune(cfg),
  ])
}

const cleanShutdown = async (signal: string) => {
  console.log(JSON.stringify({ event: 'worker_shutdown', signal }))
  try { await shutdownMetrics() } catch {}
  try { await closePool() } catch {}
  process.exit(0)
}
process.on('SIGTERM', () => { cleanShutdown('SIGTERM') })
process.on('SIGINT', () => { cleanShutdown('SIGINT') })

// Last-resort backstop. Per-event handlers are individually guarded
// (see guardHandler in consumers/shared.ts), so a single malformed record
// can no longer reach here. If anything else escapes, log + count it but do
// NOT exit: on this deployment (min=1/max=1) a crash just replays the same
// cursor and re-crashes, which is exactly the multi-day crash loop this
// hardening exists to prevent. Staying up keeps ingestion flowing while the
// error is visible in happy_feed_worker_error_total.
process.on('unhandledRejection', (reason) => {
  recordWorkerError(1, { kind: 'unhandled_rejection', worker: WORKER_ID })
  log('unhandled_rejection', {
    error: String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  })
})
process.on('uncaughtException', (err) => {
  recordWorkerError(1, { kind: 'uncaught_exception', worker: WORKER_ID })
  log('uncaught_exception', { error: String(err), stack: err.stack })
})

main().catch(async (err) => {
  console.error('[worker] fatal:', err)
  try { await shutdownMetrics() } catch {}
  try { await closePool() } catch {}
  process.exit(1)
})
