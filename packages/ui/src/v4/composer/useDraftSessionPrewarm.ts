/* oxlint-disable eslint(max-lines) -- draft-prewarm creation, reuse, disposal, and first-frame ModelSelection must share one owner state machine; splitting files would make the StrictMode/transport-generation cleanup ordering harder to audit. */
// Draft-state v4 session prewarm.
//
// Context: with no session on record in draft state, the config panel falls back to the workspace-default legacy RPC whose
// buildWorkspaceState reply builds a full app each call (140-798ms), and the first send would createSession inline.
// The v4 protocol already has the phase=draft session entity (pane-bound draft
// session = a server-side session); this module creates one in the background while the pane has no session:
// a draft session as the prewarm carrier -- config writes via v4 CAS straight to the session, first sendText reuses it,
// unused ones get cleaned. Memory-only, gone on CLI restart; the gateway isDraftSession filter keeps
// it from leaking into the sessions-index sidebar as a new task.
//
// Shape: lifecycle converges in the pure controller startDraftSessionPrewarm (unit-testable, React-free);
// useDraftSessionPrewarm only wires effects and exposes the owner-scoped binding.
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { CommandAck, CommandType, SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";

type DispatchCommand = (
  type: CommandType,
  payload: Record<string, unknown>,
  targetSessionId: string | null,
) => Promise<CommandAck>;

export interface DraftPrewarmController {
  /** The first admission command is out, ACK unsettled; dispose must not delete a session with unknown result. */
  markPromotionPending(): void;
  // Set after a successful first send (dispose no longer deletes the promoted session).
  markPromoted(): void;
  // Set after the session goes bad (subscribe error/sendText rejected); dispose sends no deleteSession - the session is likely gone already.
  markDiscarded(): void;
  /**
   * Lifecycle end (effect cleanup / workspace switch / real session bound):
   * created, unpromoted, valid -> deleteSession; creation in flight -> delete on ack.
   */
  dispose(): void;
}

/** Prewarm lifecycle pure controller: create -> onReady -> dispose decides cleanup. */
export function startDraftSessionPrewarm(params: {
  workspaceKey: string;
  dispatchCommand: DispatchCommand;
  onReady: (sessionId: string) => void;
  /** Single-flight owner awaiting the uncancellable createSession settlement; invoked exactly once, success or failure. */
  onSettled?: () => void;
  /** Prewarm session initial config (the global last-selection, resolved synchronously); the first projection frame is global, no flash. */
  resolveInitialConfig?: () => Partial<SessionConfigState> | undefined;
}): DraftPrewarmController {
  const { workspaceKey, dispatchCommand, onReady, onSettled, resolveInitialConfig } = params;
  let disposed = false;
  let promotionState: "draft" | "pending" | "promoted" | "discarded" = "draft";
  let createdSessionId: string | null = null;

  const deleteCreatedSession = (sessionId: string) => {
    void dispatchCommand("deleteSession", {}, sessionId)
      .then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn("[v4-draft-prewarm] prewarm session cleanup rejected", {
            sessionId,
            status: ack.status,
            reasonCode: ack.reasonCode ?? null,
          });
        }
      })
      .catch(() => {
        // A failed cleanup is harmless: the in-memory session dies with the CLI anyway.
      });
  };

  const createPayload = () => {
    const createPayload: Record<string, unknown> = { workspaceId: workspaceKey };
    const initialConfig = resolveInitialConfig?.();
    if (initialConfig && Object.keys(initialConfig).length > 0) {
      // The prewarm session uses the global model from frame one (the CLI merges createSession.config); no workspace-default flash.
      createPayload.config = initialConfig;
    }
    return createPayload;
  };
  const dispatchCreateSession = () => {
    const createSessionPayload = createPayload();
    if (disposed) {
      return Promise.resolve(null);
    }
    return dispatchCommand("createSession", createSessionPayload, null);
  };
  const createSessionAck = dispatchCreateSession();
  void createSessionAck
    .then((ack) => {
      if (!ack) {
        return;
      }
      if (ack.status !== "accepted" || ack.result?.type !== "createSession") {
        logger.warn("[v4-draft-prewarm] createSession rejected; falling back to no-prewarm path", {
          status: ack.status,
          reasonCode: ack.reasonCode ?? null,
          workspaceKey,
        });
        return;
      }
      createdSessionId = ack.result.sessionId;
      if (disposed) {
        // Creation cannot be cancelled on a very fast switch away; delete in place once the ACK lands, leaving no stray in-memory session.
        deleteCreatedSession(createdSessionId);
        return;
      }
      logger.info("[v4-draft-prewarm] draft session prewarm ready", {
        sessionId: createdSessionId,
        workspaceKey,
      });
      onReady(createdSessionId);
    })
    .catch((error) => {
      logger.warn("[v4-draft-prewarm] createSession failed; falling back to no-prewarm path", {
        error: error instanceof Error ? error.message : String(error),
        workspaceKey,
      });
    })
    .finally(() => {
      onSettled?.();
    });

  return {
    markPromotionPending() {
      if (promotionState === "draft") {
        promotionState = "pending";
      }
    },
    markPromoted() {
      promotionState = "promoted";
    },
    markDiscarded() {
      if (promotionState !== "promoted") {
        promotionState = "discarded";
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // An agent may admit the first send during MCP init while the renderer still awaits the ACK;
      // an owner cleanup treating it as a plain draft would kill a running execution adapter.
      // Only drafts that never started promotion are auto-reclaimable; pending waits for the original command to settle.
      if (createdSessionId && promotionState === "draft") {
        deleteCreatedSession(createdSessionId);
      }
    },
  };
}

