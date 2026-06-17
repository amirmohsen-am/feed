import { query } from "./connection";

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
