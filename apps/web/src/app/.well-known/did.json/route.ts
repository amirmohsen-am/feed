import { NextResponse } from "next/server";
import { getFeedgenHostname, getFeedgenServiceDid } from "@/lib/feedgen";

export async function GET() {
  const hostname = getFeedgenHostname();
  const serviceDid = getFeedgenServiceDid();

  return NextResponse.json({
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: serviceDid,
    service: [
      {
        id: "#bsky_fg",
        type: "BskyFeedGenerator",
        serviceEndpoint: `https://${hostname}`,
      },
    ],
  });
}
