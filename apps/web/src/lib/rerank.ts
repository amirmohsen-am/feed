/**
 * Claude reranker.
 *
 * Given a query and N candidate posts (from Vertex vector search), prompt
 * Sonnet 4.6 with a user-saved editorial system prompt and ask it to return
 * a sorted JSON array of up to K kept items: `[{i, score, reason}]`.
 *
 * `i` is the candidate index we sent in, so the client/server can join back
 * to the original hit without round-tripping URIs through the LLM.
 *
 * The output contract (the format suffix on the system prompt) lives here,
 * not in user-saved prompt text — so we can fix parsing without rewriting
 * every saved prompt.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ensureEnvFromSecret } from "./secrets";
import type { VectorHit } from "./vector-search";
import { DEFAULT_RERANK_MODEL, MAX_RERANK_IMAGES } from "./defaults";

// Default model name for bulk listwise rerank. Each call can override via
// `opts.model`; the per-feed setting is read in pg.ts.
export const RERANK_MODEL = DEFAULT_RERANK_MODEL;

const RERANK_OUTPUT_CONTRACT = `

Return JSON only — a single array of up to N items, sorted best-first.
Each item: {"i": <int candidate index>, "score": <int 0-100>, "reason": "<one short sentence>"}.
Do NOT include items you would not surface. Do NOT include any prose outside the array.`;

let _client: Anthropic | null = null;
async function client(): Promise<Anthropic> {
  if (_client) return _client;
  await ensureEnvFromSecret("anthropic-api-key");
  _client = new Anthropic();
  return _client;
}

export interface RerankedItem {
  i: number;
  score: number;
  reason: string;
}

export interface RerankResult {
  kept: RerankedItem[];
  ms_rerank: number;
}

function trimCandidate(h: VectorHit, i: number) {
  return {
    i,
    text: h.text,
    author: h.author_handle ? `@${h.author_handle}` : null,
    likes: h.like_count,
    reposts: h.repost_count,
    image_alt: h.image_alts.length > 0 ? h.image_alts.join(" / ") : undefined,
    ext_title: h.external_title || undefined,
  };
}

function safeParseArray(raw: string): unknown {
  // Strip code fences if the model wrapped output despite the contract.
  const stripped = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  // Find the first '[' and the matching last ']'.
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("reranker returned no JSON array");
  }
  return JSON.parse(stripped.slice(start, end + 1));
}

export interface RerankPhaseInfo {
  candidates: number;
  images: number;
  model: string;
}

export async function rerank(opts: {
  query: string;
  candidates: VectorHit[];
  topK: number;
  systemPrompt: string;
  // Override the model for this call. Defaults to RERANK_MODEL.
  model?: string;
  // When true, attach `image` content blocks for candidates that have images
  // (uses `hit.image_urls`). Capped at MAX_RERANK_IMAGES total.
  withImages?: boolean;
  // When true, enable Anthropic extended thinking on the call. The model
  // emits a private reasoning block before the JSON ranking, which can help
  // on borderline candidates at the cost of latency + tokens.
  thinkingEnabled?: boolean;
  // Called once when the Anthropic request is dispatched. Carries the
  // candidate/image counts so a UI can render "Ranking … 80 candidates · 87 images".
  onRequestSent?: (info: RerankPhaseInfo) => void;
  // Called once when the first text delta arrives from the model. With
  // thinking off this is just TTFT; with thinking on it marks the end of
  // the reasoning block and the start of the JSON output.
  onFirstToken?: () => void;
}): Promise<RerankResult> {
  const { query, candidates, topK, systemPrompt } = opts;
  const model = opts.model && opts.model.length > 0 ? opts.model : RERANK_MODEL;
  const t0 = performance.now();

  const trimmed = candidates.map((h, i) => trimCandidate(h, i));
  const textBlock =
    `Query: ${JSON.stringify(query)}\n` +
    `N = ${topK}\n` +
    `Candidates (n=${candidates.length}):\n` +
    JSON.stringify(trimmed);

  // Build the user content. When images are enabled, we send one text block
  // followed by interleaved `Image for candidate N:` markers + image blocks.
  // Iteration order is candidate-major: candidate 0's images first, then
  // candidate 1's, etc. — so when the cap is reached we cut off the tail of
  // the candidate list rather than dropping images uniformly.
  const content: Anthropic.ContentBlockParam[] = [
    { type: "text", text: textBlock },
  ];
  let imagesAttached = 0;
  if (opts.withImages) {
    outer: for (let i = 0; i < candidates.length; i++) {
      const urls = candidates[i].image_urls ?? [];
      if (urls.length === 0) continue;
      content.push({
        type: "text",
        text: `Images for candidate ${i}:`,
      });
      for (const url of urls) {
        if (imagesAttached >= MAX_RERANK_IMAGES) break outer;
        content.push({
          type: "image",
          source: { type: "url", url },
        });
        imagesAttached++;
      }
    }
  }

  const system = systemPrompt + RERANK_OUTPUT_CONTRACT;

  const thinkingEnabled = opts.thinkingEnabled === true;
  // Budget needs headroom under max_tokens. 4096 max with ~1500 thinking
  // leaves enough room for the JSON ranking output even on long candidate
  // lists.
  const THINKING_BUDGET = 1500;

  console.log(
    `[rerank] model=${model} candidates=${candidates.length} ` +
      `images=${imagesAttached} topK=${topK} thinking=${thinkingEnabled}`
  );
  opts.onRequestSent?.({ candidates: candidates.length, images: imagesAttached, model });

  // Stream so we can detect the "first text delta" moment — that's the
  // ranking→generating transition we surface to the client loader.
  const c = await client();
  const stream = c.messages.stream({
    model,
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content }],
    ...(thinkingEnabled
      ? { thinking: { type: "enabled" as const, budget_tokens: THINKING_BUDGET } }
      : {}),
  });

  let firstTokenFired = false;
  stream.on("text", () => {
    if (!firstTokenFired) {
      firstTokenFired = true;
      opts.onFirstToken?.();
    }
  });

  const finalMessage = await stream.finalMessage();
  // With thinking enabled the first content block is a ThinkingBlock; the
  // JSON ranking lives in the first TextBlock that follows.
  const outputTextBlock = finalMessage.content.find((b) => b.type === "text");
  const text =
    outputTextBlock && outputTextBlock.type === "text" ? outputTextBlock.text : "";
  const parsed = safeParseArray(text);
  if (!Array.isArray(parsed)) {
    throw new Error("reranker output was not a JSON array");
  }

  const kept: RerankedItem[] = [];
  const seen = new Set<number>();
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { i?: unknown; score?: unknown; reason?: unknown };
    const i = typeof r.i === "number" ? r.i : Number(r.i);
    const score = typeof r.score === "number" ? r.score : Number(r.score);
    const reason = typeof r.reason === "string" ? r.reason : "";
    if (!Number.isInteger(i) || i < 0 || i >= candidates.length) continue;
    if (seen.has(i)) continue;
    seen.add(i);
    kept.push({
      i,
      score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0,
      reason,
    });
    if (kept.length >= topK) break;
  }

  return { kept, ms_rerank: Math.round(performance.now() - t0) };
}
