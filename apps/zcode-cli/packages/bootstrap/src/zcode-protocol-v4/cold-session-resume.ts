// Cold-resume coordinator: when subscribing to a session that is not in the in-memory registry but may be persisted
// (opening history after a CLI restart), pull the record up via the host hook, then rejoin the existing
// gateway READY hydration path. Split from v4-gateway (single responsibility + max-lines).
//
// Semantic notes:
// - Only the existing runtime-activation single-flight lives here; the full READY watermark is the gateway's job;
// - error typing (project rule: never branch on error text):
//   fault.subscribe.sessionNotFound (not in the store either / host does not support resume)
//   vs fault.subscribe.resumeFailed (resume failed midway, original cause preserved).
//   message carries the reasonCode -- the renderer's subscription error block shows lastError directly, no UI change needed.

import type { MessageWithParts } from "@zcode/contracts";
import type { ZCodeWorkspaceRef } from "@zcode/shared";

export type ColdSessionResumeOutcome =
  | { status: "resumed"; persistedMessages?: MessageWithParts[] }
  | { status: "notFound" };

/** The narrow host-capability surface the coordinator needs (shaped like V4GatewayHost, avoiding a cyclic import). */
export interface ColdSessionResumeHost {
  resumePersistedSession?(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<ColdSessionResumeOutcome>;
  onDebug?(message: string): void;
  onError?(scope: string, error: unknown, context?: Record<string, unknown>): void;
}

/** Structured error for unresumable sessions (reasonCodes in the file header). */
export class V4SubscribeSessionUnavailableError extends Error {
  constructor(
    readonly sessionId: string,
    readonly reasonCode: "fault.subscribe.sessionNotFound" | "fault.subscribe.resumeFailed",
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`${detail} (${reasonCode})`, options);
    this.name = "V4SubscribeSessionUnavailableError";
  }
}

export class ColdSessionResumeCoordinator {
  /** sessionId -> in-flight runtime activation; released as soon as it settles. */
  private readonly flights = new Map<string, Promise<MessageWithParts[] | undefined>>();

  constructor(private readonly host: ColdSessionResumeHost) {}

  ensureResumed(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<MessageWithParts[] | undefined> {
    const inFlight = this.flights.get(sessionId);
    if (inFlight) {
      this.host.onDebug?.(`cold resume joined existing flight session=${sessionId}`);
      return inFlight;
    }
    this.host.onDebug?.(`cold resume flight created session=${sessionId}`);
    const flight = this.resume(sessionId, resumeThoughtLevel, workspace).finally(() => {
      this.flights.delete(sessionId);
      this.host.onDebug?.(`cold resume flight cleared session=${sessionId}`);
    });
    this.flights.set(sessionId, flight);
    return flight;
  }

  clear(): void {
    this.flights.clear();
  }

  private async resume(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<MessageWithParts[] | undefined> {
    const resume = this.host.resumePersistedSession;
    if (!resume) {
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.sessionNotFound",
        `Session is not active: ${sessionId}`,
      );
    }
    let outcome: ColdSessionResumeOutcome;
    try {
      outcome = workspace
        ? await resume.call(this.host, sessionId, resumeThoughtLevel, workspace)
        : await resume.call(this.host, sessionId, resumeThoughtLevel);
    } catch (error) {
      this.host.onError?.("v4.subscribe.resume", error, {
        phase: "resumePersistedSession",
        sessionId,
      });
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.resumeFailed",
        `Failed to resume persisted session ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (outcome.status === "notFound") {
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.sessionNotFound",
        `Session is not active and not persisted: ${sessionId}`,
      );
    }
    return outcome.persistedMessages;
  }
}
