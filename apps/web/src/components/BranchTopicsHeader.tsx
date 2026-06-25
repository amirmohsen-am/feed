"use client";

import type { BranchOption } from "@/lib/branch";

// The header atop a branched feed. Topics split into two lanes by kind —
// "deeper" (digs into the source thread) and "adjacent" (branches sideways) —
// distinguished by color alone. Each lane is a single horizontally-scrolling
// row that never wraps or truncates; a lane with no topics is omitted.
export default function BranchTopicsHeader({
  options,
}: {
  options: BranchOption[];
}) {
  const rows = (["deeper", "adjacent"] as const)
    .map((kind) => ({ kind, items: options.filter((o) => o.kind === kind) }))
    .filter((row) => row.items.length > 0);

  if (rows.length === 0) return null;

  return (
    <div className="cur-branch-header cur-branch-header-animate">
      <div className="cur-branch-header-label">Topics</div>
      {/* Both kind rows share ONE horizontal scroll container (the track is
          sized to the longer row), so a single drag moves them together; the
          shorter row simply runs empty on the right as you scroll. */}
      <div className="cur-branch-scroll">
        <div className="cur-branch-track">
          {rows.map((row) => (
            <div key={row.kind} className={`cur-branch-row cur-branch-row-${row.kind}`}>
              {row.items.map((o, i) => (
                <span key={i} className="cur-branch-tag" title={o.subquery}>
                  {o.label}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
