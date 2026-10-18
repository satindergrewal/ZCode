// ============================================================
// The dwf run's launch anchor
// ============================================================
// A subagent's agent_step must land under the turn that started this run. The anchor is an inputId,
// living SQL-free in the journal event `run-launched` (written once, in the run's birth generation):
//   - resolved at submit by this file (the active turn / a hub-minted value / the predecessor's anchor / a fallback mint)
//     and handed to the engine for persistence;
//   - resume and progress-derived fields read it back from the journal, so one run's anchor is unique across its lifetime.
//
// The same event piggybacks three same-rule host metadata: the script's declared phase table (`phaseNames`), the run's subagent
// model (`subagentModel`), and the script's source file (`scriptPath`). All four are written once at birth, never read by the engine, all SQL-free -- `dwf_run` has
// no such columns.

import type { TraceContext } from "@zcode/contracts";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { uuidv7 } from "@zcode/shared";

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
      * Absolute path of this run's script file. Same rule as the phase table and
      * subagent model: not anchor parts -- a revision records which file **this revision's** script came from, never the predecessor's.
   */
  scriptPath?: string;
    /** The run-together table index-aligned with `phaseNames` (indices into that same table); also journal-written once at birth. */
  phaseAlongside?: number[][];
}

/**
  * Reads the run's anchor from the journal: the first `run-launched`. Pre-upgrade runs lack the event => `undefined`,
  * and callers skip deriving `launchInputId` (the fact layer then emits no `workflow.lifecycle`, subagents do not report, nothing fabricated).
 *
  * The anchor follows the first `run-started` (the engine's write order), so read only the journal's head -- the whole journal
  * never enters memory; `RUN_LAUNCH_ANCHOR_SCAN_LIMIT` leaves margin if birth events are ever inserted before it.
 */
const RUN_LAUNCH_ANCHOR_SCAN_LIMIT = 8;

export function readRunLaunchAnchor(
  journal: JournalStorePort,
  runId: string,
): RunLaunchAnchor | undefined {
  for (const stored of journal.listEvents(runId, { limit: RUN_LAUNCH_ANCHOR_SCAN_LIMIT })) {
    if (stored.event.type === "run-launched") return { inputId: stored.event.inputId };
  }
  return undefined;
}

/**
  * Reads this run's subagent model: `subagentModel` on that same `run-launched`. Resume, both read faces, and cold replay restore the same canonical string --
  * SQL-free; `dwf_run` has no such column. Absent = subagents run on the session model (most runs, pre-upgrade
  * included).
 *
  * Same scan and limit as the anchor, yet **deliberately not hung on** {@link RunLaunchAnchor}:
  * {@link resolveLaunchAnchor} lets revision-resumes inherit the anchor, but the model must never be inherited -- that is
  * the tool face's tri-state (omit = inherit, null = back to the session model, string = set), normalized in
  * `AmendWorkflow`'s resolveInput, the same argument as `max_concurrency`.
 */
export function readRunSubagentModel(journal: JournalStorePort, runId: string): string | undefined {
  for (const stored of journal.listEvents(runId, { limit: RUN_LAUNCH_ANCHOR_SCAN_LIMIT })) {
    if (stored.event.type === "run-launched") return stored.event.subagentModel;
  }
  return undefined;
}

/**
  * Reads this run's script file: `scriptPath` on that same `run-launched`. The read faces' cold paths restore the same
  * absolute path -- SQL-free, no such column on `dwf_run`. Absent = the run has no editable script
  * (projects where drafts cannot be written, runs predating this feature).
 *
  * Same scan and limit as {@link readRunSubagentModel}, likewise **deliberately not hung on**
  * {@link RunLaunchAnchor}: the anchor is inherited by revision-resumes, but the predecessor's script path points at the old script --
  * honoring it would have the model edit a file no longer in play.
 */
export function readRunScriptPath(journal: JournalStorePort, runId: string): string | undefined {
  for (const stored of journal.listEvents(runId, { limit: RUN_LAUNCH_ANCHOR_SCAN_LIMIT })) {
    if (stored.event.type === "run-launched") return stored.event.scriptPath;
  }
  return undefined;
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
