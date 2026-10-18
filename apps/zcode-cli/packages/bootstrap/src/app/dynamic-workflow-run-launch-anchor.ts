// ============================================================
// The dwf run's launch anchor
// ============================================================
// A subagent's agent_step must land under the turn that started this run. The anchor is an inputId,
// living SQL-free in the journal event `run-launched` (written once, in the run's birth generation):
//   - resolved at submit by this file (the active turn / a hub-minted value / the predecessor's anchor / a fallback mint)
//     and handed to the engine for persistence;
//   - resume and progress-derived fields read it back from the journal, so one run's anchor is unique across its lifetime.
//
// The same event also carries kindred host metadata: the script's declared phase table (`phaseNames`), the run subagents'
// model choice (`subagentModel`) and permission mode (`subagentPermissionMode`, docs/dynamic-workflow/launch.md
// ("Permissions inside a run"), the script's model-binding table (`modelBindings`), and the file the script came from
// (`scriptPath`, docs/dynamic-workflow/launch.md "Script files"). All written once, in the run-creation incarnation only;
// the engine never reads, all zero SQL — on `dwf_run`
// no such columns.

import type { TraceContext } from "@zcode/contracts";
import type { JournalStorePort, RunEvent } from "@zcode/dynamic-workflow";
import { uuidv7 } from "@zcode/shared";
import {
  parseWorkflowSubagentPermissionMode,
  type WorkflowSubagentPermissionMode,
} from "./workflow-actor-permission.js";

export interface RunLaunchAnchor {
  /** The inputId of the turn that launched the run (a minted UUID v7 for hub-launched runs). */
  inputId: string;
}

/**
 * Everything handed to the engine for `run-launched`: the anchor + the script's phase table + the run's subagent model (`subagentModel`, the canonical picker string
 * `providerId/modelId[$reasoningLevel]`）。
 *
 * The latter two are **not** anchor parts: a revision-resume keeps the predecessor's inputId but takes the new script's phase table, and never inherits
 * the predecessor's model ("omit = inherit" is the tool face's tri-state, normalized by AmendWorkflow's resolveInput) --
 * so they merge alongside the anchor in submit, never inside {@link resolveLaunchAnchor}.
 */
export interface RunLaunch extends RunLaunchAnchor {
  phaseNames?: string[];
  subagentModel?: string;
  /**
   * Script-named models -> canonical strings (docs/dynamic-workflow/launch.md "Models the script names"). Like the subagent
   * choice, not anchor material: a revision's binding table is normalized by AmendWorkflow's resolveInput (same name inherits); the port inherits nothing.
   */
  modelBindings?: Record<string, string>;
  /**
   * Absolute path of this run's script file. Same rule as the phase table and
   * subagent model: not anchor parts -- a revision records which file **this revision's** script came from, never the predecessor's.
   */
  scriptPath?: string;
  /**
   * The run subagents' permission mode (docs/dynamic-workflow/launch.md "Permissions inside a run"):
   * the launching session's mode (plan not carried). Also not anchor material: a revision is a new run and takes the
   * session's mode at revision time, never the predecessor's.
   */
  subagentPermissionMode?: WorkflowSubagentPermissionMode;
  /** The run-together table index-aligned with `phaseNames` (indices into that same table); also journal-written once at birth. */
  phaseAlongside?: number[][];
}

/**
 * This run's first `run-launched` (journaled in the creation incarnation only). Type filter and `limit: 1` push down
 * into the store (docs/execution-engine.md "Reading the journal"): one query, one row, instead of reading
 * the journal's first 8 events and searching in memory.
 */
function firstRunLaunched(
  journal: JournalStorePort,
  runId: string,
): Extract<RunEvent, { type: "run-launched" }> | undefined {
  const [stored] = journal.listEvents(runId, {
    types: ["run-launched"],
    reportItems: { limit: 0 },
    limit: 1,
  });
  return stored?.event.type === "run-launched" ? stored.event : undefined;
}

/**
 * Reads the run's anchor from the journal: the first `run-launched`. Pre-upgrade runs lack the event => `undefined`,
 * and callers skip deriving `launchInputId` (the fact layer then emits no `workflow.lifecycle`, subagents do not report, nothing fabricated).
 */
export function readRunLaunchAnchor(
  journal: JournalStorePort,
  runId: string,
): RunLaunchAnchor | undefined {
  const launched = firstRunLaunched(journal, runId);
  return launched === undefined ? undefined : { inputId: launched.inputId };
}

