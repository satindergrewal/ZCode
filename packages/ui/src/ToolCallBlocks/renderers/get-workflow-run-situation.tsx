/**
 * The **situation snapshot** of the GetWorkflowRun tool card: stage track + health line (roster in
 * get-workflow-run-roster.tsx).
 *
 * Two disciplines, verbatim from the model-facing text
 * (apps/zcode-cli/packages/core/src/tool/handlers/get-workflow-run-format-roster.ts):
 *   1. **Absent means not drawn.** No timestamp, no age; no reading, no cell. Zero is a fact while
 *      unknown is another - never substitute 0 for the latter.
 *   2. Every age is computed against the snapshot instant `generatedAt`, never `Date.now()`: a
 *      three-day-old card reopened must not drift with today. Without generatedAt, no ages at all.
 *
 * Layout: always wrapping rows (flex-wrap), no fixed-width tables - on narrow phone screens rows must wrap, not overflow horizontally.
 */

import type { ToolCallGetWorkflowRunDisplay } from "@zcode/shared/zcode-protocol-v4";
import { throttleReasonLabel } from "@/app-shell/workflowRunThrottle.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatWorkflowAge, formatWorkflowDuration } from "@/lib/workflowObservationFormat.js";

type WorkflowRunPhaseView = NonNullable<ToolCallGetWorkflowRunDisplay["phases"]>[number];
type WorkflowRunHealthView = NonNullable<ToolCallGetWorkflowRunDisplay["health"]>;

const I18N_PREFIX = "chat.toolCall.workflow.getRun.";

/** Container for situation sections: the same low-level container as the log panel within this card, not a second card face. */
export const SITUATION_BLOCK_CLASS =
  "min-w-0 space-y-1 rounded-lg border border-border bg-surface px-2 py-1.5";

/** One row inside a situation section: wraps on narrow screens, baseline-aligned (mixed numbers/text never push each other taller). */
export const SITUATION_ROW_CLASS = "flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5";

/**
 * Semantic color for stage status words. Same judgment as the run's overall status
 * (run-status-presentation.ts): active work uses activity warning, done success, not-yet-started
 * the faintest, unfinished terminal states in between.
 */
const PHASE_STATE_TEXT: Record<WorkflowRunPhaseView["state"], string> = {
  done: "text-success",
  current: "text-warning",
  ahead: "text-foreground-subtlest",
  unfinished: "text-foreground-subtle",
};

/**
 * Stage track: one stage per row in declaration order. An ahead row carries only the number, name
 * and status word - it has not happened, so there are no rounds or steps to report.
 */
