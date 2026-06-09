<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Architecture

Ripple Feed is a Bluesky custom-feed curator. The user chats with a Claude agent about what they want to read; the resulting feed config is stored in Postgres. When the user views a feed, we query pgvector (HNSW) on `bsky-db` for matching posts.

This is a **monorepo** with two services that deploy independently:

```
feed/
├── apps/
│   ├── web/                  ← Next.js app (curator + landing + API). On Cloud Run as feed-web.
│   └── jetstream-indexer/    ← Node worker. Consumes Bluesky Jetstream, embeds posts via Vertex
│                               Gemini, writes embeddings into pgvector on bsky-db. On Cloud Run as
│                               jetstream-indexer.
```

Each app is self-contained with its own `package.json` and `package-lock.json`. There are no workspace packages — they share no code.

## Stack at a glance

| Concern | Choice |
|---|---|
| Web framework | Next.js 16 (App Router) on Node 22 — `npm run dev` from `apps/web/` |
| Worker runtime | Node 22 + tsx — `npm start` from `apps/jetstream-indexer/` |
| Package manager | npm (each app has its own `package-lock.json`) |
| Database | Cloud SQL Postgres 15 in `timelines-492720`. Two instances: `feed-db` (web app) and `bsky-db` (indexer). |
| Auth | Firebase Auth (Google sign-in). Token verified on the server in `apps/web/src/lib/auth.ts`. No user-managed admin SA key (org policy blocks creation), so prod uses insecure-decode fallback for the demo. |
| Chat LLM | Anthropic Claude (`claude-sonnet-4-6`) via `@anthropic-ai/sdk` — `/api/chat`, `/api/import-memory` |
| Post search | pgvector (HNSW, halfvec) on `bsky-db` — KNN SQL in `apps/web/src/lib/vector-search.ts`. Query embedding still via Vertex Gemini. |
| Hosting | Both services on Cloud Run in `timelines-492720` |

## Databases

**Two Cloud SQL instances**, one database each:

- **Instance `feed-db`** (db-f1-micro) — hosts the web app's `feed_curator` database. Secret: `database-url`.
  - `users` — Firebase UID → internal Postgres UUID
  - `feeds` — per-user feed configs (`name`, `mechanical_filters`, `semantic_config`, `description`)
  - `chat_messages` — per-feed chat transcripts
  - `subscribers` — landing-page mailing list
- **Instance `bsky-db`** (db-custom-1-3840, dedicated CPU) — hosts the indexer's `bsky_posts` database. Secret: `bsky-database-url`. Schema migrated on indexer boot from `apps/jetstream-indexer/sql/*.sql`.
  - `bsky.posts` — full post body, embed metadata, reply refs, facets, plus the searchable `embedding halfvec(768)` pgvector column (HNSW index) and the legacy cached `embedding_vec bytea` (packed float32, kept alongside until pgvector is fully validated in prod)
  - `bsky.post_engagement` — counters (`like_count`, `repost_count`, `reply_count`, `quote_count`). Read live via the KNN join. (The `last_pushed_to_vertex_at` column is a dead leftover from the Vertex reconciler.)
  - `bsky.authors` — handle, display name, description, avatar/banner CIDs
  - `bsky.handles_history` — append-only on handle changes (Jetstream identity events)
  - `bsky.consumer_state` — per-consumer Jetstream cursor in microseconds

The split: write-heavy bsky firehose got its own dedicated-CPU instance so it can't contend with the curator UI's queries. Connection strings carry instance via env vars: web reads `CLOUDSQL_CONNECTION_NAME` for feed-db; indexer and web's bsky pool both read `BSKY_CLOUDSQL_CONNECTION_NAME` for bsky-db.

# Vector search

**Backfilling / rebuilding the index: reuse the embeddings we already have — do NOT re-embed.** Every post's vector is cached in `bsky.posts.embedding_vec` (packed float32, 768d) and archived as parquet in `gs://happy-feed-data-timelines/`. Any backfill, reindex, or migration (e.g. populating a pgvector column) must reinterpret those cached bytes, not call Gemini again — re-embedding is a needless cost and the data is already there. See `apps/web/scripts/backfill-halfvec.ts`.

