/**
 * Read rules for CreateWorkflow tool input.
 *
 * Split out of `create-workflow.tsx`: these are pure functions, while the card component keeps
 * growing linearly with run state/diagnostics/graph interactions; together they pushed that file
 * past oxlint max-lines(400) (`rows.ts -> toolDisplay.ts` and
 * `ToolCallBlocks.tsx -> resolveRenderer.ts` are the same precedent). No JSX and no rendering here.
 *
 * One definition, three consumers - chat card, run-confirmation dialog, run detail page - so the
 * same input never parses to different results on different surfaces.
 */

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * In-progress kind phasing (before the run is joined). "Validating" only holds in the `running`
 * phase - the script is analyzed in `prepareApproval` before the confirmation dialog, while the
 * `inputStreaming` phase of the model writing the script can last tens of seconds. Phases only
 * trust the v4 status attached verbatim on raw by the adapter; when absent, do not guess.
 *
 * With `amend` the wording switches to revision vocabulary:
 * same renderer, same phases, different words - the model is not starting something, it is
 * changing something the user is looking at.
 */
export function readWorkflowKindMessageId(
  raw: unknown,
  isRunning: boolean,
  amend = false,
  /**
   * This call only tunes the concurrency limit (`isWorkflowRetuneInput`): no script is written and
   * nothing is compiled, so not a single word about "validating" may appear while in flight. The
   * amend vocabulary's `writing` "retuning workflow" is always true for it - whether it finally
   * applies in place or (once the run settled) falls back to a real revision - so use it for the
   * whole in-flight period instead of coining a word for a phase that lives a few hundred
   * milliseconds. Awaiting-confirmation is another matter: when that phase is present, its own
   * word is more informative.
   */
  retuning = false,
): string {
  const ids = amend ? AMEND_KIND_IDS : CREATE_KIND_IDS;
  if (!isRunning) {
    return ids.ran;
  }

  const v4Status = isPlainRecord(raw) ? raw.v4Status : undefined;
  if (v4Status === "pendingApproval") {
    return ids.awaitingConfirmation;
  }
  if (v4Status === "inputStreaming" || retuning) {
    return ids.writing;
  }

  return ids.running;
}

/**
 * Pre-launch ToolLayout line kinds:
 * - Does not compile (display present and `ok === false`): "workflow draft (retuning draft)" -
 *   nothing ran, this is a draft awaiting correction;
 * - Failed without display (rejected, tool error) still says "workflow (retuning)";
 * - While writing: "writing (retuning)"; from the 2nd draft on, "modifying..." - the model is
 *   responding to feedback, not starting from scratch;
 * - Anything else is awaiting confirmation.
 * Same vocabulary as `readWorkflowKindMessageId`, with the phase computed by the renderer.
 */
export function readWorkflowPrelaunchKindMessageId(
  phase: { compileErrors: boolean; failed: boolean; writing: boolean; revising: boolean },
  amend: boolean,
): string {
  const ids = amend ? AMEND_KIND_IDS : CREATE_KIND_IDS;
  if (phase.compileErrors) return ids.draft;
  if (phase.failed) return ids.ran;
  if (phase.writing) return phase.revising ? ids.revising : ids.writing;
  return ids.awaitingConfirmation;
}

interface WorkflowKindIds {
  writing: string;
  revising: string;
  awaitingConfirmation: string;
  running: string;
  ran: string;
  draft: string;
}

const CREATE_KIND_IDS: WorkflowKindIds = {
  writing: "chat.toolCall.workflow.writing",
  revising: "chat.toolCall.workflow.revising",
  awaitingConfirmation: "chat.toolCall.workflow.awaitingConfirmation",
  running: "chat.toolCall.workflow.running",
  ran: "chat.toolCall.workflow.ran",
  draft: "chat.toolCall.workflow.draft",
};

/** Revision vocabulary. `running` (validating) has no dedicated word: validating is the same act as creating, so reuse it. */
const AMEND_KIND_IDS: WorkflowKindIds = {
  writing: "chat.toolCall.workflow.amend.writing",
  revising: "chat.toolCall.workflow.amend.revising",
  awaitingConfirmation: "chat.toolCall.workflow.amend.awaitingConfirmation",
  running: "chat.toolCall.workflow.running",
  ran: "chat.toolCall.workflow.amend.ran",
  draft: "chat.toolCall.workflow.amend.draft",
};

