/**
 * Series palette and SECONDARY encodings for the preset charts.
 *
 * Colors reuse the design system's existing `--color-usage-chart-1..6` (DESIGN.md "Color
 * Usage Rules": semantic tokens, no one-off values). Those tokens are defined in all four
 * themes (light / dark / zai-light / zai-dark), so charts theme automatically and no
 * component needs a theme branch.
 *
 * Why every series also carries a dash pattern: these 6 slots are not pairwise separable
 * under color-vision deficiency (protan/deutan) — the dataviz palette checker scores the
 * purple<->blue and orange<->red pairs below the ΔE 8 gate in all-pairs mode. Its only
 * sanctioned remedy is a secondary encoding, so each series pairs its color with a fixed
 * dash style, and legends/direct labels are always present: identity never rests on color
 * alone (same spirit as DESIGN.md's "Use semantic status colors together with readable
 * text, never by color alone"). The palette itself is a repo-level asset.
 */

/** Slot count = max series per chart; extra y fields are not drawn (fewer series beat recycled colors). */
export const ARTIFACT_CHART_MAX_SERIES = 6;

/** Series index's color (CSS variable reference; applies instantly on theme switch). */
export function artifactSeriesColorVar(index: number): string {
  return `var(--color-usage-chart-${(index % ARTIFACT_CHART_MAX_SERIES) + 1})`;
}

const SERIES_DASH: readonly (string | undefined)[] = [
  undefined,
  "6 3",
  "2 3",
  "9 3 2 3",
  "1 3",
  "12 4",
];

/** Series index's dash style; the first series is solid. */
export function artifactSeriesDash(index: number): string | undefined {
  return SERIES_DASH[index % SERIES_DASH.length];
}

const SERIES_SYMBOL = ["circle", "cross", "diamond", "square", "triangle", "star"] as const;

/** Scatter symbol; like the dash, a second identity cue beyond color. */
export function artifactSeriesSymbol(index: number): (typeof SERIES_SYMBOL)[number] {
  return SERIES_SYMBOL[index % SERIES_SYMBOL.length]!;
}
