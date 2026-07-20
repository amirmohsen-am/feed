# jetstream-indexer monitoring

Two artifacts live here; both are the source of truth for what's deployed in
Cloud Monitoring (project `timelines-492720`).

## Dashboard — `dashboard.json`

Cloud Monitoring dashboard for the worker: consumer throughput/queue depth/cursor
lag (OTel metrics, see below) plus bsky-db Cloud SQL panels (CPU, memory, disk
IOPS, backends).

## Alert — `alert-ingestion-stall.json`

Policy **"jetstream-indexer: post ingestion stalled"**, deployed as
`projects/timelines-492720/alertPolicies/5317996576747912419`. Fires when ANY of:

| Condition | Threshold | Catches |
|---|---|---|
| indexed-posts rate low | < 5 posts/s for 30 min | degraded trickle (healthy floor is ~17/s) |
| metric absent | no data for 20 min | dead process / all flushes wedged |
| post cursor lag | > 30 min for 30 min | replay livelock (flushing but stuck in the past) |

Notification channels: Amir (email), Christian (email), Slack `#amadi-alerts`.
The runbook is embedded in the policy's documentation field (shows up in the
alert email/message).

Update flow — edit the JSON, then:

```bash
gcloud alpha monitoring policies update \
  projects/timelines-492720/alertPolicies/5317996576747912419 \
  --policy-from-file=alert-ingestion-stall.json --project=timelines-492720
```

(`policies update --policy-from-file` replaces conditions but keeps notification
channels; use `--add-notification-channels=<channel-resource>` to wire new ones.
`gcloud alpha monitoring channels list` shows what exists.)

Adding a Slack channel requires a one-time workspace authorization that only the
Cloud Console can do: Monitoring → Alerting → Edit notification channels →
Slack → Add new → authorize the workspace, then attach the channel to the policy.

## Metrics

Exported by `src/lib/otel-metrics.ts` (OTel → Cloud Monitoring, cumulative,
60s export interval) under `workload.googleapis.com/…`, resource type
`generic_node`:

- `happy_feed_posts_indexed_total` — posts upserted (the alert's rate signal)
- `happy_feed_events_consumed_total` / `happy_feed_events_flushed_total` (by `kind`)
- `happy_feed_flush_failed_total` / `happy_feed_flush_dropped_total` — failures / poison drops
- `happy_feed_queue_depth`, `happy_feed_cursor_lag_us` — gauges per consumer (`kind` label)
- `happy_feed_embed_cost_usd`, `happy_feed_embed_tokens_total`, `happy_feed_engagement_applied_total`
- `happy_feed_extract_failed_total` (by `kind`) — one malformed Jetstream event dropped by the
  per-event `guardHandler` (extractor threw). Should stay near zero; a sustained rate means the
  firehose is delivering records that break an extractor.
- `happy_feed_worker_error_total` (by `kind`) — process-level backstop for unhandled
  rejections / uncaught exceptions. Must stay flat; any increment means an error escaped the
  per-event guard.

## Background: the 2026-07-07 outage this alert exists for

Post ingestion ran at ~2.5% of normal for 40 hours with no page. Compounding
causes (all fixed, see PR #136): NUL bytes in post text poisoning upsert batches,
websocket reconnects rewinding to the boot-time cursor (replay livelock), a hung
flush permanently wedging the queue latch, and a 65h-stuck autovacuum grinding
the 30GB HNSW index and starving inserts. If the alert fires with INSERTs waiting
on `DataFileRead` and a long-running `autovacuum: VACUUM bsky.posts` in
`pg_stat_progress_vacuum`, cancel the vacuum (`pg_cancel_backend`) and consider
`apps/web/scripts/reclaim-posts-bloat.ts`; durable options are more instance RAM,
shorter retention, or scheduled REINDEX.

## Background: the 2026-07-17 crash loop (fixed, PR #138)

`extractPost` did `(r.text ?? '').trim()`, assuming `text` is a string. Jetstream
delivers raw, unvalidated user records; a post with a non-string `text` made
`.trim` undefined → `TypeError` thrown synchronously inside the `onCreate`
handler → unhandled rejection → `exit(1)`. Cloud Run restarted, replayed the same
cursor, hit the same record, and re-crashed — a ~2.5-day crash loop that only
self-healed when the poison event aged out of Jetstream retention. Two fixes:
(1) `extractPost` coerces non-string `text` to empty; (2) every consumer's event
handler is wrapped in `guardHandler` (drops the one bad event, increments
`happy_feed_extract_failed_total`) plus a process-level `unhandledRejection` /
`uncaughtException` backstop in `worker.ts`. If `happy_feed_extract_failed_total`
climbs, a new record shape is breaking an extractor — check the `handler_error`
logs for the offending `did`/`rkey`/`collection`.
