/**
 * The **subagent roster** of the GetWorkflowRun tool card (the other half of the situation
 * snapshot; phase track and health line live in get-workflow-run-situation.tsx).
 *
 * Each row reads exactly like the model-facing text
 * (apps/zcode-cli/packages/core/src/tool/handlers/get-workflow-run-format-roster.ts):
 * "who - where - which phase - which stage - doing what - tokens spent", where "doing what" forks
 * by phase: running rows show progress and last tool; waiting rows say what they await and for how
 * much longer; parked rows name the question. That is the reason this card exists: see at a glance
 * who is stuck.
 *
 * The payload is a **flat row** (no `currentAsk` nesting), so "is an ask in flight" is inferred
 * from the presence of those readouts; absent values are never drawn, and 0 never stands in for
 * unknown.
 */

import type { ToolCallGetWorkflowRunDisplay } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatWorkflowAge,
  formatWorkflowDuration,
  formatWorkflowTokenCount,
} from "@/lib/workflowObservationFormat.js";
import {
  SITUATION_BLOCK_CLASS,
  SITUATION_ROW_CLASS,
} from "@/ToolCallBlocks/renderers/get-workflow-run-situation.js";

type WorkflowRunSubagentView = NonNullable<ToolCallGetWorkflowRunDisplay["subagents"]>[number];
type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

const I18N_PREFIX = "chat.toolCall.workflow.getRun.";

/**
 * Semantic color per phase word. The word is always present; color is the second channel
 * (DESIGN: status never relies on color alone): active work uses the activity color warning,
 * waiting and unfinished terminal states sit in between, done is success, failed destructive.
 * `parked` also uses the activity color - it awaits a human answer, an attention state, not
 * quiet idle.
 */
const SUBAGENT_STATE_TEXT: Record<WorkflowRunSubagentView["state"], string> = {
  idle: "text-foreground-subtlest",
  executing: "text-warning",
  waiting: "text-foreground-subtle",
  parked: "text-warning",
  done: "text-success",
  failed: "text-destructive",
  unfinished: "text-foreground-subtle",
};

