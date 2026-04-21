import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import {
  getPreferences,
  updatePreferences,
  getChatMessages,
  addChatMessage,
  clearChat,
  type FeedCriteria,
} from "@/lib/db";

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a Bluesky feed curator assistant. Your job is to have a conversation with the user to understand what kind of posts they want to see in their custom Bluesky feed.

Ask clarifying questions to understand:
- What topics they're interested in
- What keywords or themes to look for
- What they want to EXCLUDE (topics, vibes, types of content)
- The general "vibe" they want (e.g., informative, funny, technical, casual)

Be conversational and helpful. Ask one or two questions at a time, don't overwhelm them.

When you feel you have a good understanding of their preferences (or they say they're done), output a JSON block with their structured preferences. Format it EXACTLY like this, on its own line:

FEED_CRITERIA_JSON:{"topics":["topic1","topic2"],"keywords":["kw1","kw2"],"exclude_topics":["bad1"],"exclude_keywords":["bad1"],"vibes":"description of the vibe"}

Important rules:
- Topics should be broad categories (e.g., "AI", "startups", "programming")
- Keywords should be specific terms to match (e.g., "LLM", "YC", "indie hacker")
- The vibes field is a free-text description used for AI scoring
- Only output the FEED_CRITERIA_JSON line when you're ready to save — not speculatively
- After outputting criteria, confirm to the user that their feed has been updated

Current saved preferences:
`;

export async function POST(req: NextRequest) {
  const { message, reset } = await req.json();

  if (reset) {
    clearChat();
    return NextResponse.json({ messages: [] });
  }

  if (!message || typeof message !== "string") {
    return NextResponse.json({ error: "Message required" }, { status: 400 });
  }

  addChatMessage("user", message);

  const prefs = getPreferences();
  const history = getChatMessages();

  const systemPrompt =
    SYSTEM_PROMPT +
    (prefs.description
      ? `\nDescription: "${prefs.description}"\nCriteria: ${JSON.stringify(prefs.criteria)}`
      : "\nNo preferences set yet — this is a fresh start.");

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: systemPrompt,
    messages: history.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  });

  const assistantText =
    response.content[0].type === "text" ? response.content[0].text : "";

  // Check if the assistant produced criteria
  const criteriaMatch = assistantText.match(
    /FEED_CRITERIA_JSON:(\{.*\})/
  );
  if (criteriaMatch) {
    try {
      const criteria = JSON.parse(criteriaMatch[1]) as FeedCriteria;
      const description = [
        ...criteria.topics,
        ...criteria.keywords,
        criteria.vibes,
      ]
        .filter(Boolean)
        .join(", ");
      updatePreferences(description, criteria);
    } catch {
      // If parsing fails, just save the message without updating criteria
    }
  }

  // Clean the criteria line out of the displayed message
  const cleanedText = assistantText
    .replace(/FEED_CRITERIA_JSON:\{.*\}\n?/, "")
    .trim();

  addChatMessage("assistant", cleanedText);

  const allMessages = getChatMessages();

  return NextResponse.json({
    messages: allMessages,
    preferences: getPreferences(),
  });
}

export async function GET() {
  return NextResponse.json({
    messages: getChatMessages(),
    preferences: getPreferences(),
  });
}
