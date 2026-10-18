import type { Logger, WorkspaceHookReasonCode } from "@zcode/contracts";
import {
  emitWorkspaceHookTelemetry,
  type WorkspaceHookReviewTarget,
  type WorkspaceHookRuntimeAdmissionPort,
} from "@zcode/core";
import type {
  WorkspaceHookReviewDecision,
  WorkspaceHookReviewRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";

export class WorkspaceHookReviewTelemetry {
  constructor(
    private readonly admission: WorkspaceHookRuntimeAdmissionPort,
    private readonly logger?: Logger,
  ) {}

  requestCreated(request: WorkspaceHookReviewRequestPayload): void {
    this.emit("workspace_hook.review_request_created", {
      bundleDigest: request.bundleDigest,
      generation: request.generation,
      // Persisted trust-entry count diagnostics: record requested vs actually granted to spot silent losses.
      requestItemCount: request.items.length,
      requestEnabledCount: request.items.filter((item) => item.configuredEnabled).length,
    });
  }

  timeout(request: WorkspaceHookReviewRequestPayload): void {
    this.emit("workspace_hook.review_timeout", {
      bundleDigest: request.bundleDigest,
      generation: request.generation,
      reasonCode: "workspace_hooks_interaction_timeout",
    });
  }

  responseRejected(target: WorkspaceHookReviewTarget, reasonCode: WorkspaceHookReasonCode): void {
    this.emit(
      reasonCode === "workspace_hooks_review_superseded"
        ? "workspace_hook.stale_response"
        : "workspace_hook.snapshot_mismatch",
      { bundleDigest: target.bundleDigest, reasonCode },
    );
  }

  decisionAccepted(
    target: WorkspaceHookReviewTarget,
    decision: WorkspaceHookReviewDecision,
    counts?: { grantedRecordCount?: number; requestEnabledCount?: number },
  ): void {
    this.emit("workspace_hook.trust_selected", {
      action: decision.action,
      bundleDigest: target.bundleDigest,
      generation: target.generation,
      // A mismatch with requestEnabledCount means a silent loss: decisionAccepted is emitted only after applyDecision
      // succeeds, so "accepted but under-written" is invisible from existing fields.
      ...(counts?.grantedRecordCount === undefined
        ? {}
        : { grantedRecordCount: counts.grantedRecordCount }),
      ...(counts?.requestEnabledCount === undefined
        ? {}
        : { requestEnabledCount: counts.requestEnabledCount }),
    });
  }

  /**
   * Revocation observations: whether the revoke succeeded and how many entries were removed must be visible, or debugging is blind.
   */
  revoked(bundleDigest: string, revokedCount: number): void {
    this.emit("workspace_hook.revoked", {
      bundleDigest,
      reasonCode: "workspace_hooks_revoked",
      revokedCount,
    });
  }

  trustStoreFailure(bundleDigest: string, errorMessage?: string): void {
    this.emit("workspace_hook.trust_store_failure", {
      bundleDigest,
      reasonCode: "workspace_hooks_trust_store_corrupt",
      // applyDecision can throw for non-storage reasons too (resolveWorkspaceHookReviewDigests
      // on an unknown reviewItemId, coordinator internal errors, ...). Reporting every failure as
      // trust_store_corrupt while dropping cause leaves only reasonCode in the log, hiding the real cause.
      // reasonCode stays as-is (new values need a contracts enum review); errorMessage carries the real cause.
      ...(errorMessage ? { errorMessage } : {}),
    });
  }

  toggleFailure(
    bundleDigest: string,
    reasonCode: WorkspaceHookReasonCode,
    errorMessage?: string,
  ): void {
    this.emit(
      // toggle failures pass through WorkspaceHookMutationError.code; reasonCode covers only the cases beyond write/rebuild:
      // mismatch gets a dedicated event, other unclassified failures record toggle_failure,
      // never misattributing a pre-write failure as config_rebuild_failure.
      reasonCode === "workspace_hooks_snapshot_mismatch"
        ? "workspace_hook.snapshot_mismatch"
        : reasonCode === "workspace_hooks_config_rebuild_failed"
          ? "workspace_hook.config_rebuild_failure"
          : "workspace_hook.toggle_failure",
      { bundleDigest, reasonCode, ...(errorMessage ? { errorMessage } : {}) },
    );
  }

  superseded(request: WorkspaceHookReviewRequestPayload): void {
    this.emit("workspace_hook.review_superseded", {
      bundleDigest: request.bundleDigest,
      generation: request.generation,
      reasonCode: "workspace_hooks_review_superseded",
    });
  }

  private emit(
    event: Parameters<typeof emitWorkspaceHookTelemetry>[1],
    fields: Parameters<typeof emitWorkspaceHookTelemetry>[2],
  ): void {
    emitWorkspaceHookTelemetry(this.logger, event, {
      workspaceIdentity: this.admission.getCurrentSnapshot().workspaceIdentity,
      ...fields,
    });
  }
}
