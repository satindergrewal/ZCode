// ============================================================
// AmendWorkflow - which script this amend runs
// ============================================================
//
// Three script sources, one field set: `path` (common case: an edited script file), `script` (inline, whole),
// or neither (inherit the archived predecessor script). Split from the resolveInput body (amend-workflow-resolve.ts) for the
// same reason as `create-workflow-source.ts`: this is the read-the-world side (script files, predecessor archived script);
// the handler is the change-it side. Mixed, the next person re-reads disk in the handler, and the dialog
// no longer shows the bytes that will run.

import {
  AMEND_WORKFLOW_SOURCE_ERROR,
  AmendWorkflowInputSchema,
  type AmendWorkflowInput,
  type AmendWorkflowPredecessor,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunSnapshot,
} from "@zcode/contracts";
import type { ToolHandlerFailure } from "../types.js";
import { normalizeWorkflowMaxConcurrency } from "./create-workflow-source.js";
import { readWorkflowScriptFile } from "./workflow-path-source.js";

/**
 * Local failure-code table. Numbers are log bits (the executor projects `code: "N"`); the discriminator is the message prefix.
 * `run_not_found` reuses the introspection table key/code (a missing referenced run is one thing across all three tools).
 * Numbering from 21 only avoids collision with the introspection table (1/2) and ResumeWorkflowRun (11-15).
 */
export const AMEND_WORKFLOW_ERROR_CODE = {
  AMEND_UNAVAILABLE: 21,
  MISSING_BOUNDARIES: 22,
  SUBAGENT_MODEL: 23,
  SCRIPT_UNCHANGED: 24,
  SCRIPT_FILE: 25,
  SCRIPT_UNAVAILABLE: 26,
  // The concurrency-only route's three rejections (docs/dynamic-workflow/launch.md "Changing only the
  // parallelism of a live run"); none of them touch the run.
  RETUNE_UNCHANGED: 27,
  RUN_SETTLED: 28,
  NOT_RETUNABLE: 29,
} as const;

/** Code for the input-level violation (both sources given); the same 400 as `CreateWorkflow`. */
const AMEND_WORKFLOW_INPUT_FAILURE_CODE = 400;

/**
 * At most one amend script, for model-emitted input only (reason as `validateCreateWorkflowSource`: post-normalization
 * coexisting `script` and `path` is a legal execution state). Neither given is no violation — it means inherit the predecessor script.
 */
export function validateAmendWorkflowSource(input: unknown): { result: true } | ToolHandlerFailure {
  const parsed = AmendWorkflowInputSchema.safeParse(input);
  if (!parsed.success) return { result: true };
  if (parsed.data.script !== undefined && parsed.data.path !== undefined) {
    return {
      result: false,
      errorCode: AMEND_WORKFLOW_INPUT_FAILURE_CODE,
      message: AMEND_WORKFLOW_SOURCE_ERROR,
    };
  }
  return { result: true };
}

/**
 * Both omitted with nothing to inherit. Two causes, one discriminator: the next step is the same — hand over a script.
 *
 *   - `record`: no script in the predecessor record (a pre-script-persistence run);
 *   - `host`: no run port in this session, or the port lacks `getScript` (older host).
 */
export function scriptUnavailableFailure(
  runId: string,
  cause: "record" | "host",
): ToolHandlerFailure {
  const why =
    cause === "record"
      ? `run ${runId} has no stored script to keep (it predates script persistence)`
      : `this host cannot read run ${runId}'s stored script`;
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.SCRIPT_UNAVAILABLE,
    message: `workflow_amend_script_unavailable: ${why}, so the script cannot be omitted here — pass the whole script as \`script\`, or its file as \`path\`. Nothing was stopped or created.`,
  };
}

