"use client";

import type { BranchOption } from "@/lib/branch";

export default function BranchTopicsHeader({
  options,
}: {
  options: BranchOption[];
}) {
  const deeper = options.filter((o) => o.kind === "deeper");
  const adjacent = options.filter((o) => o.kind === "adjacent");

  return (
    <div className="cur-branch-header cur-branch-header-animate">
      <div className="cur-branch-header-label">branched from</div>
      {deeper.length > 0 && (
        <div className="cur-branch-header-group">
          <span className="cur-branch-header-kind">↳ deeper</span>
          <div className="cur-branch-header-chips">
            {deeper.map((o, i) => (
              <span key={i} className="cur-branch-chip selected" data-kind="deeper" title={o.subquery}>
                <span className="cur-branch-chip-label">{o.label}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {adjacent.length > 0 && (
        <div className="cur-branch-header-group">
          <span className="cur-branch-header-kind">→ adjacent</span>
          <div className="cur-branch-header-chips">
            {adjacent.map((o, i) => (
              <span key={i} className="cur-branch-chip selected" data-kind="adjacent" title={o.subquery}>
                <span className="cur-branch-chip-label">{o.label}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
