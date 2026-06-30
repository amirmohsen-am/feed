import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { enforceRateLimit, LLM_RULES } from "@/lib/rate-limit";
import {
  getFeedForUser,
  getFeedPreviewPosts,
  type PreviewStageEvent,
} from "@/lib/pg";

/**
 * NDJSON stream variant of /api/feed-preview. Emits one JSON object per
 * line as the pipeline progresses:
 *
 *   {"event":"stage","stage":"searching"}
 *   {"event":"stage","stage":"ranking","candidates":80,"images":87,"model":"…"}
 *   {"event":"stage","stage":"generating"}
 *   {"event":"done","posts":[…],"mechanical_filters":{…},…}
 *
 * Errors before the first chunk are returned as plain JSON 4xx/5xx. Errors
 * during streaming are sent as a final `{"event":"error","message":"…"}`
 * line and the stream is closed.
 */
export async function GET(req: NextRequest) {
  const limited = enforceRateLimit(req, "feed-preview", LLM_RULES);
  if (limited) return limited;
  const auth = await requireAuth();

  const feedId = Number(req.nextUrl.searchParams.get("feedId"));
  // ?refresh=1 forces a fresh recompute and overwrites the cached snapshot.
  // Any other load is cache-eligible (served if <24h old, see getFeedPreviewPosts).
  const forceFresh = req.nextUrl.searchParams.get("refresh") === "1";
  return streamPreview(feedId, auth.userId, { forceFresh });
}

/**
 * Tail-recompute variant. The curator's partial refresh POSTs the FROZEN PREFIX
 * (posts already read + the look-ahead buffer) as `excludeUris`; the server
 * recomputes the snapshot from the feed's current config and returns only the
 * posts NOT in that prefix, so the client can splice the tail in place without
 * disturbing the read position. Body: { feedId, excludeUris?, refresh? }.
 */
export async function POST(req: NextRequest) {
  const limited = enforceRateLimit(req, "feed-preview", LLM_RULES);
  if (limited) return limited;
  const auth = await requireAuth();

  let body: { feedId?: number; excludeUris?: string[]; refresh?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* empty / malformed body → treated as missing feedId below */
  }
  const feedId = Number(body.feedId);
  const excludeUris = Array.isArray(body.excludeUris)
    ? body.excludeUris.filter((u): u is string => typeof u === "string")
    : undefined;
  return streamPreview(feedId, auth.userId, {
    forceFresh: body.refresh === true,
    excludeUris,
  });
}

async function streamPreview(
  feedId: number,
  userId: string,
  opts: { forceFresh?: boolean; excludeUris?: string[] }
): Promise<Response> {
  if (!feedId) {
    return new Response(
      JSON.stringify({ event: "error", message: "feedId required" }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const forceFresh = opts.forceFresh ?? false;
  const excludeUris = opts.excludeUris;

  const feed = await getFeedForUser(feedId, userId);
  if (!feed) {
    return new Response(
      JSON.stringify({ event: "error", message: "Feed not found" }),
      { status: 404, headers: { "content-type": "application/json" } }
    );
  }

  const encoder = new TextEncoder();
  const t0 = performance.now();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

      // "cached" is an internal signal (result came from feed_result_cache, no
      // pipeline ran) — don't forward it as a visible stage; surface it on the
      // final "done" event so the client can skip the pipeline loader.
      let servedFromCache = false;
      const onStage = (e: PreviewStageEvent) => {
        if (e.stage === "cached") {
          servedFromCache = true;
          return;
        }
        send({ event: "stage", ...e });
      };

      // Folded into the final "done" event (not a stage event) so it can't
      // regress the loader's stage progression — the count is only known after
      // the snapshot is built.
      let seenFiltered = 0;

      try {
        const posts = await getFeedPreviewPosts(feedId, 25, onStage, {
          forceFresh,
          viewerUserId: userId,
          excludeUris,
          onSeenFiltered: (n) => {
            seenFiltered = n;
          },
        });
        send({
          event: "done",
          cached: servedFromCache,
          total_stored: posts.length,
          seen_filtered: seenFiltered,
          mechanical_filters: feed.mechanical_filters,
          subqueries: feed.subqueries,
          candidate_budget: feed.candidate_budget,
          rerank_prompt: feed.rerank_prompt,
          rerank_model: feed.rerank_model,
          rerank_thinking_enabled: feed.rerank_thinking_enabled,
          posts,
          ms_total: Math.round(performance.now() - t0),
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn("[feed-preview/stream] error:", message);
        send({ event: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      // x-ndjson signals "newline-delimited JSON" to clients; Next.js dev
      // server (Node runtime) flushes each enqueue immediately.
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      // Disable proxy buffering so chunks reach the browser in real time
      // when the app sits behind nginx or Cloud Run's frontend.
      "x-accel-buffering": "no",
    },
  });
}
