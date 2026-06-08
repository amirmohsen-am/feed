import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth } from "@/lib/auth";
import { ensureEnvFromSecret } from "@/lib/secrets";
import { createFeed, updateFeed, addChatMessage } from "@/lib/pg";
import type { FeedPreviewPost } from "@/lib/pg";
import { searchPosts } from "@/lib/vector-search";
import { withMechanicalDefaults, DEFAULT_CANDIDATE_BUDGET } from "@/lib/defaults";
import type { MechanicalFilters } from "@/lib/types";
import type { Stats } from "@/lib/introspect/types";

export const runtime = "nodejs";
export const maxDuration = 30;

let _client: Anthropic | null = null;
async function client(): Promise<Anthropic> {
  if (_client) return _client;
  await ensureEnvFromSecret("anthropic-api-key");
  _client = new Anthropic();
  return _client;
}

interface Answer {
  questionId: string;
  selectedOptions: string[];
  freeText: string | null;
}

interface AnalyzeRequest {
  answers: Answer[];
  stats: Stats | null;
  topAccounts: Array<{ handle: string; total: number }>;
  handle: string | null;
}

const SYSTEM_PROMPT = `You are a feed curator translating a user's taste into a Bluesky feed configuration.

Given the user's answers to onboarding questions (and optionally their Bluesky engagement data), create a feed config.

SUBQUERIES: 2-4 short topical queries (5-15 words each) that drive ANN vector search over Bluesky posts. Each is a single distinct intent. Specific, not generic.
- GOOD: "personal essays on AI's effect on creative work"
- GOOD: "long-form posts about transformer interpretability research"
- BAD: "AI" (too sparse) or "I want thoughtful AI takes" (embeds the frame, not the content)

RERANK PROMPT: 3-6 sentence editorial filter applied after vector search. Captures what to favor / drop / the vibe — not the topic. Leave empty if the user's preferences are purely topical.

MECHANICAL FILTERS: Only set lang_allow if the user indicated a language preference. Leave everything else at defaults.

NAME: A short, evocative 2-4 word feed name. Not generic like "My Feed" — something that captures the vibe.`;

export async function POST(req: NextRequest) {
  const authResult = await requireAuth();
  const { userId } = authResult;

  let body: AnalyzeRequest;
  try {
    body = (await req.json()) as AnalyzeRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { answers, stats, topAccounts, handle } = body;

  // Build the user context for Claude
  let userMessage = "Here are the user's onboarding answers:\n\n";
  for (const a of answers) {
    userMessage += `Question ${a.questionId}:\n`;
    if (a.selectedOptions.length > 0) {
      userMessage += `  Selected: ${a.selectedOptions.join(", ")}\n`;
    }
    if (a.freeText) {
      userMessage += `  Free text: "${a.freeText}"\n`;
    }
    userMessage += "\n";
  }

  if (stats && handle) {
    const topTypes = Object.entries(stats.byType)
      .sort(([, a], [, b]) => b.count - a.count)
      .map(([type, { count }]) => `${type}: ${count}`)
      .join(", ");
    const topHandles = topAccounts
      .slice(0, 5)
      .map((a) => `@${a.handle} (${a.total})`)
      .join(", ");

    userMessage += `\nBluesky engagement context (@${handle}):
- ${stats.total} engagements over ${stats.spanDays} days
- Breakdown: ${topTypes}
- Top accounts: ${topHandles}\n`;
  }

  userMessage += "\nGenerate the feed configuration now.";

  try {
    const c = await client();
    const response = await c.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
      tools: [
        {
          name: "create_feed_config",
          description: "Create the feed configuration",
          input_schema: {
            type: "object" as const,
            properties: {
              name: {
                type: "string",
                description: "Short 2-4 word feed name",
              },
              subqueries: {
                type: "array",
                items: { type: "string" },
                description: "2-4 vector search queries, 5-15 words each",
              },
              rerank_prompt: {
                type: "string",
                description:
                  "3-6 sentence editorial filter, or empty string if purely topical",
              },
              mechanical_filters: {
                type: "object",
                properties: {
                  lang_allow: {
                    type: "array",
                    items: { type: "string" },
                    description: "Language codes, e.g. ['en']",
                  },
                },
                description: "Only set lang_allow if user indicated preference",
              },
            },
            required: ["name", "subqueries", "rerank_prompt"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "create_feed_config" },
    });

    const toolBlock = response.content.find((b) => b.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") {
      return NextResponse.json(
        { error: "Failed to generate feed config" },
        { status: 500 }
      );
    }

    const config = toolBlock.input as {
      name: string;
      subqueries: string[];
      rerank_prompt: string;
      mechanical_filters?: { lang_allow?: string[] };
    };

    // Create the feed in Postgres
    const feed = await createFeed(userId, config.name);

    const mechFilters = withMechanicalDefaults({
      ...(config.mechanical_filters?.lang_allow?.length
        ? { lang_allow: config.mechanical_filters.lang_allow }
        : {}),
    });

    await updateFeed(feed.id, {
      subqueries: config.subqueries,
      rerank_prompt: config.rerank_prompt,
      mechanical_filters: mechFilters,
    });

    // Seed the chat with a summary message
    const summaryMsg = `I've set up your feed "${config.name}" based on your onboarding answers. It's searching for:\n\n${config.subqueries.map((q, i) => `${i + 1}. ${q}`).join("\n")}${config.rerank_prompt ? `\n\nI've also added an editorial filter to fine-tune results. You can adjust any of this — just tell me what you'd like to change.` : "\n\nTell me if you'd like to adjust the topics or add any filters."}`;

    await addChatMessage(feed.id, "assistant", summaryMsg);

    // Run initial vector search for preview (no rerank for speed)
    let previewPosts: FeedPreviewPost[] = [];
    try {
      const hits = await searchPosts({
        subqueries: config.subqueries,
        totalBudget: DEFAULT_CANDIDATE_BUDGET,
        filter: {
          lang: mechFilters.lang_allow.length ? mechFilters.lang_allow : undefined,
          selfLabelsDeny: mechFilters.block_labels,
          excludeLikelyNsfw: mechFilters.exclude_likely_nsfw,
        },
      });

      previewPosts = hits.slice(0, 8).map((h) => ({
        uri: h.uri,
        text: h.text,
        author_did: h.did,
        author_handle: h.author_handle,
        author_display_name: h.author_display_name,
        author_avatar_cid: h.author_avatar_cid,
        score: h.vector_score,
        like_nsfw: h.like_nsfw,
        indexed_at: h.created_at,
        like_count: h.like_count ?? 0,
        repost_count: h.repost_count ?? 0,
        reply_count: h.reply_count ?? 0,
        quote_count: h.quote_count ?? 0,
        external_uri: h.external_uri,
        external_title: h.external_title,
        external_desc: h.external_desc,
        external_thumb: h.external_thumb,
        quote_uri: h.quote_uri,
        has_images: h.has_images,
        image_count: h.image_count,
        image_alts: h.image_alts,
        image_urls: h.image_urls ?? [],
        is_reply: h.is_reply,
        reply_parent_uri: h.reply_parent_uri,
      }));
    } catch (e) {
      console.warn("[onboarding/analyze] Vector search failed:", e);
      // Continue without preview — user will see posts when they enter the curator
    }

    return NextResponse.json({
      feed: {
        id: feed.id,
        name: config.name,
        subqueries: config.subqueries,
      },
      previewPosts,
    });
  } catch (e) {
    console.error("[onboarding/analyze] Failed:", e);
    return NextResponse.json(
      { error: "Failed to create feed" },
      { status: 500 }
    );
  }
}
