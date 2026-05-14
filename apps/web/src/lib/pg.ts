import { Pool, type PoolClient, type QueryResult } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import type {
  MechanicalFilters,
  SemanticConfig,
} from "./types";
import { withFeedConfigDefaults } from "./defaults";
import { searchPosts, type SearchFilter } from "./vector-search";
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
// We embed the feed's topics + keywords + vibes with Gemini and
// query the index directly — see src/lib/vector-search.ts.

// Translate the LLM-controlled subset of MechanicalFilters into the Vertex
// restricts SearchFilter shape. `post_type` "all" leaves the reply restrict
// off so both replies and top-level posts come back.
function mechanicalToSearchFilter(m?: MechanicalFilters): SearchFilter | undefined {
  if (!m) return undefined;
  const f: SearchFilter = {};
  let any = false;
  if (m.lang_allow?.length) { f.lang = m.lang_allow; any = true; }
  if (m.post_type === "top_level") { f.isReply = false; any = true; }
  if (m.post_type === "replies") { f.isReply = true; any = true; }
  if (m.require_media) { f.hasImages = true; any = true; }
  else if (m.exclude_media) { f.hasImages = false; any = true; }
  if (m.require_video) { f.hasVideo = true; any = true; }
  else if (m.exclude_video) { f.hasVideo = false; any = true; }
  if (m.require_link) { f.hasExternalLink = true; any = true; }
  else if (m.exclude_links) { f.hasExternalLink = false; any = true; }
  if (m.require_quote) { f.hasQuote = true; any = true; }
  if (m.hashtag_include?.length) {
    f.hashtags = m.hashtag_include.map((t) => t.toLowerCase());
    any = true;
  }
  if (m.author_blocklist?.length) { f.didExclude = m.author_blocklist; any = true; }
  if (m.block_labels?.length) { f.selfLabelsDeny = m.block_labels; any = true; }
  if (m.min_like_count > 0) { f.minLikeCount = m.min_like_count; any = true; }
  if (m.min_repost_count > 0) { f.minRepostCount = m.min_repost_count; any = true; }
  if (m.min_reply_count > 0) { f.minReplyCount = m.min_reply_count; any = true; }

  // Time window. Preset windows ("1h"/"24h"/"7d"/"30d") compute a relative
  // lower bound from now. "custom" reads the two ISO timestamps and can set
  // both bounds. "all" / undefined → no time filter.
  const bounds = timeWindowToBounds(m);
  if (bounds.afterUs !== undefined) { f.createdAfterUs = bounds.afterUs; any = true; }
  if (bounds.beforeUs !== undefined) { f.createdBeforeUs = bounds.beforeUs; any = true; }

  return any ? f : undefined;
}

const PRESET_WINDOW_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function timeWindowToBounds(m: MechanicalFilters): {
  afterUs?: number;
  beforeUs?: number;
} {
  const window = m.time_window;
  if (!window || window === "all") return {};
  if (window === "custom") {
    const out: { afterUs?: number; beforeUs?: number } = {};
    if (m.created_after_iso) {
      const t = Date.parse(m.created_after_iso);
      if (!Number.isNaN(t)) out.afterUs = t * 1000;
    }
    if (m.created_before_iso) {
      const t = Date.parse(m.created_before_iso);
      if (!Number.isNaN(t)) out.beforeUs = t * 1000;
    }
    return out;
  }
  const delta = PRESET_WINDOW_MS[window];
  if (!delta) return {};
  return { afterUs: (Date.now() - delta) * 1000 };
}

