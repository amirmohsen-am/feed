import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth, isAuthError } from "@/lib/auth";
import { ensureEnvFromSecret } from "@/lib/secrets";
import type { Stats } from "@/lib/introspect/types";

export const runtime = "nodejs";
export const maxDuration = 15;

let _client: Anthropic | null = null;
async function client(): Promise<Anthropic> {
  if (_client) return _client;
  await ensureEnvFromSecret("anthropic-api-key");
  _client = new Anthropic();
  return _client;
}

interface QuestionRequest {
  stats: Stats | null;
  topAccountHandles: string[];
  handle: string | null;
}

interface GeneratedQuestion {
  id: string;
  text: string;
  options: string[];
  allowFreeText: boolean;
}

export async function POST(req: NextRequest) {
  const authResult = await requireAuth(req);
  if (isAuthError(authResult)) return authResult;

  let body: QuestionRequest;
  try {
    body = (await req.json()) as QuestionRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { stats, topAccountHandles, handle } = body;

  let contextBlock = "";
  if (stats && handle) {
    const topTypes = Object.entries(stats.byType)
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, 3)
      .map(([type, { count, pct }]) => `${type}: ${count} (${pct.toFixed(0)}%)`)
      .join(", ");

    const topAccounts = topAccountHandles.slice(0, 5).join(", ");

    contextBlock = `The user's Bluesky handle is @${handle}. Here's their engagement profile:
- Total engagements: ${stats.total} over ${stats.spanDays} days (${stats.avgPerDay.toFixed(1)}/day)
- Signal breakdown: ${topTypes}
- Top accounts they engage with: ${topAccounts}
- Avg quote length: ${stats.avgQuoteWords.toFixed(0)} words, avg reply length: ${stats.avgReplyWords.toFixed(0)} words
${stats.ratios.ownToConsumed !== null ? `- Own content vs consumed ratio: ${(stats.ratios.ownToConsumed * 100).toFixed(0)}%` : ""}`;
  }

  const systemPrompt = `You're a friend with great taste helping someone set up their feed. Ask 2-3 quick, casual questions to figure out what they'd actually enjoy reading.

${contextBlock ? `USER CONTEXT:\n${contextBlock}\n\nYou know their Bluesky habits — use that to skip the obvious stuff. Don't recite their stats back at them. Instead, ask about the WHY and the VIBE — what mood are they in when they scroll, what makes them stop and actually read something, what rabbit holes they fall into.` : "They haven't connected Bluesky, so you're starting from scratch. Ask fun, low-effort questions about what they gravitate toward — not a survey, more like a friend asking 'so what are you into lately?'"}

TONE:
- Warm, casual, zero jargon. Like texting a friend, not filling out a form.
- Questions should be SHORT — one sentence max. Easy to answer without thinking hard.
- Options should be vibes and feelings, not technical categories.
  BAD options: "AI alignment discourse", "Transformer interpretability research", "Climate policy analysis"
  GOOD options: "People arguing about whether AI will save or doom us", "Beautiful nature photography that makes you want to go outside", "Drama and hot takes you can't look away from"
- Options should feel like things a real person would say out loud
- Keep it to 3-4 options per question. Each option should be immediately understandable.
- The last question should always allow free text
- Generate 2 questions if you have engagement data, 3 if you don't`;

  try {
    const c = await client();
    const response = await c.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: "Generate the onboarding questions." }],
      tools: [
        {
          name: "generate_questions",
          description: "Output the onboarding questions",
          input_schema: {
            type: "object" as const,
            properties: {
              questions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "q1, q2, or q3" },
                    text: { type: "string", description: "The question text" },
                    options: {
                      type: "array",
                      items: { type: "string" },
                      description: "3-4 specific options",
                    },
                    allowFreeText: { type: "boolean" },
                  },
                  required: ["id", "text", "options", "allowFreeText"],
                },
              },
            },
            required: ["questions"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "generate_questions" },
    });

    const toolBlock = response.content.find((b) => b.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") {
      return NextResponse.json({ error: "No questions generated" }, { status: 500 });
    }

    const result = toolBlock.input as { questions: GeneratedQuestion[] };
    return NextResponse.json({ questions: result.questions });
  } catch (e) {
    console.error("[onboarding/questions] Claude call failed:", e);
    return NextResponse.json(
      { error: "Failed to generate questions" },
      { status: 500 }
    );
  }
}
