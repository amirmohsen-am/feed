# Ripple Feed

A Bluesky custom-feed curator. Talk to a Claude agent about what you want to read; the resulting feed config is stored in Postgres and used to query pgvector (HNSW) on `bsky-db` for matching posts.

This is a monorepo with two services that deploy independently to Cloud Run in `timelines-492720`:

```
apps/
├── web/                  Next.js 16 + React 19. Service: feed-web.
└── jetstream-indexer/    Node 22 worker. Consumes Bluesky Jetstream, embeds
                          posts via Vertex Gemini, writes embeddings into
                          pgvector on bsky-db. Service: jetstream-indexer.
```

Each app is self-contained — they share no code. Architecture details live in `AGENTS.md`.

## Setup

```bash
gcloud auth application-default login
```

The three real secrets (`DATABASE_URL`, `BSKY_DATABASE_URL`, `ANTHROPIC_API_KEY`) are fetched at runtime from Google Secret Manager in `timelines-492720` (see `apps/web/src/lib/secrets.ts`). The Vertex Gemini embedding resource IDs are hardcoded as defaults in code (`apps/web/src/lib/vector-search.ts` and `apps/jetstream-indexer/src/config.ts`), env-overridable.

You need access to `timelines-492720`:
- `roles/secretmanager.secretAccessor` on `database-url`, `bsky-database-url`, and `anthropic-api-key`
- `roles/aiplatform.user` (for Gemini embeddings)
- `roles/storage.objectAdmin` on `gs://happy-feed-data-timelines` (worker only)

If you'd rather not use Secret Manager, set any of `DATABASE_URL` / `BSKY_DATABASE_URL` / `ANTHROPIC_API_KEY` as plain env vars — `getSecret()` checks `process.env` first.

Apply the Postgres schema once:

```bash
npx tsx scripts/setup-postgres.ts
```

## Run the web app

```bash
cd apps/web
npm install
npm run dev
```

Open <http://localhost:3000>. The landing page is at `/`; the curator lives at `/curator` (linked from the landing nav). Sign in with Google, then chat with the agent.

## Run the worker

```bash
cd apps/jetstream-indexer
npm install
npm start    # consumes Bluesky Jetstream, writes to gs://happy-feed-data-timelines
              # and pgvector on the prod bsky-db — local dev should normally let
              # the Cloud Run instance handle this.
```

## Deploy

Both services deploy from this repo to Cloud Run in `timelines-492720`.

**Web:** source-based deploy from `apps/web/`:

```bash
cd apps/web
gcloud run deploy feed-web --source=. --region=us-central1 --project=timelines-492720
```

**Worker:** Cloud Build → Artifact Registry → Cloud Run:

```bash
cd apps/jetstream-indexer
gcloud builds submit --config=cloudbuild.yaml --project=timelines-492720 .
gcloud run deploy jetstream-indexer \
  --image=us-central1-docker.pkg.dev/timelines-492720/jetstream-indexer/worker:latest \
  --region=us-central1 --project=timelines-492720 \
  --no-cpu-throttling --min-instances=1 --max-instances=1 --concurrency=1 \
  --cpu=2 --memory=2Gi \
  --service-account=777152549518-compute@developer.gserviceaccount.com
```

The worker needs `--no-cpu-throttling` (long-lived WebSocket to Jetstream) and `concurrency=1` (single writer — prevents races on the per-consumer cursors in `bsky.consumer_state`).

## Rate limiting & cost controls

The demo is public and unauthenticated, so the paid LLM / embedding / Hive routes are rate-limited **per client IP**. Implemented in `apps/web/src/lib/rate-limit.ts` as an **in-memory fixed-window limiter** — correct because `feed-web` is pinned at `min=max=1` (one process ⇒ one global counter). If you ever raise max instances, move this to shared state (Postgres/Redis) or Cloud Armor, or the limit multiplies per instance.

Keyed on the client IP (rightmost `X-Forwarded-For` entry). Over-limit requests get `429` + a `Retry-After` header; the client shows a calm "Easy there" toast (`ServerErrorToast`) instead of an error.

| Tier | Limits (per IP) | Routes |
|---|---|---|
| `LLM_RULES` | 20/min, 300/day | `/api/chat`, `/api/search`, `/api/import-memory`, `/api/branch/options`, `/api/feed-preview/stream` |
| `EXPENSIVE_RULES` | 6/min, 40/hr, 80/day | `/api/introspect/fetch`, `/api/introspect/process-batch` (multi-call / heavy fan-out) |
| `HIVE_RULES` | 100/min, 1000/hr, 4000/day | `/api/ai-label` (fires one request per image-bearing post on every feed load) |

**Bypass / tuning** (env vars on the `feed-web` service):

- `RATE_LIMIT_DISABLED=1` — disable the limiter entirely (use on a dev/staging deploy).
- `RATE_LIMIT_ALLOW_IPS=ip1,ip2,…` — IPs that skip the limiter. The office IP `64.125.53.231` is built in.

**Input caps:** chat message ≤ 4000 chars, search query ≤ 1000 chars, memory import ≤ 8000 chars.

**These limits are not the bill ceiling.** They blunt scripted abuse; the hard guarantee is provider-side and must be set separately: an **Anthropic** monthly spend limit and a **Hive** usage cap. **Vertex AI** (Gemini embeddings) is intentionally **not capped** — embeddings are low-cost, so a plain **GCP** billing budget/alert on `timelines-492720` is enough there rather than a hard request quota.

> `/api/ai-label` results are cached per image URL in feed-db (`ai_image_labels`, `sql/008`) — Bluesky image URLs are content-addressed, so each unique image hits the paid Hive API at most once. Hive itself is dormant until a `hive-api-key` secret is configured.

## Monitoring

Cloud Monitoring dashboard for the indexer (flush rate, cursor lag, embed cost, QPS): <https://console.cloud.google.com/monitoring/dashboards/builder/781a3b9f-7c30-4eed-82bd-61fa79964612?project=timelines-492720>

Source JSON lives at `apps/jetstream-indexer/monitoring/dashboard.json` — re-import with `gcloud monitoring dashboards create --config-from-file=...` if it gets blown away.

See `AGENTS.md` for the full architecture, env vars, and the list of things this repo intentionally does **not** do.

## TODO

- **`/introspect` storage + auth.** The Bluesky engagement self-portrait at `/introspect/<handle>` currently writes per-handle snapshots and a shared image cache to `apps/web/.local-data/introspect/` on disk. That's fine for a single-instance demo but breaks the moment Cloud Run autoscales or redeploys (per-container, ephemeral). Two things to figure out before this graduates from demo:
  - **Storage:** decide between Postgres (consistent with the rest of the app, but adds a schema and a write-amplification per-click), GCS-backed JSON blobs (cheap, matches the current shape — swap `lib/introspect/storage.ts` and keep the type), or Firestore (cheap and indexed by handle, but new infra). Image cache likely wants its own bucket either way.
  - **Auth:** entry is now gated by `IntrospectGate` (Bluesky connect). Open question whether to require Bluesky ownership proof (AT Proto OAuth) before letting someone introspect a given handle, or keep it "introspect any public handle once connected".
