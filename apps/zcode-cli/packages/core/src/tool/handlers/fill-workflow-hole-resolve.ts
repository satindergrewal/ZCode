// ============================================================
// FillWorkflowHole: everything before confirmation (resolveInput and its structured failures)
// ============================================================
// docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」→「Input and output」「Approval」。
//
// Split from fill-workflow-hole.ts (same split as amend-workflow-resolve.ts): that side is handler and tool
// declaration; here is the flow's **only port read** — the model's input becomes "the execution facts that will happen": the body's bytes
// (inline or file), whether the hole is awaiting this run, whether it belongs to this session, where the draft is. Past this, permission, dialog, and
// handler faces one body and one `hole` facts block.

import { readFile } from "node:fs/promises";
import {
  FILL_WORKFLOW_HOLE_SOURCE_ERROR,
  FillWorkflowHoleInputSchema,
  type DynamicWorkflowRunHole,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunSnapshot,
  type FillWorkflowHoleHole,
  type FillWorkflowHoleInput,
} from "@zcode/contracts";
import type {
  ToolHandlerFailure,
  ToolInputResolutionContext,
  ToolInputResolutionResult,
} from "../types.js";
import { spliceHoleBodyPreview } from "./fill-workflow-hole-splice.js";
import { resolveWorkflowScriptFilePath } from "./workflow-path-source.js";
import { workflowRunNotFoundFailure } from "./workflow-run-introspection.js";
import { describeWorkflowScriptPath } from "./workflow-script-path.js";

/**
 * Local failure-code table. Numbers are log bits (the executor projects `code: "N"`); the discriminator is the message prefix.
 * `run_not_found` reuses the introspection table's same-key same-code. Numbering from 32 keeps it visually distinct from the introspection table (1/2),
 * ResumeWorkflowRun (11-15), ResolveWorkflowQuestion (21-24), and AmendWorkflow (21-29) — each table's number space is independent.
 */
export const FILL_WORKFLOW_HOLE_ERROR_CODE = {
  FILL_UNAVAILABLE: 31,
  HOLE_NOT_WAITING: 32,
  FILL_UNCHANGED: 33,
  FILL_FILE: 34,
  IDS_UNSTABLE: 35,
  BODY_UNAVAILABLE: 36,
} as const;

/** Input-level violation (not exactly one source) code, the same 400 as CreateWorkflow / AmendWorkflow. */
const FILL_WORKFLOW_HOLE_INPUT_FAILURE_CODE = 400;

/**
 * Exactly-one body source holds only for model-issued input (after normalization, `script` and `path` both present is a legal
 * execution state: `path`'s bytes were read into `script`). Neither given is also a violation — nothing to inherit.
 */
export function validateFillWorkflowHoleSource(
  input: unknown,
): { result: true } | ToolHandlerFailure {
  const parsed = FillWorkflowHoleInputSchema.safeParse(input);
  if (!parsed.success) return { result: true };
  const sources = [parsed.data.script, parsed.data.path].filter((value) => value !== undefined);
  if (sources.length === 1) return { result: true };
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_INPUT_FAILURE_CODE,
    message: FILL_WORKFLOW_HOLE_SOURCE_ERROR,
  };
}

// ------------------------------------------------------------
// The last rejected attempt (docs/dynamic-workflow/launch.md's `fill_unchanged`)
// ------------------------------------------------------------
// "A `path` whose bytes equal this hole's last-rejected copy" means the edit was forgotten; catch it before the dialog. Per-session table,
// keyed (session, run, hole): the handler records the bytes when the port reports `compile_failed`; resolveInput compares
// `path` submissions. Holds for `path` only — re-pasting inline mints a new fill file, a different error, told by the diagnostics.

const rejectedFills = new Map<string, string>();

function rejectionKey(sessionId: string | undefined, runId: string, holeId: string): string {
  return `${sessionId ?? ""}\u0000${runId}\u0000${holeId}`;
}

export function rememberRejectedFill(
  sessionId: string | undefined,
  runId: string,
  holeId: string,
  body: string,
): void {
  rejectedFills.set(rejectionKey(sessionId, runId, holeId), body);
}

/** Test hook: clear the last-rejected table so cases stay independent. */
export function resetFillWorkflowHoleRejectionsForTests(): void {
  rejectedFills.clear();
  preview = undefined;
}

// ------------------------------------------------------------
// The confirm dialog's preview (docs/dynamic-workflow/launch.md "Approval")
// ------------------------------------------------------------
// prepareApproval is synchronous and sees only the input, while the valid script needs a port read (the run's script). So
// resolveInput builds it and records it in a **single slot**; prepareApproval claims it by (run, hole, body) — the same posture as
// workflow-script-analysis.ts's single-slot memo: the only duplication worth converging is this adjacent call pair.

