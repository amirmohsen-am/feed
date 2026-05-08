// Live Bluesky Jetstream → Vertex Vector Search + GCS persistence.
// Runs as a long-lived process (Cloud Run with --no-cpu-throttling, min=max=1).

import http from 'http'
import { Storage } from '@google-cloud/storage'
import { Jetstream } from '@skyware/jetstream'
import { config } from './config.js'
import { embedTexts } from './lib/embed.js'
import { uriToPointId } from './lib/hash.js'
import { extractPost, type JetstreamCreateEvent } from './lib/jetstream-extract.js'
import {
  recordEmbedCostUsd,
  recordEmbedTokensEstimated,
  recordPostsIndexed,
  shutdownMetrics,
} from './lib/otel-metrics.js'
import {
  writeEmbeddings,
  writePosts,
  type EmbeddingRecord,
  type PostRecord,
} from './lib/storage.js'
import { VertexStore } from './lib/vertex-store.js'

const cfg = config

const WORKER_ID = process.env.WORKER_ID ?? `w${process.pid}`
const HEALTH_PORT = parseInt(process.env.PORT ?? '8080', 10)
const CURSOR_OBJECT = 'state/jetstream-cursor.json'
const EMBED_BATCH_SIZE = 100 // Vertex Gemini embeddings API caps at ~250
const UPSERT_BATCH_SIZE = 500

// Calculated (NOT actual billing) cost estimate emitted in flush logs so the
// dashboard can show real-time spend rate. Verify rate at:
// https://cloud.google.com/vertex-ai/generative-ai/pricing#embedding-models
const EMBED_USD_PER_1K_TOKENS = 0.00015
const CHARS_PER_TOKEN = 4

// Cloud Logging auto-parses JSON from stdout into jsonPayload.* fields.
const logEvent = (event: string, fields: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ event, worker: WORKER_ID, ...fields }))
}

type CursorState = {
  cursor_us: number
  host: string
  updated_at: string
}

const storage = new Storage({ projectId: cfg.gcpProject })
const cursorFile = storage.bucket(cfg.gcsBucket).file(CURSOR_OBJECT)

const readCursor = async (): Promise<CursorState | null> => {
  const [exists] = await cursorFile.exists()
  if (!exists) return null
  const [buf] = await cursorFile.download()
  return JSON.parse(buf.toString()) as CursorState
}

const writeCursor = async (state: CursorState): Promise<void> => {
  await cursorFile.save(JSON.stringify(state), {
    contentType: 'application/json',
    resumable: false,
  })
}

let lastCursorUs = 0
let lastFlushAt = 0
const queue: Array<{ post: PostRecord; cursorUs: number }> = []
let flushing = false
let flushTimer: ReturnType<typeof setInterval> | null = null

const startHealthServer = () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const body = JSON.stringify({
        worker: WORKER_ID,
        cursor_us: lastCursorUs,
        last_flush_at: lastFlushAt,
        queue_depth: queue.length,
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body)
      return
    }
    res.writeHead(404).end()
  })
  server.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`[health] listening on :${HEALTH_PORT}`)
  })
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Token bucket — 60 RPM default for embedTexts protection.
const RATE_LIMIT_RPM = 60
let rateBucket = RATE_LIMIT_RPM
setInterval(() => {
  rateBucket = Math.min(RATE_LIMIT_RPM, rateBucket + 1)
}, 1000)
const consumeRateToken = async () => {
  while (rateBucket <= 0) await sleep(100)
  rateBucket--
}

const embedWithBackoff = async (texts: string[]): Promise<number[][]> => {
  let attempt = 0
  while (true) {
    try {
      await consumeRateToken()
      return await embedTexts(cfg, texts, 'RETRIEVAL_DOCUMENT')
    } catch (err: any) {
      const msg = String(err?.message ?? err)
      if (!/429|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(msg)) throw err
      attempt++
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6))
      logEvent('embed_backoff', { delay_ms: delay, attempt })
      await sleep(delay)
    }
  }
}

const chunked = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

