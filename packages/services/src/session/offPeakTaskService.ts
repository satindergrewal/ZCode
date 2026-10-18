/* eslint-disable max-lines -- the off-peak orchestrator keeps create/cancel/pause/resume/delete,
   poll sync (offPeakTaskSync), the terminal-settle outbox, and 3102 re-ticketing together; split once stable. */
/* Off-peak task orchestration service (host domain, modeled on automationService).
   Responsibilities:
   - ticket-on-create (persist only after POST /ticket, 4.1); 3103/3101 surface as typed errors
   - state-guard orchestration for cancel/pause/resume/delete/edit (D29-3/D30-7/D30-10)
   - offPeakTaskSync: batch-poll /ticket/status only with non-terminal tasks (polling drives server promotion, D25/D26),
     writing back schedulable/position/next_poll_at; expired non-paused re-tickets under the same task id (D26/D27)
   - terminal-settle outbox: settle on terminal, piggyback retries each poll, startup sweep (D22/7.7)
   - 3102 resume: host terminal writeback flags it and calls handleTicketExpiredDuringRun to re-ticket (4.6) */
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import {
  isOffPeakTerminalStatus,
  resolveWorkspaceKey,
  type OffPeakCodingPlanSupport,
  type OffPeakTaskCreateErrorCategory,
  type OffPeakTaskCreateFailureStage,
  type OffPeakTaskCreateResult,
  type ZCodeOffPeakTask,
  type ZCodeOffPeakTaskCreateParams,
} from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import { isOffPeakBoundSessionConflict, type OffPeakTaskRepo } from "./offPeakTaskRepo.js";
import type { IOffPeakTaskService, OffPeakUpdateTaskParams } from "./offPeakTask.js";
import { OffPeakServerError, type OffPeakServerClient } from "./offPeakServerClient.js";
import type { ModelSelection, ModelSelectionValidation } from "@zcode/provider";

/** Poll floor/ceiling and failure backoff (server next_poll_after wins, clamped to avoid storms and starvation). */
export const OFF_PEAK_SYNC_MIN_INTERVAL_MS = 5_000;
export const OFF_PEAK_SYNC_MAX_INTERVAL_MS = 5 * 60_000;
const SYNC_FAILURE_BASE_MS = 10_000;

