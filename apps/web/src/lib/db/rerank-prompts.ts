import { query, withClient } from "./connection";

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
