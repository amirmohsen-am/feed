<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Architecture

Ripple Feed is a Bluesky custom-feed curator. The user chats with a Claude agent about what they want to read; the feed config is stored in Postgres. Viewing a feed runs a pgvector (HNSW) KNN on `bsky-db`.

**Monorepo, two independently-deployed services**, each self-contained with its own `package.json`/`package-lock.json` (no shared workspace packages):

```
apps/
├── web/                ← Next.js 16 (App Router, Node 22) — curator + landing + API. Cloud Run: feed-web.
└── jetstream-indexer/  ← Node 22 + tsx worker — consumes Bluesky Jetstream, embeds posts, writes
                          pgvector on bsky-db. Cloud Run: jetstream-indexer.
```

| Concern | Choice |
|---|---|
| Auth | Anonymous session cookie (`apps/web/src/middleware.ts`); server resolves it in `lib/auth.ts` (`requireAuth`) via `session.ts`. Bluesky OAuth (`lib/bsky-oauth.ts`) layers on for authenticated Bluesky actions. |
| Chat LLM | Anthropic Claude (`claude-sonnet-4-6`) via `@anthropic-ai/sdk` — `/api/chat`, `/api/import-memory` |
| Post search | pgvector (HNSW, halfvec) on `bsky-db` — `apps/web/src/lib/vector-search.ts`. Query embedding via Vertex Gemini. |
| Hosting | Both on Cloud Run in `timelines-492720` |

## Databases

Two Cloud SQL Postgres 15 instances in `timelines-492720`, one database each. Split so the write-heavy firehose can't contend with the curator UI. Connection strings carry the instance via env: web → `CLOUDSQL_CONNECTION_NAME` (feed-db); indexer + web's bsky pool → `BSKY_CLOUDSQL_CONNECTION_NAME` (bsky-db).

- **`feed-db`** (db-f1-micro) — web app's `feed_curator` db. Secret: `database-url`.
  - `users` — session id → internal UUID; linked Bluesky DID/handle after OAuth
  - `feeds` — per-user feed configs · `chat_messages` — per-feed transcripts · `subscribers` — landing mailing list
- **`bsky-db`** (db-custom-1-3840, dedicated CPU) — indexer's `bsky_posts` db. Secret: `bsky-database-url`. Schema migrated on indexer boot from `apps/jetstream-indexer/sql/*.sql`.
  - `bsky.posts` — full post body, embed metadata, reply refs, facets; searchable `embedding halfvec(768)` (HNSW) + legacy cached `embedding_vec bytea` (packed float32, kept until pgvector fully validated in prod)
  - `bsky.post_engagement` — `like/repost/reply/quote_count`, read live via the KNN join (`last_pushed_to_vertex_at` is a dead Vertex leftover)
  - `bsky.authors` · `bsky.handles_history` (append-only on handle change) · `bsky.consumer_state` (per-consumer Jetstream cursor, microseconds)

# Vector search

**Read side** (`apps/web/src/lib/vector-search.ts`): embeds each subquery with Gemini (`gemini-embedding-001`, 768d, `RETRIEVAL_QUERY`), then one pgvector KNN per subquery in a single SQL statement (`embedding <=> $1::halfvec` + filters + engagement/author join + field selection, no separate hydrate). `searchPosts` unions per-subquery rows by URI (max `vector_score`) and applies the AppView NSFW label gate.
- **Invariant:** the HNSW index is **partial** (`WHERE ingested_at_us >= INDEX_INGEST_CUTOFF_US`); every KNN must carry that same literal floor or it degrades to an exact scan over all rows. `hnsw.ef_search = 250` is set at the DB level.

**Write side:** the jetstream-indexer worker (see below).

**Backfill/reindex invariant — never re-embed.** Every vector is cached in `bsky.posts.embedding_vec` (packed float32, 768d) and archived as parquet in `gs://happy-feed-data-timelines/`. Any backfill/migration must reinterpret those cached bytes, not call Gemini again. See `apps/web/scripts/backfill-halfvec.ts`.

Local reader smoke test (auth via `gcloud auth application-default login`):
```bash
cd apps/web && npx tsx -e "import { searchPosts } from './src/lib/vector-search'; (async () => console.log(await searchPosts({ subqueries: ['climate'], totalBudget: 3 })))()"
```
~3 hits in 1–2s. **If it 403s, set `GOOGLE_CLOUD_QUOTA_PROJECT=timelines-492720`.**

Vertex is used **only for Gemini embeddings** (project `timelines-492720`, region `us-central1`). These are public resource IDs, plain env vars (not secrets): `VERTEX_PROJECT`, `VERTEX_LOCATION`, `GCS_BUCKET` (worker only).

### feed-db: default to prod, opt in to local

