import { query } from "./connection";

// --- Search runs ---

interface DbSearchRun {
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