export interface OffPeakTaskServiceDeps {
  repo: OffPeakTaskRepo;
  client: OffPeakServerClient;
  //* Sanitized resolver result shared with ticket/runtime, gating renderer creation. */
  resolveCodingPlanSupport: () => Promise<OffPeakCodingPlanSupport>;
  //* Safe hostname only; empty on parse failure, never affecting the create result. */
  resolveTelemetryProviderName: () => Promise<string>;
  //* Resolves/validates the fixed Off-Peak selection against the full registry. */
  resolveModelSelection: (input: {
    readonly modelId?: string;
    readonly reasoningLevel?: string;
  }) => Promise<
    | { readonly ok: true; readonly selection: ModelSelection }
    | { readonly ok: false; readonly validation: ModelSelectionValidation }
  >;
  logger: ServiceLogger;
  //* Wakes the scheduler tick as soon as schedulable flips (else it waits 20s). */
  requestSchedulerWake?: () => void;
  //* Aborts a running task's agent loop on cancel (host-injected, best-effort). */
  stopRunningTask?: (params: {
    conversationId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
  //* List-changed hook for UI refresh. */
  onTasksChanged?: () => void;
  //* Test-injected clock. */
  now?: () => number;
  //* Extra disposeAll cleanup (e.g. stopping the mock gateway). */
  onDispose?: () => void;
}

const VALID_CREATE_PERMISSION_MODES = new Set([
  "default",
  "yolo",
  "guarded",
  "plan",
  "edit",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "autoEdit",
  "build",
]);

function isValidCreateParams(params: ZCodeOffPeakTaskCreateParams): boolean {
  return (
    typeof params.title === "string" &&
    params.title.trim().length > 0 &&
    typeof params.prompt === "string" &&
    params.prompt.trim().length > 0 &&
    typeof params.workspacePath === "string" &&
    params.workspacePath.trim().length > 0 &&
    typeof params.permissionMode === "string" &&
    VALID_CREATE_PERMISSION_MODES.has(params.permissionMode)
  );
}

export function classifyOffPeakCreateFailure(
  error: unknown,
  failureStage: OffPeakTaskCreateFailureStage,
): Pick<
  Extract<OffPeakTaskCreateResult, { ok: false }>,
  "failureStage" | "errorCategory" | "errorCode"
> {
  let errorCategory: OffPeakTaskCreateErrorCategory = "unknown";
  let errorCode = "";
  if (failureStage === "client_validation") {
    errorCategory = "client_validation";
  } else if (failureStage === "local_persist") {
    errorCategory = "local_persist";
  } else if (error instanceof OffPeakServerError) {
    errorCode = error.bizCode === undefined ? "" : String(error.bizCode);
    if (error.bizCode === 3101) errorCategory = "eligibility_3101";
    else if (error.bizCode === 3103) errorCategory = "quota_3103";
  } else if (error instanceof ZodError) {
    errorCategory = "invalid_response";
  } else {
    // The ticket client can throw plain Errors across layers (credential/RPC/fetch/abort);
    // they are still ticket_request: never guess from raw messages or leak server bodies.
    errorCategory = "network";
  }
  return { failureStage, errorCategory, errorCode };
}

const OFF_PEAK_SESSION_BOUND_FAILURE = {
  failureStage: "client_validation",
  errorCategory: "client_validation",
  errorCode: "session_bound",
} as const;

export class OffPeakTaskService implements IOffPeakTaskService {
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncRunning = false;
  private syncStopped = true;
  private consecutiveSyncFailures = 0;

  constructor(private readonly deps: OffPeakTaskServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private emitChanged(): void {
    try {
      this.deps.onTasksChanged?.();
    } catch (error) {
      this.deps.logger.warn("off-peak onTasksChanged callback failed:", error);
    }
  }

  //---- Management ops ----

  async getCodingPlanSupport(): Promise<OffPeakCodingPlanSupport> {
    return this.deps.resolveCodingPlanSupport();
  }

  //* Narrow pre-dispatch check; the target agent ModelFactory revalidates at execution. */
  async validateDispatchModelSelection(selection: ModelSelection): Promise<boolean> {
    const resolved = await this.deps.resolveModelSelection({
      modelId: selection.modelId,
      ...(selection.options?.reasoningLevel
        ? { reasoningLevel: selection.options.reasoningLevel }
        : {}),
    });
    return (
      resolved.ok &&
      resolved.selection.providerId === selection.providerId &&
      resolved.selection.modelId === selection.modelId
    );
  }

  async getTakeNumberAvailability() {
    return this.deps.client.getTakeNumberAvailability();
  }

  //* Ticket-on-create (persist after success); failures return stable classes, never raw errors over RPC. */
  async createTask(params: ZCodeOffPeakTaskCreateParams): Promise<OffPeakTaskCreateResult> {
    let providerName = "";
    try {
      providerName = await this.deps.resolveTelemetryProviderName();
    } catch {
      // provider_name is telemetry-only; parse failure never alters creation, toasts, or execution.
    }
    if (!isValidCreateParams(params)) {
      return {
        ok: false,
        ...classifyOffPeakCreateFailure(undefined, "client_validation"),
        providerName,
      };
    }
    const selection = await this.deps.resolveModelSelection({
      modelId: params.modelSelection.modelId,
      ...(params.modelSelection.options?.reasoningLevel
        ? { reasoningLevel: params.modelSelection.options.reasoningLevel }
        : {}),
    });
    if (!selection.ok) {
      return {
        ok: false,
        ...classifyOffPeakCreateFailure(undefined, "client_validation"),
        providerName,
      };
    }
    const normalizedParams: ZCodeOffPeakTaskCreateParams = {
      ...params,
      modelSelection: selection.selection,
    };
    // Reject when the bound session already has a non-terminal task, before spending a ticket;
    // races past the check fail at INSERT via idx_off_peak_bound_active (see local_persist).
    if (
      params.boundSessionId &&
      (await this.deps.repo.hasActiveBoundTask(
        resolveWorkspaceKey({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        }),
        params.boundSessionId,
      ))
    ) {
      return { ok: false, ...OFF_PEAK_SESSION_BOUND_FAILURE, providerName };
    }
    const offPeakTaskId = `offpeak-${randomUUID()}`;
    let ticket;
    try {
      ticket = await this.deps.client.takeTicket(offPeakTaskId);
    } catch (error) {
      return {
        ok: false,
        ...classifyOffPeakCreateFailure(error, "ticket_request"),
        providerName,
      };
    }
    let created: ZCodeOffPeakTask;
    try {
      created = await this.deps.repo.create(normalizedParams, {
        offPeakTaskId,
        serverTicketId: ticket.ticketId,
        registeredAt: ticket.registeredAt,
        ...(ticket.position !== undefined ? { queuePosition: ticket.position } : {}),
        // Ticket-ready-on-take (idle promotion) dispatches inline
        schedulable: ticket.state === "ready",
      });
      if (ticket.nextPollAfterMs !== undefined) {
        await this.deps.repo.updateSchedulingSnapshot(created.offPeakTaskId, {
          nextPollAt: this.now() + ticket.nextPollAfterMs,
        });
      }
    } catch (error) {
      if (isOffPeakBoundSessionConflict(error)) {
        // Voided tickets expire server-side; no release endpoint for this.
        return { ok: false, ...OFF_PEAK_SESSION_BOUND_FAILURE, providerName };
      }
      return {
        ok: false,
        ...classifyOffPeakCreateFailure(error, "local_persist"),
        providerName,
      };
    }
    this.deps.logger.info(
      `off-peak task created id=${offPeakTaskId} ticket=${ticket.ticketId} state=${ticket.state}`,
    );
    this.emitChanged();
    this.ensureSyncScheduled(0);
    if (ticket.state === "ready") {
      try {
        this.deps.requestSchedulerWake?.();
      } catch (error) {
        this.deps.logger.warn("off-peak scheduler wake failed after create:", error);
      }
    }
    return {
      ok: true,
      task: created,
      ticketInitialState: ticket.state,
      ...(ticket.position !== undefined ? { queuePosition: ticket.position } : {}),
      providerName,
    };
  }

  /**
   * Cancel (any non-terminal): terminal state first, then stop the loop, so a late stopped writeback
   * hits the terminal guard and cannot overwrite cancelled (idempotent).
   */
  async cancelTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const existing = await this.deps.repo.get(offPeakTaskId);
    if (!existing || isOffPeakTerminalStatus(existing.status)) return existing;
    const cancelled = await this.deps.repo.markTerminal(offPeakTaskId, {
      status: "cancelled",
      endedAt: this.now(),
    });
    if (!cancelled) return this.deps.repo.get(offPeakTaskId);
    if (existing.status === "running" && existing.conversationId && this.deps.stopRunningTask) {
      try {
        await this.deps.stopRunningTask({
          conversationId: existing.conversationId,
          workspacePath: existing.workspacePath,
          ...(existing.workspaceIdentity ? { workspaceIdentity: existing.workspaceIdentity } : {}),
        });
      } catch (error) {
        this.deps.logger.warn(`off-peak cancel stop loop failed task=${offPeakTaskId}:`, error);
      }
    }
    this.emitChanged();
    void this.settleOne(cancelled);
    return cancelled;
  }

  //* Pause: stop local dispatch; the ticket keeps its server queue spot. */
  async pauseTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const paused = await this.deps.repo.setPaused(offPeakTaskId, true, {
      now: this.now(),
    });
    if (paused) this.emitChanged();
    return paused;
  }

  /**
   * Continue: a live ticket resumes free; a dead one (expired/not_found/absent)
   * at the queue tail (spending needs an explicit user action).
   */
  async continueTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const resumed = await this.deps.repo.setPaused(offPeakTaskId, false, {
      now: this.now(),
    });
    if (!resumed) return null;
    let ticketAlive = false;
    if (resumed.serverTicketId) {
      try {
        const status = await this.deps.client.batchStatus([resumed.serverTicketId]);
        // Match by ticketId, never tickets[0]: batch answers promise no order.
        const entry = status.tickets.find((t) => t.ticketId === resumed.serverTicketId);
        ticketAlive =
          entry !== undefined && entry.state !== "expired" && entry.state !== "not_found";
        if (entry && ticketAlive) {
          await this.deps.repo.updateSchedulingSnapshot(offPeakTaskId, {
            schedulable: entry.state === "ready",
            queuePosition: entry.position ?? null,
            now: this.now(),
          });
        }
      } catch (error) {
        // Status errors count as alive and let polling decide; never burn a ticket on Continue.
        this.deps.logger.warn(
          `off-peak continue status check failed task=${offPeakTaskId}:`,
          error,
        );
        ticketAlive = true;
      }
    }
    if (!ticketAlive) {
      await this.retakeTicket(offPeakTaskId);
    }
    this.emitChanged();
    this.ensureSyncScheduled(0);
    return this.deps.repo.get(offPeakTaskId);
  }