/**
 * Reads this run's subagent model: `subagentModel` on that same `run-launched`. Resume, both read faces, and cold replay restore the same canonical string --
 * SQL-free; `dwf_run` has no such column. Absent = subagents run on the session model (most runs, pre-upgrade
 * included).
 *
 * The same read as the anchor, yet **deliberately not hung on** {@link RunLaunchAnchor}:
 * {@link resolveLaunchAnchor} lets revision-resumes inherit the anchor, but the model must never be inherited -- that is
 * the tool face's tri-state (omit = inherit, null = back to the session model, string = set), normalized in
 * `AmendWorkflow`'s resolveInput, the same argument as `max_concurrency`.
 */
export function readRunSubagentModel(journal: JournalStorePort, runId: string): string | undefined {
  return firstRunLaunched(journal, runId)?.subagentModel;
}

/**
 * Reads back the models the run's script named: the `modelBindings` on the same `run-launched`
 * (docs/dynamic-workflow/launch.md "Models the script names"). Subagent-session creation (incl. resume), both read faces, and
 * cold replay map persona model names to canonical strings with it — names resolved once at launch, never re-resolved against the catalog,
 * so a resumed run still runs the models approved at its creation. Absent means the script named no model.
 *
 * Same read as {@link readRunSubagentModel}, same reason it hangs off no anchor.
 */
export function readRunModelBindings(
  journal: JournalStorePort,
  runId: string,
): Record<string, string> | undefined {
  return firstRunLaunched(journal, runId)?.modelBindings;
}

/**
 * Reads back the run subagents' permission mode: `subagentPermissionMode` on the same `run-launched`
 * (docs/dynamic-workflow/launch.md "Permissions inside a run"). Resume keeps subagents in the mode captured
 * at run creation, regardless of the session's current mode. Absent or unknown means YOLO (runs predating the feature too).
 */
export function readRunSubagentPermissionMode(
  journal: JournalStorePort,
  runId: string,
): WorkflowSubagentPermissionMode | undefined {
  const launched = firstRunLaunched(journal, runId);
  return launched === undefined
    ? undefined
    : parseWorkflowSubagentPermissionMode(launched.subagentPermissionMode);
}

/**
 * Reads back the run's script file: `scriptPath` on the same `run-launched`
 * (docs/dynamic-workflow/launch.md "Script files", Provenance). The cold paths of both read faces
 * absolute path -- SQL-free, no such column on `dwf_run`. Absent = the run has no editable script
 * (projects where drafts cannot be written, runs predating this feature).
 *
 * Same read as {@link readRunSubagentModel}, likewise **deliberately not hung on**
 * {@link RunLaunchAnchor}: the anchor is inherited by revision-resumes, but the predecessor's script path points at the old script --
 * honoring it would have the model edit a file no longer in play.
 */
export function readRunScriptPath(journal: JournalStorePort, runId: string): string | undefined {
  // A fill may mint a draft for a run that had none (docs/dynamic-workflow/launch.md "The draft after a fill");
  // the path lands in the journal with that `hole-filled`; the last one present beats the creation incarnation's record. A typed-filtered
  // narrow read: most runs have no hole-filled at all.
  let minted: string | undefined;
  for (const { event } of journal.listEvents(runId, {
    types: ["hole-filled"],
    reportItems: { limit: 0 },
  })) {
    if (event.type === "hole-filled" && event.scriptPath !== undefined) minted = event.scriptPath;
  }
  return minted ?? firstRunLaunched(journal, runId)?.scriptPath;
}

/**
 * Resolves the anchor at submit. Priority:
 *   1. a revision-resume (`resume_from`) keeps the **predecessor's** anchor -- every step of one work item hangs under one message;
 *   2. an explicit caller `launchInputId` (hub-launched: shares the controlOnly turn's UUID v7);
 *   3. the parent runtime's active-turn inputId (chat CreateWorkflow: the tool runs inside that turn);
 *   4. fallback mint of a UUID v7 (CLI, hosts with no active turn, revisions whose predecessor lacks an anchor).
 */
export function resolveLaunchAnchor(input: {
  requested?: string;
  trace: TraceContext;
  resolveLaunchInputId?: (trace: TraceContext) => string | undefined;
  predecessor?: RunLaunchAnchor;
  mint?: () => string;
}): RunLaunchAnchor {
  if (input.predecessor !== undefined) return input.predecessor;
  const inputId =
    input.requested ?? input.resolveLaunchInputId?.(input.trace) ?? (input.mint ?? uuidv7)();
  return { inputId };
}
