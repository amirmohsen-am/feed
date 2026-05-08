// OpenTelemetry metrics → Cloud Monitoring.
//
// CUMULATIVE counters (not log-based DELTA distributions) — log-based metrics
// with EXTRACT() are forced to DISTRIBUTION value type, which can't be reduced
// to a window-bounded scalar through Cloud Monitoring's standard aggregator.

import { metrics, diag, DiagConsoleLogger, DiagLogLevel, type Counter } from '@opentelemetry/api'
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

let _embedCostUsd: Counter | null = null
export const recordEmbedCostUsd = (usd: number, attrs: Record<string, string> = {}): void => {
  if (!_embedCostUsd) {
    _embedCostUsd = getMeter().createCounter('happy_feed_embed_cost_usd', {
      description: 'Calculated Gemini embedding cost in USD (estimated from char/4 token count × pricing rate, not actual billing).',
      unit: '{USD}',
    })
  }
  _embedCostUsd.add(usd, attrs)
}

let _postsIndexed: Counter | null = null
export const recordPostsIndexed = (count: number, attrs: Record<string, string> = {}): void => {
  if (!_postsIndexed) {
    _postsIndexed = getMeter().createCounter('happy_feed_posts_indexed_total', {
      description: 'Total posts upserted into the vector store (cumulative since worker start).',
      unit: '1',
      valueType: 1,
    })
  }
  _postsIndexed.add(count, attrs)
}

let _embedTokens: Counter | null = null
export const recordEmbedTokensEstimated = (tokens: number, attrs: Record<string, string> = {}): void => {
  if (!_embedTokens) {
    _embedTokens = getMeter().createCounter('happy_feed_embed_tokens_total', {
      description: 'Estimated total tokens sent to Gemini embeddings (cumulative since worker start).',
      unit: '1',
      valueType: 1,
    })
  }
  _embedTokens.add(tokens, attrs)
}

export const shutdownMetrics = async (): Promise<void> => {
  if (_provider) await _provider.shutdown()
}