  //* Delete: non-terminal cancels first (stop loop + settle) then deletes; terminal deletes outright. */
  async deleteTask(offPeakTaskId: string): Promise<void> {
    const existing = await this.deps.repo.get(offPeakTaskId);
    if (!existing) return;
    if (!isOffPeakTerminalStatus(existing.status)) {
      await this.cancelTask(offPeakTaskId);
    }
    await this.deps.repo.delete(offPeakTaskId);
    this.emitChanged();
  }

  //* Delete history: local visibility flag only; task and session remain. */
  async deleteHistory(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const updated = await this.deps.repo.markHistoryDeleted(offPeakTaskId, {
      now: this.now(),
    });
    if (updated) this.emitChanged();
    return updated;
  }

  //* Edit (queued/paused fully editable; the ticket pins queue identity, read at prompt dispatch). */
  async updateTask(
    offPeakTaskId: string,
    params: OffPeakUpdateTaskParams,
  ): Promise<ZCodeOffPeakTask | null> {
    const existing = await this.deps.repo.get(offPeakTaskId);
    if (!existing) return null;
    if (existing.status !== "queued" && existing.status !== "paused") {
      // Running locks edits (cancel only); terminal is read-only.
      return null;
    }
    // Off-peak tasks persist a registry-resolvable model; an emptied model must not degrade to
    // first-available-later, or the edited choice and the dispatched model diverge.
    if (params.modelSelection === null) return null;
    const candidate = params.modelSelection ?? existing.modelSelection;
    if (!candidate) return null;
    const selection = await this.deps.resolveModelSelection({
      modelId: candidate.modelId,
      ...(candidate.options?.reasoningLevel
        ? { reasoningLevel: candidate.options.reasoningLevel }
        : {}),
    });
    if (!selection.ok) return null;
    const normalizedParams: OffPeakUpdateTaskParams = {
      ...params,
      modelSelection: selection.selection,
    };
    const updated = await this.deps.repo.updateEditableFields(offPeakTaskId, normalizedParams, {
      now: this.now(),
    });
    if (updated) this.emitChanged();
    return updated;
  }

