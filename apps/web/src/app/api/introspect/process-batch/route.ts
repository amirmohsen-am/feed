/**
 * POST /api/introspect/process-batch  { handle: string }
 *
 * Runs the Extractor on the next unprocessed batch (lowest unprocessed
 * index, so the user always processes newest-first), then re-runs the
 * Aggregator over all batch notes accumulated so far, then refreshes the
 * feed-seed prompts.
 *
 * Streams progress as newline-delimited JSON (application/x-ndjson) so the
 * UI can show the pipeline moving and live-type the prose as the model
 * writes it. Event shapes (one JSON object per line):
 *   { t: "phase",  phase: "extract"|"aggregate"|"seeds", batchIndex?: number }
 *   { t: "delta",  phase: "extract"|"aggregate", text: string }
 *   { t: "done",   snapshot: Snapshot }
 *   { t: "error",  error: string, snapshot?: Snapshot, batchIndex?: number }
 *
 * Failure semantics (design §6.4), preserved from the buffered version:
 *  - Extractor fails → batch note isn't written, snapshot unchanged. We emit
 *    an `error` event (no snapshot) and stop.
 *  - Aggregator fails AFTER Extractor succeeded → the batch note IS saved;
 *    we persist the snapshot without a refreshed profile and emit `error`
 *    carrying that snapshot so the caller can retry aggregation.
 */

import { NextRequest } from "next/server";
import { enforceRateLimit, EXPENSIVE_RULES } from "@/lib/rate-limit";
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
  const limited = enforceRateLimit(req, "introspect-process-batch", EXPENSIVE_RULES);
  if (limited) return limited;
  let body: { handle?: string };
  try {
    body = (await req.json()) as { handle?: string };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const handle = (body.handle ?? "").trim();
  if (!handle) {
    return Response.json({ error: "handle required" }, { status: 400 });
  }

  const snap = await readSnapshot(handle);
  if (!snap) {
    return Response.json(
      { error: "no snapshot — call /fetch first" },
      { status: 404 }
    );
  }

  const encoder = new TextEncoder();
  const t0 = performance.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

      // Find the next unprocessed batch (lowest index not yet in batchNotes).
      // Batches are sorted by index (batch 1 = newest); user processes
      // them newest-first.
      const nextBatch = snap.batches.find((b) => !snap.batchNotes[b.index]);

      let extractorRan = false;
      if (nextBatch) {
        send({ t: "phase", phase: "extract", batchIndex: nextBatch.index });
        const engagementsInBatch = snap.engagements.filter((e) =>
          nextBatch.engagementIds.includes(e.id)
        );
        try {
          const { note } = await runExtractor(
            nextBatch.index,
            nextBatch.hash,
            engagementsInBatch,
            (text) => send({ t: "delta", phase: "extract", text })
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
          send({
            t: "error",
            error: `Extractor failed on batch ${nextBatch.index}: ${msg}`,
            batchIndex: nextBatch.index,
          });
          controller.close();
          return;
        }
      }

      // Always re-run the aggregator if we have at least one batch note. If
      // the user clicked when all batches are already processed, this is a
      // no-op refresh (e.g. after a previous Aggregator-only failure).
      const allNotes = Object.values(snap.batchNotes);
      if (allNotes.length === 0) {
        send({ t: "done", snapshot: snap });
        controller.close();
        return;
      }

      // Engagement → batch lookup needed for anchor sampling.
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

      send({ t: "phase", phase: "aggregate" });
      try {
        const profile = await runAggregator(allNotes, anchors, (text) =>
          send({ t: "delta", phase: "aggregate", text })
        );
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
        send({
          t: "error",
          error: `Aggregator failed: ${msg}. Batch note saved; retry to re-aggregate.`,
          snapshot: snap,
        });
        controller.close();
        return;
      }

      // Feed-seed prompts: chained after the Aggregator so suggestions stay in
      // sync with the refreshed profile. Failure here must not throw away the
      // profile we just produced — swallow and fall through.
      if (snap.profile) {
        send({ t: "phase", phase: "seeds" });
        try {
          const seeds = await runFeedSeedGenerator(snap.profile);
          if (seeds.prompts.length > 0) snap.feedSeedPrompts = seeds;
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

      send({ t: "done", snapshot: snap });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
