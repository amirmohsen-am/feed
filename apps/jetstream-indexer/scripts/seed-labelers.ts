// One-time seed of the labeler directory.
//
// AT Protocol has no "list all labelers" endpoint, so we bootstrap the known
// universe from a public, community-maintained directory. After this seed runs,
// the directory is kept fresh going forward by the Jetstream
// `app.bsky.labeler.service` consumer (Phase 2) — the public list is NOT a
// recurring source.
//
// Like counts and profile fields are NOT fetched here; the web app enriches
// rows on read from the AppView (apps/web/src/lib/labelers.ts). This script only
// records which DIDs exist.
//
// Run with:
//   cd apps/jetstream-indexer
//   npx tsx scripts/seed-labelers.ts
//
// Re-running is safe (idempotent upsert). ⚠️ Writes to the prod bsky-db.

import { runMigrations } from '../src/lib/migrator.js'
import { closePool, withClient } from '../src/lib/pg.js'

// Community-maintained labeler directory (Kuba / blue.mackuba.eu). Returns
// { labellers: [{ did, handle, name, ... }] } for every labeler it knows about.
const SOURCE_URL =
  process.env.LABELLERS_SOURCE_URL ??
  'https://blue.mackuba.eu/xrpc/blue.feeds.mod.getLabellers'

interface SourceLabeller {
  did: string
  handle: string | null
  name: string | null
}

const main = async () => {
  // Applies pending migrations (incl. 0008_labelers.sql) and is a no-op for
  // those already recorded in bsky._migrations.
  await runMigrations()

  console.log(`[seed-labelers] fetching ${SOURCE_URL}`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) {
    throw new Error(`source fetch failed (${res.status}): ${await res.text()}`)
  }
  const body = (await res.json()) as { labellers?: SourceLabeller[] }
  const labellers = (body.labellers ?? []).filter((l) => l.did?.startsWith('did:'))
  console.log(`[seed-labelers] ${labellers.length} labeler DIDs from source`)

  let inserted = 0
  await withClient(async (c) => {
    for (const l of labellers) {
      // Discovery only: never clobber enrichment. Backfill the seed handle when
      // we don't already have one.
      const r = await c.query(
        `INSERT INTO bsky.labelers (did, handle)
         VALUES ($1, $2)
         ON CONFLICT (did) DO UPDATE
           SET handle = COALESCE(bsky.labelers.handle, EXCLUDED.handle)`,
        [l.did, l.handle ?? null],
      )
      inserted += r.rowCount ?? 0
    }
    const { rows } = await c.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM bsky.labelers',
    )
    console.log(`[seed-labelers] upserted ${labellers.length}; table now holds ${rows[0].count} rows`)
  })
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('[seed-labelers] failed:', err)
    await closePool().catch(() => {})
    process.exit(1)
  })