  async list(): Promise<ZCodeOffPeakTask[]> {
    return this.projectModelSelectionIssues(await this.deps.repo.list());
  }

  async get(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const task = await this.deps.repo.get(offPeakTaskId);
    if (!task) return null;
    return (await this.projectModelSelectionIssues([task]))[0] ?? null;
  }

  /**
   * Derives diagnostics from current config only; no writes. Legacy fields belong to migration.
   */
  private async projectModelSelectionIssues(
    tasks: readonly ZCodeOffPeakTask[],
  ): Promise<ZCodeOffPeakTask[]> {
    const repaired: ZCodeOffPeakTask[] = [];
    for (const task of tasks) {
      if (task.modelSelection) {
        // Nulling an unavailable account on read loses the choice forever and invites legacy rebinds.
        // The new shape derives diagnostics without touching task/ticket; terminal states skip model checks.
        const usable =
          isOffPeakTerminalStatus(task.status) ||
          (await this.validateDispatchModelSelection(task.modelSelection));
        repaired.push(
          usable
            ? task
            : {
                ...task,
                schedulable: false,
                modelSelectionIssue: {
                  code: "repair-required",
                  legacyModelId: task.modelSelection.modelId,
                  legacyReasoningLevel: task.modelSelection.options?.reasoningLevel,
                },
              },
        );
        continue;
      }
      // When migration cannot prove the legacy provider, stay missing; reads never backfill or rebind tickets.
      repaired.push({ ...task, schedulable: false });
    }
    return repaired;
  }

