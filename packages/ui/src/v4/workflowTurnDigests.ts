import type {
  WorkflowLaunchMeta,
  WorkflowSettingsAmendMeta,
} from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { readWorkflowName } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnFlowItems.js";

/**
 * Turn-tail run-card resolution: which sources in this turn
 * name a run. Pure functions, cut along the same seam as `resolveCronAutomationTurnCards`.
 *
 * Three sources, one rule - every source naming a runId yields a card:
 * - Direct launch turn (`unit.workflowLaunch`): metadata carries runId / toolCallId /
 *   name; it is the entire presentation of the turn (no user row rendered).
 * - CreateWorkflow row: joined by toolCallId (the projected run.toolCallId is the initiating row); the row itself names no runId,
 *   so rows without a run join (rejected / compile error) get no card.
 * - ResumeWorkflowRun row: the display payload carries runId (the projected toolCallId is reused across resume, unreachable
 *   by toolCallId lookups).
 *
 * The graph is a property of the run: look it up in the host-built graph by the run initiating toolCallId, regardless of the hosting row -
 * a resume row thus shares the initiator graph. Sources that cannot join the live projection (evicted / cold recovery) still get a card with
 * `summary` absent, degraded to a neutral single line. One run, one card per turn (first-seen source).
 *
 * One exception: the in-place settings turn (`rowOnly`) names a run without starting or resuming it - it only changed
 * that run concurrency limit. That run card already lives in the turn that started it, so this source contributes the row above only.
 */
export interface WorkflowTurnDigest {
  key: string;
  /** Source id this card hangs on (swapped to the initiating row id by `resolveWorkflowRunOpenToolCallId` when opening the side panel). */
  toolCallId: string;
  runId: string;
  /** Script `name`; the renderer localizes a fallback name when absent. */
  name: string | undefined;
  graph: WorkflowCausalityGraphData | undefined;
  /** Live-projection join digest; absent = run not in the projection, card degrades to a neutral row (ended). */
  summary: WorkflowRunCardSummary | undefined;
  /**
   * Settings turn: which run this card
   * config was revised from, and what changed. When present, an adjusted-settings row renders above the card; `at` is that turn time.
   */
  settings?: { amend: WorkflowSettingsAmendMeta; at?: number };
  /**
   * Row only, no card: the in-place settings turn (concurrency-limit only, run still running, `amend` without `predecessorRunId`). Its run was not
   * replaced - identity intact - and its card already lives in the turn that started it; a second card would read as a second run. Always with `settings`.
   */
  rowOnly?: true;
}

interface WorkflowTurnDigestSource {
  workflowLaunch?: WorkflowLaunchMeta;
  assistantWorkRows: readonly AssistantWorkRow[];
  /** When this turn started (the settings-row timestamp). */
  startedAt?: number;
}

interface WorkflowTurnDigestJoin {
  byToolCallId?: ReadonlyMap<string, WorkflowRunCardSummary>;
  byRunId?: ReadonlyMap<string, WorkflowRunCardSummary>;
  graphByToolCallId?: ReadonlyMap<string, WorkflowCausalityGraphData>;
}

export function resolveWorkflowTurnDigests(
  unit: WorkflowTurnDigestSource,
  join: WorkflowTurnDigestJoin,
): WorkflowTurnDigest[] {
  const digests: WorkflowTurnDigest[] = [];
  const seen = new Set<string>();
  const graphOf = (originToolCallId: string | undefined) =>
    originToolCallId === undefined ? undefined : join.graphByToolCallId?.get(originToolCallId);

  const launch = unit.workflowLaunch;
  if (launch !== undefined) {
    // In-place settings turn: `amend` carries no predecessorRunId (absent = no predecessor, it amended itself,
    // workflow-row-meta.ts). It is the only source naming a run without starting/resuming it, so it does
    // NOT take this turn card slot - the source that actually launched the run still gets its card.
    const rowOnly = launch.amend !== undefined && launch.amend.predecessorRunId === undefined;
    if (!rowOnly) seen.add(launch.runId);
    digests.push({
      graph: graphOf(launch.toolCallId),
      key: `launch:${launch.toolCallId}`,
      name: launch.name,
      runId: launch.runId,
      summary: join.byRunId?.get(launch.runId),
      toolCallId: launch.toolCallId,
      ...(rowOnly ? { rowOnly: true as const } : {}),
      ...(launch.amend === undefined
        ? {}
        : {
            settings: {
              amend: launch.amend,
              ...(unit.startedAt === undefined ? {} : { at: unit.startedAt }),
            },
          }),
    });
  }

  for (const row of unit.assistantWorkRows) {
    if (row.kind !== "toolCall") continue;
    const created = join.byToolCallId?.get(row.toolCallId);
    if (created !== undefined) {
      if (seen.has(created.runId)) continue;
      seen.add(created.runId);
      digests.push({
        graph: graphOf(row.toolCallId),
        key: `${row.rowId}:${row.toolCallId}`,
        name: readWorkflowName(row.input),
        runId: created.runId,
        summary: created,
        toolCallId: row.toolCallId,
      });
      continue;
    }
    if (row.display?.kind !== "resume_workflow_run") continue;
    const runId = row.display.runId;
    if (seen.has(runId)) continue;
    seen.add(runId);
    const resumed = join.byRunId?.get(runId);
    digests.push({
      // The initiating row id is only known via the projection join; resume cards outside the projection have no graph to find.
      graph: graphOf(resumed?.toolCallId),
      key: `${row.rowId}:${row.toolCallId}`,
      name: undefined,
      runId,
      summary: resumed,
      toolCallId: row.toolCallId,
    });
  }
  return digests;
}