/**
 * Three-state normalization of the concurrency bound (docs/dynamic-workflow/concurrency.md "Two bounds on a run"):
 *
 *   - number -> floor to at least 1, no ceiling (above or below default both count);
 *   - `null` -> clear, the key disappears (the new run uses default concurrency);
 *   - absent -> inherit the predecessor's bound, **verbatim**. The snapshot carries `maxConcurrency` only when it differs from default, so
 *     "never set" and "running at default" are the same thing here: the key vanishes; a raised predecessor passes its number on.
 *     it on.
 *
 * The three states end here: past dialog and handler there is only a-number-or-nothing. The sole exception, the in-place retune
 * That route (amend-workflow-retune.ts): `retuneConcurrency` takes `number | null` itself, so the default-concurrency number
 * is port knowledge; the tool must not guess twice.
 */
export function resolveAmendMaxConcurrency(
  requested: number | null | undefined,
  inherited: number | undefined,
): { max_concurrency?: number } {
  if (requested === null) return {};
  const resolved = requested ?? inherited;
  if (resolved === undefined) return {};
  return { max_concurrency: normalizeWorkflowMaxConcurrency(resolved) };
}

/**
 * The predecessor facts block (docs/dynamic-workflow/launch.md "From call to run", step 2). resolveInput and the in-place
 * retune fallback (one snapshot re-read in the settlement race) share this derivation, so both answer what-state-is-this-run-in
 * identically.
 */
export function describePredecessor(
  snapshot: DynamicWorkflowRunSnapshot,
  sessionId: string | undefined,
): AmendWorkflowPredecessor {
  // The snapshot `status` is tracker vocabulary (stopped folded into cancelled…); the real word is `runStatus`, present
  // only in terminal states — else read running (pending equals running here: the amend stops both).
  const status = snapshot.runStatus ?? "running";
  return {
    ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
    status,
    ...(snapshot.stopReason === undefined ? {} : { stop_reason: snapshot.stopReason }),
    owned_by_this_session:
      sessionId !== undefined &&
      snapshot.parentSessionId !== undefined &&
      snapshot.parentSessionId === sessionId,
  };
}

/** Normalized script fields (one shape from all three sources), plus the model-facing file spelling and inherited-or-not. */
export type AmendScriptResolution =
  | {
      result: true;
      fields: { script: string; path?: string; script_line_offset?: number };
      described?: string;
      inherited: boolean;
    }
  | ToolHandlerFailure;

/**
 * All three sources normalize to one field set.
 *
 *   - `path`: read the file. A metadata block is stripped, its **declarations ignored** — amends carry no args (args belong to the predecessor run
 *     record, in the journal), so there is nothing to validate; the block is still stripped, or it gets
 *     fed to the compiler as script.
 *   - `script`: verbatim.
 *   - Neither: read the predecessor archived script via the port (the bytes resume replays). The read lives in resolveInput, not the
 *     handler: the dialog must graph the script that will run, hooks and project rules must match it — both happen
 *     before the handler. Empty string equals absent — the runtime schema `.min(1)` rejects empty scripts. The inherited script also
 *     gets a home check ({@link resolveKeptScriptFile}): if the predecessor script file still holds these bytes, the new run keeps
 *     recording it; else `path` is absent and the handler writes a fresh draft per the not-from-a-file rule.
 *
 * With `port` absent (unwired host) the first two stand, the third cannot inherit and fails right there.
 */
