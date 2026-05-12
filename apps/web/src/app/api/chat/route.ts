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
import type { SemanticConfig } from "@/lib/types";

let _client: Anthropic | null = null;
async function client(): Promise<Anthropic> {
  if (_client) return _client;
  await ensureEnvFromSecret("anthropic-api-key");
  _client = new Anthropic();
  return _client;
}

const SYSTEM_PROMPT = `You are a taste architect — you help people discover what they actually want to see on their Bluesky feed. You're perceptive, concise, and a little opinionated. Think of yourself as a music recommendation engine but for social posts.

STYLE:
- 1-2 sentences max, then options. No filler. No "Great choice!" — just move.
- Options should feel like real choices, not generic categories. Be specific. Surprise them.
- Use the italic serif voice for your main text. End every message with 3-5 numbered options.
- The user can also type a free-form reply in the input box — they pick one or more options and/or describe it themselves. Do NOT include an option like "Let me describe it myself" or "Other" — the input field handles that already, so adding it is redundant noise.

FORMAT:
Your question here — make it feel like you're reading their mind.

1. Specific option A
2. Specific option B
3. Specific option C
4. Specific option D

CONVERSATION FLOW — go deep, not wide:
1. OPENER: Don't ask "what are you into?" — that's boring. Instead, ask what they've been thinking about lately, or what rabbit hole they've been down this week. Make them feel like they're talking to a friend, not filling out a form.
2. PULL THE THREAD: When they pick something, don't immediately move on. Pull the thread. If they say "AI", ask what corner — are they watching foundation model drops, AI art drama, agent frameworks, policy debates? The good stuff is in the specifics.
3. FIND THE VIBE: Ask what makes a post worth reading vs. scrolling past. This is about tone, not topic. Examples: "Do you want the takes that make you think, or the ones that make you laugh?" / "Shitposts or thinkpieces?" / "Hot takes or deep dives?"
4. EXCLUSIONS: Ask what they're tired of seeing. Frame it as: "What makes you instantly scroll past?" This catches the stuff they hate that might sneak through keyword matching.
5. STRICTNESS: Ask how picky the feed should be. Frame as "Do you want a busy feed with occasional misses, or a quiet feed where every post hits?"
6. CONFIRM: When the user signals they're satisfied, output FEED_DONE on its own line.

EARLY EXIT: If the user says anything like "make my feed now", "just go ahead", "finalize", "skip the rest", or otherwise asks you to wrap up early, DO NOT ask another clarifying question — immediately go to FEED_DONE. Use sensible defaults for any dimensions you haven't covered: vibes can be inferred from their answers so far, exclude_topics/exclude_keywords can be empty, embedding_threshold 0.5, judge_strictness "moderate".

IMPORTANT — keyword generation:
Generate 10-20 SPECIFIC keywords. Not just "AI" — think "transformer architecture", "GPT", "diffusion models", "RLHF", "open source LLMs". The more specific and varied the keywords, the better the embedding matching works. Include jargon, names of people/projects/tools they'd care about, and slang their community uses.

LIVE CONFIG — after EVERY assistant reply, append BOTH of these on their own lines:
- FEED_NAME:Short Feed Name (2-4 words, punchy — e.g. "Indie Dev Underground", "NBA Brain", "AI Paper Trail"). Re-emit each turn; you may refine the name as you learn more.
- FEED_CONFIG_JSON:{"topics":[...],"keywords":[...],"exclude_topics":[...],"exclude_keywords":[...],"vibes":"...","embedding_threshold":0.5,"judge_enabled":true,"judge_strictness":"moderate"}

The FEED_CONFIG_JSON must reflect your CURRENT BEST UNDERSTANDING of the user's preferences — cumulative, not a delta. Always include EVERY field you've inferred so far. Empty arrays are fine for fields you haven't probed yet ("[]"), and an empty string is fine for vibes early on. NEVER drop a field or value you previously inferred unless the user explicitly contradicts it. The settings panel updates live as you emit this, so partial-but-growing is exactly right.

When the user confirms, output FEED_DONE on its own line plus a single closing sentence. Still emit FEED_NAME and FEED_CONFIG_JSON on the same final reply.

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

    // If init and we already have messages, just return them
    if (isInit && history.length > 0) {
      return NextResponse.json({ messages: history, feed });
    }

    const systemPrompt =
      SYSTEM_PROMPT +
      (feed.description
        ? `\nDescription: "${feed.description}"\nSemantic config: ${JSON.stringify(feed.semantic_config)}`
        : "\nNo preferences set yet — this is a fresh start.");

    // For init, use a nudge (not saved to history)
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
      model: "claude-sonnet-4-20250514",
      max_tokens: 512,
      system: systemPrompt,
      messages: apiMessages,
    });
    const tAfterLLM = performance.now();

    const assistantText =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Check for feed name
    const nameMatch = assistantText.match(/FEED_NAME:(.+)/);
    if (nameMatch) {
      await updateFeed(feedId, { name: nameMatch[1].trim() });
    }

    // Check for config (new format). Merge with existing semantic_config so
    // the agent emitting a sparser config on a later turn doesn't wipe fields
    // it inferred earlier — only an explicit non-empty override should replace.
    const configMatch = assistantText.match(/FEED_CONFIG_JSON:\s*(\{[\s\S]*?\})\s*$/m)
      || assistantText.match(/FEED_CONFIG_JSON:\s*(\{[\s\S]*\})/);
    if (configMatch) {
      try {
        const incoming = JSON.parse(configMatch[1]) as Partial<SemanticConfig>;
        const existing = (feed.semantic_config || {}) as Partial<SemanticConfig>;
        const pickList = (a?: string[], b?: string[]) =>
          a && a.length > 0 ? a : b ?? [];
        const pickScalar = <T>(a: T | undefined, b: T | undefined): T | undefined =>
          a !== undefined ? a : b;
        const merged: SemanticConfig = {
          topics: pickList(incoming.topics, existing.topics),
          keywords: pickList(incoming.keywords, existing.keywords),
          exclude_topics: pickList(incoming.exclude_topics, existing.exclude_topics),
          exclude_keywords: pickList(incoming.exclude_keywords, existing.exclude_keywords),
          vibes: pickScalar(incoming.vibes, existing.vibes) ?? "",
          embedding_threshold:
            pickScalar(incoming.embedding_threshold, existing.embedding_threshold) ?? 0.5,
          judge_enabled:
            pickScalar(incoming.judge_enabled, existing.judge_enabled) ?? true,
          judge_strictness:
            pickScalar(incoming.judge_strictness, existing.judge_strictness) ?? "moderate",
        };
        const description = [
          ...merged.topics,
          ...merged.keywords,
          merged.vibes,
        ]
          .filter(Boolean)
          .join(", ");
        await updateFeed(feedId, { description, semantic_config: merged });
      } catch {
        // parsing failed, skip
      }
    }

    // Backward compat: check for old criteria format
    if (!configMatch) {
      const criteriaMatch = assistantText.match(
        /FEED_CRITERIA_JSON:\s*(\{[\s\S]*\})/
      );
      if (criteriaMatch) {
        try {
          const criteria = JSON.parse(criteriaMatch[1]);
          const semanticConfig: SemanticConfig = {
            topics: criteria.topics || [],
            keywords: criteria.keywords || [],
            exclude_topics: criteria.exclude_topics || [],
            exclude_keywords: criteria.exclude_keywords || [],
            vibes: criteria.vibes || "",
            embedding_threshold: 0.5,
            judge_enabled: true,
            judge_strictness: "moderate",
          };
          const description = [
            ...semanticConfig.topics,
            ...semanticConfig.keywords,
            semanticConfig.vibes,
          ]
            .filter(Boolean)
            .join(", ");
          await updateFeed(feedId, {
            description,
            semantic_config: semanticConfig,
          });
        } catch {
          // parsing failed, skip
        }
      }
    }

    // Check for done signal
    const isDone = /FEED_DONE/.test(assistantText);

    // Clean control lines out of the displayed message
    const cleanedText = assistantText
      .replace(/FEED_NAME:.+\n?/g, "")
      .replace(/FEED_CONFIG_JSON:\s*\{[\s\S]*?\}\s*\n?/g, "")
      .replace(/FEED_CRITERIA_JSON:\s*\{[\s\S]*?\}\s*\n?/g, "")
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
