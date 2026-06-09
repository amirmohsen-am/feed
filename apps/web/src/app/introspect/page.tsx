"use client";

/**
 * /introspect — splash page. Just an input for a Bluesky handle; submission
 * routes to /introspect/<handle> where the dashboard lives.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import IntrospectBackLink from "./IntrospectBackLink";
import IntrospectGate from "./IntrospectGate";

export default function IntrospectSplash() {
  const router = useRouter();
  const [handleInput, setHandleInput] = useState("");

  return (
    <IntrospectGate>
    <main className="min-h-screen overflow-x-hidden bg-[#fafafa] text-[#1a1a1a]">
      <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6 sm:py-24">
        <IntrospectBackLink />
        <h1 className="mb-3 font-serif text-3xl tracking-tight sm:text-4xl">
          introspect
        </h1>
        <p className="mb-8 leading-relaxed text-[#666]">
          A natural-language self-portrait built from Bluesky engagements
          — likes, reposts, quotes, posts, and replies. Introspect any public
          handle.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const h = handleInput.replace(/^@/, "").trim().toLowerCase();
            if (!h) return;
            router.push(`/introspect/${encodeURIComponent(h)}`);
          }}
          className="flex flex-col gap-2 sm:flex-row"
        >
          <input
            type="text"
            value={handleInput}
            onChange={(e) => setHandleInput(e.target.value)}
            placeholder="jay.bsky.team"
            className="min-h-11 flex-1 rounded border border-[#ddd] bg-white px-3 py-2 text-base focus:border-[#1a1a1a] focus:outline-none sm:text-sm"
            autoFocus
          />
          <button
            type="submit"
            disabled={!handleInput.trim()}
            className="min-h-11 rounded bg-[#1a1a1a] px-4 py-2 text-white disabled:opacity-50 sm:min-h-0"
          >
            Introspect
          </button>
        </form>
      </div>
    </main>
    </IntrospectGate>
  );
}
