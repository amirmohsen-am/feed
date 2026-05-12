import { Pool, type PoolClient, type QueryResult } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import type {
  MechanicalFilters,
  SemanticConfig,
} from "./types";
import { withFeedConfigDefaults } from "./defaults";
import { searchPosts } from "./vector-search";
import { getSecret } from "./secrets";

// --- Connection Pool ---
// We talk to Cloud SQL via @google-cloud/cloud-sql-connector in both local
// dev and on Cloud Run. The connector authenticates via ADC, fetches an
// ephemeral cert from the SQL Admin API, and opens a TLS tunnel directly to
// the instance — no IP allowlist, no `--add-cloudsql-instances` flag, no
// unix socket. Same code path everywhere.
//
// We still pull DATABASE_URL from Secret Manager so the password isn't
// hardcoded; we just parse the connection string and feed user/password/
// database to the pool, while the connector replaces the network stream.

const INSTANCE_CONNECTION_NAME =
  process.env.CLOUDSQL_CONNECTION_NAME ??
  "timelines-492720:us-central1:feed-db";

let _pool: Pool | null = null;
let _poolInit: Promise<Pool> | null = null;
let _connector: Connector | null = null;

export async function getPool(): Promise<Pool> {
  if (_pool) return _pool;
  if (_poolInit) return _poolInit;
  const init = (async () => {
    const dsn = await getSecret("database-url");
    const u = new URL(dsn);
    const user = decodeURIComponent(u.username);
    const password = decodeURIComponent(u.password);
    const database = u.pathname.replace(/^\//, "") || "postgres";

    _connector = new Connector();
    const clientOpts = await _connector.getOptions({
      instanceConnectionName: INSTANCE_CONNECTION_NAME,
      ipType: IpAddressTypes.PUBLIC,
    });

    const pool = new Pool({
      ...clientOpts,
      user,
      password,
      database,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on("error", (err) => {
      console.error("[pg] Unexpected pool error:", err.message);
    });
    _pool = pool;
    return pool;
  })();
  // Cache only successful inits — on rejection, clear so the next call retries.
  _poolInit = init;
  init.catch((err) => {
    console.error("[pg] pool init failed:", err?.code, err?.message ?? err);
    if (_poolInit === init) _poolInit = null;
  });
  return init;
}

export async function query(
  text: string,
  params?: unknown[]
): Promise<QueryResult> {
  const pool = await getPool();
  return pool.query(text, params);
}

export async function withClient<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// --- User ---

export interface DbUser {
  id: string; // UUID
  firebase_uid: string;
  name: string;
  email: string;
  photo_url: string | null;
  bluesky_handle: string | null;
  bluesky_did: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function upsertUser(params: {
  firebaseUid: string;
  name: string;
  email: string;
  photoUrl?: string;
  blueskyHandle?: string;
  blueskyDid?: string;
}): Promise<DbUser> {
  const res = await query(
    `INSERT INTO users (firebase_uid, name, email, photo_url, bluesky_handle, bluesky_did)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (firebase_uid) DO UPDATE SET
       name = EXCLUDED.name,
       email = EXCLUDED.email,
       photo_url = COALESCE(EXCLUDED.photo_url, users.photo_url),
       bluesky_handle = COALESCE(EXCLUDED.bluesky_handle, users.bluesky_handle),
       bluesky_did = COALESCE(EXCLUDED.bluesky_did, users.bluesky_did),
       updated_at = now()
     RETURNING *`,
    [
      params.firebaseUid,
      params.name,
      params.email,
      params.photoUrl ?? null,
      params.blueskyHandle ?? null,
      params.blueskyDid ?? null,
    ]
  );
  return res.rows[0];
}

export async function getUserByFirebaseUid(
  firebaseUid: string
): Promise<DbUser | null> {
  const res = await query("SELECT * FROM users WHERE firebase_uid = $1", [
    firebaseUid,
  ]);
  return res.rows[0] ?? null;
}

// --- Feeds ---

export interface DbFeed {
  id: number;
  user_id: string;
  name: string;
  description: string;
  mechanical_filters: MechanicalFilters;
  semantic_config: SemanticConfig;
  published_rkey: string | null;
  is_active: boolean;
  color: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DbFeedRow {
  id: number;
  user_id: string;
  name: string;
  description: string;
  mechanical_filters: MechanicalFilters | string;
  semantic_config: SemanticConfig | string;
  published_rkey: string | null;
  is_active: boolean;
  color: string | null;
  created_at: Date;
  updated_at: Date;
}

function parseJsonCol<T>(val: T | string): T {
  return typeof val === "string" ? JSON.parse(val) : val;
}

function rowToFeed(row: DbFeedRow): DbFeed {
  const config = withFeedConfigDefaults({
    mechanical: parseJsonCol(row.mechanical_filters),
    semantic: parseJsonCol(row.semantic_config),
  });
  return {
    ...row,
    mechanical_filters: config.mechanical,
    semantic_config: config.semantic,
  };
}

export async function createFeed(
  userId: string,
  name: string = "Untitled"
): Promise<DbFeed> {
  const res = await query(
    `INSERT INTO feeds (user_id, name) VALUES ($1, $2) RETURNING *`,
    [userId, name]
  );
  return rowToFeed(res.rows[0]);
}

export async function getFeed(id: number): Promise<DbFeed | null> {
  const res = await query("SELECT * FROM feeds WHERE id = $1", [id]);
  return res.rows[0] ? rowToFeed(res.rows[0]) : null;
}

export async function getFeedForUser(
  id: number,
  userId: string
): Promise<DbFeed | null> {
  const res = await query(
    "SELECT * FROM feeds WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return res.rows[0] ? rowToFeed(res.rows[0]) : null;
}

export async function listFeedsForUser(userId: string): Promise<DbFeed[]> {
  const res = await query(
    "SELECT * FROM feeds WHERE user_id = $1 ORDER BY updated_at DESC",
    [userId]
  );
  return res.rows.map(rowToFeed);
}

export async function getFeedByRkey(rkey: string): Promise<DbFeed | null> {
  const res = await query(
    "SELECT * FROM feeds WHERE published_rkey = $1",
    [rkey]
  );
  return res.rows[0] ? rowToFeed(res.rows[0]) : null;
}

export async function getActiveFeeds(): Promise<DbFeed[]> {
  const res = await query(
    "SELECT * FROM feeds WHERE is_active = true ORDER BY id"
  );
  return res.rows.map(rowToFeed);
}

export async function updateFeed(
  id: number,
  updates: {
    name?: string;
    description?: string;
    mechanical_filters?: MechanicalFilters;
    semantic_config?: SemanticConfig;
    published_rkey?: string;
    is_active?: boolean;
    color?: string;
  }
): Promise<DbFeed | null> {
  const feed = await getFeed(id);
  if (!feed) return null;

  const res = await query(
    `UPDATE feeds SET
       name = $1, description = $2,
       mechanical_filters = $3, semantic_config = $4,
       published_rkey = $5, is_active = $6, color = $7,
       updated_at = now()
     WHERE id = $8 RETURNING *`,
    [
      updates.name ?? feed.name,
      updates.description ?? feed.description,
      JSON.stringify(updates.mechanical_filters ?? feed.mechanical_filters),
      JSON.stringify(updates.semantic_config ?? feed.semantic_config),
      updates.published_rkey ?? feed.published_rkey,
      updates.is_active ?? feed.is_active,
      updates.color ?? feed.color,
      id,
    ]
  );
  return res.rows[0] ? rowToFeed(res.rows[0]) : null;
}

export async function deleteFeed(id: number): Promise<void> {
  await query("DELETE FROM chat_messages WHERE feed_id = $1", [id]);
  await query("DELETE FROM feeds WHERE id = $1", [id]);
}

// --- Posts ---
// Posts come from a Vertex AI Vector Search index of Bluesky Jetstream
// (the index lives in `amir-experimental`, fed by happy-feed's worker).
// We embed the feed's name + topics + keywords + vibes with Gemini and
// query the index directly — see src/lib/vector-search.ts.

function buildSearchQuery(feed: DbFeed): string {
  const sc = feed.semantic_config || ({} as SemanticConfig);
  const parts: string[] = [];
  if (feed.name && feed.name !== "New Feed" && feed.name !== "Untitled") {
    parts.push(feed.name);
  }
  if (sc.topics && sc.topics.length > 0) {
    parts.push(`Topics: ${sc.topics.join(", ")}`);
  }
  if (sc.keywords && sc.keywords.length > 0) {
    parts.push(`Keywords: ${sc.keywords.join(", ")}`);
  }
  if (sc.vibes) {
    parts.push(sc.vibes);
  }
  return parts.join(". ").trim();
}

export async function getFeedPreviewPosts(
  feedId: number,
  limit: number = 25
): Promise<
  {
    uri: string;
    text: string;
    author_did: string;
    score: number;
    indexed_at: string;
  }[]
> {
  const t0 = performance.now();
  const feedRes = await query("SELECT * FROM feeds WHERE id = $1", [feedId]);
  if (feedRes.rows.length === 0) return [];
  const feed = rowToFeed(feedRes.rows[0]);
  const tFeed = performance.now();

  const queryText = buildSearchQuery(feed);
  if (!queryText) return [];

  const filter = feed.mechanical_filters?.lang_allow?.length
    ? { lang: feed.mechanical_filters.lang_allow }
    : undefined;

  try {
    const hits = await searchPosts({ query: queryText, k: limit, filter });
    const tSearch = performance.now();
    console.log(
      `[timing] getFeedPreviewPosts feed-lookup=${(tFeed - t0).toFixed(0)}ms ` +
        `searchPosts=${(tSearch - tFeed).toFixed(0)}ms ` +
        `total=${(tSearch - t0).toFixed(0)}ms feedId=${feedId} hits=${hits.length}`
    );
    return hits.map((h) => ({
      uri: h.uri,
      text: h.text,
      author_did: h.did,
      score: h.vector_score,
      indexed_at: h.created_at,
    }));
  } catch (e) {
    // Vertex unreachable / IAM issue. Surface as empty so the UI shows its
    // "no posts yet" state instead of a 500.
    console.warn(
      "[vector-search] search failed:",
      e instanceof Error ? e.message : String(e)
    );
    return [];
  }
}

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

// --- Mailing list ---

export async function addSubscriber(email: string): Promise<{ created: boolean }> {
  const res = await query(
    `INSERT INTO subscribers (email) VALUES ($1)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [email]
  );
  return { created: res.rowCount === 1 };
}