  //---- 3102 resume (host calls after flagging the terminal writeback) ----

  //* Expired ticket (3h active cap/ready void): keep the session, re-ticket under the same task id. */
  async handleTicketExpiredDuringRun(offPeakTaskId: string): Promise<void> {
    const requeued = await this.deps.repo.requeueForContinuation(offPeakTaskId, {
      now: this.now(),
    });
    if (!requeued) {
      this.deps.logger.info(
        `off-peak ticket-expired requeue dropped (not running) task=${offPeakTaskId}`,
      );
      return;
    }
    await this.retakeTicket(offPeakTaskId);
    this.emitChanged();
    this.ensureSyncScheduled(0);
  }

  //* Re-ticket under the same task id (explicitly allowed repeatedly); failures retry next poll. */
  private async retakeTicket(offPeakTaskId: string): Promise<void> {
    try {
      const ticket = await this.deps.client.takeTicket(offPeakTaskId);
      await this.deps.repo.updateSchedulingSnapshot(offPeakTaskId, {
        serverTicketId: ticket.ticketId,
        registeredAt: ticket.registeredAt,
        schedulable: ticket.state === "ready",
        queuePosition: ticket.position ?? null,
        ...(ticket.nextPollAfterMs !== undefined
          ? { nextPollAt: this.now() + ticket.nextPollAfterMs }
          : {}),
        now: this.now(),
      });
      if (ticket.state === "ready") this.deps.requestSchedulerWake?.();
      this.deps.logger.info(
        `off-peak re-take ticket task=${offPeakTaskId} ticket=${ticket.ticketId} state=${ticket.state}`,
      );
    } catch (error) {
      // Take failures (quota/network) never terminalize: stay queued and re-ticket when a poll finds no live ticket.
      this.deps.logger.warn(`off-peak re-take ticket failed task=${offPeakTaskId}:`, error);
    }
  }

  //---- offPeakTaskSync: batch poll + promotion writeback + settle outbox ----

  startSync(): void {
    if (!this.syncStopped) return;
    this.syncStopped = false;
    // Sweep unsettled terminal tasks once at startup.
    this.ensureSyncScheduled(0);
  }

