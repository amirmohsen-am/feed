import { NextResponse } from "next/server";

export async function GET() {
  const hostname = process.env.FEEDGEN_HOSTNAME || "localhost";

  return NextResponse.json({
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: `did:web:${hostname}`,
    service: [
      {
        id: "#bsky_fg",
        type: "BskyFeedGenerator",
        serviceEndpoint: `https://${hostname}`,
      },
    ],
  });
}