Search runs on **pgvector on `bsky-db`** — there is no Vertex Vector Search index anymore (migrated in PR #20; the Vertex index + endpoint GCP resources were deleted 2026-06-04). Vertex AI is still used, but **only for Gemini embeddings** (query + document). Both services hit the same `bsky.posts.embedding` halfvec column:

- **Read side** (`apps/web/src/lib/vector-search.ts`): embeds each subquery with Gemini (`gemini-embedding-001`, 768d, `RETRIEVAL_QUERY`), then runs one pgvector KNN per subquery in a single SQL statement — KNN (`embedding <=> $1::halfvec`) + filter predicates + engagement/author join + field selection, no separate hydrate step. `searchPosts` unions the per-subquery rows by URI (max `vector_score`) and applies the AppView NSFW label gate. The HNSW index is **partial** (`WHERE ingested_at_us >= INDEX_INGEST_CUTOFF_US`); every KNN must carry that same literal floor or it degrades to an exact scan over all rows. `hnsw.ef_search = 250` is set at the database level.
- **Write side** (`apps/jetstream-indexer/`): three parallel Jetstream consumers + a prune loop in one process:
  - `postConsumer` — `app.bsky.feed.post` creates + deletes. Composes embedding input as `text + image alt + external title/description`, embeds via Gemini `RETRIEVAL_DOCUMENT`, upserts `bsky.posts` (full record + `embedding halfvec` + cached `embedding_vec` float32 bytea). Reply / quote create events also bump `reply_count`/`quote_count` of the parent/target.
  - `engagementConsumer` — `app.bsky.feed.like` + `app.bsky.feed.repost` creates. Monotonic counters in `bsky.post_engagement`; delete events ignored (drift ~1–5%, see DECISIONS.md). Read live by the KNN join — no separate push step.
  - `profileConsumer` — `app.bsky.actor.profile` + Jetstream `identity` events. Updates `bsky.authors` and appends `bsky.handles_history`.
  - `prune` — retention prune anchored on `ingested_at_us`.

All loops share one Cloud Run instance. Per-consumer cursors live in `bsky.consumer_state`; restart-safe. All consumers also write parquet to `gs://happy-feed-data-timelines/jetstream/{posts,likes,reposts,profiles,identity}/dt=YYYY-MM-DD/` as the internal replay log.

Both processes run as the default compute SA `777152549518-compute@developer.gserviceaccount.com`, which has `roles/aiplatform.user` on `timelines-492720` (needed for Gemini embeddings).

## Vertex / pgvector env vars

| Var | Default | Notes |
|---|---|---|
| `VERTEX_PROJECT` | `timelines-492720` | Gemini embeddings project |
| `VERTEX_LOCATION` | `us-central1` | Gemini embeddings region |
| `GCS_BUCKET` | `happy-feed-data-timelines` | (worker only — parquet + cursor) |

These are **public resource IDs**, not secrets — plain env vars, not Secret Manager. The old `VERTEX_INDEX_ID` / `VERTEX_INDEX_ENDPOINT_*` / `VERTEX_DEPLOYED_INDEX_ID` vars are gone with the Vertex index. The pgvector connection is the `bsky-database-url` secret (same as read-side hydration).

## Local dev

Auth via your local ADC: `gcloud auth application-default login`. Smoke test for the reader:

```bash
cd apps/web
npx tsx -e "import { searchPosts } from './src/lib/vector-search'; (async () => console.log(await searchPosts({ subqueries: ['climate'], totalBudget: 3 })))()"
```

Should return ~3 hits in 1–2 seconds. If it 403s, set `GOOGLE_CLOUD_QUOTA_PROJECT=timelines-492720`.

Worker locally:

```bash
cd apps/jetstream-indexer
npm start    # writes to gs://happy-feed-data-timelines and pgvector on the prod bsky-db
```

# Jetstream indexer

`apps/jetstream-indexer/src/worker.ts` orchestrates three Jetstream consumers + a prune loop in a single Node process:

1. `postConsumer` — subscribes to `app.bsky.feed.post`. Extracts everything (text, reply refs, facets, embed details, langs, hashtags, mentions, self-labels). Embeds via Gemini using `composeEmbedInput` (text + image alts + external link card). Upserts `bsky.posts` (full record + `embedding halfvec` + cached `embedding_vec` float32 bytea) and writes the parquet posts archive. Reply/quote post creates bump counters on parent/target.
2. `engagementConsumer` — subscribes to `app.bsky.feed.like` + `app.bsky.feed.repost` (creates only). Monotonic increments into `bsky.post_engagement`. Delete events ignored. Counters are read live by the read-side KNN join — there is no reconciler/push step.
3. `profileConsumer` — subscribes to `app.bsky.actor.profile` + Jetstream `identity` events. Upserts `bsky.authors`, appends `bsky.handles_history` on handle changes.
4. `prune` — retention prune anchored on `ingested_at_us` (client `created_at` has garbage at both extremes).

Schema migrations run on boot from `apps/jetstream-indexer/sql/*.sql` against the `bsky` database. The pgvector HNSW index is built once out-of-band (`CREATE INDEX CONCURRENTLY`, see `sql/0003_pgvector.sql`), not by the migrator.

Cloud Run config: `--no-cpu-throttling`, `--min-instances=1 --max-instances=1 --concurrency=1`, `--cpu=2`, `--memory=2Gi`. Concurrency=1 prevents cursor races. Per-consumer cursors live in `bsky.consumer_state`.

Deploy:

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

To wipe + rewind for a fresh backfill (last 4 days):

```bash
cd apps/jetstream-indexer
npx tsx scripts/wipe-and-rewind.ts 4    # TRUNCATEs bsky.* and rewinds cursors
# Restart the Cloud Run service; consumers replay from the rewound cursors
# subject to Jetstream's retention (community reports ~hours, operator-dependent).
```

(Env vars are baked into the image's defaults via `src/config.ts`; override at deploy time with `--update-env-vars` if needed.)

Logs:

```bash
gcloud logging read 'resource.labels.service_name="jetstream-indexer"' --project=timelines-492720 --limit=20
```

`apps/jetstream-indexer/scripts/setup-vertex.sh` (provisioning a Vertex Vector Search index) is **dead** — the Vertex index/endpoint were deleted in favor of pgvector; kept only as historical reference. The Cloud Monitoring dashboard JSON is at `apps/jetstream-indexer/monitoring/dashboard.json` (import via `gcloud monitoring dashboards create --config-from-file=...`).

## What this repo does NOT do anymore

- **No OpenAI.** Embeddings come from Vertex Gemini; the chat is pure Claude.
- **No Vertex Vector Search.** Search migrated to pgvector (HNSW, halfvec) on `bsky-db` in PR #20; the Vertex index + endpoint were deleted 2026-06-04. Vertex AI is still used, but only for Gemini embeddings. There is no `MatchServiceClient`/`findNeighbors`/upsert-to-index path, and no `vertexReconciler` loop.
- **No happy-feed external repo.** The worker source moved into `apps/jetstream-indexer/` (was `/Users/amir/code/happy-feed`).
- **No publish-to-Bluesky.** The `/api/publish-feed` route, the xrpc endpoints, and `/.well-known/did.json` are gone. The `published_rkey` column on `feeds` is left in place for future revival but is unused.
- **No synthetic onboarding card bank.** Removed along with `OnboardingFlow`/`TapCards`/`TasteReveal`/`ReversePrompting` and the `onboarding_cards` table. Onboarding is now plain chat with the Claude agent.

# Conventions

- Running `npm install` (or `npm ci`) in either app is pre-approved — just do it when needed, no need to ask first.
- All API routes under `apps/web/src/app/api/*` use `requireAuth(req)` from `apps/web/src/lib/auth.ts`.
- The curator UI loads sidebar feeds from Postgres (`/api/feeds`), filtered to feeds with non-empty topics/keywords. Postgres is the source of truth — there is no client-side cache (no localStorage, no Firestore).
- Feed switching in the curator is non-blocking: clicking a feed clears the panels synchronously and fires chat + posts fetches in parallel. There is no auto-polling — the user clicks **Refresh** to re-query.

# Secrets

Three real secrets live in **Google Secret Manager** in `timelines-492720`:

| Secret | What |
|---|---|
| `database-url` | Cloud SQL connection string for the `feed` database (web app) |
| `bsky-database-url` | Cloud SQL connection string for the `bsky` database (indexer + read-side hydration) |
| `anthropic-api-key` | Anthropic Claude API key |

**The code fetches them at runtime** — see `apps/web/src/lib/secrets.ts`. There are no `--set-secrets` mounts on Cloud Run and no plaintext copies in `.env.local`. The pattern:

```ts
// pg.ts (lazy pool init)
const pool = await getPool();   // fetches DATABASE_URL from SM on first call
// chat/route.ts (lazy Anthropic client)
const c = await client();       // fetches ANTHROPIC_API_KEY from SM on first call
```

`getSecret(name)` checks `process.env` first (UPPER_SNAKE_CASE of the secret name) and falls back to Secret Manager. Override locally with an env var if needed.

**Auth**: locally, `gcloud auth application-default login` once. On Cloud Run, the runtime SA `777152549518-compute@developer.gserviceaccount.com` has `roles/secretmanager.secretAccessor` on each secret.

**Rotate**: `echo -n "<new>" | gcloud secrets versions add <name> --project=timelines-492720 --data-file=-`. The cache is per-process — restart Cloud Run revisions to pick up new versions.

# External resources

| What | Where |
|---|---|
| Cloud SQL `feed-db` (web app) | `gcloud sql instances describe feed-db --project=timelines-492720` |
| Cloud SQL `bsky-db` (indexer) | `gcloud sql instances describe bsky-db --project=timelines-492720` |
| Firebase project | `timelines-492720` (display name "timelines"). Authorized domains list managed via Identity Toolkit Admin API. |
| Secret Manager | `gcloud secrets list --project=timelines-492720` |
| Vertex Gemini embeddings | project `timelines-492720`, region `us-central1`, model `gemini-embedding-001` (768d). No Vector Search index — search is pgvector on `bsky-db`. |
| GCS data bucket | `gs://happy-feed-data-timelines` (parquet posts/embeddings + Jetstream cursor) |
| Artifact Registry (worker) | `us-central1-docker.pkg.dev/timelines-492720/jetstream-indexer/worker` |
