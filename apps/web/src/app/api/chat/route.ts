import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth } from "@/lib/auth";
import { enforceRateLimit, LLM_RULES } from "@/lib/rate-limit";
import {
  getFeedForUser,
  getFeed,
  updateFeed,
  getChatMessages,
  addChatMessage,
  clearChat,
} from "@/lib/pg";
import { ensureEnvFromSecret } from "@/lib/secrets";
import { logLlmCall } from "@/lib/llm-log";
import { hydratePostByUri, type VectorHit } from "@/lib/vector-search";
import { normalizeRankingBias } from "@/lib/defaults";
import type { MechanicalFilters } from "@/lib/types";
import { buildFeedToolCall, type FeedToolArgs } from "@/lib/feed-tool-call";

let _client: Anthropic | null = null;
async function client(): Promise<Anthropic> {
  if (_client) return _client;
  await ensureEnvFromSecret("anthropic-api-key");
  _client = new Anthropic();
  return _client;
}

const SYSTEM_PROMPT = `You are a feed curator for Amadi, a company that believes people deserve to own their scroll. Modern feeds are built to maximize engagement, not to serve the person reading them. Your job is the opposite: figure out what feed would genuinely benefit this user, then build it for them.

EVERY reply MUST include a short text response (1-3 sentences). Tool calls are silent state mutations; without text alongside, the user sees a blank message. Always narrate, even when "just" saving. Never tool calls alone.

APPROACH: Do NOT interrogate the user or try to extract maximum information. Instead, listen to whatever they share, then propose a feed you think would be good for them. Be opinionated. Suggest things they might not have thought to ask for. A great curator doesn't just take orders, they see what someone needs and bring it to them. If someone says "I like tech," don't ask 5 follow-ups. Propose a specific, thoughtful feed and let them react.

BUILD AS YOU GO: on EVERY turn, if the user's message revealed ANYTHING that should shape the feed, call update_feed_config in that same turn — even if you are also asking a question or presenting options. Never wait for more information to save what you already have. A single mentioned interest is enough for a first draft: propose subqueries + a rerank_prompt + a name immediately, then refine as the conversation continues. The feed is always live.

Voice: warm, direct, a little opinionated. Like someone who genuinely cares about what you read and why. You're not a waiter taking an order, you're a friend who knows what's good. Keep it brief. One or two sentences, then act.

You translate interests into 1-4 SUBQUERIES — short topical queries (5-15 words) that drive ANN vector search over Bluesky posts. Each is a single distinct intent. Specific, not generic.
- GOOD: "personal essays on AI's effect on creative work"
- GOOD: "long-form posts about transformer interpretability research"
- BAD: "AI" (too sparse) or "I want thoughtful AI takes" (embeds the frame, not the content)

A RERANK PROMPT is a 3-6 sentence editorial filter applied after vector search. Use it to favor substance, originality, and posts worth someone's time. Deprioritize engagement bait, rage content, and empty takes. This is where you encode Amadi's values: the feed should leave the user better off than before they opened it.

STRUCTURAL FILTERS (post_type, lang_allow, require_media, time_window, min_like_count, etc.) — set sensible defaults based on context. Don't ask about them unless the user brings them up.

RANKING BIAS (engagement_weight, recency_weight, recency_halflife_h) — deterministic nudges layered on the editorial rerank. You can adjust these when context suggests it, but don't probe for them.

Tools:
- update_feed_config: call with just the fields that changed; the server merges with existing state.
- present_options: when you want the user to pick from 2-4 specific directions. Surprising and specific, not generic. No "Other" option — the input box handles free text. Your accompanying text contains the question. Asking a question never excuses skipping the save: if the turn taught you something, call update_feed_config alongside it.

Current saved preferences:
`;

const INTERVIEW_PROMPT = `

GUIDED MODE
The user asked to be walked through it. You're not interrogating them, you're getting just enough to make a great recommendation.
1. Open with ONE spark question to understand what matters to them right now. Use present_options with 3-4 specific, surprising options that reflect real ways people engage with content (not generic categories).
2. From their first answer onward, build as you go: every reply updates the feed via update_feed_config and may also ask one refinement question via present_options. Explain briefly why you think the feed would be good for them.
Keep it to ~3 questions total, then stop asking and let them react to the feed. Keep it warm and brief.

The goal: build a feed that serves them, not one that maximizes their time on screen. Think about what would leave them feeling informed, inspired, or genuinely entertained, not drained.`;

