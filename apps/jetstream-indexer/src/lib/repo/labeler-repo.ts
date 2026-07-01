// Labeler discovery persistence.
// - labelerConsumer: upsert DIDs into bsky.labelers on app.bsky.labeler.service
//   create/update; remove them on delete.
//
// This only records WHICH labelers exist. Profile fields + like_count are a
// cache the web app fills from the AppView on read (apps/web/src/lib/labelers.ts),
// so the upsert here must never clobber those enrichment columns.

import { withClient } from '../pg.js'

export const upsertLabelers = async (dids: string[]): Promise<void> => {
  if (dids.length === 0) return
  await withClient(async (c) => {
    for (const did of dids) {
      // Discovery only: insert the DID, or just touch updated_at if known.
      // Enrichment columns are left untouched for the web read side to fill.
      await c.query(
        `INSERT INTO bsky.labelers (did)
         VALUES ($1)
         ON CONFLICT (did) DO UPDATE SET updated_at = now()`,
        [did],
      )
    }
  })
}

export const deleteLabelers = async (dids: string[]): Promise<void> => {
  if (dids.length === 0) return
  await withClient(async (c) => {
    await c.query('DELETE FROM bsky.labelers WHERE did = ANY($1)', [dids])
  })
}
