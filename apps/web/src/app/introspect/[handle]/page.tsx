import IntrospectDashboard from "../IntrospectDashboard";

export default async function IntrospectHandlePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  // Next 16 made route params a promise in server components.
  const { handle } = await params;
  const cleanHandle = decodeURIComponent(handle).replace(/^@/, "").toLowerCase();
  return <IntrospectDashboard handle={cleanHandle} />;
}
