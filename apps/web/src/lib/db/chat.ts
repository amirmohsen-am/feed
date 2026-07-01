import { query } from "./connection";
import type { FeedToolCall } from "../feed-tool-call";

// --- Chat Messages ---

export interface ChatMessageRow {
  id: number;
  role: string;
  content: string;
  // The turn's tool-call payload (assistant rows only). UI-only; never sent to
  // the model. See lib/feed-tool-call.ts.
  tool_calls: FeedToolCall | null;
}

export async function getChatMessages(feedId: number): Promise<ChatMessageRow[]> {
  const res = await query(
    "SELECT id, role, content, tool_calls FROM chat_messages WHERE feed_id = $1 ORDER BY id ASC",
    [feedId]
  );
  return res.rows;
}

export async function addChatMessage(
  feedId: number,
  role: "user" | "assistant",
  content: string,
  toolCalls?: FeedToolCall | null
): Promise<void> {
  await query(
    "INSERT INTO chat_messages (feed_id, role, content, tool_calls) VALUES ($1, $2, $3, $4)",
    [feedId, role, content, toolCalls ? JSON.stringify(toolCalls) : null]
  );
}

export async function clearChat(feedId: number): Promise<void> {
  await query("DELETE FROM chat_messages WHERE feed_id = $1", [feedId]);
}
