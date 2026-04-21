import { BskyAgent } from "@atproto/api";

async function main() {
  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  const hostname = process.env.FEEDGEN_HOSTNAME;

  if (!handle || !password || !hostname) {
    console.error(
      "Required env vars: BLUESKY_HANDLE, BLUESKY_APP_PASSWORD, FEEDGEN_HOSTNAME"
    );
    process.exit(1);
  }

  const agent = new BskyAgent({ service: "https://bsky.social" });
  await agent.login({ identifier: handle, password });

  console.log(`Logged in as ${agent.session?.did}`);

  const res = await agent.api.com.atproto.repo.putRecord({
    repo: agent.session!.did,
    collection: "app.bsky.feed.generator",
    rkey: "curated",
    record: {
      did: `did:web:${hostname}`,
      displayName: "My Curated Feed",
      description: "AI-curated feed based on my preferences",
      createdAt: new Date().toISOString(),
    },
  });

  console.log("Feed published!");
  console.log(
    `Feed URI: at://${agent.session!.did}/app.bsky.feed.generator/curated`
  );
  console.log(`Record: ${JSON.stringify(res.data, null, 2)}`);
}

main().catch(console.error);
