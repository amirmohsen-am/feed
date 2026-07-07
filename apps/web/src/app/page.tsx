import type { Metadata } from "next";
import Landing from "./landing";

// Resolved against metadataBase (layout.tsx) → https://amadi.social.
// Deliberately per-page, not in the root layout: a layout-level canonical
// is inherited by every route and would point them all at the homepage.
export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

// Re-prerender at most hourly so the emitted `Cache-Control: s-maxage`
// stops pinning year-old HTML in shared caches (Google Frontend was
// serving stale landing pages on amadi.social).
export const revalidate = 3600;

export default function Page() {
  return <Landing />;
}
