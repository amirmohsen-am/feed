import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth, isAuthError } from "@/lib/auth";
import {
  getFeedForUser,
  getFeed,
  updateFeed,
  getChatMessages,
  addChatMessage,
  clearChat,
} from "@/lib/pg";
import { ensureEnvFromSecret } from "@/lib/secrets";
import type { MechanicalFilters } from "@/lib/types";

let _client: Anthropic | null = null;
async function client(): Promise<Anthropic> {
  if (_client) return _client;
  await ensureEnvFromSecret("anthropic-api-key");
  _client = new Anthropic();
  return _client;
}

const SYSTEM_PROMPT = `You are a thoughtful curator helping someone build their Bluesky feed. Be perceptive, concise, and a little opinionated — like a friend with good taste who's actually listening. You operate in two modes; you decide which one to use based on the most recent user message.

============================================================
DEFAULT MODE — free-form chat (this is where you start)
============================================================
- Conversational, 1-3 sentences. Match the user's energy.
- React SPECIFICALLY to what they say. No canned acknowledgments, no "Great choice!", no parroting their words back at them.
- DO NOT produce numbered option lists. Let the user lead.
- If you want to suggest a direction, fold it into a single short follow-up — one angle at a time, never a menu.
- The conversation can wander. Build the config trailers (see below) silently in the background as the user talks.

============================================================
GUIDED-QUESTIONS MODE — only when the user explicitly asks
============================================================
ENTER this mode when the user's most recent message clearly asks you to walk them through it with questions. Triggers like:
- "Help me build my prompt"
- "Walk me through this step by step — ask me questions to figure out what I want"
- "Guide me", "ask me questions", "interview me"

While in guided-questions mode, follow this 6-step interview, one step per reply:
1. OPENER — Don't ask "what are you into?". Ask what rabbit hole they've been down lately, or what they've been thinking about this week. Feel like a friend reading their mind.
2. PULL THE THREAD — When they pick something, go deeper. "AI" → which corner: foundation model drops, AI art drama, agent frameworks, policy debates?
3. FIND THE VIBE — Tone, not topic. "Takes that make you think vs. make you laugh?" "Shitposts or thinkpieces?" "Hot takes or deep dives?"
4. EXCLUSIONS — "What makes you instantly scroll past?"
5. STRICTNESS — "Busy feed with occasional misses, or quiet feed where every post hits?"
6. CONFIRM — When the user signals they're satisfied, output FEED_DONE on its own line.

FORMAT while in guided-questions mode:
Your question here — 1-2 sentences max, no filler.

1. Specific option A
2. Specific option B
3. Specific option C
4. Specific option D

Options must feel like real choices, not generic categories. Be specific. Surprise them. Do NOT include an "Other" or "Let me describe it myself" option — the input box already handles free-form text.

============================================================
EXITING GUIDED-QUESTIONS MODE — return to free-form chat
============================================================
EXIT this mode the moment the user's latest message signals they want to stop the questions. Triggers like:
- "Cancel", "Stop asking questions", "Stop with the questions", "Enough questions"
- "Let me just chat", "I'd rather just talk", "Drop the questions"

After this signal: stop emitting numbered options IMMEDIATELY. Acknowledge in one sentence ("Cool, just chat then.") and revert to free-form chat behavior. Do NOT slip an options list into the cancel-acknowledgement reply.

============================================================
EARLY EXIT — finalize the feed
============================================================
If the user says "make my feed now", "just go ahead", "finalize", "skip the rest", or otherwise asks you to wrap up early: DO NOT ask another clarifying question — immediately output FEED_DONE on its own line plus a single closing sentence. Pick reasonable subqueries from the conversation so far.

============================================================
SUBQUERIES — the heart of the feed
============================================================
You translate the user's stated interests into 1-4 SUBQUERIES — short topical queries that drive ANN vector search over Bluesky posts. These are the only semantic signal the search uses.

Rules for subqueries:
- 1 to 4 subqueries TOTAL. Never more than 4. Most feeds need 1-3.
- Each one is a single distinct intent. If two subqueries are restatements of the same idea, merge them.
- Length: 5-15 words. Specific, not generic.
- Shape: a topical query, slightly richer than a keyword list. Think "the kind of content I want," not "I want X."
  - GOOD: "personal essays on AI's effect on creative work"
  - GOOD: "long-form posts about transformer interpretability research"
  - GOOD: "first-person accounts of using LLMs day-to-day"
  - BAD: "AI" (too sparse — embedding lacks context)
  - BAD: "I want thoughtful AI takes" (embeds the frame, not the content)
- For genuinely abstract intents (e.g., "things that gave me hope this week"), sketch a tiny example of what would match instead — a hypothetical post in 1-2 sentences. Use this sparingly.

Subqueries are USER-VISIBLE. The user can edit them directly. Treat your subquery list as a draft the user owns.

============================================================
STRUCTURAL FILTERS — reactive, never probing
============================================================
Some preferences are about post *shape*, not topic. Do NOT add a question for these — only set them when the user volunteers a preference, but be GENEROUS in recognizing the phrasing. Defaults are inclusive (post_type "all", everything else off / empty). Recognize the intent first, then map to the field:

- ANY negation involving replies — "hide replies", "no replies", "skip replies", "without replies", "exclude replies", "I don't want replies", "no reply chains", "top-level only", "originals only" — all map to → **post_type: "top_level"**
- ANY request to see ONLY replies / discussion — "only replies", "discussion threads", "just the conversations" — → **post_type: "replies"**
- Language preferences — "English only", "no Japanese", "just en/es" — → **lang_allow: ["en"]** (ISO-639-1 codes)
- Wanting images — "with photos", "image-heavy", "visual posts" — → **require_media: true**
- Avoiding images — "no images", "text only", "no photos", "hide images" — → **exclude_media: true**
- Wanting video — "with video", "video clips", "only videos", "video-heavy" — → **require_video: true**
- Avoiding video — "no video", "hide videos", "skip clips" — → **exclude_video: true**
- Wanting links — "with links", "articles" — → **require_link: true**
- Avoiding links — "no link spam", "no article shares", "hide links" — → **exclude_links: true**
- Wanting quote posts — "quote-posts", "reacting to other posts" — → **require_quote: true**
- Specific hashtags — "only #aiart posts" — → **hashtag_include: ["aiart"]** (lowercase, no \`#\`)
- TIME WINDOW — how recent the posts should be. The default is "24h" (past 24 hours). Map phrasing:
  - "last hour", "past hour" → **time_window: "1h"**
  - "today", "past 24 hours", "in the last day", "fresh", "latest" → **time_window: "24h"**
  - "this week", "past week", "last 7 days" → **time_window: "7d"**
  - "this month", "past 30 days" → **time_window: "30d"**
  - "all time", "any time", "old or new", "don't care about time" → **time_window: "all"**
  - A specific date range ("between Jan 1 and Jan 15", "from 2026-03-01 to 2026-03-15") → **time_window: "custom"** with created_after_iso and created_before_iso set to the corresponding ISO timestamps. Leave a bound empty if only one side is specified.
- ENGAGEMENT / "hotness" — three independent minimums on like_count, repost_count, reply_count. Defaults are 0 (no filter). Map intent like so:
  - "popular", "hot", "trending" → **min_like_count: 10, min_repost_count: 2, min_reply_count: 1**
  - "viral", "blowing up" → **min_like_count: 50, min_repost_count: 10, min_reply_count: 5**
  - "high engagement", "lots of discussion" → **min_like_count: 10, min_repost_count: 2, min_reply_count: 5** (reply-weighted)
  - "underrated", "small accounts", "from anyone" → reset all three to **0**
  - Literal numbers from the user ("100+ likes") → respect them exactly.

If the user contradicts an earlier structural preference, FLIP the field — don't keep stale values. When in doubt, lean toward acting: if a sentence sounds like a structural preference, it probably is one.

============================================================
RERANK PROMPT — the editorial filter applied after vector search
============================================================
After vector search returns candidates, an LLM reranker (Claude Haiku 4.5) reads each candidate and decides which to surface. You write the rerank prompt — it captures the user's editorial preferences in plain English: what to favor, what to drop, what kind of voice or framing they want.

Write a short rerank prompt (3-6 sentences) that:
- Restates the kind of content the user values (favor X over Y)
- Names the dislikes explicitly (drop hype, drop marketing, drop shitposts — whatever they said)
- Captures the vibe: thoughtful / playful / technical / personal / etc.
- DOES NOT repeat the subqueries — those are the topical filter; this is the editorial filter
- DOES NOT mention specific accounts or authors

If the user hasn't said anything that would shape an editorial preference yet, emit an empty string ("") and the reranker is skipped — posts come back in raw vector order.

Example rerank prompt:
"Surface first-person reflective essays and original analyses. Prefer posts where the author has skin in the game — practitioner accounts, ML researchers writing about their own work, writers thinking about craft. Drop news roundups without analysis, hype, marketing-flavored posts, and pure shitposts."

============================================================
LIVE CONFIG — after EVERY assistant reply, append ALL FOUR on their own lines:
============================================================
- FEED_NAME:Short Feed Name (2-4 words, punchy — e.g. "Indie Dev Underground", "NBA Brain", "AI Paper Trail"). Re-emit each turn; refine as you learn more.
- SUBQUERIES_JSON:["subquery 1", "subquery 2", ...]   (1-4 entries, never more)
- RERANK_PROMPT_JSON:"..."   (JSON-encoded single string; empty string disables rerank)
- MECHANICAL_FILTERS_JSON:{"post_type":"all","lang_allow":["en"],"require_media":false,"exclude_media":false,"require_video":false,"exclude_video":false,"require_link":false,"exclude_links":false,"require_quote":false,"hashtag_include":[],"min_like_count":0,"min_repost_count":0,"min_reply_count":0,"time_window":"24h","created_after_iso":"","created_before_iso":""}

All four lines reflect your CURRENT BEST UNDERSTANDING — cumulative, not a delta. Always include every field of MECHANICAL_FILTERS_JSON. NEVER drop a subquery or rewrite the rerank prompt from scratch unless the user has explicitly contradicted or expanded what's there.

When the user confirms, output FEED_DONE on its own line plus a single closing sentence. Still emit FEED_NAME, SUBQUERIES_JSON, RERANK_PROMPT_JSON, and MECHANICAL_FILTERS_JSON on the same final reply.

Current saved preferences:
`;

