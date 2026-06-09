import { NextResponse } from "next/server";
import { getFeedgenServiceDid } from "@/lib/feedgen";
import { getPublishedFeedsWithPublisher } from "@/lib/pg";

export async function GET() {
  const entries = await getPublishedFeedsWithPublisher();

  return NextResponse.json({
    did: getFeedgenServiceDid(),
    feeds: entries.map(({ feed, publisher_did }) => ({
      uri: `at://${publisher_did}/app.bsky.feed.generator/${feed.published_rkey}`,
    })),
  });
}
