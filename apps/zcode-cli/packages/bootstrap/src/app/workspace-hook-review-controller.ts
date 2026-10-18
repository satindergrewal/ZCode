import {
  SessionEventType,
  type WorkspaceHookBundleSnapshot,
  type WorkspaceHookReasonCode,
} from "@zcode/contracts";
import {
  WorkspaceHookReviewFlowRegistry,
  createWorkspaceHookTrustRecords,
  type WorkspaceHookReviewFlow,
  type WorkspaceHookReviewTarget,
  type WorkspaceHookRuntimeAdmissionPort,
  type WorkspaceHookSnapshotEvaluation,
  type WorkspaceHookTrustCoordinator,
} from "@zcode/core";
import type {
  WorkspaceHookReviewDecision,
  WorkspaceHookReviewRequestPayload,
  WorkspaceHookTrustRevokeTarget,
} from "@zcode/shared/zcode-protocol-v4";
import { WorkspaceHookMutationError } from "@zcode/shared/workspace-hook-mutation";

export type * from "./workspace-hook-review-types.js";
import type {
  WorkspaceHookReviewCommandResult,
  WorkspaceHookReviewControllerOptions,
  WorkspaceHookReviewHostPort,
  WorkspaceHookReviewMutationPort,
  WorkspaceHookTrustStoreMutationPort,
} from "./workspace-hook-review-types.js";
import {
  buildWorkspaceHookReviewRequest,
  resolveWorkspaceHookReviewDigests,
  toWorkspaceHookReviewTarget,
} from "./workspace-hook-review-request.js";
import { WorkspaceHookReviewTelemetry } from "./workspace-hook-review-telemetry.js";
import { superviseWorkspaceHookReviewFlow } from "./workspace-hook-review-supervisor.js";
import { applyWorkspaceHookRevoke } from "./workspace-hook-review-revoke.js";