The web app connects to the **prod** `feed-db` by default (via the Cloud SQL connector + the `database-url` secret). This is the default for all local runs — `npm run dev` against prod is correct for UI work and for reading real data. **Only opt in to the local Postgres when you are making changes to the database schema/data** (migrations, destructive writes, anything you don't want hitting prod).

The switch is a single env var, `LOCAL_DATABASE_URL` (resolved in `apps/web/src/lib/db/connection.ts`):

- **Unset (default)** → prod `feed-db`. Run `npm run dev`.
- **Set** to a local DSN → bypasses Cloud SQL and the secret, connects directly to local Postgres. Bootstrap once with `LOCAL_DATABASE_URL=… npx tsx scripts/setup-local-db.ts` (see `apps/web/LOCAL_DB.md`), then run with the var set.

Do not commit `LOCAL_DATABASE_URL` into any `.env*` file — keep prod the default and pass it inline only for the local-DB session that needs it.

# Jetstream indexer

`apps/jetstream-indexer/src/worker.ts` runs three Jetstream consumers + a prune loop in one Node process; per-consumer cursors in `bsky.consumer_state` make it restart-safe. All consumers also write parquet to `gs://happy-feed-data-timelines/jetstream/{posts,likes,reposts,profiles,identity}/dt=YYYY-MM-DD/` as the replay log.

1. `postConsumer` — `app.bsky.feed.post` creates + deletes. Composes embedding input (`text + image alts + external title/description`), embeds via Gemini `RETRIEVAL_DOCUMENT`, upserts `bsky.posts` (full record + `embedding halfvec` + cached `embedding_vec`). Reply/quote creates bump parent/target counters.
2. `engagementConsumer` — `app.bsky.feed.like` + `repost` creates only. Monotonic counters in `bsky.post_engagement`; deletes ignored (drift ~1–5%). No reconciler/push — read live by the KNN join.
3. `profileConsumer` — `app.bsky.actor.profile` + Jetstream `identity` events. Upserts `bsky.authors`, appends `bsky.handles_history`.
4. `prune` — retention prune anchored on `ingested_at_us` (client `created_at` is garbage at both extremes).

The pgvector HNSW index is built once out-of-band (`CREATE INDEX CONCURRENTLY`, `sql/0003_pgvector.sql`), not by the boot migrator. Both services run as the compute SA `777152549518-compute@developer.gserviceaccount.com` (has `roles/aiplatform.user`).

- **Run locally:** `cd apps/jetstream-indexer && npm start` — ⚠️ writes to the **prod** bsky-db + GCS bucket.
- **Cloud Run invariant:** `--no-cpu-throttling --min-instances=1 --max-instances=1 --concurrency=1 --cpu=2 --memory=2Gi`. Concurrency=1 prevents cursor races.
- **Deploy:** `./deploy.sh` (in each app dir) — builds locally (`docker buildx`, linux/amd64), pushes to Artifact Registry, then `gcloud run deploy`s the image. The image swap preserves the live revision's config (env via `src/config.ts`, scaling, secrets). Args: `full` (default), `push-only`, `deploy-only`.
- **Fresh backfill:** `npx tsx scripts/wipe-and-rewind.ts <days>` — ⚠️ **TRUNCATEs `bsky.*`** and rewinds cursors; then restart the service. Replay is bounded by Jetstream retention (~hours).
- **Logs:** `gcloud logging read 'resource.labels.service_name="jetstream-indexer"' --project=timelines-492720`. Dashboard: `apps/jetstream-indexer/monitoring/dashboard.json`.

# Publishing to Bluesky

`PublishFeedModal` → `POST /api/publish-feed` writes an `app.bsky.feed.generator` record to the user's repo (OAuth, app-password fallback) pointing at this service's `did:web`, storing the rkey in `feeds.published_rkey`. Bluesky resolves the feed via the xrpc endpoints served here: `/.well-known/did.json`, `/xrpc/app.bsky.feed.describeFeedGenerator`, `/xrpc/app.bsky.feed.getFeedSkeleton` (serves URIs from the cached skeleton).

# Conventions

- **Fresh worktrees have no `node_modules`.** Don't check for it or skip steps because deps are missing — always run `npm install` first as part of any verify step (near-noop when current; pre-approved, never ask). Bundle it in:
  - Web typecheck: `cd apps/web && npm install && npx tsc --noEmit` · lint: `... && npm run lint`
  - Indexer typecheck: `cd apps/jetstream-indexer && npm install && npm run typecheck`
- **Landing copy & design:** never use italics (emphasis is color only; `em` is styled `font-style: normal`), and never use dashes ("-", "—") in user-facing copy — rephrase with commas or new sentences.
- API routes under `apps/web/src/app/api/*` use `requireAuth(req)` — except the intentionally public `/api/introspect/*`, `/api/subscribe`, `/api/feedgen/info`, and the xrpc / `did.json` endpoints.
- Curator sidebar loads feeds from Postgres (`/api/feeds`, filtered to non-empty topics/keywords). Postgres is the only source of truth — no client-side cache. Feed switching is non-blocking; no auto-polling (user clicks **Refresh**).

# Secrets

Three real secrets in **Google Secret Manager** (`timelines-492720`): `database-url`, `bsky-database-url`, `anthropic-api-key`. **Fetched at runtime** (`apps/web/src/lib/secrets.ts`) — no `--set-secrets` mounts, no `.env.local` copies. `getSecret(name)` checks `process.env` (UPPER_SNAKE_CASE) first, then Secret Manager. Locally: `gcloud auth application-default login`. Cloud Run: the compute SA has `secretmanager.secretAccessor`. Rotate: `echo -n "<new>" | gcloud secrets versions add <name> --project=timelines-492720 --data-file=-` then restart revisions (cache is per-process).

# External resources

| What | Where |
|---|---|
| Cloud SQL | `gcloud sql instances describe {feed-db,bsky-db} --project=timelines-492720` |
| Secret Manager | `gcloud secrets list --project=timelines-492720` |
| GCS data bucket | `gs://happy-feed-data-timelines` (parquet + Jetstream cursor) |
| Artifact Registry (worker) | `us-central1-docker.pkg.dev/timelines-492720/jetstream-indexer/worker` |
| Firebase | `timelines-492720` — Analytics only now (`apps/web/src/components/Analytics.tsx`), no longer auth |