const MEMORY_IMPORT_PROMPT = `

MEMORY IMPORT MODE
The user pasted an export of their AI chat memory (from ChatGPT, Claude, etc.). This contains their interests, preferences, and personality.

Your job: use this to build a feed that would genuinely benefit them, not just mirror their existing habits back.
1. First reply: note what stood out (1-2 sentences, be specific). Save a first draft via update_feed_config, then propose a feed direction you think would serve them well, with present_options for 3-4 possible vibes or angles. Be opinionated about what you think would be healthiest and most rewarding for them.
2. Second reply: refine the draft via update_feed_config with final subqueries + a rerank_prompt + a name. Brief closing sentence.

Do NOT ask multiple rounds of questions. One question, then build.`;

const MECHANICAL_FILTERS_SCHEMA = {
  type: "object" as const,
  properties: {
    post_type: { type: "string", enum: ["all", "top_level", "replies"] },
    lang_allow: { type: "array", items: { type: "string" }, description: "ISO-639-1 codes, e.g. ['en']" },
    require_media: { type: "boolean" },
    exclude_media: { type: "boolean" },
    require_video: { type: "boolean" },
    exclude_video: { type: "boolean" },
    require_link: { type: "boolean" },
    exclude_links: { type: "boolean" },
    require_quote: { type: "boolean" },
    hashtag_include: { type: "array", items: { type: "string" }, description: "lowercase, no '#'" },
    min_like_count: { type: "number" },
    min_repost_count: { type: "number" },
    min_reply_count: { type: "number" },
    time_window: { type: "string", enum: ["1h", "24h", "3d", "custom"], description: "Max 3d — the vector index currently covers ~3 days" },
    created_after_iso: { type: "string", description: "Used only with time_window=custom" },
    created_before_iso: { type: "string", description: "Used only with time_window=custom" },
  },
};

const TOOLS: Anthropic.Tool[] = [
  {
    name: "update_feed_config",
    description:
      "Update the user's feed configuration. Include only the fields that changed — server merges with existing state. " +
      "Call this whenever you learn something that should shape the feed.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short feed name, 2-4 words, punchy" },
        subqueries: {
          type: "array",
          items: { type: "string" },
          description: "1-4 topical queries for vector search. Each 5-15 words, specific.",
        },
        rerank_prompt: {
          type: "string",
          description:
            "3-6 sentence editorial filter applied after vector search. Empty string disables rerank.",
        },
        mechanical_filters: MECHANICAL_FILTERS_SCHEMA,
        engagement_weight: {
          type: "number",
          description:
            "0–0.9. How much post popularity (likes/reposts/replies) nudges ordering AFTER the editorial rerank. 0 = ignore engagement; higher surfaces more popular posts. Default 0.2.",
        },
        recency_weight: {
          type: "number",
          description:
            "0–0.9. How much freshness nudges ordering after the rerank. 0 = ignore age; higher favors newer posts. Default 0.1. engagement_weight + recency_weight is capped so relevance always leads.",
        },
        recency_halflife_h: {
          type: "number",
          description:
            "1–720 hours. Only matters when recency_weight > 0: a post this old counts as half as fresh as a brand-new one. A few hours = breaking-news feel; days/weeks = age barely matters. Default 24.",
        },
      },
    },
  },
  {
    name: "present_options",
    description:
      "Show the user 2-4 specific options to pick from. Use INSTEAD of writing numbered lists in prose. " +
      "Your message text should contain the question; the options array contains just the choices.",
    input_schema: {
      type: "object",
      required: ["options"],
      properties: {
        options: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 4,
        },
      },
    },
  },
];

interface UpdateFeedConfigArgs {
  name?: string;
  subqueries?: string[];
  rerank_prompt?: string;
  mechanical_filters?: Partial<MechanicalFilters>;
  engagement_weight?: number;
  recency_weight?: number;
  recency_halflife_h?: number;
}

// Compact source-post payload for the chat UI's embedded card on a branched
// feed. The Bluesky embed script hydrates the rich card from the URI; text +
// author are the fallback shown before/if that fails. Returns null for
// non-branch feeds (no source_post_uri).
export interface ChatSourcePost {
  uri: string;
  bsky_url: string | null;
  text: string;
  author_handle: string | null;
  author_display_name: string | null;
}

function toChatSourcePost(hit: VectorHit): ChatSourcePost {
  const m = hit.uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
  return {
    uri: hit.uri,
    bsky_url: m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null,
    text: hit.text,
    author_handle: hit.author_handle,
    author_display_name: hit.author_display_name,
  };
}

