# Running feed-db locally (no prod changes)

Only **feed-db** goes local (feeds, users, chat, subscribers). It needs **no pgvector**.

**bsky-db stays prod.** It holds the post embeddings + pgvector index and only exists in
prod, so vector search + the embedding snapshot read from prod (read-only; the only write is
a best-effort author-profile cache). Leave `LOCAL_BSKY_DATABASE_URL` unset.

You still need ADC for the prod reads + secrets used in local dev (Vertex query embeddings,
Anthropic, bsky-db): `gcloud auth application-default login`.

## One-time setup

```bash
# 1. Start a local Postgres
docker run --name feed-local -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=feed_curator -p 5432:5432 -d postgres:16

# 2. Point feed-db at it (add to apps/web/.env.local so `next dev` picks it up)
echo 'LOCAL_DATABASE_URL=postgres://postgres:postgres@localhost:5432/feed_curator' >> apps/web/.env.local

# 3. Create the schema — runs every sql/*.sql migration (000_base + 001..009) in order
cd apps/web
LOCAL_DATABASE_URL=postgres://postgres:postgres@localhost:5432/feed_curator \
  npx tsx scripts/setup-local-db.ts

# 4. Run the app — feed-db is now local
npm run dev
```

The schema is defined entirely by `sql/*.sql`: `000_base.sql` creates the base tables and
`001+` evolve them, so running them in order against an empty database reproduces prod. The
same files are the migrations applied to prod, so there is a single source of truth and
nothing to reconcile.

## Switching local ↔ prod

The presence of `LOCAL_DATABASE_URL` is the only switch:

- **Local feed-db:** `LOCAL_DATABASE_URL` set (in `.env.local` or the shell).
- **Prod feed-db:** unset it (comment it out in `.env.local`) → falls back to the Cloud SQL
  connector + the `database-url` secret, exactly as before.

The startup log prints which mode is active: `[pg] feed-db: LOCAL mode (...)` vs the connector
path.