export function WorkflowRunPhaseTrack({
  phases,
  generatedAt,
  terminal,
}: {
  phases: readonly WorkflowRunPhaseView[];
  generatedAt: number | undefined;
  terminal: boolean;
}) {
  const { intl } = useZCodeIntl();
  if (phases.length === 0) return null;
  return (
    <div className={SITUATION_BLOCK_CLASS} data-testid="workflow-run-phases">
      {phases.map((phase, index) => {
        const cells: string[] = [];
        // rounds 0 can only be ahead: a stage never entered cannot say how often it ran.
        if (phase.rounds > 0) {
          cells.push(
            intl.formatMessage(
              { id: `${I18N_PREFIX}phase.${phase.rounds === 1 ? "roundsOne" : "rounds"}` },
              { count: phase.rounds },
            ),
          );
        }
        if (phase.nodesSettled > 0) {
          cells.push(
            intl.formatMessage(
              { id: `${I18N_PREFIX}phase.settled` },
              { count: phase.nodesSettled },
            ),
          );
        }
        if (phase.nodesRunning > 0) {
          // Inside a terminal run, still-running means unsettled, not active.
          cells.push(
            intl.formatMessage(
              { id: `${I18N_PREFIX}phase.${terminal ? "unfinished" : "running"}` },
              { count: phase.nodesRunning },
            ),
          );
        }
        const duration = phaseDuration(phase, generatedAt, terminal, intl.formatMessage);
        return (
          <div className={SITUATION_ROW_CLASS} key={`${phase.name}-${index}`}>
            <span className="shrink-0 tabular-nums text-foreground-subtlest">{index + 1}.</span>
            <span className="min-w-0 break-words text-foreground">{phase.name}</span>
            <span className={`shrink-0 ${PHASE_STATE_TEXT[phase.state]}`}>
              {intl.formatMessage({ id: `${I18N_PREFIX}phase.state.${phase.state}` })}
            </span>
            {cells.map((cell) => (
              <span className="text-foreground-subtle" key={cell}>
                {cell}
              </span>
            ))}
            {duration === undefined ? null : (
              <span className="text-foreground-subtlest">{duration}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

function phaseDuration(
  phase: WorkflowRunPhaseView,
  generatedAt: number | undefined,
  terminal: boolean,
  formatMessage: FormatMessage,
): string | undefined {
  if (phase.enteredAt === undefined) return undefined;
  if (phase.exitedAt !== undefined) return formatWorkflowDuration(phase.exitedAt - phase.enteredAt);
  // No exit instant: a live run says so-far; a terminal run says nothing - nobody recorded its
  // exit, and subtracting from the snapshot instant would bill the post-mortem hours to this stage.
  if (terminal) return undefined;
  const soFar = formatWorkflowAge(generatedAt, phase.enteredAt);
  return soFar === undefined
    ? undefined
    : formatMessage({ id: `${I18N_PREFIX}phase.soFar` }, { duration: soFar });
}

/**
 * Health line: whether the run as a whole is still moving, in one row.
 *
 * stalled only means something for a live run (terminal runs obviously do not move); a terminal run
 * gets a **leftover note** instead - roster rows still marked running are remains under a dead
 * process. This is the only spot on the card that admits uncertainty out loud (the other is the
 * hidden pending-question hint): silence would read as "they are still running".
 *
 * consecutiveFailures / cachedSteps appear only when > 0: zero is not news for these readouts, and
 * the card is stingier with rows than the model-facing text.
 */
export function WorkflowRunHealthLine({
  health,
  generatedAt,
  terminal,
}: {
  health: WorkflowRunHealthView;
  generatedAt: number | undefined;
  terminal: boolean;
}) {
  const { intl } = useZCodeIntl();
  const cells: string[] = [];

  const lastProgress = formatWorkflowAge(generatedAt, health.lastProgressAt);
  if (lastProgress !== undefined) {
    cells.push(
      intl.formatMessage({ id: `${I18N_PREFIX}health.lastProgress` }, { age: lastProgress }),
    );
  }

  if (health.concurrency !== undefined) {
    const { effective, cap, reason, since } = health.concurrency;
    cells.push(intl.formatMessage({ id: `${I18N_PREFIX}health.concurrency` }, { effective, cap }));
    // Reason and start instant each get a cell, never parentheses: parenthesis shapes differ across
    // locales and this row reads cell by cell. reason is an open string - known values map to a
    // short label, unknown render verbatim.
    if (reason !== undefined) cells.push(throttleReasonLabel(reason, intl.formatMessage));
    const sinceAge = formatWorkflowAge(generatedAt, since);
    if (sinceAge !== undefined) {
      cells.push(
        intl.formatMessage({ id: `${I18N_PREFIX}health.concurrencySince` }, { age: sinceAge }),
      );
    }
  }

  if (!terminal) {
    const stalledAge = formatWorkflowAge(generatedAt, health.stalledSince);
    cells.push(
      health.stalledSince === undefined
        ? intl.formatMessage({ id: `${I18N_PREFIX}health.notStalled` })
        : stalledAge === undefined
          ? intl.formatMessage({ id: `${I18N_PREFIX}health.stalledNoClock` })
          : intl.formatMessage({ id: `${I18N_PREFIX}health.stalled` }, { age: stalledAge }),
    );
  }

  if (health.consecutiveFailures > 0) {
    cells.push(
      intl.formatMessage(
        {
          id: `${I18N_PREFIX}health.${health.consecutiveFailures === 1 ? "failuresOne" : "failures"}`,
        },
        { count: health.consecutiveFailures },
      ),
    );
  }
  if (health.cachedSteps > 0) {
    cells.push(
      intl.formatMessage(
        {
          id: `${I18N_PREFIX}health.${health.cachedSteps === 1 ? "cachedStepsOne" : "cachedSteps"}`,
        },
        { count: health.cachedSteps },
      ),
    );
  }

  const leftover = terminal ? health.leftoverRunning : undefined;
  if (cells.length === 0 && leftover === undefined) return null;
  return (
    <div className="min-w-0 space-y-1" data-testid="workflow-run-health">
      {cells.length === 0 ? null : (
        <div className={`${SITUATION_ROW_CLASS} text-ui-sm text-foreground-subtlest`}>
          {cells.map((cell) => (
            <span key={cell}>{cell}</span>
          ))}
        </div>
      )}
      {leftover === undefined ? null : (
        <p className="break-words text-ui-sm text-warning" data-testid="workflow-run-leftover">
          {intl.formatMessage(
            { id: `${I18N_PREFIX}health.${leftover === 1 ? "leftoverOne" : "leftover"}` },
            { count: leftover },
          )}
        </p>
      )}
    </div>
  );
}
