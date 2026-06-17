import { query } from "./connection";

// --- Feedback ---

export type FeedbackCategory = "bug" | "idea" | "feed_quality" | "other";

export interface DbFeedback {
  id: string;
  user_id: string;
  feed_id: number | null;
  category: FeedbackCategory;
  rating: number;
  body: string | null;
  page_url: string | null;
  user_agent: string | null;
  created_at: Date;
}

export async function recordFeedback(params: {
  userId: string;
  feedId: number | null;
  category: FeedbackCategory;
  rating: number;
  body: string | null;
  pageUrl: string | null;
  userAgent: string | null;
}): Promise<DbFeedback> {
  const res = await query(
    `INSERT INTO feedback (user_id, feed_id, category, rating, body, page_url, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      params.userId,
      params.feedId,
      params.category,
      params.rating,
      params.body,
      params.pageUrl,
      params.userAgent,
    ]
  );
  return res.rows[0];
}
