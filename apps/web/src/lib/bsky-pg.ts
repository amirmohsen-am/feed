// Postgres pool for the bsky database (Cloud SQL feed-db, separate database
// from the web app's feed db). Same connector / secrets pattern as pg.ts.

import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { getSecret } from "./secrets";
import { onAdcChange } from "./adc-watcher";

// Dedicated bsky-db instance (separate from feed-db). The web app reads the
// bsky_posts database for hydration after Vertex returns URIs.
const INSTANCE_CONNECTION_NAME =
  process.env.BSKY_CLOUDSQL_CONNECTION_NAME ??
  "timelines-492720:us-central1:bsky-db";

const SECRET_NAME = process.env.BSKY_DATABASE_SECRET ?? "bsky-database-url";

// Local-dev switch (symmetric with feed-db's LOCAL_DATABASE_URL). Normally
// LEFT UNSET — bsky-db holds the post embeddings + pgvector index and only
// exists in prod, so local search reads prod. Set this only if you stand up a
// local bsky_posts with pgvector + data.
const LOCAL_BSKY_DATABASE_URL = process.env.LOCAL_BSKY_DATABASE_URL;

let _pool: Pool | null = null;
let _poolInit: Promise<Pool> | null = null;
let _connector: Connector | null = null;

onAdcChange(() => {
  const had = _pool !== null || _poolInit !== null || _connector !== null;
  if (_pool) { _pool.end().catch(() => { /* ignore */ }); }
  _pool = null;
  _poolInit = null;
  if (_connector) { try { _connector.close(); } catch { /* ignore */ } }
  _connector = null;
  if (had) console.log("[bsky-pg] pool/connector reset after ADC change");
});

async function getBskyPool(): Promise<Pool> {
  if (_pool) return _pool;
  if (_poolInit) return _poolInit;
  const init = (async () => {
    if (LOCAL_BSKY_DATABASE_URL) {
      const pool = new Pool({
        connectionString: LOCAL_BSKY_DATABASE_URL,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      });
      pool.on("error", (err) => {
        console.error("[bsky-pg] local pool error:", err.message);
      });
      _pool = pool;
      console.log("[bsky-pg] bsky-db: LOCAL mode (LOCAL_BSKY_DATABASE_URL)");
      return pool;
    }

    const dsn = await getSecret(SECRET_NAME);
    const u = new URL(dsn);
    const user = decodeURIComponent(u.username);
    const password = decodeURIComponent(u.password);
    const database = u.pathname.replace(/^\//, "") || "bsky_posts";

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
      // bsky-db is dedicated to the indexer + this read pool. ~200 max_connections.
      max: 15,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on("error", (err) => {
      console.error("[bsky-pg] pool error:", err.message);
    });
    _pool = pool;
    return pool;
  })();
  _poolInit = init;
  init.catch((err) => {
    console.error("[bsky-pg] pool init failed:", err?.code, err?.message ?? err);
    if (_poolInit === init) _poolInit = null;
  });
  return init;
}

export async function bskyQuery<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<R>> {
  const pool = await getBskyPool();
  return pool.query<R>(text, params);
}

export async function withBskyClient<T>(
  fn: (c: PoolClient) => Promise<T>
): Promise<T> {
  const pool = await getBskyPool();
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}
