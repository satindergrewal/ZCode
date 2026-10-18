import { OffPeakPermanentDispatchError } from "@zcode/services/node";

/**
 * Off-peak dispatch, three branches:
 * - resume: conversation_id backfilled means it ran; resume the same session and send the continuation prompt.
 * - bound-first-run: created in-session with session_id bound but never run; resume that session and send the task's original prompt
 *   (mirroring dispatchCronRun's targetTaskId path).
 * - init: form-created; allocate a dedicated session.
 */
export type OffPeakDispatchKind = "resume" | "bound-first-run" | "init";

export function resolveOffPeakDispatchKind(request: {
  conversationId?: string;
  sessionId?: string;
}): OffPeakDispatchKind {
  if (request.conversationId?.trim()) return "resume";
  if (request.sessionId?.trim()) return "bound-first-run";
  return "init";
}

/** Bound session deleted by the user: retrying is pointless; permanent (otherwise backoff runs until the ticket expires and a new one is drawn). */
export class OffPeakBoundSessionDeletedError extends OffPeakPermanentDispatchError {
  constructor(readonly sessionId: string) {
    super(`off-peak bound session was deleted: ${sessionId}`);
    this.name = "OffPeakBoundSessionDeletedError";
  }
}

/**
 * Bound session is running a user turn: transient, left to scheduler backoff.
 * Must throw before writing the session mode. CLI session/send rejects with -32010, but setMode has no active-turn check,
 * so writing config then colliding would silently flip the user's session into the task's permission mode.
 */
export class OffPeakBoundSessionBusyError extends Error {
  constructor(readonly sessionId: string) {
    super(`off-peak bound session is busy: ${sessionId}`);
    this.name = "OffPeakBoundSessionBusyError";
  }
}

export function assertBoundSessionDispatchable(params: {
  sessionId: string;
  deleted: boolean;
  running: boolean;
}): void {
  if (params.deleted) throw new OffPeakBoundSessionDeletedError(params.sessionId);
  if (params.running) throw new OffPeakBoundSessionBusyError(params.sessionId);
}
