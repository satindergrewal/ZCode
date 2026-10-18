// ============================================================
// Dynamic Workflow Run's **situation snapshot**: phases / subagents / health
// ============================================================
// `getRunDetail` used to offer only counts and a
// log tail, unable to answer the model's three real questions: where is the run, what is each subagent doing now, is it still moving.
// This module is the derivation of exactly those three, and **only a derivation** -- pure functions, no journal, no registry, no clock:
// events, node rows, actor rows, reducer state, parked questions, and `now` all arrive from the caller.
//
// Why pure: the rules for these three field groups (state-word order, absent-reading, the single time source) are dense
// and error-prone, while their data sources (SQLite journal + engine registry) are brutally expensive in tests. Separating rules from fetching
// lets hand-made events and rows pin the rules; one integration test then proves the wiring.
//
// Split: event scan in -roster-events.ts, phase table in -roster-phases.ts, roster in
// -roster-subagents.ts (each header documents its own fetch discipline); this file keeps the public contract, health face, and orchestration.

import type {
  DynamicWorkflowRunHealth,
  DynamicWorkflowRunLifecycleStatus,
  DynamicWorkflowRunPendingQuestion,
  DynamicWorkflowRunPhaseView,
  DynamicWorkflowRunSubagentView,
} from "@zcode/contracts";
import type { ActorRecord, NodeRecord, StoredEvent } from "@zcode/dynamic-workflow";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { TERMINAL_RUN_STATUSES } from "./dynamic-workflow-run-observation.js";
import {
  indexRosterEvents,
  instanceKey,
  type RosterEventIndex,
} from "./dynamic-workflow-run-roster-events.js";
import { buildPhaseViews } from "./dynamic-workflow-run-roster-phases.js";
import { buildSubagentViews, NODE_ROW_RUNNING } from "./dynamic-workflow-run-roster-subagents.js";

/** The `kind` of ask node rows. Streaks count ask settlements only: a world-read failure is not "subagents dying in a row". */
const ASK_NODE_KIND = "ask";

/** The situation snapshot's fetch inputs. */
export interface WorkflowRunRosterInput {
  /**
   * This run's reducer state (journal events replayed into the same reducer as the run panel).
   * A run with zero events (registry gap) passes `undefined`: no phase table, empty roster.
   */
  run: WorkflowRunState | undefined;
  /** All of the run's journal events, ascending sequence. The **only** source of time. */
  events: readonly StoredEvent[];
  /**
   * Non-report node rows, without results (`listNodes(runId, {kinds: NON_REPORT_NODE_KINDS, withResult:
   * false})`). Contribute status and `stats` only; no time columns on the row.
   */
  nodes: readonly NodeRecord[];
  /** `journal.listActors(runId, {withPersona: false})`. The roster's roster. */
  actors: readonly ActorRecord[];
  /** The run's lifecycle state, the same value the detail face shows (terminal or not rewrites half the state words). */
  status: DynamicWorkflowRunLifecycleStatus;
  /**
   * Questions parked on this run; **`undefined` = this read cannot see the park table** (the run lives
   * in another process); then `health.pendingQuestionsKnown` is false and no subagent is reported `parked`.
   * An empty array is the opposite: a definite "nobody waiting".
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /** The instant of this read, used only to **clamp** event times (see -roster-events.ts's `timeOf`). */
  now: number;
}

/** The situation snapshot: the detail face spreads these three keys. */
export interface WorkflowRunRoster {
  phases?: DynamicWorkflowRunPhaseView[];
  subagents: DynamicWorkflowRunSubagentView[];
  health: DynamicWorkflowRunHealth;
}

/** Derives the situation snapshot from the facts a getRunDetail already fetched. */
export function buildWorkflowRunRoster(input: WorkflowRunRosterInput): WorkflowRunRoster {
  const { run, events, nodes, actors, status, pendingQuestions, now } = input;
  const terminal = TERMINAL_RUN_STATUSES.has(status);
  const index = indexRosterEvents(events, now);
  const phases = buildPhaseViews({ run, index, terminal });
  return {
    ...(phases === undefined ? {} : { phases }),
    subagents: buildSubagentViews({
      actors,
      nodes,
      run,
      index,
      terminal,
      ...(pendingQuestions === undefined ? {} : { pendingQuestions }),
    }),
    health: buildHealth({ run, nodes, index, terminal, pendingQuestions }),
  };
}

/** Whether the run as a whole is still moving (see `DynamicWorkflowRunHealth`). */
function buildHealth(input: {
  run: WorkflowRunState | undefined;
  nodes: readonly NodeRecord[];
  index: RosterEventIndex;
  terminal: boolean;
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
}): DynamicWorkflowRunHealth {
  const { run, nodes, index, terminal, pendingQuestions } = input;
  // Only terminal runs count leftovers: while alive, "rows marked running" is just the run working.
  const leftoverRunning = terminal
    ? nodes.filter((node) => node.status === NODE_ROW_RUNNING).length
    : 0;
  return {
    ...(index.lastProgressAt === undefined ? {} : { lastProgressAt: index.lastProgressAt }),
    ...(index.stalledSince === undefined ? {} : { stalledSince: index.stalledSince }),
    ...concurrencyField(run, index),
    consecutiveFailures: countTrailingFailures(nodes, index),
    cachedSteps: index.settlements.filter((settlement) => settlement.cached).length,
    ...(leftoverRunning === 0 ? {} : { leftoverRunning }),
    pendingQuestionsKnown: pendingQuestions !== undefined,
  };
}

/**
 * The concurrency picture.
 *
 * `cap` is **this run's own** bound: the user-set number, else default concurrency (`concurrency.ceiling`,
 * a key that predates the default-concurrency concept).
 * `effective` is what the governor actually admits now, i.e. min with the shared gate once more.
 *
 * **Present only when `effective < cap`**, the same absence rule as the detail's `maxConcurrency`: a run
 * bound has nothing to say. Reporting the default as `cap` is wrong — a run started with `max_concurrency: 3` would
 * six-core machine would read "3/6" forever, like being throttled, while running on the user's own bound.
 */
function concurrencyField(
  run: WorkflowRunState | undefined,
  index: RosterEventIndex,
): Pick<DynamicWorkflowRunHealth, "concurrency"> {
  const concurrency = run?.concurrency;
  if (concurrency === undefined) return {};
  const cap = concurrency.limit ?? concurrency.ceiling;
  const effective = Math.min(concurrency.cap, cap);
  if (effective >= cap) return {};
  return {
    concurrency: {
      effective,
      cap,
      ...(index.concurrencyReason === undefined ? {} : { reason: index.concurrencyReason }),
      ...(index.concurrencySince === undefined ? {} : { since: index.concurrencySince }),
    },
  };
}

/**
 * Consecutively failed asks at the **end** of the settlement order: 3 in a row and 3 scattered are different situations --
 * the former predicts the next failure too. Asks only -- world-read failures are the script's problem, not subagents collapsing.
 * `cancelled` breaks the streak like success: cancelled is not failed.
 */
function countTrailingFailures(nodes: readonly NodeRecord[], index: RosterEventIndex): number {
  const askKeys = new Set(
    nodes
      .filter((node) => node.kind === ASK_NODE_KIND)
      .map((node) => instanceKey(node.siteId, node.ordinal)),
  );
  let failures = 0;
  for (let position = index.settlements.length - 1; position >= 0; position -= 1) {
    const settlement = index.settlements[position]!;
    if (!askKeys.has(settlement.key)) continue;
    if (settlement.outcome !== "failed") break;
    failures += 1;
  }
  return failures;
}
