import Anthropic from "@anthropic-ai/sdk";
import type { FeedCriteria } from "./db";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * Fast keyword-based pre-filter. Returns a rough score 0-1.
 * Posts scoring > 0 are candidates for AI refinement.
 */
export function keywordScore(text: string, criteria: FeedCriteria): number {
  const lower = text.toLowerCase();

  // Hard exclude
  for (const kw of criteria.exclude_keywords) {
    if (lower.includes(kw.toLowerCase())) return -1;
  }
  for (const topic of criteria.exclude_topics) {
    if (lower.includes(topic.toLowerCase())) return -1;
  }

  let score = 0;
  let maxPossible = 0;

  // Topic matches (weighted higher)
  for (const topic of criteria.topics) {
    maxPossible += 2;
    if (lower.includes(topic.toLowerCase())) score += 2;
  }

  // Keyword matches
  for (const kw of criteria.keywords) {
    maxPossible += 1;
    if (lower.includes(kw.toLowerCase())) score += 1;
  }

  if (maxPossible === 0) return 0;
  return score / maxPossible;
}

/**
 * AI-based scoring for posts that pass the keyword pre-filter.
 * Batches posts for efficiency. Returns scores 0-1 for each post.
 */
export async function aiScoreBatch(
  posts: { uri: string; text: string }[],
  criteria: FeedCriteria
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (posts.length === 0) return scores;

  const numbered = posts
    .map((p, i) => `[${i}] ${p.text.slice(0, 300)}`)
    .join("\n\n");

  const prompt = `You are scoring social media posts for a custom feed. The user wants:

Topics: ${criteria.topics.join(", ") || "none specified"}
Keywords: ${criteria.keywords.join(", ") || "none specified"}
Exclude: ${[...criteria.exclude_topics, ...criteria.exclude_keywords].join(", ") || "nothing"}
Vibe: ${criteria.vibes || "not specified"}

Score each post from 0.0 (completely irrelevant) to 1.0 (perfect match).
Consider topic relevance, quality signals, and the desired vibe.

Posts:
${numbered}

Respond with ONLY a JSON array of numbers, one score per post. Example: [0.8, 0.2, 0.95]`;

  try {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "[]";
    const match = text.match(/\[[\d\s.,]+\]/);
    if (match) {
      const parsed = JSON.parse(match[0]) as number[];
      posts.forEach((p, i) => {
        scores.set(p.uri, parsed[i] ?? 0);
      });
    }
  } catch (e) {
    console.error("AI scoring failed, using keyword scores:", e);
  }

  return scores;
}
