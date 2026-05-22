/**
 * Batch composer (design §6.2: 100 records per batch, locked).
 *
 * Splits a chronologically-sorted engagement list (newest-first) into
 * fixed-size batches. Batch 1 = the most recent 100 engagements, batch 2 =
 * the next 100 older, and so on.
 *
 * Each batch carries a content hash over its sorted engagement URIs so we
 * can invalidate a stored Extractor note when the user's recent activity
 * shifts what falls into that batch.
 */

import { createHash } from "node:crypto";
import type { BatchInfo, Engagement, SignalType } from "./types";

export const BATCH_SIZE = 100;

/** Engagements MUST be sorted newest-first by `ts`. */
export function composeBatches(engagements: Engagement[]): BatchInfo[] {
  const batches: BatchInfo[] = [];
  for (let i = 0; i < engagements.length; i += BATCH_SIZE) {
    const slice = engagements.slice(i, i + BATCH_SIZE);
    if (slice.length === 0) break;
    const startTs = slice[slice.length - 1].ts; // oldest in batch
    const endTs = slice[0].ts; // newest in batch
    const mix: Record<SignalType, number> = {
      like: 0,
      repost: 0,
      quote: 0,
      post: 0,
      reply: 0,
    };
    for (const e of slice) mix[e.type] += 1;

    const uris = slice
      .map((e) => `${e.type}:${e.subject.uri}`)
      .sort();
    const hash = createHash("sha256")
      .update(uris.join("\n"))
      .digest("hex")
      .slice(0, 16);

    batches.push({
      index: batches.length + 1,
      startTs,
      endTs,
      engagementIds: slice.map((e) => e.id),
      mix,
      hash,
    });
  }
  return batches;
}
