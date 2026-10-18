/**
 * Small shared parts for the four preset renderers: the labels contract, empty state, field
 * headings, and the reveal-animation class.
 *
 * These components NEVER touch i18n: the run side pane and the `workflow-artifact` tab each
 * hold their own intl and pass translated strings via `labels`. Rationale: the renderers
 * must be reusable from side pane, tab, and (future) hub detail page; who calls what what
 * is the caller's call. Having components look up message ids would weld those three
 * surfaces together.
 */

import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

/** The three translations every caller must supply (all other copy comes from the spec author's label/title). */
export type PresetLabels = {
  /** Name of the board column catching statuses not listed in `columns`. */
  otherColumn: string;
  /** Shown before any data has arrived. */
  empty: string;
  /** "N items" — table rows, board cards. */
  itemsCount: (count: number) => string;
};

/**
 * Reveal animation for new elements. Stable React key + plays once on MOUNT only, so
 * existing points do not replay as new ones arrive; fully disabled under `motion-reduce`.
 */
export const REVEAL_ANIMATION_CLASS =
  "animate-in fade-in duration-300 ease-out motion-reduce:animate-none";

/** Empty state. Minimal presence: a board is legitimately empty early in a run. */
export function PresetEmpty({ label, compact }: { label: string; compact?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-lg border border-dashed border-border text-foreground-subtlest",
        compact ? "px-2 py-3 text-ui-xs" : "px-4 py-8 text-ui-sm",
      )}
      data-testid="artifact-preset-empty"
    >
      {label}
    </div>
  );
}

/** Field heading convention: the unit follows the label in parentheses, never repeated per value (dataviz convention). */
export function fieldHeading(label: string, unit?: string): string {
  return unit ? `${label} (${unit})` : label;
}

/**
 * Full-size heading bar: the spec's title/description are authored in user language and
 * rendered verbatim. When all three are absent the whole block is OMITTED (margins
 * included) — hence the margins live here, not in a caller's wrapper div.
 */
export function PresetHeading({
  title,
  description,
  trailing,
  className,
}: {
  title?: string;
  description?: string;
  trailing?: ReactNode;
  className?: string;
}) {
  if (!title && !description && !trailing) {
    return null;
  }
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        {title ? (
          <div className="truncate text-ui-base font-medium text-foreground">{title}</div>
        ) : null}
        {description ? (
          <div className="mt-0.5 text-ui-sm text-foreground-subtle">{description}</div>
        ) : null}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  );
}