function buildSearchQuery(feed: DbFeed): string {
  const sc = feed.semantic_config || ({} as SemanticConfig);
  const parts: string[] = [];
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

export interface FeedPreviewPost {
  uri: string;
  text: string;
  author_did: string;
  author_handle: string | null;
  author_display_name: string | null;
  author_avatar_cid: string | null;
  score: number;
  indexed_at: string;
  like_count: number;
  repost_count: number;
  reply_count: number;
  quote_count: number;
  external_uri: string | null;
  external_title: string | null;
  external_desc: string | null;
  quote_uri: string | null;
  has_images: boolean;
  image_count: number;
  image_alts: string[];
  is_reply: boolean;
  reply_parent_uri: string | null;
}

export async function getFeedPreviewPosts(
  feedId: number,
  limit: number = 25
): Promise<FeedPreviewPost[]> {
  const t0 = performance.now();
  const feedRes = await query("SELECT * FROM feeds WHERE id = $1", [feedId]);
  if (feedRes.rows.length === 0) return [];
  const feed = rowToFeed(feedRes.rows[0]);
  const tFeed = performance.now();

  const queryText = buildSearchQuery(feed);
  if (!queryText) return [];

  const filter = mechanicalToSearchFilter(feed.mechanical_filters);

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
      author_handle: h.author_handle,
      author_display_name: h.author_display_name,
      author_avatar_cid: h.author_avatar_cid,
      score: h.vector_score,
      indexed_at: h.created_at,
      like_count: h.like_count ?? 0,
      repost_count: h.repost_count ?? 0,
      reply_count: h.reply_count ?? 0,
      quote_count: h.quote_count ?? 0,
      external_uri: h.external_uri,
      external_title: h.external_title,
      external_desc: h.external_desc,
      quote_uri: h.quote_uri,
      has_images: h.has_images,
      image_count: h.image_count,
      image_alts: h.image_alts,
      is_reply: h.is_reply,
      reply_parent_uri: h.reply_parent_uri,
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

// --- Reranker prompts (used by /search) ---

export interface DbRerankPrompt {
  id: string;
  user_id: string;
  name: string;
  current_version_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DbRerankPromptVersion {
  id: string;
  prompt_id: string;
  version: number;
  system_prompt: string;
  created_at: Date;
}

export interface RerankPromptWithVersion extends DbRerankPrompt {
  current_version: number | null;
  current_system_prompt: string | null;
}

export async function listRerankPromptsForUser(
  userId: string
): Promise<RerankPromptWithVersion[]> {
  const res = await query(
    `SELECT p.*,
            v.version       AS current_version,
            v.system_prompt AS current_system_prompt
       FROM rerank_prompts p
       LEFT JOIN rerank_prompt_versions v ON v.id = p.current_version_id
      WHERE p.user_id = $1
      ORDER BY p.updated_at DESC`,
    [userId]
  );
  return res.rows;
}

export async function getRerankPromptForUser(
  id: string,
  userId: string
): Promise<RerankPromptWithVersion | null> {
  const res = await query(
    `SELECT p.*,
            v.version       AS current_version,
            v.system_prompt AS current_system_prompt
       FROM rerank_prompts p
       LEFT JOIN rerank_prompt_versions v ON v.id = p.current_version_id
      WHERE p.id = $1 AND p.user_id = $2`,
    [id, userId]
  );
  return res.rows[0] ?? null;
}

export async function listRerankPromptVersions(
  promptId: string
): Promise<DbRerankPromptVersion[]> {
  const res = await query(
    `SELECT * FROM rerank_prompt_versions
      WHERE prompt_id = $1
      ORDER BY version DESC`,
    [promptId]
  );
  return res.rows;
}

export async function createRerankPrompt(opts: {
  userId: string;
  name: string;
  systemPrompt: string;
}): Promise<RerankPromptWithVersion> {
  return withClient(async (c) => {
    await c.query("BEGIN");
    try {
      const promptRes = await c.query<DbRerankPrompt>(
        `INSERT INTO rerank_prompts (user_id, name) VALUES ($1, $2) RETURNING *`,
        [opts.userId, opts.name]
      );
      const prompt = promptRes.rows[0];
      const versionRes = await c.query<DbRerankPromptVersion>(
        `INSERT INTO rerank_prompt_versions (prompt_id, version, system_prompt)
         VALUES ($1, 1, $2) RETURNING *`,
        [prompt.id, opts.systemPrompt]
      );
      const version = versionRes.rows[0];
      await c.query(
        `UPDATE rerank_prompts SET current_version_id = $1, updated_at = now() WHERE id = $2`,
        [version.id, prompt.id]
      );
      await c.query("COMMIT");
      return {
        ...prompt,
        current_version_id: version.id,
        current_version: version.version,
        current_system_prompt: version.system_prompt,
      };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  });
}

export async function renameRerankPrompt(
  id: string,
  userId: string,
  name: string
): Promise<void> {
  await query(
    `UPDATE rerank_prompts SET name = $1, updated_at = now()
      WHERE id = $2 AND user_id = $3`,
    [name, id, userId]
  );
}

export async function saveRerankPromptVersion(opts: {
  promptId: string;
  userId: string;
  systemPrompt: string;
}): Promise<DbRerankPromptVersion> {
  return withClient(async (c) => {
    await c.query("BEGIN");
    try {
      // Verify ownership inside the transaction.
      const own = await c.query(
        `SELECT id FROM rerank_prompts WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [opts.promptId, opts.userId]
      );
      if (own.rowCount === 0) {
        await c.query("ROLLBACK");
        throw new Error("prompt not found");
      }
      const maxRes = await c.query<{ max: number | null }>(
        `SELECT MAX(version) AS max FROM rerank_prompt_versions WHERE prompt_id = $1`,
        [opts.promptId]
      );
      const nextVersion = (maxRes.rows[0]?.max ?? 0) + 1;
      const versionRes = await c.query<DbRerankPromptVersion>(
        `INSERT INTO rerank_prompt_versions (prompt_id, version, system_prompt)
         VALUES ($1, $2, $3) RETURNING *`,
        [opts.promptId, nextVersion, opts.systemPrompt]
      );
      const version = versionRes.rows[0];
      await c.query(
        `UPDATE rerank_prompts SET current_version_id = $1, updated_at = now() WHERE id = $2`,
        [version.id, opts.promptId]
      );
      await c.query("COMMIT");
      return version;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  });
}

export async function activateRerankPromptVersion(opts: {
  promptId: string;
  userId: string;
  versionId: string;
}): Promise<void> {
  const res = await query(
    `UPDATE rerank_prompts
        SET current_version_id = $1, updated_at = now()
      WHERE id = $2 AND user_id = $3
        AND EXISTS (
          SELECT 1 FROM rerank_prompt_versions
           WHERE id = $1 AND prompt_id = $2
        )`,
    [opts.versionId, opts.promptId, opts.userId]
  );
  if (res.rowCount === 0) {
    throw new Error("prompt or version not found");
  }
}

export async function deleteRerankPrompt(
  id: string,
  userId: string
): Promise<void> {
  await query(
    `DELETE FROM rerank_prompts WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
}

// --- Search runs ---

export interface DbSearchRun {
  id: string;
  user_id: string;
  query: string;
  vector_k: number;
  rerank_k: number;
  rerank_enabled: boolean;
  prompt_version_id: string | null;
  filters_json: unknown;
  vector_hit_uris: string[];
  rerank_kept: unknown;
  ms_embed: number | null;
  ms_find: number | null;
  ms_hydrate: number | null;
  ms_rerank: number | null;
  ms_total: number | null;
  created_at: Date;
}

export async function insertSearchRun(run: {
  userId: string;
  query: string;
  vectorK: number;
  rerankK: number;
  rerankEnabled: boolean;
  promptVersionId: string | null;
  filtersJson: unknown;
  vectorHitUris: string[];
  rerankKept: unknown;
  msEmbed: number | null;
  msFind: number | null;
  msHydrate: number | null;
  msRerank: number | null;
  msTotal: number;
}): Promise<DbSearchRun> {
  const res = await query(
    `INSERT INTO search_runs
       (user_id, query, vector_k, rerank_k, rerank_enabled, prompt_version_id,
        filters_json, vector_hit_uris, rerank_kept,
        ms_embed, ms_find, ms_hydrate, ms_rerank, ms_total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [
      run.userId,
      run.query,
      run.vectorK,
      run.rerankK,
      run.rerankEnabled,
      run.promptVersionId,
      JSON.stringify(run.filtersJson ?? null),
      run.vectorHitUris,
      run.rerankKept === null ? null : JSON.stringify(run.rerankKept),
      run.msEmbed,
      run.msFind,
      run.msHydrate,
      run.msRerank,
      run.msTotal,
    ]
  );
  return res.rows[0];
}

export async function listSearchRunsForUser(
  userId: string,
  limit: number = 20
): Promise<DbSearchRun[]> {
  const res = await query(
    `SELECT * FROM search_runs WHERE user_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return res.rows;
}

export async function getSearchRunForUser(
  id: string,
  userId: string
): Promise<DbSearchRun | null> {
  const res = await query(
    `SELECT * FROM search_runs WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return res.rows[0] ?? null;
}
