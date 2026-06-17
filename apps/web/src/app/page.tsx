import Landing from "./landing";

// Re-prerender at most hourly so the emitted `Cache-Control: s-maxage`
// stops pinning year-old HTML in shared caches (Google Frontend was
// serving stale landing pages on amadi.social).
export const revalidate = 3600;

export default function Page() {
  return <Landing />;
}
