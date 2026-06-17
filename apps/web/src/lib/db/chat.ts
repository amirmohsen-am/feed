import { query } from "./connection";

// --- Chat Messages ---

export async function getChatMessages(
  feedId: number
): Promise<{ role: string; content: string }[]> {
  const res = await query(
    "SELECT role, content FROM chat_messages WHERE feed_id = $1 ORDER BY id ASC",
    [feedId]
  );
  return res.rows;
}

export async function addChatMessage(
  feedId: number,
  role: "user" | "assistant",
  content: string
): Promise<void> {
  await query(
    "INSERT INTO chat_messages (feed_id, role, content) VALUES ($1, $2, $3)",
    [feedId, role, content]
  );
}

export async function clearChat(feedId: number): Promise<void> {
  await query("DELETE FROM chat_messages WHERE feed_id = $1", [feedId]);
}
