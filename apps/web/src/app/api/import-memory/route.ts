import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth, isAuthError } from "@/lib/auth";
import { createFeed, updateFeed } from "@/lib/pg";
import { ensureEnvFromSecret } from "@/lib/secrets";
import type { SemanticConfig } from "@/lib/types";

let _client: Anthropic | null = null;
async function client(): Promise<Anthropic> {
  if (_client) return _client;
  await ensureEnvFromSecret("anthropic-api-key");
  _client = new Anthropic();
  return _client;
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const { memoryText, source } = await req.json();

  if (!memoryText || typeof memoryText !== "string") {
    return NextResponse.json(
      { error: "memoryText required" },
      { status: 400 }
    );
  }

  const response = await (await client()).messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: `You analyze AI assistant memory exports (from ChatGPT or Claude) and extract the user's interests, profession, hobbies, and preferences to create a Bluesky feed.

From the memory text, output EXACTLY two lines:
FEED_NAME:<2-4 word name capturing their main interests>
FEED_CONFIG_JSON:{"topics":[...],"keywords":[...],"exclude_topics":[],"exclude_keywords":[],"vibes":"...","embedding_threshold":0.5,"judge_enabled":true,"judge_strictness":"moderate"}

Rules:
- topics: broad categories (3-6 items) based on what they care about
- keywords: specific terms, tools, names they'd want to see posts about (5-15 items)
- vibes: a sentence describing the tone/type of content they'd enjoy
- Be generous — extract everything that suggests an interest, even minor ones
- If the memory mentions their job/field, include related professional topics
- If there's not much to work with, do your best with what's there`,
    messages: [
      {
        role: "user",
        content: `Here's a memory export from ${source || "an AI assistant"}:\n\n${memoryText.slice(0, 8000)}`,
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  const nameMatch = text.match(/FEED_NAME:(.+)/);
  const configMatch = text.match(/FEED_CONFIG_JSON:(\{.*\})/);

  if (!configMatch) {
    return NextResponse.json(
      { error: "Could not extract preferences from memory" },
      { status: 422 }
    );
  }

  try {
    const semanticConfig = JSON.parse(configMatch[1]) as SemanticConfig;
    const name = nameMatch ? nameMatch[1].trim() : "From AI Memory";
    const description = [
      ...(semanticConfig.topics || []),
      ...(semanticConfig.keywords || []),
      semanticConfig.vibes,
    ]
      .filter(Boolean)
      .join(", ");

    const feed = await createFeed(auth.userId, name);
    await updateFeed(feed.id, { name, description, semantic_config: semanticConfig });

    return NextResponse.json({
      feed: { ...feed, name, description, semantic_config: semanticConfig },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to parse extracted config" },
      { status: 422 }
    );
  }
}
