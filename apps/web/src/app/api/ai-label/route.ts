import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { enforceRateLimit, HIVE_RULES } from "@/lib/rate-limit";
import { checkPostMedia } from "@/lib/hive";

/**
 * GET /api/ai-label?uri=<at-uri>&image_urls=<comma-separated-cdn-urls>
 *
 * Calls the Hive AI API to check whether the post's images are AI-generated.
 * Returns { uri, ai_generated, scores, error? }.
 */
export async function GET(req: NextRequest) {
  const limited = enforceRateLimit(req, "ai-label", HIVE_RULES);
  if (limited) return limited;
  const auth = await requireAuth();

  const uri = req.nextUrl.searchParams.get("uri");
  const imageUrlsParam = req.nextUrl.searchParams.get("image_urls");

  if (!uri || !imageUrlsParam) {
    return NextResponse.json(
      { error: "uri and image_urls query params required" },
      { status: 400 }
    );
  }

  const imageUrls = imageUrlsParam
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  if (imageUrls.length === 0) {
    return NextResponse.json({ uri, ai_generated: false, scores: [] });
  }

  const result = await checkPostMedia(imageUrls);

  return NextResponse.json({
    uri,
    ai_generated: result.ai_generated,
    scores: result.scores,
    ...(result.error ? { error: true } : {}),
  });
}