const flush = async (store: VertexStore) => {
  if (flushing) return
  if (queue.length === 0) return
  flushing = true
  const t0 = Date.now()
  // Drain at most one batch worth to keep each flush bounded.
  const drained = queue.splice(0, cfg.batchMax)
  const maxCursor = drained.reduce((m, x) => (x.cursorUs > m ? x.cursorUs : m), 0)
  try {
    const posts = drained.map((d) => d.post)
    const ids = await Promise.all(posts.map((p) => uriToPointId(p.uri)))
    const existing = await store.hasMany(ids)
    const missingIdx: number[] = []
    for (let i = 0; i < ids.length; i++) {
      if (!existing.has(ids[i]!)) missingIdx.push(i)
    }

    if (missingIdx.length === 0) {
      logEvent('flush', {
        drained: posts.length,
        new: 0,
        existing: existing.size,
        cursor_us: maxCursor,
        cursor_lag_us: Date.now() * 1000 - maxCursor,
        ms: Date.now() - t0,
        queue: queue.length,
        embed_chars: 0,
        embed_tokens_est: 0,
        embed_cost_usd: 0,
      })
    } else {
      const newPosts = missingIdx.map((i) => posts[i]!)
      const newIds = missingIdx.map((i) => ids[i]!)

      const allVecs: number[][] = []
      for (const chunk of chunked(newPosts, EMBED_BATCH_SIZE)) {
        const vecs = await embedWithBackoff(chunk.map((p) => p.text))
        allVecs.push(...vecs)
      }

      const allPoints = newIds.map((id, i) => {
        const p = newPosts[i]!
        return {
          id,
          vector: allVecs[i]!,
          payload: {
            uri: p.uri,
            did: p.did,
            text: p.text,
            created_at: p.created_at,
            created_at_us: p.created_at_us,
            has_images: p.has_images,
            has_video: p.has_video,
            has_quote: p.has_quote,
            has_external_link: p.has_external_link,
            domains: p.domains,
            lang: p.lang,
          },
        }
      })

      for (const chunk of chunked(allPoints, UPSERT_BATCH_SIZE)) {
        await store.upsert(chunk)
      }
      await writePosts(cfg, newPosts, WORKER_ID)
      const embeddingRecords: EmbeddingRecord[] = newIds.map((_, i) => ({
        uri: newPosts[i]!.uri,
        embedding: allVecs[i]!,
      }))
      await writeEmbeddings(cfg, embeddingRecords, WORKER_ID)
      const embedChars = newPosts.reduce((s, p) => s + p.text.length, 0)
      const embedTokensEst = Math.ceil(embedChars / CHARS_PER_TOKEN)
      const embedCostUsd = (embedTokensEst / 1000) * EMBED_USD_PER_1K_TOKENS
      recordEmbedCostUsd(embedCostUsd, { worker: WORKER_ID })
      recordEmbedTokensEstimated(embedTokensEst, { worker: WORKER_ID })
      recordPostsIndexed(newPosts.length, { worker: WORKER_ID })
      logEvent('flush', {
        drained: posts.length,
        new: newPosts.length,
        existing: existing.size,
        cursor_us: maxCursor,
        cursor_lag_us: Date.now() * 1000 - maxCursor,
        ms: Date.now() - t0,
        queue: queue.length,
        embed_chars: embedChars,
        embed_tokens_est: embedTokensEst,
        embed_cost_usd: embedCostUsd,
      })
    }

    if (maxCursor > lastCursorUs) {
      lastCursorUs = maxCursor
      await writeCursor({
        cursor_us: lastCursorUs,
        host: cfg.jetstreamHost,
        updated_at: new Date().toISOString(),
      })
    }
    lastFlushAt = Date.now()
  } catch (err) {
    queue.unshift(...drained)
    logEvent('flush_failed', { error: String(err), queue: queue.length })
    await sleep(2000)
  } finally {
    flushing = false
  }
}

const main = async () => {
  startHealthServer()

  const store = new VertexStore(cfg)
  await store.ensureCollection()

  const checkpoint = await readCursor()
  // First start with no checkpoint: start from "now" — 60s grace for connection.
  const initialCursor =
    checkpoint?.cursor_us ?? Date.now() * 1000 - 60_000_000
  lastCursorUs = initialCursor

  logEvent('worker_start', {
    cursor_us: initialCursor,
    resumed: !!checkpoint,
    project: cfg.gcpProject,
    bucket: cfg.gcsBucket,
  })

  flushTimer = setInterval(() => {
    flush(store).catch((err) => console.error('[flush-tick] error:', err))
  }, cfg.flushMs)

  const QUEUE_MAX = 20_000
  const handle = (event: JetstreamCreateEvent) => {
    const post = extractPost(event)
    if (!post) return
    if (queue.length >= QUEUE_MAX) {
      // Backpressure: drop oldest. Cursor still advances on flush so we don't
      // get stuck replaying — at the cost of skipping some posts.
      queue.splice(0, queue.length - QUEUE_MAX + 1)
    }
    queue.push({ post, cursorUs: event.time_us })
    if (queue.length >= cfg.batchMax) {
      flush(store).catch((err) => console.error('[flush-trigger] error:', err))
    }
  }

  // Reconnect loop with exponential backoff.
  let backoff = 1000
  while (true) {
    const js = new Jetstream({
      endpoint: `wss://${cfg.jetstreamHost}/subscribe`,
      wantedCollections: ['app.bsky.feed.post'],
      cursor: lastCursorUs,
    })
    js.on('open', () => {
      logEvent('ws_open', { cursor_us: lastCursorUs })
      backoff = 1000
    })
    js.onCreate('app.bsky.feed.post', (event) => handle(event as unknown as JetstreamCreateEvent))
    js.on('error', (err) => logEvent('ws_error', { error: String(err) }))

    const closed = new Promise<void>((resolve) => {
      js.on('close', () => {
        logEvent('ws_close', { backoff_ms: backoff })
        resolve()
      })
    })
    js.start()
    await closed

    await sleep(backoff)
    backoff = Math.min(30_000, backoff * 2)
  }
}

// Cloud Run sends SIGTERM with 10s grace; flush metrics so we don't lose the last window.
const cleanShutdown = async (signal: string) => {
  console.log(JSON.stringify({ event: 'worker_shutdown', signal }))
  if (flushTimer) clearInterval(flushTimer)
  try { await shutdownMetrics() } catch {}
  process.exit(0)
}
process.on('SIGTERM', () => { cleanShutdown('SIGTERM') })
process.on('SIGINT', () => { cleanShutdown('SIGINT') })

main().catch(async (err) => {
  console.error('[worker] fatal:', err)
  try { await shutdownMetrics() } catch {}
  process.exit(1)
})