export async function POST(req: NextRequest) {
  const limited = enforceRateLimit(req, "chat", LLM_RULES);
  if (limited) return limited;
  const t0 = performance.now();
  const auth = await requireAuth();
  const tAuth = performance.now();

  try {
    const { message, feedId, reset, interview, memoryImport } = await req.json();

    if (!feedId) {
      return NextResponse.json({ error: "feedId required" }, { status: 400 });
    }

    const feed = await getFeedForUser(feedId, auth.userId);
    if (!feed) {
      return NextResponse.json({ error: "Feed not found" }, { status: 404 });
    }

    if (reset) {
      await clearChat(feedId);
      return NextResponse.json({ messages: [] });
    }

    if (!message || typeof message !== "string") {
      return NextResponse.json(
        { error: "Message required" },
        { status: 400 }
      );
    }
    // Bound input size: the user message is interpolated into the Claude
    // request, so cap it to keep per-call token cost predictable.
    const maxLen = memoryImport ? 10000 : 4000;
    if (message.length > maxLen) {
      return NextResponse.json(
        { error: `Message too long (max ${maxLen} characters)` },
        { status: 400 }
      );
    }

    const isInit = message === "__init__";
    const isBranchInit = message === "__branch_init__";
    const history = await getChatMessages(feedId);

    // Hydrate the source post once for branched feeds — used to seed the
    // branch-init turn AND to render the embedded card in every response.
    let sourcePostHit: VectorHit | null = null;
    if (feed.source_post_uri) {
      sourcePostHit = await hydratePostByUri(feed.source_post_uri).catch(() => null);
    }
    const sourcePost = sourcePostHit ? toChatSourcePost(sourcePostHit) : null;

    if ((isInit || isBranchInit) && history.length > 0) {
      return NextResponse.json({ messages: history, feed, sourcePost });
    }

    const biasBlock = `\nRanking bias: engagement_weight=${feed.engagement_weight}, recency_weight=${feed.recency_weight}, recency_halflife_h=${feed.recency_halflife_h}`;
    const stateBlock =
      feed.subqueries.length > 0
        ? `Subqueries: ${JSON.stringify(feed.subqueries)}\nRerank prompt: ${JSON.stringify(feed.rerank_prompt)}\nMechanical filters: ${JSON.stringify(feed.mechanical_filters)}${biasBlock}`
        : `No preferences set yet — this is a fresh start.${biasBlock}`;

    const systemPrompt =
      SYSTEM_PROMPT + stateBlock + (interview === true ? INTERVIEW_PROMPT : "") + (memoryImport === true ? MEMORY_IMPORT_PROMPT : "");

    let apiMessages: { role: "user" | "assistant"; content: string }[];

    if (isBranchInit) {
      // Give the agent context, not instructions — the base curator system
      // prompt already knows how to turn topics into subqueries, write a
      // rerank prompt, and name the feed. We just hand it the chosen topics
      // (line-separated so the transcript reads cleanly).
      const topics = feed.subqueries.map((t) => `- ${t}`).join("\n");
      const branchSeed = `Create a feed with these topics:\n${topics}`;
      // Persist the seed so the transcript transparently shows the prompt the
      // branch was built from (unlike __init__, which hides its kickoff).
      await addChatMessage(feedId, "user", branchSeed);
      apiMessages = [{ role: "user", content: branchSeed }];
    } else if (isInit) {
      apiMessages = [{ role: "user", content: "Hey, I'd like to set up a feed." }];
    } else {
      await addChatMessage(feedId, "user", message);
      const updatedHistory = await getChatMessages(feedId);
      // The model takes only role + content; the tool_calls column is a UI-only
      // artifact and is never sent.
      apiMessages = updatedHistory.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
    }

    const tBeforeLLM = performance.now();
    const response = await (await client()).messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: systemPrompt,
      tools: TOOLS,
      messages: apiMessages,
    });
    const tAfterLLM = performance.now();

    logLlmCall({
      callSite: "chat",
      message: response,
      requestId: response._request_id,
      feedId,
      ms: tAfterLLM - tBeforeLLM,
      extra: { init: isInit, branch_init: isBranchInit, interview: interview === true, memoryImport: memoryImport === true },
    });

    // Process content blocks: collect text, apply tool calls.
    // Tool calls are server-side side-effects; we do NOT persist tool_use
    // blocks into chat_messages, so subsequent turns never need tool_result
    // blocks — the model sees the latest state via the system prompt instead.
    // We DO record what the turn set into `toolArgs`, stored on the assistant
    // message (tool_calls column) to render the in-chat "feed updated" row.
    let assistantText = "";
    const updates: Parameters<typeof updateFeed>[1] = {};
    const toolArgs: FeedToolArgs = {};
    let optionsToShow: string[] | null = null;

    for (const block of response.content) {
      if (block.type === "text") {
        assistantText += block.text;
      } else if (block.type === "tool_use") {
        if (block.name === "update_feed_config") {
          const args = block.input as UpdateFeedConfigArgs;
          if (typeof args.name === "string" && args.name.trim()) {
            updates.name = args.name.trim();
            toolArgs.name = updates.name;
          }
          if (Array.isArray(args.subqueries)) {
            const cleaned = args.subqueries
              .filter((s): s is string => typeof s === "string")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            if (cleaned.length > 0) {
              updates.subqueries = cleaned;
              toolArgs.subqueries = cleaned;
            }
          }
          if (typeof args.rerank_prompt === "string") {
            updates.rerank_prompt = args.rerank_prompt;
            toolArgs.rerank_prompt = args.rerank_prompt;
          }
          if (args.mechanical_filters && typeof args.mechanical_filters === "object") {
            updates.mechanical_filters = {
              ...feed.mechanical_filters,
              ...args.mechanical_filters,
            };
            // Keep the raw partial (just the fields the agent touched) for the row.
            toolArgs.mechanical_filters = args.mechanical_filters;
          }
          // Ranking-bias knobs: clamp + joint relevance-floor cap via the same
          // helper the Tune-panel PATCH uses, so the agent can't push the blend
          // past the bounds the UI enforces.
          const bias = normalizeRankingBias(args, feed);
          if (bias.engagement_weight !== undefined) {
            updates.engagement_weight = bias.engagement_weight;
            toolArgs.engagement_weight = bias.engagement_weight;
          }
          if (bias.recency_weight !== undefined) {
            updates.recency_weight = bias.recency_weight;
            toolArgs.recency_weight = bias.recency_weight;
          }
          if (bias.recency_halflife_h !== undefined) {
            updates.recency_halflife_h = bias.recency_halflife_h;
            toolArgs.recency_halflife_h = bias.recency_halflife_h;
          }
        } else if (block.name === "present_options") {
          const args = block.input as { options?: unknown };
          if (Array.isArray(args.options)) {
            const cleaned = args.options
              .filter((s): s is string => typeof s === "string")
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
              .slice(0, 4);
            if (cleaned.length >= 2) optionsToShow = cleaned;
          }
        }
      }
    }

    if (response.stop_reason === "max_tokens") {
      console.warn(
        `[chat] feedId=${feedId} response hit max_tokens — output may be truncated`
      );
    }

    if (Object.keys(updates).length > 0) {
      await updateFeed(feedId, updates);
    }

    // What the tool set this turn, for the in-chat "feed updated" row. Stored on
    // the assistant message (tool_calls column); null on a pure chat/question
    // turn that set nothing.
    const toolCall = buildFeedToolCall(toolArgs);

    // Embed options as numbered lines in the stored message so the client's
    // existing chip-rendering can pick them up after refresh without a sidecar.
    let finalText = assistantText.trim();
    if (optionsToShow) {
      const lines = optionsToShow.map((o, i) => `${i + 1}. ${o}`).join("\n");
      finalText = finalText ? `${finalText}\n\n${lines}` : lines;
    }

    await addChatMessage(feedId, "assistant", finalText, toolCall);

    const allMessages = await getChatMessages(feedId);
    const updatedFeed = await getFeed(feedId);
    const tEnd = performance.now();
    console.log(
      `[timing] POST /api/chat auth=${(tAuth - t0).toFixed(0)}ms ` +
        `pre-llm=${(tBeforeLLM - tAuth).toFixed(0)}ms ` +
        `llm=${(tAfterLLM - tBeforeLLM).toFixed(0)}ms ` +
        `post-llm=${(tEnd - tAfterLLM).toFixed(0)}ms ` +
        `total=${(tEnd - t0).toFixed(0)}ms feedId=${feedId} init=${isInit} ` +
        `interview=${interview === true} tools=${response.content.filter((b) => b.type === "tool_use").length}`
    );

    return NextResponse.json({
      messages: allMessages,
      feed: updatedFeed,
      sourcePost,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal error";
    console.error("Chat API error:", e);
    return NextResponse.json({ error: msg, messages: [] }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const t0 = performance.now();
  const auth = await requireAuth();
  const tAuth = performance.now();

  const feedId = Number(req.nextUrl.searchParams.get("feedId"));
  if (!feedId) {
    return NextResponse.json({ error: "feedId required" }, { status: 400 });
  }

  const feed = await getFeedForUser(feedId, auth.userId);
  if (!feed) {
    return NextResponse.json({ error: "Feed not found" }, { status: 404 });
  }
  const tFeed = performance.now();
  const messages = await getChatMessages(feedId);
  let sourcePost: ChatSourcePost | null = null;
  if (feed.source_post_uri) {
    const hit = await hydratePostByUri(feed.source_post_uri).catch(() => null);
    if (hit) sourcePost = toChatSourcePost(hit);
  }
  const tMessages = performance.now();
  console.log(
    `[timing] GET /api/chat auth=${(tAuth - t0).toFixed(0)}ms ` +
      `feed-lookup=${(tFeed - tAuth).toFixed(0)}ms ` +
      `messages=${(tMessages - tFeed).toFixed(0)}ms ` +
      `total=${(tMessages - t0).toFixed(0)}ms feedId=${feedId} count=${messages.length}`
  );

  return NextResponse.json({ messages, feed, sourcePost });
}
