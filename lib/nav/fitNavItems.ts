/**
 * How many header menus fit in the available width before the rest fold into "More ▾" (owner request 2026-11-20:
 * at common laptop widths the header overflowed and the profile avatar ended up behind the scrollbar).
 *
 * Pure: the header measures real widths and calls this; tests call it with widths for 1280 / 1440 / 1920.
 *   available  - the nav's inner width (the right-hand Company/Credits/Avatar cluster never shrinks or folds);
 *   widths     - each menu's rendered width, in order;
 *   moreWidth  - the "More ▾" button's width;
 *   gap        - the flex gap between items.
 * Returns how many leading items stay visible. If ALL fit, no "More" is needed. Otherwise as many as fit WITH
 * room left for "More". Never negative.
 */
export function fitNavItems(available: number, widths: readonly number[], moreWidth: number, gap: number): number {
  const n = widths.length;
  if (n === 0) return 0;
  const all = widths.reduce((s, w) => s + w, 0) + gap * (n - 1);
  if (all <= available) return n;
  let used = 0;
  for (let i = 0; i < n; i++) {
    const next = used + (i > 0 ? gap : 0) + widths[i];
    if (next + gap + moreWidth > available) return i;
    used = next;
  }
  return n;
}
