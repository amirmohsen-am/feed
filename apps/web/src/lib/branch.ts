// Shared helpers for the "branch off a post into a new feed" flow.
//
// Branching reframes consumption as a deliberately forked tree of interests:
// the user picks a post that sparked a new direction, chooses among
// Claude-generated topical branches, and we spin up a new feed seeded with
// those topics + lineage back to the source post. See BRANCHING_PRD.md.

import type { VectorHit } from "./vector-search";

// Max categories a single branch can carry — a feed supports 1-4 subqueries.
export const MAX_BRANCH_TOPICS = 4;

// One proposed branch direction. `subquery` is the vector-search query that
// seeds the new feed; `label` is the human chip; `kind` distinguishes going
// deeper into the post's thread vs. branching sideways into an adjacent one.
export interface BranchOption {
  label: string;
  subquery: string;
  kind: "deeper" | "adjacent";
}

/**
 * Render a source post into a compact, readable block for prompting. Includes
 * everything the LLM needs to read the vibe + topic: author, text, image alt
 * text, the external link card, and a quote marker. No video (unsupported).
 */
export function composeSourcePostText(hit: VectorHit): string {
  const lines: string[] = [];
  const author =
    hit.author_display_name?.trim() ||
    (hit.author_handle ? `@${hit.author_handle}` : hit.did);
  lines.push(`Author: ${author}`);
  if (hit.text.trim()) {
    lines.push(`Text: ${hit.text.trim()}`);
  }
  if (hit.image_alts.length > 0) {
    const alts = hit.image_alts.map((a) => a.trim()).filter(Boolean);
    if (alts.length > 0) lines.push(`Image alt text: ${alts.join(" / ")}`);
  } else if (hit.has_images) {
    lines.push("(post has images, no alt text)");
  }
  if (hit.external_title || hit.external_desc) {
    const card = [hit.external_title, hit.external_desc]
      .map((s) => s?.trim())
      .filter(Boolean)
      .join(" — ");
    if (card) lines.push(`Linked article: ${card}`);
  }
  if (hit.has_quote) {
    lines.push("(post quotes another post)");
  }
  if (hit.hashtags.length > 0) {
    lines.push(`Hashtags: ${hit.hashtags.map((t) => `#${t}`).join(" ")}`);
  }
  return lines.join("\n");
}
