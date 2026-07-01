import type { Metadata } from "next";
import { getLabelers, type Labeler } from "@/lib/labelers";
import "./labelers.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Labeler directory",
  description: "Bluesky labelers, ranked by likes.",
};

function formatLikes(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function nameFor(l: Labeler): string {
  return l.displayName?.trim() || l.handle || l.did;
}

function LabelerRow({ labeler, rank }: { labeler: Labeler; rank: number }) {
  const name = nameFor(labeler);
  const likes = labeler.likeCount ?? 0;
  return (
    <a
      className="lbl-row"
      href={`https://bsky.app/profile/${labeler.did}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      <span className="lbl-rank">{rank}</span>
      {labeler.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="lbl-avatar" src={labeler.avatarUrl} alt="" />
      ) : (
        <span className="lbl-avatar lbl-avatar-fallback">
          {name.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="lbl-body">
        <span className="lbl-name">{name}</span>
        {labeler.handle ? (
          <span className="lbl-handle">@{labeler.handle}</span>
        ) : null}
        {labeler.description ? (
          <span className="lbl-desc">{labeler.description}</span>
        ) : null}
      </span>
      <span className="lbl-likes">
        <span className="lbl-likes-count">{formatLikes(likes)}</span>
        <span className="lbl-likes-label">likes</span>
      </span>
    </a>
  );
}

export default async function LabelersPage() {
  const labelers = await getLabelers();

  return (
    <main className="lbl-page">
      <h1 className="lbl-header">Labeler directory</h1>
      <p className="lbl-sub">
        Every Bluesky labeler we know about, ranked by likes. Tap one to open its
        profile on Bluesky.
      </p>
      {labelers.length === 0 ? (
        <p className="lbl-empty">No labelers yet. Check back soon.</p>
      ) : (
        <div className="lbl-list">
          {labelers.map((l, i) => (
            <LabelerRow key={l.did} labeler={l} rank={i + 1} />
          ))}
        </div>
      )}
    </main>
  );
}
