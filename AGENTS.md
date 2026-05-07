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
| Post search | **happy-feed** — separate service, see below |
| Hosting | Railway (web) — Cloud Run worker is decommissioned |

## Tables

- `users` — Firebase UID → internal Postgres UUID
- `feeds` — per-user feed configs (`name`, `mechanical_filters`, `semantic_config`, `description`)
- `chat_messages` — per-feed chat transcripts
- `subscribers` — landing-page mailing list
- `published_rkey` column on `feeds` is unused (publish flow is on hold)

# happy-feed

This repo does **not** ingest Bluesky's firehose itself. That work lives in the [`happy-feed`](file:///Users/amir/code/happy-feed) service, which:

- Subscribes to Bluesky's Jetstream and indexes ~hundreds of thousands of posts.
- Embeds each post with **Vertex AI `gemini-embedding-001`** (768-d, `RETRIEVAL_DOCUMENT` task type).
- Stores vectors in **Vertex AI Vector Search** (managed). GCP project: `amir-experimental` (NOT `timelines-492720`).
- Exposes HTTP search endpoints. Auth is Application Default Credentials only — no API keys.

## What we use

We hit one endpoint:

```
POST {HAPPY_FEED_URL}/query/search
Content-Type: application/json
{ "query": "<feed name + topics + keywords + vibes>", "k": 25, "filter": { "lang": "en" }? }
```

Response shape: `{ hits: SearchHit[], ms, query_id }`. See `src/lib/happy-feed.ts` for the typed client. The query string is built from the feed's stored `semantic_config` in `src/lib/pg.ts:buildSearchQuery`.

## Local dev

happy-feed defaults to port **3000** in dev — same as Next. Run it on a different port:

```
cd ~/code/happy-feed
PORT=8787 bun run start
```

Then in `.env.local` here: `HAPPY_FEED_URL=http://localhost:8787`.

If happy-feed isn't running, the curator's post panel shows a graceful empty state (no 500). The chat agent works fine without it.

## What this repo does NOT do anymore

- **No Jetstream worker.** Removed in May 2026 along with `scripts/firehose.ts`, `Dockerfile.worker`, `cloudbuild-worker.yaml`, `src/app/api/worker/*`, `src/lib/mechanical-filter.ts`, and the `posts`/`feed_posts`/`author_post_counts` tables.
- **No OpenAI.** Embeddings come from Vertex via happy-feed; the chat is pure Claude.
- **No publish-to-Bluesky.** The `/api/publish-feed` route, the xrpc endpoints, and `/.well-known/did.json` are gone (May 2026). The `published_rkey` column is left in place for future revival but is unused.
- **No synthetic onboarding card bank.** Removed along with `OnboardingFlow`/`TapCards`/`TasteReveal`/`ReversePrompting` and the `onboarding_cards` table. Onboarding is now plain chat with the Claude agent.

# Conventions

- All API routes under `src/app/api/*` use `requireAuth(req)` from `src/lib/auth.ts`.
- The curator UI loads sidebar feeds from Postgres (`/api/feeds`), filtered to feeds with non-empty topics/keywords. Postgres is the source of truth — there is no client-side cache (no localStorage, no Firestore).
- Feed switching in the curator is non-blocking: clicking a feed clears the panels synchronously and fires chat + posts fetches in parallel. There is no auto-polling — the user clicks **Refresh** to re-query happy-feed.

# Secrets

Production secrets live in **Google Secret Manager** in `timelines-492720`:

| Secret | What |
|---|---|
| `database-url` | Full Cloud SQL connection string (includes the postgres password) |
| `anthropic-api-key` | Anthropic Claude API key |

The Cloud Run `feed-web` service mounts these via `--set-secrets` (see `gcloud run services describe feed-web --region=us-central1` → `valueFrom.secretKeyRef`). The default compute service account `777152549518-compute@developer.gserviceaccount.com` has `roles/secretmanager.secretAccessor` on each secret. Rotate by adding a new version (`gcloud secrets versions add <name> --data-file=-`) — Cloud Run pinned to `:latest` will pick it up on next deploy.

Local dev still uses `.env.local` (gitignored). To sync local from Secret Manager, run:
```bash
gcloud secrets versions access latest --secret=database-url --project=timelines-492720
gcloud secrets versions access latest --secret=anthropic-api-key --project=timelines-492720
```

`HAPPY_FEED_URL` is **not** a secret — it's a plain env var (the URL of the search service). In dev: `http://localhost:8787`.

# External resources

| What | Where |
|---|---|
| Cloud SQL `feed-db` | `gcloud sql instances describe feed-db --project=timelines-492720` |
| Firebase project | `timelines-492720` (display name "timelines"). Authorized domains list managed via Identity Toolkit Admin API. |
| Secret Manager | `gcloud secrets list --project=timelines-492720` |
| happy-feed source | `/Users/amir/code/happy-feed` |
| happy-feed Vertex resources | project `amir-experimental`, region `us-central1`, index `3473324246795550720` |