export class WorkspaceHookReviewController {
  private readonly admission: WorkspaceHookRuntimeAdmissionPort;
  private readonly appVersion?: string;
  private readonly coordinator: WorkspaceHookTrustCoordinator;
  private readonly host: WorkspaceHookReviewHostPort;
  private readonly telemetry: WorkspaceHookReviewTelemetry;
  private readonly mutation: WorkspaceHookReviewMutationPort;
  private readonly sessionId: string;
  private readonly store: Promise<WorkspaceHookTrustStoreMutationPort>;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly registry = new WorkspaceHookReviewFlowRegistry();
  /** flow -> supervisor promise. A WeakMap so the entry vanishes once the flow is collected; no extra references. */
  private readonly supervisedFlows = new WeakMap<WorkspaceHookReviewFlow, Promise<void>>();
  private reviewFlowId?: string;
  private generation = 0;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: WorkspaceHookReviewControllerOptions) {
    this.admission = options.admission;
    this.appVersion = options.appVersion;
    this.coordinator = options.coordinator;
    this.host = options.host;
    this.telemetry = new WorkspaceHookReviewTelemetry(this.admission, options.logger);
    this.mutation = options.mutation;
    this.sessionId = options.sessionId;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  /**
   * See workspace-hook-review-supervisor: every newly opened flow must be supervised by it.
   *
   * openOrReuseFlow reuses a still-pending flow
   * object, so repeated requestReview and revoke-reopen paths can each attach a supervisor to the same flow and
   * double-emit ReviewSettled at timeout. Double-supervision is the same disease as none:
   * singleton per flow object; repeat requests reuse the existing supervisor promise.
   */
  private superviseFlow(flow: WorkspaceHookReviewFlow): Promise<void> {
    const existing = this.supervisedFlows.get(flow);
    if (existing) return existing;
    const supervision = superviseWorkspaceHookReviewFlow({
      flow,
      host: this.host,
      registry: this.registry,
      sessionId: this.sessionId,
      telemetry: this.telemetry,
    });
    this.supervisedFlows.set(flow, supervision);
    return supervision;
  }

  /**
   * Soft gate: open a review flow on demand.
   *
   * Invoked via the requestWorkspaceHookReview command when the user clicks review.
   * With no pending items it is a safe no-op (returns accepted).
   * With a live flow, idempotent reuse (openOrReuseFlow).
   * Must go through superviseFlow - otherwise the flow dies silently at timeout and the panel is dead forever.
   */
  async requestReview(target: {
    workspaceIdentity: string;
    bundleDigest: string;
  }): Promise<WorkspaceHookReviewCommandResult> {
    const snapshot = this.admission.getCurrentSnapshot();
    if (
      target.workspaceIdentity !== snapshot.workspaceIdentity ||
      target.bundleDigest !== snapshot.bundleDigest
    ) {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_snapshot_mismatch" as const,
      };
    }
    const evaluation = this.coordinator.evaluateSnapshot({ snapshot });
    // The old implementation counted only configuredEnabled=true pendings as reviewable, deadlocking
    // Settings once it locked the toggle for untrusted hooks - a disabled hook never runs, never raises the
    // banner, and can never pre-establish trust. The config gate and trust are orthogonal; the review request
    // already carries all snapshot items, so decide by admissionClass; a disabled item still does not run after
    // trusting.
    const hasPending = evaluation.items.some((item) => item.admissionClass === "pending");
    if (!hasPending) {
      if (evaluation.items.some((item) => item.trustState === "blocked_policy")) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_blocked_by_policy" as const,
        };
      }
      if (evaluation.storeStatus === "corrupt") {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_trust_store_corrupt" as const,
        };
      }
      // No pending items: safe no-op
      return { accepted: true, reviewItemIds: [] };
    }
    const flow = await this.openOrReuseFlow(snapshot, evaluation);
    void this.superviseFlow(flow).catch(() => undefined);
    return { accepted: true, reviewItemIds: [] };
  }

  respond(
    target: WorkspaceHookReviewTarget,
    decision: WorkspaceHookReviewDecision,
  ): Promise<WorkspaceHookReviewCommandResult> {
    return this.enqueueMutation(async () => {
      const validation = this.registry.validate(target, decision);
      if (!validation.accepted) {
        this.telemetry.responseRejected(target, validation.reasonCode);
        return validation;
      }
      const flow = this.registry.getCurrentFlow(this.sessionId);
      if (!flow) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_review_superseded" as const,
        };
      }
      const snapshot = this.admission.getCurrentSnapshot();
      // The request binds the immutable snapshot bundle captured at open. Today
      // replaceSnapshot's only legitimate caller is toggle (superseding the old flow via refreshPendingFlow);
      // equivalence leans on that implicit invariant. Once the config hot-reload watcher becomes a second
      // caller bypassing refreshPendingFlow, a missing tombstone would land the grant on the new bundle.
      // Validate explicitly, aligned with revokeCurrent, removing the implicit dependency.
      if (
        target.workspaceIdentity !== snapshot.workspaceIdentity ||
        target.bundleDigest !== snapshot.bundleDigest
      ) {
        this.telemetry.responseRejected(target, "workspace_hooks_snapshot_mismatch");
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      // Check persistent-trust policy eligibility explicitly before granting: a policy rejection thrown by
      // assertPersistentTrustMutationAllowed inside applyDecision, if it fell into the catch-all below,
      // would be blanket-reported as trust_store_corrupt; with tightened enterprise policy the
      // user would see the wrong diagnosis. Aligned with the revoke path: precheck + precise reasonCode.
      if (!this.coordinator.canMutatePersistentTrust(snapshot.workspaceIdentity)) {
        this.telemetry.responseRejected(target, "workspace_hooks_blocked_by_policy");
        return {
          accepted: false,
          reasonCode: "workspace_hooks_blocked_by_policy" as const,
        };
      }
      let applied: { grantedRecordCount?: number };
      try {
        applied = await this.applyPersistentTrust(validation.reviewItemIds);
      } catch (error) {
        // applyDecision can throw for non-store reasons - resolveWorkspaceHookReviewDigests on unknown
        // reviewItemId, coordinator internal errors, store persist failures. A bare catch would blanket-report
        // all as trust_store_corrupt and drop the original error, same as the toggle path.
        // reasonCode unchanged (new ones need a contracts review); only forward
        // errorMessage into telemetry for traceability.
        //
        // Redaction: WorkspaceHookMutationError messages are redacted upstream
        // (workspaceIdentitySummary / digestSummary in workspace-hook-review-mutation.ts).
        // For any Error take error.message only - the upstream throw sites must guarantee messages carry no
        // absolute paths / full digests (never report full workspace/source paths).
        this.telemetry.trustStoreFailure(
          target.bundleDigest,
          error instanceof Error ? error.message : String(error),
        );
        return {
          accepted: false,
          reasonCode: "workspace_hooks_trust_store_corrupt" as const,
        };
      }
      this.telemetry.decisionAccepted(target, decision, {
        ...(applied.grantedRecordCount === undefined
          ? {}
          : { grantedRecordCount: applied.grantedRecordCount }),
        requestEnabledCount: flow.request.items.filter((item) => item.configuredEnabled).length,
      });
      const resolved = this.registry.resolve(target, decision);
      // applyDecision and registry.resolve are not atomic - if the
      // registry deadline timer fires in between, the flow turns timed_out and resolve returns superseded, so
      // trust-persisted gets reported as review-expired. Users retry; debuggers conclude the write failed -
      // again a mis-attribution.
      // The decision already took effect (persistent trust persisted), so report accepted and emit
      // Settled anyway, letting the frontend converge on decided; a refused resolve only means another
      // terminal state took the flow, not a failed grant. Here more-yes-less-no: never reports
      // unauthorized as authorized.
      if (!resolved.accepted) {
        // Keep observation: another terminal state took the flow (usually the deadline firing).
        this.telemetry.responseRejected(target, resolved.reasonCode);
      }
      await this.host.emit({
        type: SessionEventType.WorkspaceHookReviewSettled,
        payload: { interactionId: target.interactionId, state: "resolved" },
      });
      // Soft gate: re-evaluate pending after settle; notify the projection to refresh the banner
      await this.emitAdmissionUpdatedAfterMutation();
      // Per-item trust must not strip the action entry from other pending items. Once the old generation
      // settles with pending declarations remaining, publish the next immutable generation immediately; trusted
      // rows disappear on the next Settings refresh, the rest stay actionable.
      await this.refreshPendingFlow(snapshot);
      return resolved.accepted
        ? resolved
        : {
            accepted: true as const,
            reviewItemIds: [...validation.reviewItemIds],
          };
    });
  }

  toggle(
    target: WorkspaceHookReviewTarget,
    reviewItemId: string,
    enabled: boolean,
  ): Promise<
    WorkspaceHookReviewCommandResult & {
      request?: WorkspaceHookReviewRequestPayload;
    }
  > {
    return this.enqueueMutation(async () => {
      const validation = this.registry.validate(target, {
        action: "trust_selected",
        reviewItemIds: [reviewItemId],
      });
      if (!validation.accepted) return validation;
      const currentSnapshot = this.admission.getCurrentSnapshot();
      const entry = currentSnapshot.hooks.find((item) => item.reviewItemId === reviewItemId);
      if (!entry?.editable) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      let writeCommitted = false;
      let nextSnapshot: WorkspaceHookBundleSnapshot;
      try {
        nextSnapshot = await this.mutation.toggle(
          { snapshot: currentSnapshot, reviewItemId, enabled },
          () => {
            writeCommitted = true;
            this.admission.invalidate("workspace_hooks_config_rebuild_failed");
          },
        );
        this.admission.replaceSnapshot(nextSnapshot);
      } catch (error) {
        if (!writeCommitted) {
          // A bare catch used to blanket-report every mutation-port failure as
          // config_write_failed - including pre-write snapshot mismatches (bundle changed after
          // review / discovery read failure). Users would retry the write forever, real cause hidden.
          // Pass through WorkspaceHookMutationError.code; add cause to telemetry for locating.
          const isMutationError =
            error instanceof WorkspaceHookMutationError ||
            (error instanceof Error && error.name === "WorkspaceHookMutationError");
          const mutationCode = isMutationError
            ? ((error as WorkspaceHookMutationError).code as WorkspaceHookReasonCode)
            : ("workspace_hooks_config_write_failed" as const);
          this.telemetry.toggleFailure(
            target.bundleDigest,
            mutationCode,
            error instanceof Error ? error.message : String(error),
          );
          return {
            accepted: false,
            reasonCode: mutationCode as WorkspaceHookReasonCode,
          };
        }
        this.telemetry.toggleFailure(target.bundleDigest, "workspace_hooks_config_rebuild_failed");
        this.registry.fail(target, "workspace_hooks_config_rebuild_failed");
        await this.host.emit({
          type: SessionEventType.WorkspaceHookReviewSettled,
          payload: {
            interactionId: target.interactionId,
            state: "configuration_error",
            reasonCode: "workspace_hooks_config_rebuild_failed",
          },
        });
        return {
          accepted: false,
          reasonCode: "workspace_hooks_config_rebuild_failed" as const,
        };
      }

      const nextFlow = await this.refreshPendingFlow(nextSnapshot);
      // Soft gate: re-evaluate pending after toggle rebuilds the bundle
      await this.emitAdmissionUpdatedAfterMutation();
      return {
        accepted: true,
        reviewItemIds: [reviewItemId],
        ...(nextFlow ? { request: nextFlow.request } : {}),
      };
    });
  }

  revoke(
    target: WorkspaceHookReviewTarget,
    reviewItemIds: readonly string[],
  ): Promise<WorkspaceHookReviewCommandResult> {
    return this.enqueueMutation(async () => {
      const validation = this.registry.validate(target, {
        action: "trust_selected",
        reviewItemIds: [...reviewItemIds],
      });
      if (!validation.accepted) return validation;
      const snapshot = this.admission.getCurrentSnapshot();
      const result = await applyWorkspaceHookRevoke({
        coordinator: this.coordinator,
        digests: resolveWorkspaceHookReviewDigests(snapshot, validation.reviewItemIds),
        reviewItemIds: validation.reviewItemIds,
        snapshot,
        store: this.store,
      });
      if (result.accepted) {
        this.telemetry.revoked(snapshot.bundleDigest, validation.reviewItemIds.length);
        await this.refreshPendingFlow(snapshot);
        // Soft gate: re-evaluate pending after revoke
        await this.emitAdmissionUpdatedAfterMutation();
      }
      return result;
    });
  }

  revokeCurrent(target: WorkspaceHookTrustRevokeTarget): Promise<WorkspaceHookReviewCommandResult> {
    return this.enqueueMutation(async () => {
      const snapshot = this.admission.getCurrentSnapshot();
      if (
        target.sessionId !== this.sessionId ||
        target.remoteSessionId !== this.host.remoteSessionId ||
        target.workspaceIdentity !== snapshot.workspaceIdentity ||
        target.bundleDigest !== snapshot.bundleDigest
      ) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      const digests = [...new Set(target.hookDeclarationDigests)];
      const entries = snapshot.hooks.filter((entry) =>
        digests.includes(entry.hookDeclarationDigest),
      );
      if (
        digests.length === 0 ||
        new Set(entries.map((entry) => entry.hookDeclarationDigest)).size !== digests.length
      ) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      const result = await applyWorkspaceHookRevoke({
        coordinator: this.coordinator,
        digests,
        reviewItemIds: entries.map((entry) => entry.reviewItemId),
        snapshot,
        store: this.store,
      });
      if (result.accepted) {
        this.telemetry.revoked(snapshot.bundleDigest, digests.length);
        await this.refreshPendingFlow(snapshot);
        // Soft gate: re-evaluate pending after revokeCurrent
        await this.emitAdmissionUpdatedAfterMutation();
      }
      return result;
    });
  }

  private async refreshPendingFlow(
    snapshot: WorkspaceHookBundleSnapshot,
  ): Promise<WorkspaceHookReviewFlow | undefined> {
    const current = this.registry.getCurrentFlow(this.sessionId);
    if (!current || current.state.state !== "pending") {
      // Returning directly with no pending flow would leave the
      // current session with no re-authorization entry at all after grant -> review resolved -> revoke;
      // the only path out would be a new conversation.
      //
      // revoke means revoked -> admission=pending, i.e. re-consent by design, so open a new flow only when
      // pending items truly exist: no grant-trust-directly side door; authorization still happens only via the
      // inline buttons of the current immutable review binding.
      return await this.openReviewFlowForNewPendingItems(snapshot);
    }
    const target = toWorkspaceHookReviewTarget(current.request);
    const evaluation = this.coordinator.evaluateSnapshot({ snapshot });
    const replacement = this.buildRequest(snapshot, evaluation, {
      reviewFlowId: current.request.reviewFlowId,
      generation: current.request.generation + 1,
    });
    const nextFlow = this.registry.supersede(target, replacement);
    this.telemetry.superseded(replacement);
    this.generation = replacement.generation;
    await this.host.emit({
      type: SessionEventType.WorkspaceHookReviewSuperseded,
      payload: {
        interactionId: current.request.interactionId,
        supersededByInteractionId: replacement.interactionId,
      },
    });
    this.telemetry.requestCreated(replacement);
    await this.host.emit({
      type: SessionEventType.WorkspaceHookReviewRequested,
      payload: { request: replacement },
    });
    if (replacement.summary.pendingCount === 0) {
      this.registry.closeWithoutDecision(toWorkspaceHookReviewTarget(replacement));
      await this.host.emit({
        type: SessionEventType.WorkspaceHookReviewSettled,
        payload: {
          interactionId: replacement.interactionId,
          state: "resolved",
        },
      });
    }
    return nextFlow;
  }

  /**
   * After revoke, with no pending flow in this session, reopen review.
   *
   * Only when pending items truly exist. The toggle governs running, trust governs admission; hence
   * configured-disabled declarations in the current review snapshot keep their inline trust entry too. Opening
   * goes through openOrReuseFlow - the same path as first consent - leaving generation / reviewFlowId /
   * interactionId semantics untouched.
   */
  private async openReviewFlowForNewPendingItems(
    snapshot: WorkspaceHookBundleSnapshot,
  ): Promise<WorkspaceHookReviewFlow | undefined> {
    const evaluation = this.coordinator.evaluateSnapshot({
      snapshot,
    });
    const hasPending = evaluation.items.some((item) => item.admissionClass === "pending");
    if (!hasPending) return undefined;
    const flow = await this.openOrReuseFlow(snapshot, evaluation);
    // Must supervise: else the flow dies silently at timeout and the panel is dead forever (see superviseFlow).
    // Deliberately not awaited - revoke must not block on a 10-minute review deadline;
    // the catch prevents unhandled rejection; flow termination itself raises nothing to bubble.
    void this.superviseFlow(flow).catch(() => undefined);
    return flow;
  }

  private async openOrReuseFlow(
    snapshot: WorkspaceHookBundleSnapshot,
    evaluation: WorkspaceHookSnapshotEvaluation,
  ): Promise<WorkspaceHookReviewFlow> {
    const current = this.registry.getCurrentFlow(this.sessionId);
    if (
      current?.state.state === "pending" &&
      current.request.bundleDigest === snapshot.bundleDigest
    ) {
      return current;
    }
    this.reviewFlowId ??= `workspace-hook-review:${this.createId()}`;
    const request = this.buildRequest(snapshot, evaluation, {
      reviewFlowId: this.reviewFlowId,
      generation: this.generation + 1,
    });
    this.generation = request.generation;
    const flow = this.registry.open(request);
    this.telemetry.requestCreated(request);
    await this.host.emit({
      type: SessionEventType.WorkspaceHookReviewRequested,
      payload: { request },
    });
    return flow;
  }

  private buildRequest(
    snapshot: WorkspaceHookBundleSnapshot,
    evaluation: WorkspaceHookSnapshotEvaluation,
    flow: { reviewFlowId: string; generation: number },
  ): WorkspaceHookReviewRequestPayload {
    return buildWorkspaceHookReviewRequest({
      snapshot,
      evaluation,
      ...flow,
      sessionId: this.sessionId,
      host: this.host,
      now: this.now,
      createId: this.createId,
    });
  }

  private async applyPersistentTrust(
    reviewItemIds: readonly string[],
  ): Promise<{ grantedRecordCount?: number }> {
    const snapshot = this.admission.getCurrentSnapshot();
    this.coordinator.assertPersistentTrustMutationAllowed(snapshot.workspaceIdentity);
    const records = createWorkspaceHookTrustRecords({
      snapshot,
      reviewItemIds,
      grantedAt: new Date(this.now()).toISOString(),
      ...(this.appVersion ? { appVersion: this.appVersion } : {}),
    });
    const file = await (await this.store).grant(records);
    this.coordinator.replacePersistentTrustRecords(file.records, {
      status: "ok",
    });
    return { grantedRecordCount: records.length };
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Soft gate: after a mutation, re-evaluate pending and emit AdmissionUpdated.
   *
   * Same criterion as admission: configuredEnabled && admissionClass === pending.
   * Emit even at pendingCount === 0; the projection clears the banner on it.
   * Via admission.invalidate -> refreshEvaluation inside evaluateDispatch;
   * here the coordinator re-evaluates the snapshot directly, same source as admission.emitAdmissionState.
   */
  private async emitAdmissionUpdatedAfterMutation(): Promise<void> {
    const snapshot = this.admission.getCurrentSnapshot();
    const evaluation = this.coordinator.evaluateSnapshot({ snapshot });
    const pendingCount = evaluation.items.filter(
      (item) => item.configuredEnabled && item.admissionClass === "pending",
    ).length;
    await this.host.emit({
      type: SessionEventType.WorkspaceHookAdmissionUpdated,
      payload: {
        pendingCount,
        bundleDigest: snapshot.bundleDigest,
        ...(snapshot.workspaceIdentity ? { workspaceIdentity: snapshot.workspaceIdentity } : {}),
      },
    });
  }
}