export async function resolveAmendScript(options: {
  model: AmendWorkflowInput;
  cwd: string;
  port: DynamicWorkflowRunPort | undefined;
  /** The script file on the predecessor snapshot (absolute); the home check for inherited scripts. */
  predecessorScriptPath: string | undefined;
}): Promise<AmendScriptResolution> {
  const { model, cwd, port } = options;
  if (model.path !== undefined) {
    const read = await readWorkflowScriptFile({ cwd, inputPath: model.path });
    if (!read.ok) {
      return {
        result: false,
        errorCode: AMEND_WORKFLOW_ERROR_CODE.SCRIPT_FILE,
        message: `workflow_script_file_unreadable: ${read.message} Nothing was stopped or created.`,
      };
    }
    return {
      result: true,
      inherited: false,
      described: read.file.described,
      fields: {
        script: read.file.script,
        path: read.file.path,
        ...(read.file.bodyLineOffset === 0 ? {} : { script_line_offset: read.file.bodyLineOffset }),
      },
    };
  }
  if (model.script !== undefined) {
    return { result: true, inherited: false, fields: { script: model.script } };
  }
  if (port === undefined || typeof port.getScript !== "function") {
    return scriptUnavailableFailure(model.run_id, "host");
  }
  const stored = await port.getScript(model.run_id);
  if (stored === undefined || stored.length === 0) {
    return scriptUnavailableFailure(model.run_id, "record");
  }
  const kept = await resolveKeptScriptFile({
    cwd,
    scriptPath: options.predecessorScriptPath,
    script: stored,
  });
  return {
    result: true,
    inherited: true,
    ...(kept === undefined ? {} : { described: kept.described }),
    fields: {
      script: stored,
      ...(kept === undefined
        ? {}
        : {
            path: kept.path,
            ...(kept.lineOffset === 0 ? {} : { script_line_offset: kept.lineOffset }),
          }),
    },
  };
}

/**
 * Home check for an inherited script: if the predecessor-recorded script file **right now**
 * reads back as the inherited bytes, the new run keeps recording that file — script unchanged, file unchanged; it is the new run
 * script file, and the next amend edits it too. Tool inherit and the GUI settings flow share this.
 *
 * Any mismatch (never recorded, gone, unreadable, modified) returns `undefined`: the caller writes
 * a fresh draft per the not-from-a-file rule. Never pin a file no longer holding this script to the new run —
 * diagnostic lines and edit-that-file would point at different code.
 */
export async function resolveKeptScriptFile(options: {
  cwd: string;
  scriptPath: string | undefined;
  script: string;
}): Promise<{ path: string; described: string; lineOffset: number } | undefined> {
  if (options.scriptPath === undefined) return undefined;
  const read = await readWorkflowScriptFile({ cwd: options.cwd, inputPath: options.scriptPath });
  if (!read.ok || read.file.script !== options.script) return undefined;
  return {
    path: read.file.path,
    described: read.file.described,
    lineOffset: read.file.bodyLineOffset,
  };
}

/**
 * The unchanged-file precheck.
 *
 * Holds only for a **model-provided** `path`: the net catches forgotten edits; re-pasting the script or declaring it unchanged
 * (both omitted) is not that error. It also holds only when nothing else changes — a call that sets `max_concurrency`
 * or `subagent_model` means itself; an untouched script is legitimate (`null` counts as given: an explicit
 * lift).
 *
 * `getScript` is an optional port member; without it, skip the precheck — a convenience, not a correctness gate.
 */
export async function refuseUnchangedScript(options: {
  port: DynamicWorkflowRunPort;
  /** The model-emitted input (pre-normalization): a backfilled inherited `path` is not model-given. */
  model: AmendWorkflowInput;
  resolvedScript: string;
  described: string | undefined;
}): Promise<ToolHandlerFailure | undefined> {
  const { port, model, resolvedScript, described } = options;
  if (model.path === undefined) return undefined;
  if (model.max_concurrency !== undefined || model.subagent_model !== undefined) return undefined;
  if (typeof port.getScript !== "function") return undefined;

  const previous = await port.getScript(model.run_id);
  if (previous === undefined || previous !== resolvedScript) return undefined;
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.SCRIPT_UNCHANGED,
    message: `workflow_script_unchanged: ${described ?? model.path} is byte-for-byte the script run ${model.run_id} was started with, so amending it would repeat that run exactly. Edit the file first, then call AmendWorkflow again with the same \`path\`; to change only the settings, pass them and omit \`path\`; to continue a stopped run under the same script, use ResumeWorkflowRun. Nothing was stopped or created.`,
  };
}
