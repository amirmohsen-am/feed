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

    for (const post of batch) {
      const score = aiScores.get(post.uri) ?? 0;
      if (score >= 0.5) {
        insertPost(post.uri, post.cid, post.did, post.text, score);
      }
    }
  } catch (e) {
    console.error("[batch] AI scoring error:", e);
    // Fallback: insert high keyword-score posts
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
      const uri = `at://${event.did}/app.bsky.feed.post/${event.commit.rkey}`;
      const cid: string = event.commit.cid;

      // Quick keyword pre-filter
      const ks = keywordScore(text, criteria);
      if (ks < 0) return; // Excluded
      if (ks === 0 && criteria.topics.length > 0) return; // No match at all

      pendingPosts.push({ uri, cid, did: event.did, text });
    } catch {
      // Skip malformed events
    }
  });

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

// Process AI scoring batches every 5 seconds
setInterval(processBatch, 5_000);

// Prune old posts every hour
setInterval(() => pruneOldPosts(10_000), 3600_000);

connect();
