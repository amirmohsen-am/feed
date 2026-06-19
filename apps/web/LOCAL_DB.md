# Running feed-db locally (no prod changes)

Only **feed-db** goes local (feeds, users, chat, `post_signals`, `feed_taste`). It needs
**no pgvector** — signal embeddings are stored as `real[]` and clustering runs in JS.

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

# 3. Create the schema (base tables + all migrations incl. 009 recsys)
cd apps/web
LOCAL_DATABASE_URL=postgres://postgres:postgres@localhost:5432/feed_curator \
  npx tsx scripts/setup-local-db.ts

# 4. Run the app — feed-db is now local
npm run dev
```

## Switching local ↔ prod

The presence of `LOCAL_DATABASE_URL` is the only switch:

- **Local feed-db:** `LOCAL_DATABASE_URL` set (in `.env.local` or the shell).
- **Prod feed-db:** unset it (comment it out in `.env.local`) → falls back to the Cloud SQL
  connector + the `database-url` secret, exactly as before.

The startup log prints which mode is active: `[pg] feed-db: LOCAL mode (...)` vs the connector
path.
