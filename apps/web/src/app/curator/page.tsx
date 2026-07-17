import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth";
import { createFeed, ensureHomeFeed } from "@/lib/pg";

// Landing route for /curator. Resolved entirely on the server: we look up (or
// create) the user's home feed and redirect to /curator/[id] in the same
// request — no client-side spinner page, no extra /api/feeds round trip. The
// user effectively always lives at /curator/[id].
//
// Two query params modify behavior:
//   ?new=1            force-create a fresh feed even when feeds already exist
//                     (used by suggestion cards in /introspect; only ever
//                     reached via router.push, never a prefetchable <Link>)
//   ?prompt=<text>    forwarded to the workbench so it can seed the chat input
export default async function CuratorLanding({
  searchParams,
}: {
  searchParams: Promise<{ new?: string; prompt?: string }>;
}) {
  const params = await searchParams;
  const auth = await requireAuth();

  const promptSuffix = params.prompt
    ? `?prompt=${encodeURIComponent(params.prompt)}`
    : "";

  if (params.new === "1") {
    const feed = await createFeed(auth.userId, "Untitled");
    redirect(`/curator/${feed.id}${promptSuffix}`);
  }

  const home = await ensureHomeFeed(auth.userId);
  redirect(`/curator/${home.id}${promptSuffix}`);
}