/** One preview in the single slot: the valid script plus the run's model-binding table (prepareApproval judges body-named models from it). */
export interface FillPreview {
  effectiveScript: string;
  modelBindings: Record<string, string>;
}

let preview: ({ runId: string; holeId: string; body: string } & FillPreview) | undefined;

/** prepareApproval takes the preview: matching input yields the valid script and bindings, else `undefined` (the dialog still opens, just without a graph). */
export function takeFillPreview(
  runId: string,
  holeId: string,
  body: string,
): FillPreview | undefined {
  if (preview === undefined) return undefined;
  if (preview.runId !== runId || preview.holeId !== holeId || preview.body !== body)
    return undefined;
  return { effectiveScript: preview.effectiveScript, modelBindings: preview.modelBindings };
}

// ------------------------------------------------------------
// resolveInput
// ------------------------------------------------------------

/**
 * The flow's single port read: resolve `run_id` + `hole_id` into the `hole` facts block backfilled into the input.
 *
 * Order is fixed: run lookup (missing = `run_not_found`, unrelated to the body) -> is the hole being waited on (terminal run,
 * unknown id, already filled all settle here — never a dialog destined to fail) -> settle the body (read the file; name it when unreadable)
 * -> byte compare (`fill_unchanged`) -> backfill facts, build preview. **Unconditionally override** any `hole` the model supplied: forged is invalid.
 *
 * With the port absent (unwired host) the body still settles and passes through: the handler returns the structured "cannot fill in this session" failure,
 * and permission reads no `hole` and asks as usual.
 */
export async function resolveFillWorkflowHoleInput(
  input: unknown,
  context: ToolInputResolutionContext,
): Promise<ToolInputResolutionResult> {
  const parsed = FillWorkflowHoleInputSchema.safeParse(input);
  if (!parsed.success) return { result: true, input };
  const cwd = context.workingDirectory ?? ".";
  const { hole: _forged, ...model } = parsed.data;
  void _forged;
  const port = context.dynamicWorkflowRunPort;
  if (port === undefined) {
    const body = await resolveFillBody(model, cwd);
    if (!body.result) return body;
    return { result: true, input: { ...model, ...body.fields } satisfies FillWorkflowHoleInput };
  }

  const snapshot = await port.getTask(model.run_id);
  if (snapshot === undefined) return runNotFoundFailure(model.run_id);
  const waiting = findWaitingHole(snapshot, model.run_id, model.hole_id);
  if (waiting !== undefined && "result" in waiting) return waiting;

  const body = await resolveFillBody(model, cwd);
  if (!body.result) return body;
  if (model.path !== undefined) {
    const rejected = rejectedFills.get(
      rejectionKey(context.sessionId, model.run_id, model.hole_id),
    );
    if (rejected !== undefined && rejected === body.fields.script) {
      return unchangedFillFailure(body.described ?? model.path, model.run_id, model.hole_id);
    }
  }

  const hole =
    waiting === undefined ? undefined : describeHole(snapshot, waiting, context.sessionId);
  await rememberFillPreview(port, model.run_id, model.hole_id, body.fields.script, snapshot);
  return {
    result: true,
    input: {
      ...model,
      ...body.fields,
      ...(hole === undefined ? {} : { hole }),
    } satisfies FillWorkflowHoleInput,
  };
}

function runNotFoundFailure(runId: string): ToolHandlerFailure {
  const base = workflowRunNotFoundFailure(runId);
  return {
    ...base,
    message: `${base.message} Nothing was filled: \`run_id\` pointed at a run that does not exist — take it from the hole notification or from ListWorkflowRuns.`,
  };
}

/**
 * Is this hole one the run is waiting on? All three "no" cases return `hole_not_waiting`, the message saying which
 * (docs/dynamic-workflow/launch.md rejection table): the run is not in flight (stopped -> point to ResumeWorkflowRun — after resume
 * the hole asks again), the id is unknown or not yet reached, or it is already filled. Without a `holes` table (older hosts) return `undefined`:
 * undecidable — leave it to the port.
 */
