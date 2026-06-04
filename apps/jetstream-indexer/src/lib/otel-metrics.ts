// OpenTelemetry metrics → Cloud Monitoring.
//
// CUMULATIVE counters (not log-based DELTA distributions). Each metric is
// keyed by consumer where applicable so the dashboard can compare loops.

import { metrics, diag, DiagConsoleLogger, DiagLogLevel, type Counter, type ObservableGauge } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { MetricExporter } from '@google-cloud/opentelemetry-cloud-monitoring-exporter'
import { config } from '../config.js'

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN)

const SERVICE_NAME = 'jetstream-indexer'
const METER_NAME = 'jetstream-indexer'
const EXPORT_INTERVAL_MS = 60_000

let _initialized = false
let _provider: MeterProvider | null = null

const init = (): void => {
  if (_initialized) return
  _initialized = true
  const exporter = new MetricExporter({ projectId: config.gcpProject })
  const resource = resourceFromAttributes({ 'service.name': SERVICE_NAME })
  _provider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: EXPORT_INTERVAL_MS,
      }),
    ],
  })
  metrics.setGlobalMeterProvider(_provider)
}

const getMeter = () => {
  init()
  return metrics.getMeter(METER_NAME)
}

// ----- Counters -----

const counters = new Map<string, Counter>()
const counter = (name: string, description: string, unit = '1'): Counter => {
  const cached = counters.get(name)
  if (cached) return cached
  const c = getMeter().createCounter(name, { description, unit, valueType: 1 })
  counters.set(name, c)
  return c
}

export const recordEmbedCostUsd = (usd: number, attrs: Record<string, string> = {}) =>
  counter('happy_feed_embed_cost_usd', 'Calculated Gemini embedding cost (estimated, not billed).', '{USD}').add(usd, attrs)

export const recordEmbedTokensEstimated = (tokens: number, attrs: Record<string, string> = {}) =>
  counter('happy_feed_embed_tokens_total', 'Estimated total tokens sent to Gemini embeddings.').add(tokens, attrs)

export const recordPostsIndexed = (n: number, attrs: Record<string, string> = {}) =>
  counter('happy_feed_posts_indexed_total', 'Total posts upserted into the vector store.').add(n, attrs)

// Generic per-consumer event counters keyed by `kind` attribute
// (kind=posts|likes|reposts|profiles|identity).
export const recordEventsConsumed = (n: number, attrs: { kind: string; worker?: string }) =>
  counter('happy_feed_events_consumed_total', 'Jetstream events consumed by kind.').add(n, attrs)

export const recordEventsFlushed = (n: number, attrs: { kind: string; worker?: string }) =>
  counter('happy_feed_events_flushed_total', 'Jetstream events persisted to Postgres/parquet by kind.').add(n, attrs)

export const recordFlushFailed = (n: number, attrs: { kind: string; worker?: string }) =>
  counter('happy_feed_flush_failed_total', 'Flush failures by consumer kind.').add(n, attrs)

export const recordFlushDropped = (n: number, attrs: { kind: string; worker?: string }) =>
  counter(
    'happy_feed_flush_dropped_total',
    'Records dropped after exhausting flush retries (poison batch). Each unit = one record (post / like / repost / profile / identity / delete URI) that did not reach Postgres.',
  ).add(n, attrs)

export const recordEngagementApplied = (n: number, attrs: { kind: 'like' | 'repost' | 'reply' | 'quote'; worker?: string }) =>
  counter('happy_feed_engagement_applied_total', 'Engagement counter increments applied to bsky.post_engagement.').add(n, attrs)

// ----- Observable gauges (sampled at export time) -----

// Per-consumer gauges share a single metric name + a `kind` label so the
// dashboard can plot them on one panel (Cloud Monitoring doesn't support
// regex on metric.type, so the alternative of one metric per kind doesn't
// aggregate cleanly).

const queueDepthGetters = new Map<string, () => number>()
let _queueDepthGauge: ObservableGauge | null = null
export const registerQueueDepth = (kind: string, getLength: () => number) => {
  queueDepthGetters.set(kind, getLength)
  if (!_queueDepthGauge) {
    _queueDepthGauge = getMeter().createObservableGauge('happy_feed_queue_depth', {
      description: 'Live queue depth per consumer (kind label).',
      valueType: 1,
    })
    _queueDepthGauge.addCallback((result) => {
      for (const [k, g] of queueDepthGetters) result.observe(g(), { kind: k })
    })
  }
}

const cursorLagGetters = new Map<string, () => number>()
let _cursorLagGauge: ObservableGauge | null = null
export const registerCursorLagUs = (kind: string, getLagUs: () => number) => {
  cursorLagGetters.set(kind, getLagUs)
  if (!_cursorLagGauge) {
    _cursorLagGauge = getMeter().createObservableGauge('happy_feed_cursor_lag_us', {
      description: 'Microseconds behind real-time per consumer (kind label).',
      valueType: 1,
    })
    _cursorLagGauge.addCallback((result) => {
      for (const [k, g] of cursorLagGetters) result.observe(g(), { kind: k })
    })
  }
}

export const shutdownMetrics = async (): Promise<void> => {
  if (_provider) await _provider.shutdown()
}
