// Shared fold treatment for collapsing a PostCard into a compact preview: the
// body region (everything under the header, wrapped in .cur-post-foldable)
// collapses to a couple of lines whose text dissolves to transparent (a mask,
// not a white overlay — no hard clip), and the avatar shrinks. Heights are
// measured (not guessable in CSS), so the fold is driven imperatively. Used by
// the pinned branch source (useBranchController) and the swiped-post cards in
// chat (CollapsedPostCard).

export const FOLD_MIN = 48;      // collapsed body height (≈ 2 lines + the fade)
export const AVA_FULL = 40, AVA_MIN = 30;
export const FOLD_DUR = 440;     // ms — matches the recede/lift timing on commit & Back
export const foldMask = (stopPct: number) =>
  `linear-gradient(to bottom,#000 ${stopPct}%,transparent)`;
export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// Animate the card to its folded (collapsed=true) or full (collapsed=false)
// state. Re-measures the natural height each time (images may have loaded
// since the last call). Pass instant=true to land the state without animating
// (e.g. mounting a card that starts folded). Returns the measured full height.
export function settleFoldEls(
  foldable: HTMLElement,
  avatar: HTMLElement | null,
  collapsed: boolean,
  opts?: { instant?: boolean }
): number {
  const prevMax = foldable.style.maxHeight;
  foldable.style.transition = "none";
  foldable.style.maxHeight = "none";
  const full = foldable.scrollHeight;
  foldable.style.maxHeight = prevMax || full + "px";
  void foldable.offsetHeight; // reflow so the change below animates from here
  const reduce = opts?.instant === true || prefersReducedMotion();
  const ease = "cubic-bezier(0.4,0,0.2,1)";
  foldable.style.transition = reduce
    ? "none"
    : `max-height ${FOLD_DUR}ms ${ease}, -webkit-mask-image ${FOLD_DUR}ms, mask-image ${FOLD_DUR}ms`;
  foldable.style.overflow = "hidden";
  // Collapsed, the fade starts a quarter of the way down — the first line reads,
  // the rest visibly dissolves to nothing at the card border.
  foldable.style.maxHeight = (collapsed ? Math.min(FOLD_MIN, full) : full) + "px";
  foldable.style.webkitMaskImage = foldable.style.maskImage = foldMask(collapsed ? 25 : 100);
  if (avatar) {
    avatar.style.transition = reduce ? "none" : `width ${FOLD_DUR}ms ${ease}, height ${FOLD_DUR}ms ${ease}`;
    const a = (collapsed ? AVA_MIN : AVA_FULL) + "px";
    avatar.style.width = a;
    avatar.style.height = a;
  }
  return full;
}
