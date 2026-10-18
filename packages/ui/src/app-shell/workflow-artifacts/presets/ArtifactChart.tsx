/**
 * ENTRY point of the `chart` preset renderer: lazy loading plus localized failure
 * isolation; this module itself never touches recharts.
 *
 * Why lazy is mandatory: recharts triggers decimal.js-light's LN10 check at module-init
 * time, which blocks the whole renderer boot in Electron Linux containers (the fix recorded
 * in `AppUsagePanel.tsx`; the spec's preset-renderer row also mandates `lazy()`).
 * Therefore:
 * - the plotting body lives in `ArtifactChartView.tsx`, reachable only via `lazy()` dynamic
 *   import;
 * - this file and `index.ts` have no static recharts dependency, so importing them never
 *   pulls charts into the first paint.
 *
 * Callers may bypass this wrapper with their own
 * `lazy(() => import(".../ArtifactChartView.js"))` and own Suspense/error boundaries —
 * this file is just the default wiring for that pattern.
 */

import { lazy, Suspense } from "react";
import type { ArtifactItem } from "@/app-shell/workflow-artifacts/presets/apply.js";
import type { PresetLabels } from "@/app-shell/workflow-artifacts/presets/parts.js";
import type { ChartSpec } from "@/app-shell/workflow-artifacts/presets/spec.js";
import { cn } from "@/components/lib/utils.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";

const ArtifactChartView = lazy(
  () => import("@/app-shell/workflow-artifacts/presets/ArtifactChartView.js"),
);

/** Loading placeholder: space only, no words — a "loading" label in a 200ms lazy load just flickers. */
function ChartSkeleton({ compact }: { compact: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "w-full animate-pulse rounded-lg bg-surface motion-reduce:animate-none",
        compact ? "h-14" : "h-56",
      )}
      data-testid="artifact-chart-skeleton"
    />
  );
}

export function ArtifactChart({
  spec,
  items,
  compact = false,
  labels,
  className,
}: {
  spec: ChartSpec;
  items: readonly ArtifactItem[];
  compact?: boolean;
  labels: PresetLabels;
  className?: string;
}) {
  return (
    // A chart crash collapses only this block; the rest of the run side pane keeps working — the artifact area is a deliverable surface and must not be a single point of failure.
    <ScopedErrorBoundary
      resetKeys={[spec, compact]}
      scope="workflow-artifact-chart"
      variant={compact ? "compact" : "inline"}
    >
      <Suspense fallback={<ChartSkeleton compact={compact} />}>
        <ArtifactChartView
          className={className}
          compact={compact}
          items={items}
          labels={labels}
          spec={spec}
        />
      </Suspense>
    </ScopedErrorBoundary>
  );
}
