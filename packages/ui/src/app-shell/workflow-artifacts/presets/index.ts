/**
 * Public surface of the preset artifact renderers.
 *
 * Four renderers plus two pure-function layers:
 * - `parseArtifactPresetSpec(kind, spec)` decides whether a wire-level `unknown` spec is
 *   renderable;
 * - `applyArtifactItems(kind, spec, items)` folds the `report(item, id)` item stream into
 *   view models;
 * - `<ArtifactChart|Table|Metrics|Board>` render them; `compact` is the small variant used
 *   in run side pane cards.
 *
 * This barrel has NO static recharts dependency: `ArtifactChart` is a `lazy()` wrapper
 * (see `ArtifactChart.tsx`), so importing this module keeps the chart library out of the
 * first paint.
 */

export { type ArtifactItem } from "@/app-shell/workflow-artifacts/presets/apply.js";
export {
  parseArtifactPresetSpec,
  type ArtifactPresetKind,
  type BoardSpec,
  type ChartSpec,
  type MetricsSpec,
  type TableSpec,
} from "@/app-shell/workflow-artifacts/presets/spec.js";

export { type PresetLabels } from "@/app-shell/workflow-artifacts/presets/parts.js";
export { ArtifactChart } from "@/app-shell/workflow-artifacts/presets/ArtifactChart.js";
export { ArtifactTable } from "@/app-shell/workflow-artifacts/presets/ArtifactTable.js";
export { ArtifactMetrics } from "@/app-shell/workflow-artifacts/presets/ArtifactMetrics.js";
export { ArtifactBoard } from "@/app-shell/workflow-artifacts/presets/ArtifactBoard.js";
