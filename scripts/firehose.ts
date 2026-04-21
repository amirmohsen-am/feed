import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import WebSocket from "ws";
import {
  getPreferences,
  insertPost,
  pruneOldPosts,
  type FeedCriteria,
  DEFAULT_CRITERIA,
} from "../src/lib/db";
import { keywordScore, aiScoreBatch } from "../src/lib/filter";

const JETSTREAM_URL =
  "wss://jetstream1.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post";

let criteria: FeedCriteria = DEFAULT_CRITERIA;
let pendingPosts: { uri: string; cid: string; did: string; text: string }[] =
  [];

// Sample random posts for AI scoring even without keyword hits.
// For niche topics, keyword matching alone misses most relevant posts.
const RANDOM_SAMPLE_RATE = 0.02; // 2% of all posts get AI-scored
const MAX_PENDING = 100; // cap the queue

function refreshPreferences() {
  const prefs = getPreferences();
  criteria = prefs.criteria;
  const hasContent =
    criteria.topics.length > 0 || criteria.keywords.length > 0;
  console.log(
    hasContent
      ? `[prefs] Topics: ${criteria.topics.join(", ")} | Keywords: ${criteria.keywords.join(", ")}`
      : "[prefs] No criteria set yet — all posts will be skipped"
  );
}

async function processBatch() {
  if (pendingPosts.length === 0) return;

  const batch = pendingPosts.splice(0, 20);
  const candidates = batch.map((p) => ({ uri: p.uri, text: p.text }));

  try {
    const aiScores = await aiScoreBatch(candidates, criteria);

    let inserted = 0;
    for (const post of batch) {
      const score = aiScores.get(post.uri) ?? 0;
      if (score >= 0.3) {
        insertPost(post.uri, post.cid, post.did, post.text, score);
        inserted++;
        console.log(
          `[insert] score=${score.toFixed(2)} "${post.text.slice(0, 100)}"`
        );
      }
    }
    if (batch.length > 0) {
      console.log(
        `[batch] Scored ${batch.length}, inserted ${inserted}`
      );
    }
  } catch (e) {
    console.error("[batch] AI scoring error:", e);
    for (const post of batch) {
      const ks = keywordScore(post.text, criteria);
      if (ks >= 0.5) {
        insertPost(post.uri, post.cid, post.did, post.text, ks);
      }
    }
  }
}

function connect() {
  console.log("[firehose] Connecting to Jetstream...");
  const ws = new WebSocket(JETSTREAM_URL);

  ws.on("open", () => {
    console.log("[firehose] Connected");
  });

  let seen = 0;
  let kwMatched = 0;
  let sampled = 0;

  ws.on("message", (data: Buffer) => {
    try {
      const event = JSON.parse(data.toString());

      if (
        event.kind !== "commit" ||
        event.commit?.operation !== "create" ||
        event.commit?.collection !== "app.bsky.feed.post"
      ) {
        return;
      }

      const record = event.commit.record;
      if (!record?.text) return;

      const text: string = record.text;
      // Skip very short posts (usually noise)
      if (text.length < 20) return;
      // Only English-ish posts for now (skip if langs specified and no 'en')
      const langs: string[] = record.langs || [];
      if (langs.length > 0 && !langs.some((l: string) => l.startsWith("en"))) return;

      seen++;
      const uri = `at://${event.did}/app.bsky.feed.post/${event.commit.rkey}`;
      const cid: string = event.commit.cid;

      if (pendingPosts.length >= MAX_PENDING) return;

      // Keyword pre-filter
      const ks = keywordScore(text, criteria);
      if (ks < 0) return; // Excluded

      if (ks > 0) {
        // Keyword match — always send to AI
        kwMatched++;
        pendingPosts.push({ uri, cid, did: event.did, text });
      } else if (Math.random() < RANDOM_SAMPLE_RATE) {
        // Random sample — let AI find relevant posts keywords would miss
        sampled++;
        pendingPosts.push({ uri, cid, did: event.did, text });
      }
    } catch {
      // Skip malformed events
    }
  });

  setInterval(() => {
    if (seen > 0) {
      console.log(
        `[stats] ${seen} posts seen (en), ${kwMatched} keyword-matched, ${sampled} random-sampled, ${pendingPosts.length} pending`
      );
      seen = 0;
      kwMatched = 0;
      sampled = 0;
    }
  }, 10_000);

  ws.on("close", () => {
    console.log("[firehose] Disconnected, reconnecting in 5s...");
    setTimeout(connect, 5000);
  });

  ws.on("error", (err) => {
    console.error("[firehose] Error:", err.message);
    ws.close();
  });
}

// Main
console.log("[feed-curator] Starting firehose subscriber...");
refreshPreferences();

// Refresh preferences every 30 seconds
setInterval(refreshPreferences, 30_000);

// Process AI scoring batches every 3 seconds
setInterval(processBatch, 3_000);

// Prune old posts every hour
setInterval(() => pruneOldPosts(10_000), 3600_000);

connect();
