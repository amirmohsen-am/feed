import { NextResponse } from "next/server";
import {
  getFeedgenHostname,
  getFeedgenServiceDid,
  isFeedgenPublishable,
} from "@/lib/feedgen";

/**
 * GET /api/feedgen/info
 *
 * Public feed-generator service metadata (hostname, did:web, publishable).
 */
export async function GET() {
  const hostname = getFeedgenHostname();
  return NextResponse.json({
    hostname,
    serviceDid: getFeedgenServiceDid(),
    publishable: isFeedgenPublishable(),
    publishUrl: process.env.NEXT_PUBLIC_URL || null,
  });
}