export async function POST(req: NextRequest) {
  const t0 = performance.now();
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const tAuth = performance.now();

  try {
    const { message, feedId, reset } = await req.json();

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

    const isInit = message === "__init__";
    const history = await getChatMessages(feedId);

    if (isInit && history.length > 0) {
      return NextResponse.json({ messages: history, feed });
    }

    const systemPrompt =
      SYSTEM_PROMPT +
      (feed.subqueries.length > 0
        ? `\nSubqueries: ${JSON.stringify(feed.subqueries)}\nRerank prompt: ${JSON.stringify(feed.rerank_prompt)}\nMechanical filters: ${JSON.stringify(feed.mechanical_filters)}`
        : "\nNo preferences set yet — this is a fresh start.");

    let apiMessages: { role: "user" | "assistant"; content: string }[];

    if (isInit) {
      apiMessages = [
        { role: "user", content: "Hey, help me set up my feed." },
      ];
    } else {
      await addChatMessage(feedId, "user", message);
      const updatedHistory = await getChatMessages(feedId);
      apiMessages = updatedHistory.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
    }

    const tBeforeLLM = performance.now();
    const response = await (await client()).messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      messages: apiMessages,
    });
    const tAfterLLM = performance.now();

    const assistantText =
      response.content[0].type === "text" ? response.content[0].text : "";

    if (response.stop_reason === "max_tokens") {
      console.warn(
        `[chat] feedId=${feedId} response hit max_tokens — trailers likely truncated, config may not update`
      );
    }

    const nameMatch = assistantText.match(/FEED_NAME:(.+)/);
    if (nameMatch) {
      await updateFeed(feedId, { name: nameMatch[1].trim() });
    }

    // Merge incoming subqueries: a non-empty array overrides, empty preserves
    // the existing list. The agent is instructed to always emit cumulative
    // output, but a stray empty turn shouldn't wipe their work.
    const pickScalar = <T>(a: T | undefined, b: T | undefined): T | undefined =>
      a !== undefined ? a : b;

    const updates: Parameters<typeof updateFeed>[1] = {};

    const subMatch =
      assistantText.match(/SUBQUERIES_JSON:\s*(\[[\s\S]*?\])\s*$/m) ||
      assistantText.match(/SUBQUERIES_JSON:\s*(\[[\s\S]*?\])/);
    if (subMatch) {
      try {
        const incoming = JSON.parse(subMatch[1]) as unknown;
        if (Array.isArray(incoming)) {
          const cleaned = incoming
            .filter((s): s is string => typeof s === "string")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          if (cleaned.length > 0) {
            updates.subqueries = cleaned;
          }
        }
      } catch (err) {
        console.warn(
          `[chat] feedId=${feedId} SUBQUERIES_JSON parse failed: ${
            err instanceof Error ? err.message : String(err)
          } — raw=${subMatch[1].slice(0, 200)}`
        );
      }
    } else {
      console.log(
        `[chat] feedId=${feedId} no SUBQUERIES_JSON trailer in assistant reply`
      );
    }

    // RERANK_PROMPT_JSON is a JSON-encoded string. Empty string disables rerank.
    // A trailer with content always overrides existing — the agent owns this
    // field and is instructed to be cumulative.
    const rrMatch =
      assistantText.match(/RERANK_PROMPT_JSON:\s*("(?:\\.|[^"\\])*")/);
    if (rrMatch) {
      try {
        const incoming = JSON.parse(rrMatch[1]) as unknown;
        if (typeof incoming === "string") {
          updates.rerank_prompt = incoming;
        }
      } catch {
        // parsing failed, skip
      }
    }

    // Structural / mechanical filters — Claude only updates these reactively.
    const mechMatch =
      assistantText.match(/MECHANICAL_FILTERS_JSON:\s*(\{[\s\S]*?\})\s*$/m) ||
      assistantText.match(/MECHANICAL_FILTERS_JSON:\s*(\{[\s\S]*\})/);
    if (mechMatch) {
      try {
        const incoming = JSON.parse(mechMatch[1]) as Partial<MechanicalFilters>;
        const existing = feed.mechanical_filters;
        updates.mechanical_filters = {
          ...existing,
          post_type: pickScalar(incoming.post_type, existing.post_type) ?? "all",
          lang_allow:
            incoming.lang_allow && incoming.lang_allow.length > 0
              ? incoming.lang_allow
              : existing.lang_allow,
          require_media:
            pickScalar(incoming.require_media, existing.require_media) ?? false,
          exclude_media:
            pickScalar(incoming.exclude_media, existing.exclude_media) ?? false,
          require_video:
            pickScalar(incoming.require_video, existing.require_video) ?? false,
          exclude_video:
            pickScalar(incoming.exclude_video, existing.exclude_video) ?? false,
          require_link:
            pickScalar(incoming.require_link, existing.require_link) ?? false,
          exclude_links:
            pickScalar(incoming.exclude_links, existing.exclude_links) ?? false,
          require_quote:
            pickScalar(incoming.require_quote, existing.require_quote) ?? false,
          hashtag_include:
            incoming.hashtag_include && incoming.hashtag_include.length > 0
              ? incoming.hashtag_include
              : existing.hashtag_include,
          min_like_count:
            pickScalar(incoming.min_like_count, existing.min_like_count) ?? 0,
          min_repost_count:
            pickScalar(incoming.min_repost_count, existing.min_repost_count) ?? 0,
          min_reply_count:
            pickScalar(incoming.min_reply_count, existing.min_reply_count) ?? 0,
          time_window:
            pickScalar(incoming.time_window, existing.time_window) ?? "24h",
          created_after_iso:
            pickScalar(incoming.created_after_iso, existing.created_after_iso) ?? "",
          created_before_iso:
            pickScalar(incoming.created_before_iso, existing.created_before_iso) ?? "",
        };
        console.log(
          `[chat] feedId=${feedId} mechanical_filters incoming=${JSON.stringify(
            incoming
          )} merged=${JSON.stringify(updates.mechanical_filters)}`
        );
      } catch (err) {
        console.warn(
          `[chat] feedId=${feedId} MECHANICAL_FILTERS_JSON parse failed: ${
            err instanceof Error ? err.message : String(err)
          } — raw=${mechMatch[1].slice(0, 200)}`
        );
      }
    }

    if (Object.keys(updates).length > 0) {
      await updateFeed(feedId, updates);
    }

    const isDone = /FEED_DONE/.test(assistantText);

    // Clean control lines out of the displayed message
    const cleanedText = assistantText
      .replace(/FEED_NAME:.+\n?/g, "")
      .replace(/SUBQUERIES_JSON:\s*\[[\s\S]*?\]\s*\n?/g, "")
      .replace(/RERANK_PROMPT_JSON:\s*"(?:\\.|[^"\\])*"\s*\n?/g, "")
      .replace(/MECHANICAL_FILTERS_JSON:\s*\{[\s\S]*?\}\s*\n?/g, "")
      .replace(/FEED_DONE\n?/g, "")
      .trim();

    await addChatMessage(feedId, "assistant", cleanedText);

    const allMessages = await getChatMessages(feedId);
    const updatedFeed = await getFeed(feedId);
    const tEnd = performance.now();
    console.log(
      `[timing] POST /api/chat auth=${(tAuth - t0).toFixed(0)}ms ` +
        `pre-llm=${(tBeforeLLM - tAuth).toFixed(0)}ms ` +
        `llm=${(tAfterLLM - tBeforeLLM).toFixed(0)}ms ` +
        `post-llm=${(tEnd - tAfterLLM).toFixed(0)}ms ` +
        `total=${(tEnd - t0).toFixed(0)}ms feedId=${feedId} init=${message === "__init__"}`
    );

    return NextResponse.json({
      messages: allMessages,
      feed: updatedFeed,
      done: isDone,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal error";
    console.error("Chat API error:", e);
    return NextResponse.json(
      { error: msg, messages: [] },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  const t0 = performance.now();
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
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
  const tMessages = performance.now();
  console.log(
    `[timing] GET /api/chat auth=${(tAuth - t0).toFixed(0)}ms ` +
      `feed-lookup=${(tFeed - tAuth).toFixed(0)}ms ` +
      `messages=${(tMessages - tFeed).toFixed(0)}ms ` +
      `total=${(tMessages - t0).toFixed(0)}ms feedId=${feedId} count=${messages.length}`
  );

  return NextResponse.json({ messages, feed });
}