  stopSync(): void {
    this.syncStopped = true;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  //* disposeServiceResources hook: host shutdown stops polling and runs extra cleanup. */
  disposeAll(): void {
    this.stopSync();
    try {
      this.deps.onDispose?.();
    } catch (error) {
      this.deps.logger.warn("off-peak onDispose cleanup failed:", error);
    }
  }

  private ensureSyncScheduled(delayMs: number): void {
    if (this.syncStopped) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.runSyncCycle();
    }, delayMs);
    // Node timers never hold the process open (the host owns this lifecycle).
    this.syncTimer.unref?.();
  }

  //* One sync pass; explicit calls (tests/startup sweep) ignore stopSync, only the self-rescheduling loop obeys. */
  async runSyncCycle(): Promise<void> {
    if (this.syncRunning) return;
    this.syncRunning = true;
    let nextDelay = OFF_PEAK_SYNC_MAX_INTERVAL_MS;
    try {
      // 1) Piggyback settle-outbox retries (no extra timers).
      await this.flushSettleOutbox();
      // 2) Poll only when non-terminal tasks exist.
      const nonTerminal = await this.projectModelSelectionIssues(
        await this.deps.repo.listNonTerminal(),
      );
      const withTickets = nonTerminal.filter((task) => task.serverTicketId);
      // Ticketless queued tasks (failed re-takes): reticket.
      for (const task of nonTerminal) {
        if (!task.serverTicketId && task.status === "queued") {
          await this.retakeTicket(task.offPeakTaskId);
        }
      }
      if (withTickets.length === 0 && nonTerminal.length === 0) {
        // No tasks: stop self-rescheduling until create/continue.
        this.consecutiveSyncFailures = 0;
        return;
      }
      if (withTickets.length > 0) {
        const status = await this.deps.client.batchStatus(
          withTickets.map((task) => task.serverTicketId!),
        );
        let anyBecameSchedulable = false;
        for (const task of withTickets) {
          const entry = status.tickets.find((t) => t.ticketId === task.serverTicketId);
          if (!entry) continue;
          anyBecameSchedulable =
            (await this.applyTicketStatus(task, entry.state, entry.position)) ||
            anyBecameSchedulable;
        }
        if (anyBecameSchedulable) this.deps.requestSchedulerWake?.();
        if (status.nextPollAfterMs !== undefined) {
          nextDelay = status.nextPollAfterMs;
        } else {
          nextDelay = OFF_PEAK_SYNC_MIN_INTERVAL_MS;
        }
        this.emitChanged();
      } else {
        nextDelay = OFF_PEAK_SYNC_MIN_INTERVAL_MS;
      }
      this.consecutiveSyncFailures = 0;
    } catch (error) {
      // Back off after poll failures: no dispatch meanwhile, running tasks untouched.
      this.consecutiveSyncFailures += 1;
      nextDelay = Math.min(
        SYNC_FAILURE_BASE_MS * 2 ** Math.max(0, this.consecutiveSyncFailures - 1),
        OFF_PEAK_SYNC_MAX_INTERVAL_MS,
      );
      this.deps.logger.warn(
        `off-peak sync cycle failed (attempt ${this.consecutiveSyncFailures}):`,
        error,
      );
    } finally {
      this.syncRunning = false;
      const clamped = Math.min(
        Math.max(nextDelay, OFF_PEAK_SYNC_MIN_INTERVAL_MS),
        OFF_PEAK_SYNC_MAX_INTERVAL_MS,
      );
      this.ensureSyncScheduled(clamped);
    }
  }

  //* Maps one ticket state (two-axis); returns whether it became dispatchable. */
  private async applyTicketStatus(
    task: ZCodeOffPeakTask,
    state: string,
    position: number | undefined,
  ): Promise<boolean> {
    const now = this.now();
    switch (state) {
      case "ready": {
        const became = task.schedulable !== true && task.status === "queued";
        await this.deps.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
          schedulable: true,
          queuePosition: position ?? null,
          nextPollAt: now + OFF_PEAK_SYNC_MIN_INTERVAL_MS,
          now,
        });
        return became;
      }
      case "queued":
        await this.deps.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
          schedulable: false,
          queuePosition: position ?? null,
          now,
        });
        return false;
      case "active":
        // Loop running or dispatch in flight: the snapshot only clears the position display.
        await this.deps.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
          queuePosition: null,
          now,
        });
        return false;
      case "expired": {
        // Any expired re-tickets under the same task id (one rule);
        // paused waits for manual Continue, and a running 3h expiry
        // arrives via messages 400/3102; here only queued voided tickets apply.
        if (task.status === "queued") {
          await this.deps.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
            schedulable: false,
            queuePosition: null,
            now,
          });
          await this.retakeTicket(task.offPeakTaskId);
        }
        return false;
      }
      case "settled":
      case "not_found":
      default:
        return false;
    }
  }

  //* Reports unsettled terminal tasks (idempotent; endless failure is harmless, server expiry reclaims). */
  private async flushSettleOutbox(): Promise<void> {
    const unsettled = await this.deps.repo.listUnsettledTerminal();
    for (const task of unsettled) {
      await this.settleOne(task);
    }
  }

  private async settleOne(task: ZCodeOffPeakTask): Promise<void> {
    if (!task.serverTicketId) {
      // No ticket (mock-first/never taken): mark settled to keep the outbox from sticking forever.
      await this.deps.repo.markSettled(task.offPeakTaskId, this.now());
      return;
    }
    try {
      await this.deps.client.settle(task.serverTicketId);
      await this.deps.repo.markSettled(task.offPeakTaskId, this.now());
    } catch (error) {
      if (error instanceof OffPeakServerError && error.httpStatus < 500) {
        // 4xx (unknown ticket) acks idempotently: nothing left to release.
        await this.deps.repo.markSettled(task.offPeakTaskId, this.now());
        return;
      }
      // Network/5xx: stay unsettled, retry next piggyback (no extra timers).
      this.deps.logger.warn(`off-peak settle failed ticket=${task.serverTicketId}:`, error);
    }
  }
}
