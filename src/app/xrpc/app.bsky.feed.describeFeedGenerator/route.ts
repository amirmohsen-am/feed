import { NextResponse } from "next/server";

export async function GET() {
  const hostname = process.env.FEEDGEN_HOSTNAME || "localhost";
  const publisherDid = process.env.FEEDGEN_PUBLISHER_DID || "";

  return NextResponse.json({
    did: `did:web:${hostname}`,
    feeds: [
      {
        uri: `at://${publisherDid}/app.bsky.feed.generator/curated`,
      },
    ],
  });
}
