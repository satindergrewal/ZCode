// ============================================================
// The GUI "Configure" settings turn: how it is recorded and worded
// ============================================================
// docs/dynamic-workflow/launch.md "The settings turn". Split out of dynamic-workflow-run-settings.ts
// (400-line discipline): that side owns decision and side-effect order; this side is "how this is told to the model and the session" —
// enqueueing, the from/to of both settings, and the two canonical sentences (revision spawned a new run / in-place on the same run).

import type { TraceContext, WorkflowSettingsAmendMeta } from "@zcode/contracts";
import type { DynamicWorkflowRunSnapshot } from "@zcode/contracts";
import { uuidv7 } from "@zcode/shared";
import { createRuntimeCommandId } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { boundWorkflowLaunchMeta } from "@zcode/contracts";

/** Normalized shape of the run's two settings: absent means default (session model / default concurrency). */
export interface RunSettings {
  subagentModel?: string;
  maxConcurrency?: number;
}

/**
 * The settings turn does not land inside command handling: the main agent may be mid-turn and a user message cannot be inserted. It queues on the
 * runtime queue — run immediately when idle, after the current turn when busy; same priority as notifications, hence before any notice of a new run (docs/dynamic-workflow/
 * launch.md "The settings turn").
 */
export function enqueueSettingsTurn(
  this: AgentRuntimeInternal,
  turn: {
    text: string;
    meta: ReturnType<typeof boundWorkflowLaunchMeta>;
    titleInput: string;
    traceContext: TraceContext;
  },
): void {
  this.enqueueRuntimeCommand({
    branchGeneration: this.branchGeneration,
    createdAt: new Date(),
    id: createRuntimeCommandId(),
    inputId: uuidv7(),
    mode: "control-only-turn",
    priority: "next",
    text: turn.text,
    titleInput: turn.titleInput,
    traceContext: turn.traceContext,
    workflowLaunch: turn.meta,
  });
}

export function fromTo<T>(from: T | undefined, to: T | undefined): { from?: T; to?: T } {
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

/**
 * Canonical model-side sentence for the settings turn (English, not localized — it enters the provider transcript). Only changed settings are named; each `null`
 * gets its own sentence. The final sentence discourages further model changes to this run: it is already running and progress arrives via notifications.
 *
 * The two outcomes fork here on the presence of `amend.predecessorRunId` (absent = in-place, read the same way as the metadata):
 * a revision spawned a new run, so in-place concurrency still targets the same run — follow the revision wording, or the model will hunt
 * a run B that does not exist.
 */
export function buildSettingsMessageText(input: {
  name?: string;
  previous: string;
  runId: string;
  superseded: boolean;
  amend: WorkflowSettingsAmendMeta;
}): string {
  const inPlace = input.amend.predecessorRunId === undefined;
  const lead = `Changed the settings of workflow run ${input.previous}${input.name === undefined ? "" : ` ("${input.name}")`} from the GUI: ${settingsChangeClauses(input.amend, inPlace).join("; ")}.`;
  const closing =
    "Progress and results arrive as background notifications; do not amend, resume or restart it.";
  if (inPlace) {
    const kept =
      input.amend.maxConcurrency?.to === undefined
        ? `Run ${input.previous} keeps running with no limit`
        : `Run ${input.previous} keeps running under the new limit`;
    return [lead, `${kept}; nothing was stopped and no new run was started.`, closing].join(" ");
  }
  const relation = input.superseded ? "supersedes" : "takes over from";
  return [
    lead,
    `The same script continues as run ${input.runId}, which ${relation} run ${input.previous} and imports everything run ${input.previous} finished as cache.`,
    closing,
  ].join(" ");
}

/**
 * The "what changed" clause. The in-place variant must name its subject ("at most n of **its subagents**"): on that path
 * no model clause precedes it, and a bare "at most n of them" has no referent.
 */
function settingsChangeClauses(amend: WorkflowSettingsAmendMeta, inPlace: boolean): string[] {
  const changes: string[] = [];
  const model = amend.subagentModel;
  if (model !== undefined) {
    changes.push(
      model.to === undefined
        ? "its subagents are back on the session model"
        : `its subagents now run on ${model.to}`,
    );
  }
  const bound = amend.maxConcurrency;
  if (bound !== undefined) {
    changes.push(
      bound.to === undefined
        ? "the limit on subagents at once is back to the default"
        : inPlace
          ? `at most ${bound.to} of its subagents run at once`
          : `at most ${bound.to} of them run at once`,
    );
  }
  return changes;
}

/**
 * The two settings on the snapshot. Both read absent-as-default: no model ever set = the session model, a bound equal to default concurrency = no bound of its own,
 * so absence is the default — the same reading as {@link RunSettings}.
 */
export function runSettingsOfSnapshot(snapshot: DynamicWorkflowRunSnapshot): RunSettings {
  return {
    ...(snapshot.subagentModel === undefined ? {} : { subagentModel: snapshot.subagentModel }),
    ...(snapshot.maxConcurrency === undefined ? {} : { maxConcurrency: snapshot.maxConcurrency }),
  };
}
