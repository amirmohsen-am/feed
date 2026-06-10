# Ripple Feed

A Bluesky custom-feed curator. Talk to a Claude agent about what you want to read; the resulting feed config is stored in Postgres and used to query Vertex AI Vector Search for matching posts.

This is a monorepo with two services that deploy independently to Cloud Run in `timelines-492720`:

```
apps/
├── web/                  Next.js 16 + React 19. Service: feed-web.
└── jetstream-indexer/    Node 22 worker. Consumes Bluesky Jetstream, embeds
                          posts via Vertex Gemini, upserts into Vertex Vector
                          Search. Service: jetstream-indexer.
```

Each app is self-contained — they share no code. Architecture details live in `AGENTS.md`.

## Setup

```bash
gcloud auth application-default login
```

The two real secrets (`DATABASE_URL`, `ANTHROPIC_API_KEY`) are fetched at runtime from Google Secret Manager in `timelines-492720` (see `apps/web/src/lib/secrets.ts`). All Vertex resource IDs are hardcoded as defaults in code (`apps/web/src/lib/vector-search.ts` and `apps/jetstream-indexer/src/config.ts`), env-overridable.

You need access to `timelines-492720`:
- `roles/secretmanager.secretAccessor` on `database-url` and `anthropic-api-key`
- `roles/aiplatform.user` (for the vector index)
- `roles/storage.objectAdmin` on `gs://happy-feed-data-timelines` (worker only)

If you'd rather not use Secret Manager, set `DATABASE_URL` and/or `ANTHROPIC_API_KEY` as plain env vars — `getSecret()` checks `process.env` first.

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

Open <http://localhost:3000>. Sign in with Google, click **Try demo**, chat with the agent.

## Run the worker

```bash
cd apps/jetstream-indexer
npm install
npm start    # consumes Bluesky Jetstream, writes to gs://happy-feed-data-timelines
              # and the prod Vertex index — local dev should normally let the
              # Cloud Run instance handle this.
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
  --memory=1Gi \
  --service-account=777152549518-compute@developer.gserviceaccount.com
```

The worker needs `--no-cpu-throttling` (long-lived WebSocket to Jetstream) and `concurrency=1` (single writer to the cursor file).

## Database settings applied out-of-band (bsky-db)

The `bsky_posts` database carries settings that live **only in the live instance** — they are not in `apps/jetstream-indexer/sql/*.sql` migrations, and a rebuild/restore of `bsky-db` silently loses them (feeds with selective filters degrade to near-empty results, no errors). Reapply after any rebuild:

```sql
-- Load pgvector in this session first; otherwise ALTER DATABASE fails with
-- "permission denied to set parameter" (extension GUCs are unknown placeholders
-- until vector.so is loaded in the issuing backend).
SELECT '[1,2,3]'::vector;

ALTER DATABASE bsky_posts SET hnsw.ef_search = 250;
ALTER DATABASE bsky_posts SET hnsw.iterative_scan = 'relaxed_order';
ALTER DATABASE bsky_posts SET hnsw.max_scan_tuples = 40000;
ALTER DATABASE bsky_posts SET effective_cache_size = '12GB';
```

- `ef_search = 250` — HNSW recall knob; set at database level so the pooled one-shot read path needs no `SET LOCAL`.
- `iterative_scan = relaxed_order` + `max_scan_tuples = 40000` — fixes filtered-KNN starvation: by default the scan stops after `ef_search` candidates, so selective filter combos (e.g. 24h + en + top-level + min likes) post-filter down to ~0 hits. Iterative scan resumes the graph walk until the LIMIT fills, bounded at 40k tuples visited (never a full scan). `relaxed_order` is fine because the read path unions per-subquery results and reranks anyway.
- The HNSW index itself is also built out-of-band (`CREATE INDEX CONCURRENTLY`, see `apps/jetstream-indexer/sql/0003_pgvector.sql`) — the boot-time migrator does not create it.

Verify current values: `SELECT setconfig FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE d.datname = 'bsky_posts';`

## Monitoring

Cloud Monitoring dashboard for the indexer (flush rate, cursor lag, embed cost, QPS): <https://console.cloud.google.com/monitoring/dashboards/builder/781a3b9f-7c30-4eed-82bd-61fa79964612?project=timelines-492720>

Source JSON lives at `apps/jetstream-indexer/monitoring/dashboard.json` — re-import with `gcloud monitoring dashboards create --config-from-file=...` if it gets blown away.

See `AGENTS.md` for the full architecture, env vars, and the list of things this repo intentionally does **not** do.

## TODO

- **`/introspect` storage + auth.** The Bluesky engagement self-portrait at `/introspect/<handle>` currently writes per-handle snapshots and a shared image cache to `apps/web/.local-data/introspect/` on disk. That's fine for a single-instance demo but breaks the moment Cloud Run autoscales or redeploys (per-container, ephemeral). It is also signed-out — anyone can introspect any public handle. Two things to figure out before this graduates from demo:
  - **Storage:** decide between Postgres (consistent with the rest of the app, but adds a schema and a write-amplification per-click), GCS-backed JSON blobs (cheap, matches the current shape — swap `lib/introspect/storage.ts` and keep the type), or Firestore (cheap and indexed by handle, but new infra). Image cache likely wants its own bucket either way.
  - **Auth:** at minimum gate `/introspect` behind Firebase sign-in like the curator. Open question whether to require Bluesky ownership proof (AT Proto OAuth) before letting someone introspect a given handle, or keep it "introspect any public handle once signed in".
