/**
 * POST /api/search — two-phase retrieval lab endpoint.
 *
 * Body:
 *   { query: string,
 *     vector_k?: number = 100,
 *     rerank_k?: number = 25,
 *     rerank_enabled?: boolean = true,
 *     prompt_id?: string,           // required when rerank_enabled
 *     filters?: SearchFilter }
 *
 * Response: text/plain, two newline-delimited JSON objects. Phase 1 (vector)
 * is flushed first; phase 2 (rerank) arrives after the LLM call returns.
 *
 *   {"phase":"vector",  "run_id":"...","model":"claude-sonnet-4-6",
 *    "prompt":{"id":"...","version":3,"name":"..."} | null,
 *    "ms":{"embed":80,"find":220,"hydrate":80},
 *    "hits":[VectorHit, ...]}
 *   {"phase":"rerank",  "ms":{"rerank":2100,"total":2480},
 *    "kept":[{i,score,reason}, ...] | null}
 *
 * When rerank_enabled=false the phase-2 line is still emitted with kept=null
 * so the client can render the same code path.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { enforceRateLimit, LLM_RULES } from "@/lib/rate-limit";
import {
  getRerankPromptForUser,
  insertSearchRun,
} from "@/lib/pg";
import { searchPosts, type VectorHit, type SearchFilter } from "@/lib/vector-search";
import { rerank, RERANK_MODEL } from "@/lib/rerank";

export const runtime = "nodejs";

interface SearchBody {
  query?: string;
  vector_k?: number;
  rerank_k?: number;
  rerank_enabled?: boolean;
  prompt_id?: string;
  filters?: SearchFilter;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

export async function POST(req: NextRequest) {
  const limited = enforceRateLimit(req, "search", LLM_RULES);
  if (limited) return limited;
  const tTotal0 = performance.now();
  const auth = await requireAuth();

  let body: SearchBody;
  try {
    body = (await req.json()) as SearchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return NextResponse.json({ error: "query required" }, { status: 400 });
  }
  // Bound the embedded query length to keep per-call embedding cost predictable.
  if (query.length > 1000) {
    return NextResponse.json(
      { error: "query too long (max 1000 characters)" },
      { status: 400 }
    );
  }

  const vectorK = clampInt(body.vector_k, 1, 200, 100);
  const rerankK = clampInt(body.rerank_k, 1, 50, 25);
  const rerankEnabled = body.rerank_enabled !== false;
  const filters = body.filters;

  let promptRow: Awaited<ReturnType<typeof getRerankPromptForUser>> = null;
  if (rerankEnabled) {
    if (!body.prompt_id) {
      return NextResponse.json(
        { error: "prompt_id required when rerank_enabled" },
        { status: 400 }
      );
    }
    promptRow = await getRerankPromptForUser(body.prompt_id, auth.userId);
    if (!promptRow || !promptRow.current_system_prompt) {
      return NextResponse.json(
        { error: "prompt not found or has no current version" },
        { status: 404 }
      );
    }
  }

  // --- phase 1: vector search ---
  const tVec0 = performance.now();
  let hits: VectorHit[] = [];
  let vectorError: string | null = null;
  try {
    hits = await searchPosts({
      subqueries: [query],
      totalBudget: vectorK,
      filter: filters,
    });
  } catch (e) {
    vectorError = e instanceof Error ? e.message : String(e);
  }
  const tVec1 = performance.now();
  const msVectorTotal = Math.round(tVec1 - tVec0);

  // searchPosts() logs its own breakdown; we don't have direct access to
  // embed/find/hydrate split here, so collapse into a single bucket.
  const phase1: Record<string, unknown> = {
    phase: "vector",
    model: RERANK_MODEL,
    rerank_enabled: rerankEnabled,
    prompt: promptRow
      ? {
          id: promptRow.id,
          version: promptRow.current_version,
          name: promptRow.name,
        }
      : null,
    ms: { vector: msVectorTotal },
    hits,
  };
  if (vectorError) phase1.error = vectorError;

  // We'll stream two NDJSON objects. ReadableStream lets us flush phase 1
  // before the rerank call returns.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify(phase1) + "\n"));

      let kept: Awaited<ReturnType<typeof rerank>>["kept"] | null = null;
      let msRerank: number | null = null;
      let rerankError: string | null = null;

      if (rerankEnabled && hits.length > 0 && promptRow?.current_system_prompt) {
        try {
          const r = await rerank({
            query,
            candidates: hits,
            topK: rerankK,
            systemPrompt: promptRow.current_system_prompt,
          });
          kept = r.kept;
          msRerank = r.ms_rerank;
        } catch (e) {
          rerankError = e instanceof Error ? e.message : String(e);
        }
      }

      const msTotal = Math.round(performance.now() - tTotal0);
      const phase2: Record<string, unknown> = {
        phase: "rerank",
        ms: { rerank: msRerank, total: msTotal },
        kept,
      };
      if (rerankError) phase2.error = rerankError;

      controller.enqueue(encoder.encode(JSON.stringify(phase2) + "\n"));
      controller.close();

      // Persist (fire-and-forget). Don't block the response on this.
      try {
        const keptForStore =
          kept === null
            ? null
            : kept.map((k) => ({
                i: k.i,
                uri: hits[k.i]?.uri,
                score: k.score,
                reason: k.reason,
              }));
        await insertSearchRun({
          userId: auth.userId,
          query,
          vectorK,
          rerankK,
          rerankEnabled,
          promptVersionId: promptRow?.current_version_id ?? null,
          filtersJson: filters ?? null,
          vectorHitUris: hits.map((h) => h.uri),
          rerankKept: keptForStore,
          msEmbed: null,
          msFind: null,
          msHydrate: null,
          msRerank,
          msTotal,
        });
      } catch (e) {
        console.warn(
          "[search] failed to persist run:",
          e instanceof Error ? e.message : String(e)
        );
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
