import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "feed.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    migrate(_db);
  }
  return _db;
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feed_preferences (
      id INTEGER PRIMARY KEY DEFAULT 1,
      description TEXT NOT NULL DEFAULT '',
      criteria TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (id = 1)
    );

    CREATE TABLE IF NOT EXISTS posts (
      uri TEXT PRIMARY KEY,
      cid TEXT NOT NULL,
      author_did TEXT NOT NULL,
      text TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_posts_score ON posts(score DESC, indexed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_indexed ON posts(indexed_at DESC);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT OR IGNORE INTO feed_preferences (id, description, criteria) VALUES (1, '', '{}');
  `);
}

// --- Feed Preferences ---

export interface FeedCriteria {
  topics: string[];
  keywords: string[];
  exclude_topics: string[];
  exclude_keywords: string[];
  vibes: string; // free-text description of the "vibe" the user wants
}

export const DEFAULT_CRITERIA: FeedCriteria = {
  topics: [],
  keywords: [],
  exclude_topics: [],
  exclude_keywords: [],
  vibes: "",
};

export function getPreferences(): {
  description: string;
  criteria: FeedCriteria;
} {
  const db = getDb();
  const row = db
    .prepare("SELECT description, criteria FROM feed_preferences WHERE id = 1")
    .get() as { description: string; criteria: string } | undefined;
  if (!row) return { description: "", criteria: DEFAULT_CRITERIA };
  return {
    description: row.description,
    criteria: JSON.parse(row.criteria) as FeedCriteria,
  };
}

export function updatePreferences(
  description: string,
  criteria: FeedCriteria
) {
  const db = getDb();
  db.prepare(
    `UPDATE feed_preferences SET description = ?, criteria = ?, updated_at = datetime('now') WHERE id = 1`
  ).run(description, JSON.stringify(criteria));
}

// --- Posts ---

export function insertPost(
  uri: string,
  cid: string,
  authorDid: string,
  text: string,
  score: number
) {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO posts (uri, cid, author_did, text, score, indexed_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(uri, cid, authorDid, text, score);
}

export function getFeedPosts(
  limit: number = 50,
  cursor?: string
): { uri: string; indexed_at: string }[] {
  const db = getDb();
  if (cursor) {
    return db
      .prepare(
        `SELECT uri, indexed_at FROM posts
         WHERE indexed_at < ? ORDER BY score DESC, indexed_at DESC LIMIT ?`
      )
      .all(cursor, limit) as { uri: string; indexed_at: string }[];
  }
  return db
    .prepare(
      `SELECT uri, indexed_at FROM posts ORDER BY score DESC, indexed_at DESC LIMIT ?`
    )
    .all(limit) as { uri: string; indexed_at: string }[];
}

export function pruneOldPosts(keepCount: number = 10000) {
  const db = getDb();
  db.prepare(
    `DELETE FROM posts WHERE uri NOT IN (
      SELECT uri FROM posts ORDER BY indexed_at DESC LIMIT ?
    )`
  ).run(keepCount);
}

// --- Chat Messages ---

export function getChatMessages(): { role: string; content: string }[] {
  const db = getDb();
  return db
    .prepare("SELECT role, content FROM chat_messages ORDER BY id ASC")
    .all() as { role: string; content: string }[];
}

export function addChatMessage(role: "user" | "assistant", content: string) {
  const db = getDb();
  db.prepare("INSERT INTO chat_messages (role, content) VALUES (?, ?)").run(
    role,
    content
  );
}

export function clearChat() {
  const db = getDb();
  db.prepare("DELETE FROM chat_messages").run();
}
