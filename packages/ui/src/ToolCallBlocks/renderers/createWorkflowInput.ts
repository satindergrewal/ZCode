/**
 * Reading rules for the CreateWorkflow tool input.
 *
 * Split out of `create-workflow.tsx`: these are pure functions, while the card component grows
 * with run state/diagnostics/graph interactions; together they pushed the file past oxlint
 * max-lines(400) (`rows.ts -> toolDisplay.ts` and `ToolCallBlocks.tsx -> resolveRenderer.ts` are prior art). No JSX, no rendering here.
 *
 * One definition, three consumers (chat card, run approval dialog, run detail page), so the
 * same input never gets parsed differently per surface.
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
 * Phases for the in-progress kind copy (run not yet linked). "Validating" only holds while
 * `running`: the script was analyzed in `prepareApproval` before the dialog, while the
 * model-writing `inputStreaming` phase can last tens of seconds. Trust only the v4 status the adapter hangs on raw; if absent, do not guess.
 *
 * When `amend` is set, switch to the amend vocabulary:
 * same renderer, same phases, different words -- the model is not starting something but editing something the user is watching.
 */
export function readWorkflowKindMessageId(
  raw: unknown,
  isRunning: boolean,
  amend: WorkflowKindVocabulary = false,
  /**
   * This call only tunes the concurrency cap (`isWorkflowRetuneInput`): no script is written and
   * nothing compiles, so while in flight it must not say "validating"
   * (docs/dynamic-workflow/concurrency.md). The amend table's `writing` entry is always true
   * for it -- whether it lands in place or falls back to a real amend -- so it covers the whole in-flight window. Awaiting-confirmation is separate: its own word is more informative.
   */
  retuning = false,
): string {
  const ids = workflowKindIds(amend);
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
 * Pre-launch ToolLayout row kind wording:
 * - compile errors with a display (`ok === false`) say draft: nothing ran yet, a draft awaiting fixes;
 * - failed with no display (rejected, tool error) still says the ran wording;
 * - while writing, the writing wording, from the second pass on the revising wording -- the model is reacting to feedback, not starting over;
 * - anything else is awaiting confirmation.
 * Same table as `readWorkflowKindMessageId`; only the phase is computed by the renderer.
 */
export function readWorkflowPrelaunchKindMessageId(
  phase: { compileErrors: boolean; failed: boolean; writing: boolean; revising: boolean },
  amend: WorkflowKindVocabulary,
): string {
  const ids = workflowKindIds(amend);
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

/** Amend vocabulary. `running` (validating) has no word of its own: validating is creating, reuse it. */
const AMEND_KIND_IDS: WorkflowKindIds = {
  writing: "chat.toolCall.workflow.amend.writing",
  revising: "chat.toolCall.workflow.amend.revising",
  awaitingConfirmation: "chat.toolCall.workflow.amend.awaitingConfirmation",
  running: "chat.toolCall.workflow.running",
  ran: "chat.toolCall.workflow.amend.ran",
  draft: "chat.toolCall.workflow.amend.draft",
};

/** Hole-fill vocabulary (docs/dynamic-workflow/presentation.md "The fill row"); validating reuses the create wording too. */
const HOLE_KIND_IDS: WorkflowKindIds = {
  writing: "chat.toolCall.workflow.hole.writing",
  revising: "chat.toolCall.workflow.hole.revising",
  awaitingConfirmation: "chat.toolCall.workflow.hole.awaitingConfirmation",
  running: "chat.toolCall.workflow.running",
  ran: "chat.toolCall.workflow.hole.ran",
  draft: "chat.toolCall.workflow.hole.draft",
};

/** Vocabulary picker: `true` amend (legacy boolean param), `"hole"` hole-fill, otherwise create. */
export type WorkflowKindVocabulary = boolean | "hole";

function workflowKindIds(vocabulary: WorkflowKindVocabulary): WorkflowKindIds {
  if (vocabulary === "hole") return HOLE_KIND_IDS;
  return vocabulary ? AMEND_KIND_IDS : CREATE_KIND_IDS;
}

/** Optional display name in the CreateWorkflow tool input; chat card and approval dialog share this reader. */
export function readWorkflowName(input: unknown): string | undefined {
  if (isPlainRecord(input) && typeof input.name === "string") {
    const trimmed = input.name.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

/** Raw script in the CreateWorkflow tool input; chat card and approval dialog share this reader. */
export function readWorkflowScript(input: unknown): string | undefined {
  if (isPlainRecord(input) && typeof input.script === "string" && input.script.length > 0) {
    return input.script;
  }

  return undefined;
}

/**
 * Predecessor run being amended (`run_id`) in the AmendWorkflow input. Presence means this is a
 * supersede: mint a new run from the new script, import the cache from the predecessor, stopping it first if still running.
 *
 * Same discipline as `readWorkflowScript`: ride the input channel, not display, so lineage facts
 * add zero payload. Only meaningful for AmendWorkflow rows -- CreateWorkflow inputs have no `run_id`.
 */
export function readWorkflowAmendTarget(input: unknown): string | undefined {
  return isPlainRecord(input) ? readTrimmedString(input.run_id) : undefined;
}

/**
 * Predecessor facts block backfilled by the CLI `resolveInput`: the dialog uses `status` to decide whether to say "still running, will be stopped". Only the
 * two fields the dialog reads; `owned_by_this_session` for permissions lives CLI-side, the UI ignores it.
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
 * `max_concurrency`: how many subagents may run at once for this run. Create and Amend share the field name, so one reader.
 *
 * Positive integers only: Amend's `null` (lift the cap) and absence mean the same thing in the dialog -- no cap to state, no row.
 * The value here is already the effective one: both tools' `resolveInput` clamp requests above
 * the ceiling before the dialog opens, so no re-clamp here -- it has no ceiling and needs none
 * (once running, the run header chip shows min(this bound, shared cap); that is another matter).
 */
export function readWorkflowMaxConcurrency(input: unknown): number | undefined {
  if (!isPlainRecord(input)) {
    return undefined;
  }
  const value = input.max_concurrency;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * This `AmendWorkflow` call only tunes the concurrency cap: `run_id` + `max_concurrency`, no
 * script source, no model/name change. While the run is in flight it lands in place
 * (docs/dynamic-workflow/concurrency.md): no stop, no new run, no compile; the result is one sentence, not even a display.
 *
 * The input is the only wire home for this fact: the tool's structured output skips v4 (only
 * `text` and `display`), and all three `create_workflow` display schemas are frozen `.strict()`
 * field sets -- one extra key and old hosts drop the whole result. So present per input shape, zero protocol changes.
 *
 * Judge by shape, never predict the outcome: once settled, the same call falls back to a real
 * amend. That path leaves a display and mints a run joinable by toolCallId -- both are wiring-layer signals.
 * The shape also holds briefly while the input streams in (script not yet arrived), so in-flight
 * it only picks wording true for both outcomes; it never changes the row's shape.
 */
export interface WorkflowRetuneCall {
  runId: string;
  /**
   * Requested cap; `null` = lift this run's own bound (back to default concurrency).
   *
   * Warning: **not rounded**. The CLI's `resolveInput` only floors it at 1 (no ceiling), and this
   * reads the number as the model sent it. A value equal to the default reads like `null`: "back to default"; compare against the default when displaying.
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
  // Any other intent present means not a cap-only retune: script/path compile, model/name mean a different run.
  if (readWorkflowScript(input) !== undefined || readTrimmedString(input.path) !== undefined) {
    return undefined;
  }
  if (input.subagent_model !== undefined || input.name !== undefined) return undefined;
  return { runId, requested };
}

/**
 * `subagent_model`: which model this run's subagents run on (docs/dynamic-workflow/launch.md).
 * Same discipline as `max_concurrency`: Create and Amend share the field name, one reader.
 *
 * Non-empty strings only: Amend's `null` (back to session model) and absence mean the same
 * thing in the dialog -- subagents follow the session model, no second model to name, no row.
 * The value here is already effective: both tools' `resolveInput` normalize the given name to
 * canonical `providerId/modelId[$level]` before the dialog; unresolvable calls never reach it. No shape validation here -- the UI is not a second resolver.
 */
export function readWorkflowSubagentModel(input: unknown): string | undefined {
  return isPlainRecord(input) ? readTrimmedString(input.subagent_model) : undefined;
}

/**
 * The script names models for some subagents (non-empty `model_bindings` backfilled by the CLI
 * `resolveInput`, docs/dynamic-workflow/launch.md "Models the script names"). The dialog does
 * not list them; it only rewords the model sentence to "subagents run on by default".
 */
export function workflowScriptNamesModels(input: unknown): boolean {
  return (
    isPlainRecord(input) &&
    isPlainRecord(input.model_bindings) &&
    Object.keys(input.model_bindings).length > 0
  );
}

/** Dialog-adjustable facts backfilled by the CLI `resolveInput` (`adjustable_settings`). */
export interface WorkflowAdjustableSettings {
  /** The host can resolve the model picked in the dialog; when false the model row is inert text. */
  subagentModel: boolean;
  /**
   * Default concurrency D (wire key `concurrency_ceiling`, named before "default concurrency");
   * absent means unknown. Not a cap: the stepper starts at 1 unbounded; it only renders "default N" and decides "equals default = no own bound".
   */
  defaultConcurrency?: number;
}

/**
 * The two dialog-adjustable settings (docs/dynamic-workflow/launch.md "Adjusting the settings in
 * the window"). Via input, not display: display field sets are frozen, one extra key and old
 * hosts drop the whole block. Absent block = old agent: it would not apply dialog values, so the dialog keeps plain conditional text rows.
 */
export function readWorkflowAdjustableSettings(
  input: unknown,
): WorkflowAdjustableSettings | undefined {
  if (!isPlainRecord(input) || !isPlainRecord(input.adjustable_settings)) {
    return undefined;
  }
  const block = input.adjustable_settings;
  // Wire key `concurrency_ceiling` predates "default concurrency"; kept for old-host compat. It now carries D.
  const defaultConcurrency = block.concurrency_ceiling;
  return {
    subagentModel: block.subagent_model === true,
    ...(typeof defaultConcurrency === "number" &&
    Number.isInteger(defaultConcurrency) &&
    defaultConcurrency > 0
      ? { defaultConcurrency }
      : {}),
  };
}

/**
 * This amend reuses the predecessor's script.
 * Each surface has its own evidence; this is the only reading:
 *
 *   - The approval dialog reads CLI-`resolveInput`-backfilled input: the script is already in
 *     there, and `predecessor.script_inherited` marks it inherited;
 *   - The chat card reads the input as sent by the model (row input comes from streamed args,
 *     backfill happens later): the script counts as omitted only when neither source `script` nor
 *     `path` is present. Missing `script` alone does not count -- a `path` amend (the "Script files" norm) also omits `script` while submitting a changed script.
 *
 * The second reading only holds once the input is complete -- the script may still be streaming; callers ask only when not `inputStreaming`.
 * Assert nothing when the input is not a record (snapshot-truncated preview, unknown shape).
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
 * Chat-card predicate: the row input says "inherits the predecessor script". Stay silent when
 * the input was snapshot-truncated to a preview -- bytes are missing, not the script. The caller
 * also only asks for completed amend rows (the script may still be streaming).
 */
export function readWorkflowCardKeptScript(toolCall: {
  input: unknown;
  snapshotRefs?: readonly { field: string }[];
}): boolean {
  const trimmed = (toolCall.snapshotRefs ?? []).some((ref) => ref.field === "input");
  return !trimmed && readWorkflowAmendScriptInherited(toolCall.input);
}

/** Predecessor still in flight (pending/running): the amend stops it first. */
export function isWorkflowAmendPredecessorLive(
  predecessor: WorkflowAmendPredecessor | undefined,
): boolean {
  return predecessor?.status === "running" || predecessor?.status === "pending";
}

/**
 * `saved` source in the normalized CreateWorkflow input (the reusable-workflow spec's "normalized
 * `{name, script, saved: {name, args, path, scope}}`）。
 *
 * Same discipline as `readWorkflowScript`: these fields ride the input channel, not display, so
 * chat card and approval dialog share this reader. Absent `saved` means inline submission --
 * not a downgrade; the inline path stays verbatim, as today.
 */
export interface WorkflowSavedSource {
  name: string;
  path: string | undefined;
  scope: string | undefined;
  /** Argument bag after validation backfill; empty object (never undefined) when absent or malformed. */
  args: Record<string, unknown>;
}

export function readWorkflowSaved(input: unknown): WorkflowSavedSource | undefined {
  if (!isPlainRecord(input) || !isPlainRecord(input.saved)) {
    return undefined;
  }

  const saved = input.saved;
  // The name is this source's identity: an unreadable name means no source, not an empty badge.
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
 * Display for args/defaults: strings verbatim (quotes only add noise), everything else via
 * JSON -- covers all four declared types (string / number / boolean / json).
 */
export function formatWorkflowArgValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Non-serializable values (cyclic refs) must not crash the whole approval dialog.
    return String(value);
  }
}
