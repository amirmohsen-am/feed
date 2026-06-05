import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth, isAuthError } from "@/lib/auth";
import { getFeedForUser } from "@/lib/pg";
import { hydratePostByUri } from "@/lib/vector-search";
import { ensureEnvFromSecret } from "@/lib/secrets";
import { composeSourcePostText, type BranchOption } from "@/lib/branch";

let _client: Anthropic | null = null;
async function client(): Promise<Anthropic> {
  if (_client) return _client;
  await ensureEnvFromSecret("anthropic-api-key");
  _client = new Anthropic();
  return _client;
}

const SYSTEM_PROMPT = `You help someone branch off from a single Bluesky post into a new feed — a deliberate fork of their attention, not an algorithmic rabbit hole.

You are given (1) the post that caught their eye and (2) the feed they are currently reading. Propose 3-5 distinct topical directions to branch into. Each is a SUBQUERY — a 5-15 word query that will drive vector search over Bluesky posts (specific, not generic; embeds the content, not the frame).

Rules:
- DIVERGE from the current feed. Do NOT restate or lightly reword its existing subqueries — the point is a new direction, not more of the same.
- Mix two kinds: "deeper" (narrow into a specific sub-thread of THIS post) and "adjacent" (a related direction the current feed does not already cover).
- Each option gets a short 2-4 word human label for a chip.
- Ground every option in something real about the post (its topic, the linked article, the image, the argument it makes) — not generic categories.

Call propose_branches with your options. No prose.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "propose_branches",
    description:
      "Return 3-5 distinct branch directions derived from the post + current feed.",
    input_schema: {
      type: "object",
      required: ["options"],
      properties: {
        options: {
          type: "array",
          minItems: 3,
          maxItems: 5,
          items: {
            type: "object",
            required: ["label", "subquery", "kind"],
            properties: {
              label: { type: "string", description: "2-4 word chip label" },
              subquery: {
                type: "string",
                description: "5-15 word vector-search query, specific",
              },
              kind: { type: "string", enum: ["deeper", "adjacent"] },
            },
          },
        },
      },
    },
  },
];

export async function POST(req: NextRequest) {
  const t0 = performance.now();
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  try {
    const { feedId, postUri } = await req.json();
    if (!feedId || typeof postUri !== "string" || !postUri) {
      return NextResponse.json(
        { error: "feedId and postUri required" },
        { status: 400 }
      );
    }

    // Parent feed gives us the "diverge from this" context + ownership check.
    const feed = await getFeedForUser(feedId, auth.userId);
    if (!feed) {
      return NextResponse.json({ error: "Feed not found" }, { status: 404 });
    }

    const post = await hydratePostByUri(postUri);
    if (!post) {
      return NextResponse.json({ error: "Post not found" }, { status: 404 });
    }

    const userBlock =
      `CURRENT FEED\n` +
      `Name: ${feed.name}\n` +
      `Subqueries: ${JSON.stringify(feed.subqueries)}\n\n` +
      `THE POST THEY BRANCHED FROM\n${composeSourcePostText(post)}`;

    const tBeforeLLM = performance.now();
    const response = await (await client()).messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      tool_choice: { type: "tool", name: "propose_branches" },
      messages: [{ role: "user", content: userBlock }],
    });
    const tAfterLLM = performance.now();

    let options: BranchOption[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "propose_branches") {
        const args = block.input as { options?: unknown };
        if (Array.isArray(args.options)) {
          options = args.options
            .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
            .map((o): BranchOption => ({
              label: typeof o.label === "string" ? o.label.trim() : "",
              subquery: typeof o.subquery === "string" ? o.subquery.trim() : "",
              kind: o.kind === "deeper" ? "deeper" : "adjacent",
            }))
            .filter((o) => o.label.length > 0 && o.subquery.length > 0)
            .slice(0, 5);
        }
      }
    }

    if (options.length === 0) {
      return NextResponse.json(
        { error: "No branch options generated" },
        { status: 502 }
      );
    }

    console.log(
      `[timing] POST /api/branch/options llm=${(tAfterLLM - tBeforeLLM).toFixed(0)}ms ` +
        `total=${(performance.now() - t0).toFixed(0)}ms feedId=${feedId} options=${options.length}`
    );

    return NextResponse.json({ options });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal error";
    console.error("Branch options API error:", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
