/**
 * `table` preset renderer: one row per item (or one row per entity upserted by `key`).
 *
 * Two variants:
 * - `compact`: row count + first 3 rows in the run side pane card;
 * - full size: the complete table in the `workflow-artifact` tab, sticky header, both-axis
 *   scroll.
 *
 * Deliberately NOT reusing `MarkdownTable`: that is a 1400-line rich component with
 * sorting/selection/copy/virtualization; dragging the whole thing in for a read-only
 * projection table is not worth it (the spec allows "or a lightweight table, decide during
 * implementation"). A fixed row cap bounds the DOM and the overflow is reported honestly in
 * the header count — far cheaper than a virtualizer, and items are already bounded at the
 * projection layer.
 */

import { memo, useMemo } from "react";
import {
  applyArtifactItems,
  type ArtifactItem,
} from "@/app-shell/workflow-artifacts/presets/apply.js";
import {
  fieldHeading,
  PresetEmpty,
  PresetHeading,
  REVEAL_ANIMATION_CLASS,
  type PresetLabels,
} from "@/app-shell/workflow-artifacts/presets/parts.js";
import type { TableSpec } from "@/app-shell/workflow-artifacts/presets/spec.js";
import { cn } from "@/components/lib/utils.js";

/** The compact card shows only the first rows — a "there is data" signal, not a reading surface. */
const COMPACT_ROWS = 3;
/** Rows actually mounted in full size; beyond this nobody reads it and DOM size must stay bounded. */
const ARTIFACT_TABLE_MAX_ROWS = 200;

export const ArtifactTable = memo(function ArtifactTable({
  spec,
  items,
  compact = false,
  labels,
  className,
}: {
  spec: TableSpec;
  items: readonly ArtifactItem[];
  compact?: boolean;
  labels: PresetLabels;
  className?: string;
}) {
  const model = useMemo(() => applyArtifactItems("table", spec, items), [spec, items]);
  const total = model.rows.length;
  const visible = compact
    ? model.rows.slice(0, COMPACT_ROWS)
    : model.rows.slice(0, ARTIFACT_TABLE_MAX_ROWS);

  if (total === 0) {
    return (
      <div className={className}>
        {compact ? null : (
          <PresetHeading className="mb-3" description={spec.description} title={spec.title} />
        )}
        <PresetEmpty compact={compact} label={labels.empty} />
      </div>
    );
  }

  const count = (
    <span
      className="shrink-0 font-mono text-ui-xs text-foreground-subtlest tabular-nums"
      data-testid="artifact-table-count"
    >
      {labels.itemsCount(total)}
    </span>
  );

  return (
    <div className={cn("min-w-0", className)} data-testid="artifact-table">
      {compact ? (
        <div className="mb-1.5 flex justify-end">{count}</div>
      ) : (
        <PresetHeading
          className="mb-3"
          description={spec.description}
          title={spec.title}
          trailing={count}
        />
      )}
      {/* Wide content scrolls horizontally in its own container; never give the pane itself a horizontal scrollbar (DESIGN.md responsive rules). */}
      <div
        className={cn(
          "min-w-0 overflow-auto rounded-lg border border-border",
          compact ? "" : "max-h-128",
        )}
      >
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr>
              {model.columns.map((column) => (
                <th
                  className="whitespace-nowrap border-b border-border px-2 py-1.5 text-ui-xs font-medium text-foreground-subtle"
                  key={column.field}
                  scope="col"
                >
                  {fieldHeading(column.label, column.unit)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              // Identity is the row id (the spec's key value, or the journal's
              // siteId@ordinal) — stable, so only NEW rows play the reveal while existing
              // rows update in place without flashing.
              <tr
                className={cn(
                  "border-b border-border/60 last:border-b-0 hover:bg-hover",
                  REVEAL_ANIMATION_CLASS,
                )}
                data-testid="artifact-table-row"
                key={row.id}
              >
                {row.cells.map((cell, index) => (
                  <td
                    className="max-w-56 truncate px-2 py-1 font-mono text-ui-xs text-foreground"
                    key={model.columns[index]?.field ?? index}
                    title={cell}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});
