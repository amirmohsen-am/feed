// Hive AI-image-label cache (ai_image_labels).
//
// Keyed by image URL, which is content-addressed on Bluesky, so cached rows are
// permanent (no TTL). Lets each unique image hit the paid Hive API at most once,
// ever, across all users. Schema: sql/008_ai_image_labels.sql.

import { query } from "./connection";

export interface CachedImageLabel {
  ai_generated: boolean;
  score: number;
}

/** Look up cached Hive labels for the given image URLs. Missing URLs are absent
 *  from the returned map (caller treats them as cache misses). */
export async function getCachedImageLabels(
  urls: string[]
): Promise<Map<string, CachedImageLabel>> {
  const out = new Map<string, CachedImageLabel>();
  if (urls.length === 0) return out;
  const res = await query(
    `SELECT image_url, ai_generated, score
       FROM ai_image_labels
      WHERE image_url = ANY($1)`,
    [urls]
  );
  for (const r of res.rows) {
    out.set(r.image_url, { ai_generated: r.ai_generated, score: r.score });
  }
  return out;
}

/** Persist freshly-classified image labels. Content-addressed URLs are
 *  immutable, so a conflicting row is a duplicate — keep the existing one. */
export async function upsertImageLabels(
  rows: Array<{ url: string; ai_generated: boolean; score: number }>
): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const tuples = rows
    .map((r, i) => {
      const b = i * 3;
      values.push(r.url, r.ai_generated, r.score);
      return `($${b + 1}, $${b + 2}, $${b + 3})`;
    })
    .join(", ");
  await query(
    `INSERT INTO ai_image_labels (image_url, ai_generated, score)
     VALUES ${tuples}
     ON CONFLICT (image_url) DO NOTHING`,
    values
  );
}