export interface DraftSessionPrewarm {
  // The prewarm binding readied for the current workspace/transport generation.
  binding: DraftPrewarmBinding | null;
}

export interface DraftPrewarmBinding {
  workspaceKey: string;
  sessionId: string;
  // Holds lifecycle synchronously before the first admission command; false once the binding is no longer this owner's.
  beginPromotion(): boolean;
  // Set after a successful first send (stops cleanup from deleteSession-ing the promoted session).
  promote(): void;
  // Dropped on subscribe error / sendText rejection; affects only the controller that created this binding.
  discard(): void;
}

interface DraftPrewarmSubscriber {
  invalidationVersion: number;
  onBinding: (binding: DraftPrewarmBinding | null) => void;
}

interface DraftPrewarmCurrent {
  invalidationVersion: number;
  controller: DraftPrewarmController;
  binding: DraftPrewarmBinding | null;
  settled: boolean;
  retiring: boolean;
  // Which backoff attempt of this generation produced the binding; 0 = first send.
  retryAttempt: number;
}

/**
 * Backoff-retry schedule after a failed createSession.
 *
 * CUA Helper ready triggers a workspace-dispose recycle that interrupts an in-flight
 * createSession with client disposed. Warn-once would mean a permanent no-prewarm fallback:
 // the draft never gets a sessionId and pasted images stick in waitingSession at 0%. The
 // recycle is transient - retrying shortly succeeds - hence bounded backoff, not surrender.
 */
const PREWARM_RETRY_DELAYS_MS = [500, 1000, 2000];

/**
 * Prewarm coordinator per logical draft pane.
 *
 * createSession cannot bind to a React effect instance: cleanup cannot cancel in-flight
 * protocol requests while the new effect fires another createSession, so the agent's global FIFO fills with
 * one draft's slow creations. The coordinator keeps the owner across sync remounts and gates the next generation until the old ack.
 */
class DraftSessionPrewarmCoordinator {
  private readonly subscribers = new Map<symbol, DraftPrewarmSubscriber>();
  private current: DraftPrewarmCurrent | null = null;
  private blockedInvalidationVersion: number | null = null;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private dispatchCommand: DispatchCommand;
  private resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined;

  constructor(
    private readonly workspaceKey: string,
    dispatchCommand: DispatchCommand,
    resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined,
    private readonly onEmpty: () => void,
  ) {
    this.dispatchCommand = dispatchCommand;
    this.resolveInitialConfig = resolveInitialConfig;
  }

  update(
    dispatchCommand: DispatchCommand,
    resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined,
  ): void {
    this.dispatchCommand = dispatchCommand;
    this.resolveInitialConfig = resolveInitialConfig;
  }

