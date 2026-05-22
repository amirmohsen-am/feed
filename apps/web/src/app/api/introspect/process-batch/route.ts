/**
 * POST /api/introspect/process-batch  { handle: string }
 *
 * Runs the Extractor on the next unprocessed batch (lowest unprocessed
 * index, so the user always processes newest-first), then re-runs the
 * Aggregator over all batch notes accumulated so far.
 *
 * Returns the updated snapshot.
 *
 * Failure semantics (design §6.4):
 *  - Extractor fails → batch note isn't written, snapshot unchanged. Caller
 *    sees the error and can retry.
 *  - Aggregator fails AFTER Extractor succeeded → the batch note IS saved;
 *    the snapshot is written without a refreshed profile. Caller can retry
 *    aggregation by clicking again with no new batch to process (we re-
 *    aggregate over the existing notes).
 */

import { NextRequest, NextResponse } from "next/server";
import { readSnapshot, writeSnapshot } from "@/lib/introspect/storage";
import {
  runExtractor,
  runAggregator,
  runFeedSeedGenerator,
  pickAnchorEngagements,
} from "@/lib/introspect/llm";

export const runtime = "nodejs";
// Extractor + Aggregator together: ~15–25s usual, up to ~60s worst-case.
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const t0 = performance.now();
  let body: { handle?: string };
  try {
    body = (await req.json()) as { handle?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const handle = (body.handle ?? "").trim();
  if (!handle) {
    return NextResponse.json({ error: "handle required" }, { status: 400 });
  }

  const snap = await readSnapshot(handle);
  if (!snap) {
    return NextResponse.json(
      { error: "no snapshot — call /fetch first" },
      { status: 404 }
    );
  }

  // Find the next unprocessed batch (lowest index not yet in batchNotes).
  // Batches are sorted by index (batch 1 = newest), and the user processes
  // them newest-first.
  const nextBatch = snap.batches.find((b) => !snap.batchNotes[b.index]);

  let extractorRan = false;
  if (nextBatch) {
    const engagementsInBatch = snap.engagements.filter((e) =>
      nextBatch.engagementIds.includes(e.id)
    );

    try {
      const { note } = await runExtractor(
        nextBatch.index,
        nextBatch.hash,
        engagementsInBatch
      );
      snap.batchNotes[nextBatch.index] = note;
      snap.callHistory.push(note.telemetry);
      extractorRan = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "extractor error";
      console.error(
        `[introspect.process-batch] extractor failed for batch ${nextBatch.index} handle=${handle}:`,
        err
      );
      return NextResponse.json(
        {
          error: `Extractor failed on batch ${nextBatch.index}: ${msg}`,
          batchIndex: nextBatch.index,
        },
        { status: 500 }
      );
    }
  }

  // Always re-run aggregator if we have at least one batch note. If the user
  // clicked when all batches are already processed, this is a no-op refresh
  // of the profile (e.g. after a previous Aggregator-only failure).
  const allNotes = Object.values(snap.batchNotes);
  if (allNotes.length === 0) {
    return NextResponse.json({
      snapshot: snap,
      message: "no batches to process",
    });
  }

  // Build the engagement → batch lookup needed for anchor sampling.
  const batchIdByEng = new Map<number, number>();
  for (const b of snap.batches) {
    for (const id of b.engagementIds) batchIdByEng.set(id, b.index);
  }
  const processedSet = new Set(allNotes.map((n) => n.batchIndex));
  const anchors = pickAnchorEngagements(
    snap.engagements,
    processedSet,
    batchIdByEng,
    10
  );

  try {
    const profile = await runAggregator(allNotes, anchors);
    snap.profile = profile;
    snap.callHistory.push(profile.telemetry);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "aggregator error";
    console.error(
      `[introspect.process-batch] aggregator failed handle=${handle}:`,
      err
    );
    // Save snapshot so the new batch note isn't lost (design §6.4).
    await writeSnapshot(snap);
    return NextResponse.json(
      {
        error: `Aggregator failed: ${msg}. Batch note saved; retry to re-aggregate.`,
        snapshot: snap,
      },
      { status: 500 }
    );
  }

  // Feed-seed prompts: chained after the Aggregator so suggestions stay in
  // sync with the refreshed profile. Failure here must not throw away the
  // profile we just persisted in memory — fall through and write whatever
  // seed prompts (or null) we have.
  if (snap.profile) {
    try {
      const seeds = await runFeedSeedGenerator(snap.profile);
      if (seeds.prompts.length > 0) {
        snap.feedSeedPrompts = seeds;
      }
      snap.callHistory.push(seeds.telemetry);
    } catch (err) {
      console.error(
        `[introspect.process-batch] feed-seed generator failed handle=${handle}:`,
        err
      );
    }
  }

  await writeSnapshot(snap);

  const tEnd = performance.now();
  console.log(
    `[introspect.process-batch] handle=${handle} extractor=${extractorRan} total=${(tEnd - t0).toFixed(0)}ms processed=${allNotes.length}/${snap.batches.length}`
  );

  return NextResponse.json({ snapshot: snap });
}
