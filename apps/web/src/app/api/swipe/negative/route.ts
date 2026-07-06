import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth, isAuthError } from "@/lib/auth";
import { gateGuard } from "@/lib/account-gate";
import { enforceRateLimit, LLM_RULES } from "@/lib/rate-limit";
import { jsonError } from "@/lib/api";
import { hydratePostByUri } from "@/lib/vector-search";
import { ensureEnvFromSecret } from "@/lib/secrets";
import { composeSourcePostText, type NegativeTopic } from "@/lib/branch";
import { getFeedForUser } from "@/lib/pg";

let _client: Anthropic | null = null;
async function client(): Promise<Anthropic> {
  if (_client) return _client;
  await ensureEnvFromSecret("anthropic-api-key");
  _client = new Anthropic();
  return _client;
}

const SYSTEM_PROMPT = `You are helping a user curate their Bluesky feed. They swiped away a post — extract 3-5 distinct features describing what they likely want less of.

You are given the feed's current topics (what they DO want) and the post they rejected. Use the feed context to reason about the mismatch: is the post off-topic entirely, or does it hit a sub-aspect of the feed's topics they want to avoid?

Think broadly across all feature types — any of these may be relevant:
- Subject matter or topic
- Framing or angle (e.g. hot takes, contrarianism, dunking)
- Emotional register (outrage bait, doom, hype, self-promotion)
- Content type (link posts, image-only, threads, quote-posts)
- Writing style or rhetorical pattern
- Account type or poster behavior

For each feature, write a full description of what the user likely wants less of, then compress it to a short 2-5 word pill label for display.

Rules:
- Be specific to THIS post — not generic categories that apply to everything.
- Each feature should be distinct — don't extract variations of the same thing.
- Prefer features a feed-tuning agent can act on (avoid e.g. "low follower count").
- No prose. Call negative_feature_extraction with your features.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "negative_feature_extraction",
    description: "Return 3-5 distinct features describing what the user wants to see less of.",
    input_schema: {
      type: "object",
      required: ["features"],
      properties: {
        features: {
          type: "array",
          minItems: 3,
          maxItems: 5,
          items: {
            type: "object",
            required: ["label", "description"],
            properties: {
              label: { type: "string", description: "2-5 word pill label for display" },
              description: { type: "string", description: "Full description of the feature, sent to the feed-tuning agent" },
            },
          },
        },
      },
    },
  },
];

export async function POST(req: NextRequest) {
  const limited = enforceRateLimit(req, "swipe-negative", LLM_RULES);
  if (limited) return limited;
  const t0 = performance.now();
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;
  const walled = await gateGuard(auth.userId);
  if (walled) return walled;

  try {
    const { feedId, postUri } = await req.json();
    if (typeof postUri !== "string" || !postUri) {
      return NextResponse.json({ error: "postUri required" }, { status: 400 });
    }

    const [post, feed] = await Promise.all([
      hydratePostByUri(postUri),
      feedId ? getFeedForUser(feedId, auth.userId) : Promise.resolve(null),
    ]);

    if (!post) {
      return NextResponse.json({ error: "Post not found" }, { status: 404 });
    }

    const feedBlock = feed?.subqueries?.length
      ? `CURRENT FEED TOPICS\n${feed.subqueries.join("\n")}\n\n`
      : "";
    const userMessage = `${feedBlock}THE POST THEY SKIPPED\n${composeSourcePostText(post)}`;

    const tBeforeLLM = performance.now();
    const response = await (await client()).messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      tool_choice: { type: "tool", name: "negative_feature_extraction" },
      messages: [{ role: "user", content: userMessage }],
    });
    const tAfterLLM = performance.now();

    let topics: NegativeTopic[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "negative_feature_extraction") {
        const args = block.input as { features?: unknown };
        if (Array.isArray(args.features)) {
          topics = args.features
            .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
            .map((f) => ({
              label: typeof f.label === "string" ? f.label.trim() : "",
              description: typeof f.description === "string" ? f.description.trim() : "",
            }))
            .filter((f) => f.label.length > 0 && f.description.length > 0)
            .slice(0, 5);
        }
      }
    }

    if (topics.length === 0) {
      return NextResponse.json({ error: "No topics generated" }, { status: 502 });
    }

    console.log(
      `[timing] POST /api/swipe/negative llm=${(tAfterLLM - tBeforeLLM).toFixed(0)}ms ` +
        `total=${(performance.now() - t0).toFixed(0)}ms topics=${topics.length} stop=${response.stop_reason}`
    );

    return NextResponse.json({ topics });
  } catch (e) {
    return jsonError(e, "swipe/negative");
  }
}
