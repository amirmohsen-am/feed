"use client";

import type { BranchOption } from "@/lib/branch";

export default function BranchTopicsHeader({
  options,
}: {
  options: BranchOption[];
}) {
  return (
    <div className="cur-branch-header cur-branch-header-animate">
      <div className="cur-branch-header-chips">
        {options.map((o, i) => (
          <span key={i} className="cur-branch-chip selected" title={o.subquery}>
            <span className="cur-branch-chip-label">{o.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
