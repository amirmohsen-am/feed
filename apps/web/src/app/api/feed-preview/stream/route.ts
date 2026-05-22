import { NextRequest } from "next/server";
import { requireAuth, isAuthError } from "@/lib/auth";
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
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const feedId = Number(req.nextUrl.searchParams.get("feedId"));
  if (!feedId) {
    return new Response(
      JSON.stringify({ event: "error", message: "feedId required" }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const feed = await getFeedForUser(feedId, auth.userId);
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

      const onStage = (e: PreviewStageEvent) => {
        send({ event: "stage", ...e });
      };

      try {
        const posts = await getFeedPreviewPosts(feedId, 25, onStage);
        send({
          event: "done",
          total_stored: posts.length,
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
