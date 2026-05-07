<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Architecture

Ripple Feed is a Bluesky custom-feed curator. The user chats with a Claude agent about what they want to read; the resulting feed config is stored in Postgres. When the user views a feed, we query [happy-feed](#happy-feed) for matching posts.

## Stack at a glance

| Concern | Choice |
|---|---|
| Web framework | Next.js 16 (App Router) on Node — `npm run dev` |
| Database | Cloud SQL Postgres 15 in GCP project `timelines-492720`, instance `feed-db` |
| Auth | Firebase Auth (Google sign-in). Token verified on the server in `src/lib/auth.ts`. No user-managed admin SA key (org policy blocks creation), so prod uses insecure-decode fallback for the demo. |
| Chat LLM | Anthropic Claude (`claude-sonnet-4`) via `@anthropic-ai/sdk` — `/api/chat`, `/api/import-memory` |
| Post search | Vertex AI Vector Search — called directly from `src/lib/vector-search.ts` (no middleman) |
| Hosting | Railway (web) — Cloud Run worker is decommissioned |

## Tables

- `users` — Firebase UID → internal Postgres UUID
- `feeds` — per-user feed configs (`name`, `mechanical_filters`, `semantic_config`, `description`)
- `chat_messages` — per-feed chat transcripts
- `subscribers` — landing-page mailing list
- `published_rkey` column on `feeds` is unused (publish flow is on hold)

# Vector search (direct to Vertex)

This repo calls **Vertex AI Vector Search** directly from `src/lib/vector-search.ts`. The vector index lives in GCP project **`amir-experimental`** and is fed by the [happy-feed](file:///Users/amir/code/happy-feed) Jetstream worker — but our app does not depend on happy-feed's HTTP server. We call Vertex's `MatchService.findNeighbors` and embed queries with Gemini ourselves.

| Step | API | Notes |
|---|---|---|
| Embed query | `@google/genai` → Vertex Gemini `gemini-embedding-001`, 768d, `RETRIEVAL_QUERY` task type | Matches the embedding the worker uses on ingest (`RETRIEVAL_DOCUMENT`) |
| Vector search | `@google-cloud/aiplatform` → `MatchServiceClient.findNeighbors` with `returnFullDatapoint: true` | Endpoint host: `538744258.us-central1-446303112556.vdb.vertexai.goog`, deployed index `happy_feed_deployed` |
| Hydration | Reads post `text`, `did`, `lang`, `domains`, `has_*` flags from the returned datapoint **restricts** | No external lookup. happy-feed stores the post text on the datapoint itself (commit `40fb061` in that repo: "Move post text into Vertex datapoints") |

## Cross-project IAM

The vector index is in `amir-experimental`; our Cloud Run service runs in `timelines-492720`. The runtime service account `777152549518-compute@developer.gserviceaccount.com` has `roles/aiplatform.user` on `amir-experimental`. The `aiplatform.googleapis.com` API is enabled in `timelines-492720` so quota is tracked there.

## Env vars

| Var | Default | Notes |
|---|---|---|
| `VERTEX_PROJECT` | `amir-experimental` | Where the index lives |
| `VERTEX_LOCATION` | `us-central1` | |
| `VERTEX_INDEX_ENDPOINT_ID` | `73493556223803392` | |
| `VERTEX_INDEX_ENDPOINT_HOST` | `538744258.us-central1-446303112556.vdb.vertexai.goog` | The match-service public endpoint |
| `VERTEX_DEPLOYED_INDEX_ID` | `happy_feed_deployed` | |

These are **public resource IDs**, not secrets — plain env vars, not Secret Manager.

## Local dev

Auth via your local ADC: `gcloud auth application-default login`. The smoke test is:

```bash
npx tsx -e "import { searchPosts } from './src/lib/vector-search'; (async () => console.log(await searchPosts({ query: 'climate', k: 3 })))()"
```

Should return ~3 hits in 1–2 seconds. If it 403s, run `gcloud config set project amir-experimental` for ADC quota project, or set `GOOGLE_CLOUD_QUOTA_PROJECT=amir-experimental`.

## What this repo does NOT do anymore

- **No Jetstream worker.** Removed in May 2026 along with `scripts/firehose.ts`, `Dockerfile.worker`, `cloudbuild-worker.yaml`, `src/app/api/worker/*`, `src/lib/mechanical-filter.ts`, and the `posts`/`feed_posts`/`author_post_counts` tables.
- **No OpenAI.** Embeddings come from Vertex Gemini; the chat is pure Claude.
- **No happy-feed HTTP middleman.** We call Vertex directly. happy-feed's Jetstream worker still runs in `amir-experimental` to keep the index fresh, but its server is not deployed and we don't depend on it.
- **No publish-to-Bluesky.** The `/api/publish-feed` route, the xrpc endpoints, and `/.well-known/did.json` are gone (May 2026). The `published_rkey` column is left in place for future revival but is unused.
- **No synthetic onboarding card bank.** Removed along with `OnboardingFlow`/`TapCards`/`TasteReveal`/`ReversePrompting` and the `onboarding_cards` table. Onboarding is now plain chat with the Claude agent.

# Conventions

- All API routes under `src/app/api/*` use `requireAuth(req)` from `src/lib/auth.ts`.
- The curator UI loads sidebar feeds from Postgres (`/api/feeds`), filtered to feeds with non-empty topics/keywords. Postgres is the source of truth — there is no client-side cache (no localStorage, no Firestore).
- Feed switching in the curator is non-blocking: clicking a feed clears the panels synchronously and fires chat + posts fetches in parallel. There is no auto-polling — the user clicks **Refresh** to re-query happy-feed.

# Secrets

Two real secrets live in **Google Secret Manager** in `timelines-492720`:

| Secret | What |
|---|---|
| `database-url` | Full Cloud SQL connection string (includes the postgres password) |
| `anthropic-api-key` | Anthropic Claude API key |

**The code fetches them at runtime** — see `src/lib/secrets.ts`. There are no `--set-secrets` mounts on Cloud Run and no plaintext copies in `.env.local`. The pattern:

```ts
// pg.ts (lazy pool init)
const pool = await getPool();   // fetches DATABASE_URL from SM on first call
// chat/route.ts (lazy Anthropic client)
const c = await client();       // fetches ANTHROPIC_API_KEY from SM on first call
```

`getSecret(name)` checks `process.env` first (UPPER_SNAKE_CASE of the secret name) and falls back to Secret Manager. So you can still override locally with an env var if you ever need to.

**Auth**: locally, `gcloud auth application-default login` once. On Cloud Run, the runtime SA `777152549518-compute@developer.gserviceaccount.com` has `roles/secretmanager.secretAccessor` on each secret.

**Rotate**: `echo -n "<new>" | gcloud secrets versions add <name> --project=timelines-492720 --data-file=-`. The cache is per-process — restart Cloud Run revisions (or wait for a cold start) to pick up new versions.

# External resources

| What | Where |
|---|---|
| Cloud SQL `feed-db` | `gcloud sql instances describe feed-db --project=timelines-492720` |
| Firebase project | `timelines-492720` (display name "timelines"). Authorized domains list managed via Identity Toolkit Admin API. |
| Secret Manager | `gcloud secrets list --project=timelines-492720` |
| happy-feed source | `/Users/amir/code/happy-feed` |
| happy-feed Vertex resources | project `amir-experimental`, region `us-central1`, index `3473324246795550720` |
