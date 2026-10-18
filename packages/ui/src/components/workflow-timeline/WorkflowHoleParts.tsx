import { PenIcon } from "lucide-react";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { TimelineHole } from "./timeline-holes.js";

/**
 * Small hole parts (docs/dynamic-workflow/presentation.md "Holes on the timeline"), shared by card, pane
 * and tool row: the pen mark beside a phase-less fill's station name (its head), the waiting metadata
 * word awaiting-fill, and the {n} holes-awaiting-fill chip for header and pane.
 *
 * The hole's type (the T in `hole<T>`) never appears in any UI: it is a contract between compiler and
 * main agent, not reading material. Observed 2026-09-28: rendered as a mono badge after the name,
 * `{ target: string; reason: string }` filled the header and squeezed the name to zero width — so only
 * the name remains.
 */
export function HoleFillMark({ className, holeId }: { className?: string; holeId: string }) {
  // The pen mark is the phase-less fill's head (presentation.md "Filled without phases"): pointer on it
  // and timeline and pane draw this station's frame (`data-fill-head`).
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-sm bg-tag px-1 text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground",
        className,
      )}
      data-fill-head={holeId}
      data-testid="workflow-hole-fill-mark"
    >
      <PenIcon aria-hidden className="size-2.5" />
    </span>
  );
}

/** The header's awaiting-fill word: warning color, no wrap; only while the run rests at this hole. */
export function HoleWaitingMeta({ hole }: { hole: TimelineHole | undefined }) {
  const { intl } = useZCodeIntl();
  if (hole?.state !== "waiting") return null;
  return (
    <span
      className="shrink-0 whitespace-nowrap text-ui-xs text-warning"
      data-testid="workflow-hole-waiting"
    >
      {intl.formatMessage({ id: "chat.toolCall.workflow.hole.waiting" })}
    </span>
  );
}

/** The pane status header's chip: reads the run's hole table directly, counts the waiting. */
export function RunHolesWaitingChip({
  run,
  testId,
}: {
  run: Pick<WorkflowRunState, "holes"> | undefined;
  testId: string;
}) {
  const count = (run?.holes ?? []).filter((hole) => hole.state === "waiting").length;
  return <HolesWaitingChip count={count} testId={testId} />;
}

/**
 * The {n} holes-awaiting-fill chip (run card header, pane status header): pen icon in the question
 * chip's slot; both can coexist. The question chip's exact face (warning 12% ground, `text-ui-xs`);
 * clickable, it opens the run's details.
 */
export function HolesWaitingChip({
  count,
  onOpen,
  testId = "workflow-digest-holes",
}: {
  count: number;
  onOpen?: () => void;
  testId?: string;
}) {
  const { intl } = useZCodeIntl();
  if (count <= 0) return null;
  const label = intl.formatMessage(
    {
      id:
        count === 1 ? "chat.toolCall.workflow.digest.hole" : "chat.toolCall.workflow.digest.holes",
    },
    { count },
  );
  const face =
    "wf-arrive flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--color-warning)_12%,transparent)] py-0.5 pl-1.5 pr-2 text-ui-xs font-medium text-warning";
  return onOpen === undefined ? (
    <span className={face} data-testid={testId}>
      <PenIcon aria-hidden className="size-3" />
      {label}
    </span>
  ) : (
    <button
      className={cn(
        face,
        "cursor-pointer outline-none transition-colors hover:bg-[color-mix(in_oklab,var(--color-warning)_20%,transparent)] focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
      data-testid={testId}
      onClick={onOpen}
      type="button"
    >
      <PenIcon aria-hidden className="size-3" />
      {label}
    </button>
  );
}
