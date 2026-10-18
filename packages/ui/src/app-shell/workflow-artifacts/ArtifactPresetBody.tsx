import {
  ArtifactBoard,
  ArtifactChart,
  ArtifactMetrics,
  ArtifactTable,
  parseArtifactPresetSpec,
  type ArtifactItem,
  type BoardSpec,
  type ChartSpec,
  type MetricsSpec,
  type TableSpec,
} from "@/app-shell/workflow-artifacts/presets/index.js";
import { isArtifactPresetKind } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import type { PresetLabels } from "@/app-shell/workflow-artifacts/presets/index.js";
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";

/**
 * Preset-board body.
 *
 * Terminology: artifact = an output the script published for the user via `artifact.*`, not a
 * synonym for the engine-internal "script top-level return value".
 *
 * Used to share a file with the side pane's artifact card; once the card became the artifact pill,
 * only this dispatch -- shared by the side pane's small preview and the full-size tab -- remained.
 */
/**
 * Hands spec + items to one of the four renderers by kind. Shared by the side pane's compact card
 * and the full-size tab -- two separate switches would eventually skew ("small card draws, big one
 * blank") in exactly one place.
 */
export function ArtifactPresetBody({
  artifact,
  items,
  labels,
  compact,
  invalidLabel,
  missingLabel,
  className,
}: {
  artifact: Pick<WorkflowRunArtifactView, "kind" | "spec">;
  items: readonly ArtifactItem[];
  labels: PresetLabels;
  compact?: boolean;
  /** Fallback copy when spec is present but **unparseable**; absent renders nothing. */
  invalidLabel?: string;
  /** Copy when spec is **entirely absent**; absent renders nothing (see the loading note below). */
  missingLabel?: string;
  className?: string;
}) {
  if (!isArtifactPresetKind(artifact.kind)) return null;
  // "Spec absent" and "spec broken" must be stated separately.
  //
  // Only the journal query returns spec (the live projection deliberately omits it), so during the
  // **first frames after every pane open** spec is still undefined. Merging the two into one
  // "cannot render" is what makes every board flash an error line while loading. Therefore: absent =>
  // the caller decides (the side pane's compact card passes undefined and stays quiet; the full-size
  // tab passes missingLabel only once metadata **finished loading**).
  if (artifact.spec === undefined) {
    return missingLabel === undefined ? null : (
      <p
        className="text-ui-sm text-foreground-subtlest"
        data-testid="workflow-run-artifact-preset-missing"
      >
        {missingLabel}
      </p>
    );
  }
  const spec = parseArtifactPresetSpec(artifact.kind, artifact.spec);
  if (spec === undefined) {
    return invalidLabel === undefined ? null : (
      <p
        className="text-ui-sm text-foreground-subtlest"
        data-testid="workflow-run-artifact-preset-invalid"
      >
        {invalidLabel}
      </p>
    );
  }
  // All four `as` casts are guaranteed by the **same kind**: `parseArtifactPresetSpec(kind, ...)`
  // validates per kind, and whatever it accepts is that kind's spec. The 4b function has no
  // per-kind overloads (only `applyArtifactItems` does), so this narrowing can only happen at the
  // call site.
  const shared = { compact, items, labels, className };
  switch (artifact.kind) {
    case "chart":
      return <ArtifactChart spec={spec as ChartSpec} {...shared} />;
    case "table":
      return <ArtifactTable spec={spec as TableSpec} {...shared} />;
    case "metrics":
      return <ArtifactMetrics spec={spec as MetricsSpec} {...shared} />;
    default:
      return <ArtifactBoard spec={spec as BoardSpec} {...shared} />;
  }
}
