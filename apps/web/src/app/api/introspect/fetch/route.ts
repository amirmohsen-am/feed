/**
 * POST /api/introspect/fetch  { handle: string, force?: boolean }
 *
 * Resolves the handle, lists records from the user's PDS, hydrates referenced
 * posts via AppView, composes engagement records, computes stats, and builds
 * batch metadata. NO LLM calls — those are user-triggered per design.
 *
 * Returns the (saved) snapshot.
 *
 * If a snapshot already exists for this handle and `force` is not set, the
 * existing snapshot is returned untouched (no refetch). On `force=true` we
 * refetch and preserve previously-stored batch notes when the batch's
 * content hash hasn't changed (design Q7 default: "keep prior batch notes").
 */

import { NextRequest, NextResponse } from "next/server";
import { fetchEngagements } from "@/lib/introspect/fetch-engagements";
import { computeStats } from "@/lib/introspect/stats";
import { composeBatches } from "@/lib/introspect/batches";
import { readSnapshot, writeSnapshot } from "@/lib/introspect/storage";
import type { Snapshot } from "@/lib/introspect/types";

export const runtime = "nodejs";
// PDS + AppView fetches can take 8–15s on a cold cache.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const t0 = performance.now();
  let body: { handle?: string; force?: boolean };
  try {
    body = (await req.json()) as { handle?: string; force?: boolean };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const handleInput = (body.handle ?? "").trim();
  if (!handleInput) {
    return NextResponse.json({ error: "handle required" }, { status: 400 });
  }
  const force = !!body.force;

  const existing = await readSnapshot(handleInput);
  if (existing && !force) {
    return NextResponse.json({ snapshot: existing, cached: true });
  }

  try {
    const { did, pds, engagements, unavailableUris } =
      await fetchEngagements(handleInput);
    const stats = computeStats(engagements);
    const batches = composeBatches(engagements);

    // Preserve batch notes from the prior snapshot when the batch hash is
    // unchanged — refresh shouldn't burn LLM dollars on identical work.
    const priorByHash = new Map<string, Snapshot["batchNotes"][number]>();
    if (existing) {
      for (const n of Object.values(existing.batchNotes)) {
        priorByHash.set(n.hash, n);
      }
    }
    const preservedNotes: Snapshot["batchNotes"] = {};
    const preservedCallHistory = existing?.callHistory ?? [];
    for (const b of batches) {
      const prior = priorByHash.get(b.hash);
      if (prior) {
        preservedNotes[b.index] = { ...prior, batchIndex: b.index };
      }
    }
    // Aggregator profile is regenerated next click; carry it over only if
    // its source batches all survived the refresh.
    let preservedProfile = existing?.profile ?? null;
    if (preservedProfile) {
      const surviving = new Set(Object.keys(preservedNotes).map(Number));
      const ok = preservedProfile.fromBatchIndices.every((i) =>
        surviving.has(i)
      );
      if (!ok) preservedProfile = null;
    }
    // Feed seed prompts are tied to the profile. If the profile didn't
    // survive, the prompts shouldn't either — they'll be regenerated next
    // process-batch click alongside a fresh profile.
    const preservedSeedPrompts = preservedProfile
      ? existing?.feedSeedPrompts ?? null
      : null;

    const snap: Snapshot = {
      handle: handleInput.replace(/^@/, "").toLowerCase(),
      did,
      pds,
      fetchedAt: new Date().toISOString(),
      stats,
      engagements,
      batches,
      batchNotes: preservedNotes,
      profile: preservedProfile,
      feedSeedPrompts: preservedSeedPrompts,
      callHistory: preservedCallHistory,
    };
    await writeSnapshot(snap);

    const tEnd = performance.now();
    console.log(
      `[introspect.fetch] handle=${snap.handle} total=${(tEnd - t0).toFixed(0)}ms engagements=${engagements.length} batches=${batches.length} unavailable=${unavailableUris.length}`
    );

    return NextResponse.json({
      snapshot: snap,
      cached: false,
      unavailableCount: unavailableUris.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[introspect.fetch] handle=${handleInput} failed:`, err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
