import { type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";

/**
 * Header bar for collapsible sections in the workflow run detail page.
 *
 * The pending-questions and artifacts sections share this one bar: their collapse semantics
 * are identical, and duplicating them would eventually drift in radius, hover color, or
 * chevron angle. The prototype was the old Script section's toggle (extracted verbatim), so
 * this bar introduces NO new visual vocabulary. The Results/event-log/Script sections are
 * gone; the two remaining callers default oppositely (questions collapsed, artifacts
 * expanded) — that is each section's business, not this component's.
 *
 * The header owns only open/close; data fetching, gating, and layout stay with each
 * section.
 *
 * Deliberately not memoized: its callers are themselves memo components that re-render only
 * when their state or projection changes — exactly when this bar's
 * `expanded`/`label`/`trailing` change. Wrapping in memo would only force `onToggle` and
 * `trailing` into `useCallback`/`useMemo` (the reactStableReferences guard requires it) for
 * a comparison that can never hit.
 */
export function WorkflowRunSectionToggle({
  expanded,
  label,
  onToggle,
  testId,
  title,
  trailing,
}: {
  expanded: boolean;
  /** aria-label: "Expand X"/"Collapse X" per state; the title itself is carried by `title`. */
  label: string;
  onToggle: () => void;
  testId: string;
  title: string;
  /**
   * Ancillary header info (counts, loading hints, ...). Present while collapsed too —
   * collapsing must not hide whether the section has anything in it.
   */
  trailing?: ReactNode;
}) {
  return (
    <button
      aria-expanded={expanded}
      aria-label={label}
      className="flex w-full items-center gap-1.5 px-4 py-2 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/40"
      data-testid={testId}
      onClick={onToggle}
      type="button"
    >
      <ChevronRightIcon
        className={cn(
          "size-3.5 shrink-0 text-foreground-subtlest transition-transform",
          expanded ? "rotate-90" : undefined,
        )}
      />
      <span className="min-w-0 flex-1 truncate text-ui-xs font-medium text-foreground-subtle">
        {title}
      </span>
      {trailing}
    </button>
  );
}
