import { bskyQuery } from "../src/lib/bsky-pg";

(async () => {
  const counts = await bskyQuery(`
    SELECT
      (SELECT COUNT(*) FROM bsky.posts)                              AS total_posts,
      (SELECT COUNT(*) FROM bsky.posts WHERE created_at > now() - interval '24 hours') AS last_24h,
      (SELECT COUNT(*) FROM bsky.posts WHERE created_at > now() - interval '7 days')   AS last_7d,
      (SELECT MIN(created_at) FROM bsky.posts)                       AS oldest,
      (SELECT MAX(created_at) FROM bsky.posts)                       AS newest`);
  console.log(JSON.stringify(counts.rows[0], null, 2));
  process.exit(0);
})().catch((e) => {
  console.error("ERR:", e?.message ?? e);
  process.exit(1);
});