function findWaitingHole(
  snapshot: DynamicWorkflowRunSnapshot,
  runId: string,
  holeId: string,
): DynamicWorkflowRunHole | ToolHandlerFailure | undefined {
  const status = snapshot.runStatus;
  if (status === "stopped") {
    return notWaitingFailure(
      `run ${runId} is stopped (${snapshot.stopReason ?? "unknown reason"}), so nothing is waiting at ${holeId}. Continue it with ResumeWorkflowRun first; the hole will ask again once the script reaches it.`,
    );
  }
  if (status === "completed" || status === "errored") {
    return notWaitingFailure(
      `run ${runId} has already ${status}, so nothing is waiting at ${holeId}.`,
    );
  }
  const holes = snapshot.holes;
  if (holes === undefined) return undefined;
  const entry = holes.find((hole) => hole.siteId === holeId);
  if (entry === undefined) {
    return notWaitingFailure(
      `run ${runId} is not waiting at ${holeId}: no hole with that id has been reached (unknown id, or the script has not got there yet). GetWorkflowRun lists the holes it is waiting at.`,
    );
  }
  if (entry.state !== "waiting") {
    return notWaitingFailure(
      `hole ${holeId} ("${entry.name}") of run ${runId} is already filled; the branch has resumed with that body. To change what it does, edit the run's draft and use AmendWorkflow.`,
    );
  }
  return entry;
}

function notWaitingFailure(detail: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.HOLE_NOT_WAITING,
    message: `hole_not_waiting: ${detail} Nothing was filled.`,
  };
}

function unchangedFillFailure(
  described: string,
  runId: string,
  holeId: string,
): ToolHandlerFailure {
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.FILL_UNCHANGED,
    message: `fill_unchanged: ${described} is byte-for-byte the body that was just rejected for hole ${holeId} of run ${runId}, so resubmitting it would fail the same way. Edit the file first (the diagnostics name the lines), then call FillWorkflowHole again with the same \`path\`. Nothing was filled.`,
  };
}

/**
 * The `hole` facts block. `owned_by_this_session` folded into the amend rule's two conditions (initiated by this session, and not
 * user-stopped) — the permission service reads only that bit (docs/dynamic-workflow/launch.md "Approval").
 */
function describeHole(
  snapshot: DynamicWorkflowRunSnapshot,
  entry: DynamicWorkflowRunHole,
  sessionId: string | undefined,
): FillWorkflowHoleHole {
  const owned =
    sessionId !== undefined &&
    snapshot.parentSessionId !== undefined &&
    snapshot.parentSessionId === sessionId &&
    snapshot.stopReason !== "user";
  return {
    name: entry.name,
    type: entry.type,
    ...(snapshot.scriptPath === undefined ? {} : { draft_path: snapshot.scriptPath }),
    ...(entry.line === undefined ? {} : { line: entry.line }),
    owned_by_this_session: owned,
  };
}

/** The normalized body fields (both sources, same shape) plus the file wording the model should see. */
type FillBodyResolution =
  | { result: true; fields: { script: string; path?: string }; described?: string }
  | ToolHandlerFailure;

/**
 * Both sources normalize to one field set. `path` is read byte-for-byte (no metadata blocks stripped: a fill file is nothing but statements),
 * in resolveInput not the handler — the dialog must draw the exact bytes to be spliced, and hooks/project rules must match them too.
 */
async function resolveFillBody(
  model: FillWorkflowHoleInput,
  cwd: string,
): Promise<FillBodyResolution> {
  if (model.path !== undefined) {
    const absolute = resolveWorkflowScriptFilePath(cwd, model.path);
    const described = describeWorkflowScriptPath(absolute, cwd);
    try {
      const script = await readFile(absolute, "utf8");
      if (script.length === 0) return fillFileFailure(`${described} is empty`);
      return { result: true, described, fields: { script, path: absolute } };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return fillFileFailure(`${described} could not be read: ${reason}`);
    }
  }
  if (model.script !== undefined) return { result: true, fields: { script: model.script } };
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.BODY_UNAVAILABLE,
    message: `workflow_fill_body_unavailable: ${FILL_WORKFLOW_HOLE_SOURCE_ERROR}`,
  };
}

function fillFileFailure(detail: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.FILL_FILE,
    message: `workflow_fill_file_unreadable: ${detail}. Pass \`path\` for the fill file a previous result named, or submit the body inline as \`script\`. Nothing was filled.`,
  };
}

/** Splice the valid script once into the single slot (unreadable run script or unsplicable body just means no preview, never a failure). */
async function rememberFillPreview(
  port: DynamicWorkflowRunPort,
  runId: string,
  holeId: string,
  body: string,
  snapshot: DynamicWorkflowRunSnapshot,
): Promise<void> {
  preview = undefined;
  if (typeof port.getScript !== "function") return;
  let stored: string | undefined;
  try {
    stored = await port.getScript(runId);
  } catch {
    return;
  }
  if (stored === undefined || stored.length === 0) return;
  const effectiveScript = spliceHoleBodyPreview(stored, holeId, body);
  if (effectiveScript === undefined) return;
  // No binding table means the run never named a model (the snapshot's `modelBindings` exists only when it did).
  preview = { runId, holeId, body, effectiveScript, modelBindings: snapshot.modelBindings ?? {} };
}
