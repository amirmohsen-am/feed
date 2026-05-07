# Ripple Feed

A Bluesky custom-feed curator. Talk to a Claude agent about what you want to read; the resulting feed config is stored in Postgres and used to query a separate vector-search service for matching posts.

This repo is the web app (Next.js 16 + React 19). Architecture details live in `AGENTS.md`.

## Setup

```bash
npm install
```

Required env vars in `.env.local`:

```
DATABASE_URL=postgres://...
ANTHROPIC_API_KEY=sk-ant-...
HAPPY_FEED_URL=http://localhost:8787
```

Apply the schema once:

```bash
npx tsx scripts/setup-postgres.ts
```

## Run

```bash
npm run dev
```

Open <http://localhost:3000>. Sign in with Google, click **Try demo (feed curation)**, chat with the agent.

## Posts come from happy-feed

This repo doesn't ingest Bluesky's firehose. That work lives in [`happy-feed`](file:///Users/amir/code/happy-feed) — a separate Bun service that maintains a Vertex AI vector index of Bluesky posts. To see real posts in the curator, run happy-feed in another terminal:

```bash
cd ~/code/happy-feed
PORT=8787 bun run start
```

Without happy-feed running, the chat works but the post panel stays empty.

See `AGENTS.md` for the full architecture, the happy-feed integration surface, and the list of things this repo intentionally does **not** do.