export function WorkflowRunSubagentRoster({
  subagents,
  generatedAt,
}: {
  subagents: readonly WorkflowRunSubagentView[];
  generatedAt: number | undefined;
}) {
  const { intl } = useZCodeIntl();
  // An empty roster draws nothing: no subagents spawned yet needs no whole section to say.
  if (subagents.length === 0) return null;
  return (
    <div className={SITUATION_BLOCK_CLASS} data-testid="workflow-run-subagents">
      {subagents.map((subagent) => {
        const activity = subagentActivity(subagent, generatedAt, intl.formatMessage);
        return (
          <div className="min-w-0 space-y-0.5" key={`${subagent.siteId}@${subagent.ordinal}`}>
            <div className={`${SITUATION_ROW_CLASS} text-ui-sm`}>
              {/* Anonymous subagents get no synthesized fallback name: leave empty; the address still identifies them. */}
              {subagent.name === undefined ? null : (
                <span className="min-w-0 break-words text-foreground">{subagent.name}</span>
              )}
              <span className="break-all font-mono text-ui-xs text-foreground-subtlest">
                {subagent.siteId}@{subagent.ordinal}
              </span>
              <span className={`shrink-0 ${SUBAGENT_STATE_TEXT[subagent.state]}`}>
                {intl.formatMessage({ id: `${I18N_PREFIX}subagent.state.${subagent.state}` })}
              </span>
              {subagent.phaseName === undefined ? null : (
                <span className="min-w-0 break-words text-foreground-subtle">
                  {intl.formatMessage(
                    { id: `${I18N_PREFIX}subagent.phase` },
                    { name: subagent.phaseName },
                  )}
                </span>
              )}
              {activity.map((cell) => (
                <span className="min-w-0 break-words text-foreground-subtle" key={cell}>
                  {cell}
                </span>
              ))}
              {subagent.tokens > 0 ? (
                <span className="shrink-0 tabular-nums text-foreground-subtlest">
                  {intl.formatMessage(
                    { id: "chat.toolCall.workflow.run.usage.tokens" },
                    { tokens: formatWorkflowTokenCount(subagent.tokens) },
                  )}
                </span>
              ) : null}
            </div>
            {subagent.instructionsHead === undefined ||
            subagent.instructionsHead.length === 0 ? null : (
              // The task row belongs to the row above, not a new fact: indent, do not start a new cell.
              <p className="min-w-0 break-words pl-3 text-ui-sm text-foreground-subtle">
                {intl.formatMessage(
                  { id: `${I18N_PREFIX}subagent.task` },
                  { task: subagent.instructionsHead },
                )}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Any of those progress readouts present means an ask stands behind this row (the flat payload has no currentAsk marker). */
function hasCurrentAsk(subagent: WorkflowRunSubagentView): boolean {
  return (
    subagent.startedAt !== undefined ||
    subagent.turn !== undefined ||
    subagent.toolCalls !== undefined ||
    subagent.lastTool !== undefined ||
    subagent.instructionsHead !== undefined
  );
}

function subagentActivity(
  subagent: WorkflowRunSubagentView,
  generatedAt: number | undefined,
  formatMessage: FormatMessage,
): string[] {
  if (subagent.state === "parked" && subagent.parkedOn !== undefined) {
    // qid only, no asked-at instant: the card payload lacks pendingQuestions, so the row cannot say how long it has waited.
    return [formatMessage({ id: `${I18N_PREFIX}subagent.parkedOn` }, { qid: subagent.parkedOn })];
  }
  if (subagent.state === "waiting") return waitCells(subagent, generatedAt, formatMessage);
  if (subagent.state === "unfinished" && hasCurrentAsk(subagent)) {
    return [formatMessage({ id: `${I18N_PREFIX}subagent.inFlightAtStop` })];
  }
  if (hasCurrentAsk(subagent)) {
    const cells = executingCells(subagent, generatedAt, formatMessage);
    // An ask in flight with no readouts at all (old journal): fall back to settled steps; never leave a row with only a phase word.
    return cells.length > 0 ? cells : settledCells(subagent, formatMessage);
  }
  return settledCells(subagent, formatMessage);
}

function executingCells(
  subagent: WorkflowRunSubagentView,
  generatedAt: number | undefined,
  formatMessage: FormatMessage,
): string[] {
  const cells: string[] = [];
  const onStep = formatWorkflowAge(generatedAt, subagent.startedAt);
  if (onStep !== undefined) {
    cells.push(formatMessage({ id: `${I18N_PREFIX}subagent.onStep` }, { age: onStep }));
  }
  if (subagent.turn !== undefined) {
    cells.push(formatMessage({ id: `${I18N_PREFIX}subagent.turn` }, { count: subagent.turn }));
  }
  if (subagent.toolCalls !== undefined) {
    cells.push(
      formatMessage(
        {
          id: `${I18N_PREFIX}subagent.${subagent.toolCalls === 1 ? "toolCallsOne" : "toolCalls"}`,
        },
        { count: subagent.toolCalls },
      ),
    );
  }
  if (subagent.lastTool !== undefined) {
    const { name, target, at } = subagent.lastTool;
    const age = formatWorkflowAge(generatedAt, at);
    cells.push(
      [
        formatMessage({ id: `${I18N_PREFIX}subagent.lastTool` }, { name }),
        target,
        age === undefined ? undefined : formatMessage({ id: `${I18N_PREFIX}age` }, { age }),
      ]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join(" "),
    );
  }
  return cells;
}

function waitCells(
  subagent: WorkflowRunSubagentView,
  generatedAt: number | undefined,
  formatMessage: FormatMessage,
): string[] {
  if (subagent.waitCause === undefined) return [];
  const cells = [
    formatMessage({
      id: `${I18N_PREFIX}subagent.${subagent.waitCause === "slot" ? "waitingSlot" : "waitingBackoff"}`,
    }),
  ];
  // "Waiting since" sits next to the reason, "waiting until" closes the line: two durations side by side are otherwise indistinguishable.
  const waited = formatWorkflowAge(generatedAt, subagent.waitSince);
  if (waited !== undefined) {
    cells.push(formatMessage({ id: `${I18N_PREFIX}subagent.waitedFor` }, { age: waited }));
  }
  if (subagent.retryAfterMs !== undefined) {
    cells.push(
      formatMessage(
        { id: `${I18N_PREFIX}subagent.retryIn` },
        { duration: formatWorkflowDuration(subagent.retryAfterMs) },
      ),
    );
  }
  return cells;
}

function settledCells(subagent: WorkflowRunSubagentView, formatMessage: FormatMessage): string[] {
  if (subagent.stepsSettled === 0 && subagent.stepsFailed === 0) return [];
  const cells = [
    formatMessage(
      { id: `${I18N_PREFIX}subagent.${subagent.stepsSettled === 1 ? "stepsOne" : "steps"}` },
      { count: subagent.stepsSettled },
    ),
  ];
  if (subagent.stepsFailed > 0) {
    cells.push(
      formatMessage({ id: `${I18N_PREFIX}subagent.stepsFailed` }, { count: subagent.stepsFailed }),
    );
  }
  return cells;
}
