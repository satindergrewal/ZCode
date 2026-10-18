// V4 user-input admission commons: body/attachment non-empty checks, held-queue verdicts, and legacy-sender
// Selection/Mode pinning. session-flow / goal-compact / session-mgmt /
// queue / fork-edit-retry all consume these; a cross-cutting commands-layer capability,
// hence placed beside prompt-turn.ts and record-access.ts under commands/,
// not lodged in one handler file.
import type { SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import { resolveExecutionState, type ModelSelection } from "@zcode/shared";
import type { TurnAttachment } from "@zcode/core";
import type { SteerTurnOptions } from "../../app/types.js";
import { parseProviderQualifiedModelSelection } from "../../app/provider-registry-selection.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "./types.js";

export class V4InputAdmissionRejectedError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "V4InputAdmissionRejectedError";
  }
}

/** Unified v4 user-input admission: body or attachments, at least one. */
export function hasPromptInput(text: string, attachments: readonly unknown[] | undefined): boolean {
  return text.trim().length > 0 || Boolean(attachments && attachments.length > 0);
}

/** held (inputRouting.mode=choice) sendText/sendGoalCommand without disposition -> reject (10 6.4). */
export class V4HeldQueueDispositionRequiredError extends Error {
  readonly reasonCode = "heldQueueDispositionRequired";
  constructor() {
    super("held queue requires heldQueueDisposition (clearQueueAndSend | keepQueueAndSend)");
    this.name = "V4HeldQueueDispositionRequiredError";
  }
}

/** The queue changed on the other end while the confirm dialog was open: a stale confirm may not clear/keep-and-send. */
export class V4HeldQueueConfirmationStaleError extends Error {
  readonly reasonCode = "guard.heldQueueConfirmationStale";
  constructor() {
    super("paused queue changed after send confirmation opened");
    this.name = "V4HeldQueueConfirmationStaleError";
  }
}

export async function enqueueDeferredInputForBusyWork(
  record: V4SessionRecordView,
  text: string,
  options: {
    commandKind?: SteerTurnOptions["commandKind"];
    inputId: string;
    queryId: SteerTurnOptions["queryId"];
    intent?: SteerTurnOptions["intent"];
    attachments?: TurnAttachment[];
    toolDisallowlist?: SteerTurnOptions["toolDisallowlist"];
  },
): Promise<boolean> {
  if (!record.app.enqueueDeferredInput) return false;
  const result = await record.app.enqueueDeferredInput(text, {
    ...(options.commandKind ? { commandKind: options.commandKind } : {}),
    delivery: "queue",
    inputId: options.inputId,
    ...(options.intent ? { intent: options.intent } : {}),
    ...(options.attachments ? { attachments: options.attachments } : {}),
    ...(options.toolDisallowlist ? { toolDisallowlist: options.toolDisallowlist } : {}),
    queryId: options.queryId,
  });
  if (result.kind === "queued") return true;
  throw new V4InputAdmissionRejectedError(
    result.reason === "input_too_large"
      ? "proto.payloadTooLarge"
      : result.reason === "empty_input"
        ? "proto.invalidPayload"
        : "fault.command.inputRejected",
    `deferred input rejected: ${result.reason}`,
  );
}

/**
 * Held-choice verdict commons (catalog B06/B07, ruling 2026-07-05): with completed + queue>0 +
 // autoDrain=false (projected inputRouting.mode=choice) input never silently enqueues —
 * clear -> empty the queue then startNow; keep -> keep the queue, startNow; absent -> reject.
 */
export async function applyHeldQueueDisposition(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  disposition: "clearQueueAndSend" | "keepQueueAndSend" | undefined,
  expectedQueueItemIds?: readonly string[],
): Promise<void> {
  const routing = host.getInputRoutingMode?.(record.app.sessionId) ?? null;
  if (routing !== "choice") return;
  if (!disposition) {
    throw new V4HeldQueueDispositionRequiredError();
  }
  if (expectedQueueItemIds) {
    const expected = new Set(expectedQueueItemIds);
    const sameItems =
      expected.size === expectedQueueItemIds.length &&
      host.getQueueLength?.(record.app.sessionId) === expected.size &&
      expectedQueueItemIds.every(
        (queueItemId) => host.getQueueItem?.(record.app.sessionId, queueItemId) !== null,
      );
    if (!sameItems) {
      throw new V4HeldQueueConfirmationStaleError();
    }
  }
  if (disposition === "clearQueueAndSend") {
    await record.app.clearQueueItems();
    host.clearQueuedTurnExecutions?.(record.app.sessionId);
  }
}

/**
 * M3-compat admission: new senders state Selection/Mode/Plan explicitly; old senders get them pinned at the CLI receive boundary.
 * current Session values pinned into the canonical intent at the CLI receive boundary. Once pinned, Queue/Guide never read the mutable Session.
 */
export function resolveSubmittedExecutionState(
  record: V4SessionRecordView,
  payload: {
    modelSelection?: ModelSelection;
    mode?: SubmissionMode;
    planEnabled?: boolean;
  },
): { modelSelection: ModelSelection; mode: SubmissionMode; planEnabled: boolean } {
  let modelSelection = payload.modelSelection;
  if (!modelSelection) {
    const runtimeSelection = record.app.runtime?.getSessionModelSelection?.();
    const entrySelection = runtimeSelection
      ? undefined
      : parseProviderQualifiedModelSelection(record.app.getModel());
    if (!runtimeSelection && !entrySelection) {
      throw new Error(`Session model must be provider-qualified: ${record.app.getModel()}`);
    }
    // Why: getThoughtLevel() is the Active Model's effective display fact. Putting it back
    // into the canonical intent would disguise a Config default as an explicit pin; legacy senders can only pin the sparse Selection
    // the Session already holds, never re-interpret it at admission.
    modelSelection = runtimeSelection
      ? {
          providerId: runtimeSelection.providerId,
          modelId: runtimeSelection.modelId,
          ...(runtimeSelection.options ? { options: { ...runtimeSelection.options } } : {}),
        }
      : {
          providerId: entrySelection!.providerId,
          modelId: entrySelection!.modelId,
          ...(entrySelection!.options ? { options: { ...entrySelection!.options } } : {}),
        };
  }
  const current = resolveExecutionState({
    mode: record.app.getMode?.(),
    planEnabled: record.app.runtime?.getPlanEnabled?.(),
  });
  const state = resolveExecutionState(payload, current);
  return {
    modelSelection,
    mode: state.mode === "auto" ? "build" : state.mode,
    planEnabled: state.planEnabled,
  };
}

/**
 * A Highspeed Selection is valid only paired with the same turn's execution material. Retry, edit re-send, expired cards, and
 // queue promotion without valid material fall back to the resident Selection through this one resolver;
 // never drop modelExecution while keeping the account:*-highspeed-card Selection (spec 3, rule 13).
 // Read-only on the session's current value; never rewrites the resident model.
 */
export function resolveSessionFallbackModelSelection(record: V4SessionRecordView): ModelSelection {
  return resolveSubmittedExecutionState(record, {}).modelSelection;
}