  acquire(params: {
    invalidationVersion: number;
    onBinding: (binding: DraftPrewarmBinding | null) => void;
  }): () => void {
    if (this.cleanupTimer !== null) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const token = Symbol("draft-prewarm-subscriber");
    this.subscribers.set(token, params);
    this.reconcile();
    this.emitBindingTo(params);

    return () => {
      if (!this.subscribers.delete(token) || this.subscribers.size > 0) {
        return;
      }
      // StrictMode/same-key remounts cleanup then re-run the effect; defer to the next task to confirm
      // the real departure, avoiding create->cleanup-delete->create protocol churn.
      this.cleanupTimer = setTimeout(() => {
        this.cleanupTimer = null;
        if (this.subscribers.size > 0) {
          return;
        }
        this.retireCurrent();
        if (!this.current) {
          this.onEmpty();
        }
      }, 0);
    };
  }

  private requestedInvalidationVersion(): number | null {
    let latest: number | null = null;
    for (const subscriber of this.subscribers.values()) {
      latest =
        latest === null
          ? subscriber.invalidationVersion
          : Math.max(latest, subscriber.invalidationVersion);
    }
    return latest;
  }

  private reconcile(): void {
    const requestedVersion = this.requestedInvalidationVersion();
    if (requestedVersion === null) {
      return;
    }
    if (
      this.blockedInvalidationVersion !== null &&
      this.blockedInvalidationVersion !== requestedVersion
    ) {
      this.blockedInvalidationVersion = null;
    }
    if (this.current) {
      if (!this.current.retiring && this.current.invalidationVersion === requestedVersion) {
        return;
      }
      this.retireCurrent();
      // An issued createSession is uncancellable; onSettled queues the delete after the ACK and starts only the newest generation.
      if (this.current) {
        return;
      }
    }
    if (this.blockedInvalidationVersion === requestedVersion) {
      return;
    }
    this.startCurrent(requestedVersion);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * A settled createSession without a binding is a failure (rejected or threw). client-disposed from recycling is
   * transient -- requeue one creation with backoff; once spent, keep the existing fall back to no-prewarm.
   */
  private scheduleRetryAfterFailure(failed: DraftPrewarmCurrent): void {
    const delay = PREWARM_RETRY_DELAYS_MS[failed.retryAttempt];
    if (delay === undefined) return;
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.current !== failed || failed.retiring || failed.binding !== null) return;
      if (this.subscribers.size === 0) return;
      const requestedVersion = this.requestedInvalidationVersion();
      if (requestedVersion === null || this.blockedInvalidationVersion === requestedVersion) return;
      // Release the failed generation so the next one passes reconcile's single-flight gate.
      this.current = null;
      this.startCurrent(requestedVersion, failed.retryAttempt + 1);
    }, delay);
  }

  private startCurrent(invalidationVersion: number, retryAttempt = 0): void {
    let current!: DraftPrewarmCurrent;
    const controller = startDraftSessionPrewarm({
      workspaceKey: this.workspaceKey,
      dispatchCommand: (type, payload, targetSessionId) =>
        this.dispatchCommand(type, payload, targetSessionId),
      resolveInitialConfig: () => this.resolveInitialConfig?.(),
      onReady: (sessionId) => {
        if (this.current !== current || current.retiring) {
          return;
        }
        let binding!: DraftPrewarmBinding;
        binding = {
          workspaceKey: this.workspaceKey,
          sessionId,
          beginPromotion: () => {
            if (this.current !== current || current.binding !== binding) {
              return false;
            }
            current.controller.markPromotionPending();
            return true;
          },
          promote: () => {
            if (this.current !== current || current.binding !== binding) {
              return;
            }
            current.controller.markPromoted();
          },
          discard: () => {
            if (this.current !== current || current.binding !== binding) {
              return;
            }
            current.controller.markDiscarded();
            current.binding = null;
            this.blockedInvalidationVersion = current.invalidationVersion;
            this.emitBindings();
          },
        };
        current.binding = binding;
        this.emitBindings();
      },
      onSettled: () => {
        current.settled = true;
        if (this.current !== current || !current.retiring) {
          // Not retired yet no binding = createSession failed; transient recycles may retry via backoff.
          if (this.current === current && !current.retiring && current.binding === null) {
            this.scheduleRetryAfterFailure(current);
          }
          return;
        }
        this.current = null;
        if (this.subscribers.size > 0) {
          this.reconcile();
        } else {
          this.onEmpty();
        }
      },
    });
    current = {
      invalidationVersion,
      controller,
      binding: null,
      settled: false,
      retiring: false,
      retryAttempt,
    };
    this.current = current;
  }

  private retireCurrent(): void {
    const current = this.current;
    if (!current || current.retiring) {
      return;
    }
    this.clearRetryTimer();
    current.retiring = true;
    current.binding = null;
    current.controller.dispose();
    this.emitBindings();
    if (current.settled) {
      this.current = null;
    }
  }

  private emitBindings(): void {
    for (const subscriber of this.subscribers.values()) {
      this.emitBindingTo(subscriber);
    }
  }

  private emitBindingTo(subscriber: DraftPrewarmSubscriber): void {
    const current = this.current;
    subscriber.onBinding(
      current && !current.retiring && current.invalidationVersion === subscriber.invalidationVersion
        ? current.binding
        : null,
    );
  }
}

