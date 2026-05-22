import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth, isAuthError } from "@/lib/auth";
import { createFeed, updateFeed } from "@/lib/pg";
import { ensureEnvFromSecret } from "@/lib/secrets";

let _client: Anthropic | null = null;
async function client(): Promise<Anthropic> {
  if (_client) return _client;
  await ensureEnvFromSecret("anthropic-api-key");
  _client = new Anthropic();
  return _client;
}

const SYSTEM = `You analyze AI assistant memory exports (from ChatGPT, Claude, etc.) and extract a Bluesky feed config.

Call extract_feed_config exactly once with:
- name: 2-4 word feed name capturing their main interests
- subqueries: 1-4 short topical queries (5-15 words each) describing the kind of Bluesky posts they'd enjoy

Rules for subqueries:
- Each is a single distinct intent; merge overlapping ones.
- Slightly richer than a keyword list. Specific, not generic.
  - GOOD: "personal essays on AI's effect on creative work"
  - GOOD: "indie game developer postmortems and design discussions"
  - BAD: "AI" (too sparse) or "I want thoughtful AI takes" (embeds the frame)
- If the memory mentions a job or field, include a subquery for that domain.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "extract_feed_config",
    description: "Emit the extracted feed name and subqueries.",
    input_schema: {
      type: "object",
      required: ["name", "subqueries"],
      properties: {
        name: { type: "string" },
        subqueries: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 4,
        },
      },
    },
  },
];

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const { memoryText, source } = await req.json();

  if (!memoryText || typeof memoryText !== "string") {
    return NextResponse.json({ error: "memoryText required" }, { status: 400 });
  }

  const response = await (await client()).messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM,
    tools: TOOLS,
    tool_choice: { type: "tool", name: "extract_feed_config" },
    messages: [
      {
        role: "user",
        content: `Memory export from ${source || "an AI assistant"}:\n\n${memoryText.slice(0, 8000)}`,
      },
    ],
  });

  const call = response.content.find((b) => b.type === "tool_use");
  if (!call || call.type !== "tool_use") {
    return NextResponse.json(
      { error: "Could not extract preferences from memory" },
      { status: 422 }
    );
  }

  const args = call.input as { name?: unknown; subqueries?: unknown };
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : "From AI Memory";
  const subqueries = Array.isArray(args.subqueries)
    ? args.subqueries
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .slice(0, 4)
    : [];

  if (subqueries.length === 0) {
    return NextResponse.json(
      { error: "No usable subqueries extracted" },
      { status: 422 }
    );
  }

  const feed = await createFeed(auth.userId, name);
  const updated = await updateFeed(feed.id, { name, subqueries });
  return NextResponse.json({ feed: updated ?? feed });
}
