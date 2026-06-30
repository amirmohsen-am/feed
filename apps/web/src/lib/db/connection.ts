import { Pool, type PoolClient, type QueryResult } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { getSecret } from "../secrets";
import { onAdcChange } from "../adc-watcher";

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

// Local-dev switch: when LOCAL_DATABASE_URL is set we connect directly to a
// standard Postgres (e.g. a local Docker container), bypassing the Cloud SQL
// connector AND Secret Manager. Unset it to go back to the prod feed-db.
// This is the only thing that decides local vs prod for feed-db.
const LOCAL_DATABASE_URL = process.env.LOCAL_DATABASE_URL;

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
  if (had) console.log("[pg] feed-db pool/connector reset after ADC change");
});

async function getPool(): Promise<Pool> {
  if (_pool) return _pool;
  if (_poolInit) return _poolInit;
  const init = (async () => {
    // Local mode — direct connection, no connector, no secrets.
    if (LOCAL_DATABASE_URL) {
      const pool = new Pool({
        connectionString: LOCAL_DATABASE_URL,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      });
      pool.on("error", (err) => {
        console.error("[pg] local pool error:", err.message);
      });
      _pool = pool;
      console.log("[pg] feed-db: LOCAL mode (LOCAL_DATABASE_URL)");
      return pool;
    }

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