const draftPrewarmCoordinatorsByTransport = new Map<
  unknown,
  Map<string, DraftSessionPrewarmCoordinator>
>();

function logicalDraftOwnerKey(workspaceKey: string, paneId: string): string {
  return JSON.stringify([workspaceKey, paneId]);
}

function getDraftSessionPrewarmCoordinator(params: {
  workspaceKey: string;
  paneId: string;
  transportIdentity: unknown;
  dispatchCommand: DispatchCommand;
  resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined;
}): DraftSessionPrewarmCoordinator {
  let transportCoordinators = draftPrewarmCoordinatorsByTransport.get(params.transportIdentity);
  if (!transportCoordinators) {
    transportCoordinators = new Map();
    draftPrewarmCoordinatorsByTransport.set(params.transportIdentity, transportCoordinators);
  }
  const ownerKey = logicalDraftOwnerKey(params.workspaceKey, params.paneId);
  let coordinator = transportCoordinators.get(ownerKey);
  if (!coordinator) {
    coordinator = new DraftSessionPrewarmCoordinator(
      params.workspaceKey,
      params.dispatchCommand,
      params.resolveInitialConfig,
      () => {
        if (transportCoordinators?.get(ownerKey) !== coordinator) {
          return;
        }
        transportCoordinators.delete(ownerKey);
        if (transportCoordinators.size === 0) {
          draftPrewarmCoordinatorsByTransport.delete(params.transportIdentity);
        }
      },
    );
    transportCoordinators.set(ownerKey, coordinator);
  }
  return coordinator;
}

export function useDraftSessionPrewarm(params: {
  /** Enabled while the pane has no bound session (sessionId===null). */
  enabled: boolean;
  workspaceKey: string;
  /** Logical pane identity within the workspace; must stay stable across synchronous remounts. */
  paneId: string;
  /** Bumps on capability changes; only recycles/rebuilds not-yet-promoted draft prewarm sessions. */
  invalidationVersion?: number;
  /** The conversation provider transport identity; stable across same-workspace lease changes. */
  transportIdentity: unknown;
  dispatchCommand: DispatchCommand;
  /** Prewarm session initial config (the global last-selection, resolved synchronously); the first projection frame is global, no flash. */
  resolveInitialConfig?: () => Partial<SessionConfigState> | undefined;
}): DraftSessionPrewarm {
  const {
    enabled,
    workspaceKey,
    paneId,
    transportIdentity,
    invalidationVersion = 0,
    dispatchCommand,
    resolveInitialConfig,
  } = params;
  // workspace/pane/transport together define the logical owner: same-owner remounts reuse single-flight, while a transport
  // generation change mints a new coordinator so old-session cleanup never rides the new transport.
  const owner = useMemo(
    () => ({ workspaceKey, paneId, transportIdentity }),
    [paneId, transportIdentity, workspaceKey],
  );
  const coordinator = useMemo(
    () =>
      getDraftSessionPrewarmCoordinator({
        workspaceKey,
        paneId,
        transportIdentity,
        dispatchCommand,
        resolveInitialConfig,
      }),
    [owner],
  );
  useLayoutEffect(() => {
    coordinator.update(dispatchCommand, resolveInitialConfig);
  }, [coordinator, dispatchCommand, resolveInitialConfig]);
  const generation = useMemo(() => ({ owner }), [enabled, invalidationVersion, owner]);
  const [ready, setReady] = useState<{
    generation: typeof generation;
    binding: DraftPrewarmBinding;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    return coordinator.acquire({
      invalidationVersion,
      onBinding: (binding) => {
        setReady((current) => {
          if (!binding) {
            return current?.generation === generation ? null : current;
          }
          return { generation, binding };
        });
      },
    });
  }, [coordinator, enabled, generation, invalidationVersion]);

  return { binding: ready?.generation === generation ? ready.binding : null };
}
