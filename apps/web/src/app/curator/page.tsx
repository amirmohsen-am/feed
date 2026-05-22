"use client";

import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authedFetch } from "@/lib/authed-fetch";
import { useCurator } from "./curatorContext";

// Landing route for /curator. The layout has already gated on auth/onboarding,
// so by the time this runs we know we have a profile. We pick the user's most
// recent feed and redirect there. If they have none, we create one. The user
// effectively always lives at /curator/[id].
//
// Two query params modify behavior:
//   ?new=1            force-create a fresh feed even when feeds already exist
//                     (used by suggestion cards in /introspect)
//   ?prompt=<text>    forwarded to the workbench so it can seed the chat input
export default function CuratorLanding() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { feeds, reloadFeeds } = useCurator();
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    const forceNew = searchParams.get("new") === "1";
    const promptParam = searchParams.get("prompt");
    const promptSuffix = promptParam
      ? `?prompt=${encodeURIComponent(promptParam)}`
      : "";

    (async () => {
      try {
        if (!forceNew) {
          // Layout fires reloadFeeds() on mount too, but we don't want to race
          // it — go straight to the source of truth.
          const res = await authedFetch("/api/feeds");
          const data = await res.json();
          const list: { id: number }[] = data.feeds || [];
          if (list.length > 0) {
            router.replace(`/curator/${list[0].id}${promptSuffix}`);
            return;
          }
        }
        // Either no feeds yet, or ?new=1 explicitly asked for a fresh one.
        const createRes = await authedFetch("/api/feeds", {
          method: "POST",
          body: JSON.stringify({ name: "Untitled" }),
        });
        const created = await createRes.json();
        const id = created.feed?.id ?? created.id;
        if (id != null) {
          await reloadFeeds();
          router.replace(`/curator/${id}${promptSuffix}`);
        }
      } catch {
        /* ignore — user will see the spinner and can retry */
      }
    })();
  }, [router, reloadFeeds, feeds, searchParams]);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div className="cur-dots"><span /><span /><span /></div>
    </div>
  );
}
