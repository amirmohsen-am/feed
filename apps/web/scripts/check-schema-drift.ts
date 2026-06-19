/**
 * Compare the PROD feed-db schema against a LOCAL one, column by column, to
 * find drift (prod columns/tables our migrations + base DDL don't reproduce).
 *
 * Read-only. Prod is reached via the normal connector (needs ADC + the
 * `database-url` secret); local via a plain connection string.
 *
 * IMPORTANT: do NOT set LOCAL_DATABASE_URL in the env when running this — the
 * prod pool is `getPool()`, which would otherwise be redirected to local.
 * Pass the local URL as argv[2] instead.
 *
 *   npx tsx scripts/check-schema-drift.ts postgres://postgres:postgres@localhost:5432/feed_curator
 */

import { Pool } from "pg";
import { getPool } from "../src/lib/pg";

type Col = { type: string; nullable: string; default: string | null };
type Schema = Map<string, Map<string, Col>>;

const COLS_SQL = `
  SELECT table_name, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
  ORDER BY table_name, ordinal_position`;

function toSchema(rows: Array<Record<string, unknown>>): Schema {
  const s: Schema = new Map();
  for (const r of rows) {
    const t = String(r.table_name);
    if (!s.has(t)) s.set(t, new Map());
    s.get(t)!.set(String(r.column_name), {
      type: String(r.data_type),
      nullable: String(r.is_nullable),
      default: r.column_default == null ? null : String(r.column_default),
    });
  }
  return s;
}

async function main() {
  const localUrl = process.argv[2];
  if (!localUrl) {
    console.error("usage: tsx scripts/check-schema-drift.ts <local-connection-url>");
    process.exit(1);
  }
  if (process.env.LOCAL_DATABASE_URL) {
    console.error("Refusing to run: LOCAL_DATABASE_URL is set, which would point the prod pool at local. Unset it.");
    process.exit(1);
  }

  const prodPool = await getPool(); // prod (connector)
  const localPool = new Pool({ connectionString: localUrl });

  const prod = toSchema((await prodPool.query(COLS_SQL)).rows);
  const local = toSchema((await localPool.query(COLS_SQL)).rows);

  let drift = 0;
  console.log("=== Tables in PROD missing from LOCAL ===");
  for (const t of prod.keys()) if (!local.has(t)) { console.log(`  - ${t}`); drift++; }

  console.log("=== Tables in LOCAL not in PROD (expected: new recsys tables) ===");
  for (const t of local.keys()) if (!prod.has(t)) console.log(`  + ${t}`);

  console.log("=== Per-table column drift (PROD vs LOCAL) ===");
  for (const [t, pcols] of prod) {
    const lcols = local.get(t);
    if (!lcols) continue; // already reported as missing table
    const lines: string[] = [];
    for (const [c, pc] of pcols) {
      const lc = lcols.get(c);
      if (!lc) {
        lines.push(`    MISSING in local: ${c} (${pc.type}, nullable=${pc.nullable}, default=${pc.default ?? "∅"})`);
        drift++;
      } else if (pc.type !== lc.type || pc.nullable !== lc.nullable) {
        lines.push(`    DIFF ${c}: prod(${pc.type},null=${pc.nullable}) vs local(${lc.type},null=${lc.nullable})`);
        drift++;
      }
    }
    // Columns local has that prod doesn't (our additions to base tables)
    for (const c of lcols.keys()) {
      if (!pcols.has(c)) lines.push(`    EXTRA in local: ${c}`);
    }
    if (lines.length) {
      console.log(`  [${t}]`);
      for (const l of lines) console.log(l);
    }
  }

  console.log(`\n=== ${drift} drift item(s) where prod has something local lacks ===`);
  await prodPool.end();
  await localPool.end();
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR", e); process.exit(1); });