/** Optional display name in CreateWorkflow tool input; chat card and run-confirmation dialog share this reader. */
export function readWorkflowName(input: unknown): string | undefined {
  if (isPlainRecord(input) && typeof input.name === "string") {
    const trimmed = input.name.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

/** Raw script in CreateWorkflow tool input; chat card and run-confirmation dialog share this reader. */
export function readWorkflowScript(input: unknown): string | undefined {
  if (isPlainRecord(input) && typeof input.script === "string" && input.script.length > 0) {
    return input.script;
  }

  return undefined;
}

/**
 * The predecessor run (`run_id`) being amended in an AmendWorkflow call. Present means this is a
 * supersede: mint a new run from the new script, importing the cache from that predecessor, and
 * stop the predecessor first if it is still running.
 *
 * Same discipline as `readWorkflowScript`: go through the **input channel**, not display, so
 * lineage facts cost zero extra payload. Only meaningful for AmendWorkflow rows - CreateWorkflow
 * input has no `run_id`.
 */
export function readWorkflowAmendTarget(input: unknown): string | undefined {
  return isPlainRecord(input) ? readTrimmedString(input.run_id) : undefined;
}

/**
 * Predecessor facts backfilled by the CLI `resolveInput` in the AmendWorkflow input: the
 * confirmation dialog uses `status` to decide whether to say "still running, will be stopped".
 * Only the two fields the dialog uses are read; `owned_by_this_session`, used for permission
 * decisions, lives CLI-side and is not the UI's concern.
 */
interface WorkflowAmendPredecessor {
  status: string | undefined;
  name: string | undefined;
}

export function readWorkflowAmendPredecessor(input: unknown): WorkflowAmendPredecessor | undefined {
  if (!isPlainRecord(input) || !isPlainRecord(input.predecessor)) {
    return undefined;
  }
  const predecessor = input.predecessor;
  return {
    status: readTrimmedString(predecessor.status),
    name: readTrimmedString(predecessor.name),
  };
}

/**
 * `max_concurrency`: how many subagents this run may run at once, per the user. Create and Amend
 * share the field name, so there is only one reader.
 *
 * Positive integers only: Amend's `null` (remove the cap) and absence mean the same thing in the
 * dialog - no cap to state, so no row. The value here **is already the effective one**: both
 * tools' `resolveInput` clamp requests above the ceiling before the dialog opens, so no re-clamp
 * here - the ceiling is unavailable and unneeded. (Once the run starts, the run-header concurrency
 * chip shows min(this bound, shared cap); that is a different surface.)
 */
export function readWorkflowMaxConcurrency(input: unknown): number | undefined {
  if (!isPlainRecord(input)) {
    return undefined;
  }
  const value = input.max_concurrency;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * This `AmendWorkflow` call **only tunes the concurrency limit**: `run_id` + `max_concurrency`, no
 * script source, no model change, no rename. While the run is in flight it applies in place:
 * the run is not stopped, no new run is minted, nothing is compiled; the result is a single
 * sentence, without even a display.
 *
 ** The input is the only place this fact lives on the wire**: the tool's structured output does
 * not pass through v4 (only `text` and `display`), and all three `create_workflow` display schemas
 * are `.strict()` frozen field sets - one extra key would make older clients drop the whole tool
 * result. So the presentation is shaped from the input, with zero protocol changes.
 *
 * Only the **shape** is read, never the outcome: once the run settled, the same call falls back to
 * a real revision (compiling with the predecessor's script). That path leaves a display and mints a
 * run joinable by toolCallId - both are wiring-layer criteria. While streaming, the shape also holds
 * briefly when input is half-delivered (script not yet streamed), so in-flight state uses it only to
 * pick a word true under both outcomes, never to change the row's form.
 */
export interface WorkflowRetuneCall {
  runId: string;
  /**
   * The requested cap; `null` = lift this run's own bound (back to the machine limit).
   *
   * ** Warning - not yet clamped**: the CLI `resolveInput` clamps it into `[1, ceiling]`, while
   * this is the number the model sent. Presenters must compare against the machine ceiling and
   * never read this number out as "the actually effective concurrency".
   */
  requested: number | null;
}

export function readWorkflowRetuneCall(input: unknown): WorkflowRetuneCall | undefined {
  if (!isPlainRecord(input)) return undefined;
  const runId = readWorkflowAmendTarget(input);
  if (runId === undefined) return undefined;
  const bound = input.max_concurrency;
  const requested = bound === null ? null : readWorkflowMaxConcurrency(input);
  if (requested === undefined) return undefined;
  // Any other intent present disqualifies "limit-only retune": script/path need compiling, model and name mean a different run.
  if (readWorkflowScript(input) !== undefined || readTrimmedString(input.path) !== undefined) {
    return undefined;
  }
  if (input.subagent_model !== undefined || input.name !== undefined) return undefined;
  return { runId, requested };
}

/**
 * `subagent_model`: which model this run's **subagents** run on.
 * Same discipline as `max_concurrency`: Create and Amend share the field name, one reader.
 *
 * Non-empty strings only: Amend's `null` (back to the session model) and absence mean the same
 * thing in the dialog - subagents follow the session model, there is no second model to name, so
 * no row. The value here **is already the effective one**: both tools' `resolveInput` normalize the
 * user-given name into the canonical `providerId/modelId[$level]` before the dialog opens; calls
 * that fail to resolve never reach the dialog. So no shape validation here - the UI is not a
 * second resolver.
 */
export function readWorkflowSubagentModel(input: unknown): string | undefined {
  return isPlainRecord(input) ? readTrimmedString(input.subagent_model) : undefined;
}

/**
 * This revision inherits the predecessor's script.
 * Each surface has its own evidence; the reading lives only here:
 *
 *   - The confirmation dialog reads input backfilled by the CLI `resolveInput`: the script is
 *     already there, and `predecessor.script_inherited` says it was inherited;
 *   - The chat card reads the **model-emitted** input (the row's input comes from streamed args,
 *     backfill happens after that): only when **both** script sources `script` and `path` are
 *     absent was the script omitted. Missing `script` alone proves nothing - a `path` revision
 *     (the normal "Script files" case) also has no `script`, yet it submits a changed script.
 *
 * The second rule only holds **after input completes** - while streaming the script may not have
 * arrived; callers ask only when not `inputStreaming`. When the input is not a record (snapshot
 * trimmed to a preview, unknown shape), assert nothing.
 */
export function readWorkflowAmendScriptInherited(input: unknown): boolean {
  if (!isPlainRecord(input)) {
    return false;
  }
  if (isPlainRecord(input.predecessor) && input.predecessor.script_inherited === true) {
    return true;
  }
  return readWorkflowScript(input) === undefined && readTrimmedString(input.path) === undefined;
}

/**
 * Chat-card decision: the row's input says the predecessor script was
 * inherited. Say nothing while the input was snapshot-trimmed to a preview - what is missing there
 * is bytes, not a script. The caller is also responsible for asking only about **completed** amend
 * rows (while streaming the script may not have arrived).
 */
export function readWorkflowCardKeptScript(toolCall: {
  input: unknown;
  snapshotRefs?: readonly { field: string }[];
}): boolean {
  const trimmed = (toolCall.snapshotRefs ?? []).some((ref) => ref.field === "input");
  return !trimmed && readWorkflowAmendScriptInherited(toolCall.input);
}

/** Predecessor still in flight (pending / running): the amend stops it first. */
export function isWorkflowAmendPredecessorLive(
  predecessor: WorkflowAmendPredecessor | undefined,
): boolean {
  return predecessor?.status === "running" || predecessor?.status === "pending";
}

/**
 * The saved-workflow source in normalized CreateWorkflow input (the "normalized shape" of a
 * reusable workflow spec: `{name, script, saved: {name, args, path, scope}}`).
 *
 * Same discipline as `readWorkflowScript`: these fields travel the **input channel**, not display,
 * so the chat card and run-confirmation dialog share one reader and never parse separately. A
 * missing `saved` is an inline submission, not a downgrade - the inline path stays verbatim as today.
 */
export interface WorkflowSavedSource {
  name: string;
  path: string | undefined;
  scope: string | undefined;
  /** Argument bag after validation backfill. Empty object - never undefined - when absent or malformed. */
  args: Record<string, unknown>;
}

export function readWorkflowSaved(input: unknown): WorkflowSavedSource | undefined {
  if (!isPlainRecord(input) || !isPlainRecord(input.saved)) {
    return undefined;
  }

  const saved = input.saved;
  // The name is this source's identity: no readable name means no source, not an empty badge.
  const name = typeof saved.name === "string" ? saved.name.trim() : "";
  if (name.length === 0) {
    return undefined;
  }

  return {
    name,
    path: readTrimmedString(saved.path),
    scope: readTrimmedString(saved.scope),
    args: isPlainRecord(saved.args) ? saved.args : {},
  };
}

/**
 * Display form for argument / default values: strings verbatim (quotes only add noise around
 * prose arguments), everything else via JSON - all four declared types
 * (string / number / boolean / json) stay readable that way.
 */
export function formatWorkflowArgValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Unserializable values (cyclic references etc.) must not crash the whole confirmation dialog.
    return String(value);
  }
}
