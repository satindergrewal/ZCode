import type {
  Logger,
  WorkspaceHookBundleSnapshot,
  WorkspaceHookReasonCode,
  WorkspaceHookSecurityRevision,
} from "@zcode/contracts";
import type { WorkspaceHookTrustCoordinator } from "./workspace-hook-trust-coordinator.js";
import {
  emitWorkspaceHookTelemetry,
  type WorkspaceHookTelemetryEvent,
  type WorkspaceHookTelemetryFields,
} from "./workspace-hook-telemetry.js";
import type { WorkspaceHookSnapshotEvaluation } from "./workspace-hook-trust-types.js";

export type WorkspaceHookActivationSource = "startup" | "resume" | "clear" | "compact";

export interface WorkspaceHookDispatchInput {
  /** Compatibility assertion for callers that hold a bundle target. Runtime registrations omit it. */
  bundleDigest?: string;
  hookDeclarationDigest: string;
  reviewItemId: string;
}

export type WorkspaceHookDispatchDecision =
  | { allowed: true }
  | {
      allowed: false;
      reasonCode: WorkspaceHookReasonCode;
      skipLifecycle?: boolean;
    };

// Soft gate: once evaluation completes, the admission layer reports pending state through this port.
// pendingCount = declarations with configuredEnabled && admissionClass === "pending".
// Report even when pendingCount === 0 (lets the projection clear the banner).
export interface WorkspaceHookAdmissionState {
  pendingCount: number;
  bundleDigest: string;
  workspaceIdentity?: string;
}

export type WorkspaceHookAdmissionStateCallback = (state: WorkspaceHookAdmissionState) => void;

export interface WorkspaceHookRuntimeAdmissionPort {
  activate(source: WorkspaceHookActivationSource, signal?: AbortSignal): Promise<void>;
  evaluateDispatch(input: WorkspaceHookDispatchInput): WorkspaceHookDispatchDecision;
  getCurrentSnapshot(): WorkspaceHookBundleSnapshot;
  replaceSnapshot(snapshot: WorkspaceHookBundleSnapshot): void;
  invalidate(reasonCode: WorkspaceHookReasonCode): void;
}

export interface WorkspaceHookRuntimeAdmissionOptions {
  coordinator: WorkspaceHookTrustCoordinator;
  enabled?: boolean;
  logger?: Logger;
  ready: Promise<void>;
  /** Soft gate: callback after activate() finishes evaluation, reporting pending state. */
  onAdmissionStateChanged?: WorkspaceHookAdmissionStateCallback;
  snapshot: WorkspaceHookBundleSnapshot;
}

export class WorkspaceHookRuntimeAdmission implements WorkspaceHookRuntimeAdmissionPort {
  private readonly coordinator: WorkspaceHookTrustCoordinator;
  private readonly enabled: boolean;
  private readonly logger?: Logger;
  private readonly ready: Promise<void>;
  private readonly onAdmissionStateChanged?: WorkspaceHookAdmissionStateCallback;
  private snapshot: WorkspaceHookBundleSnapshot;
  private readonly entriesByReviewItemId = new Map<string, string>();
  private evaluation?: WorkspaceHookSnapshotEvaluation;
  private validatedRevision?: WorkspaceHookSecurityRevision;
  private invalidatedReason?: WorkspaceHookReasonCode;
  private readonly emittedTelemetry = new Set<string>();
  private activated = false;
  private bootstrapFailed = false;

  constructor(options: WorkspaceHookRuntimeAdmissionOptions) {
    this.coordinator = options.coordinator;
    this.enabled = options.enabled ?? true;
    this.logger = options.logger;
    this.ready = options.ready;
    this.onAdmissionStateChanged = options.onAdmissionStateChanged;
    this.snapshot = options.snapshot;
    this.indexSnapshot(options.snapshot);
  }

  async activate(source: WorkspaceHookActivationSource, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.enabled) {
      if (!this.activated) {
        this.activated = true;
        this.emitTelemetryOnce("workspace_hook.feature_disabled", {
          workspaceIdentity: this.snapshot.workspaceIdentity,
          reasonCode: "workspace_hooks_feature_disabled",
          source,
        });
        // Feature off: pendingCount = 0, report the cleared state.
        this.emitAdmissionState();
      }
      return;
    }
    if (!this.activated) {
      try {
        await waitForWorkspaceHookAdmission(this.ready, signal);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        // A trust-store bootstrap failure must not widen the execution surface; the main task and other hook origins keep working.
        this.bootstrapFailed = true;
      }
      this.activated = true;
    }
    this.safeRefreshEvaluation();
    // Soft gate: do not wait for review; report pending state for the projection layer.
    this.emitAdmissionState();
  }

  evaluateDispatch(input: WorkspaceHookDispatchInput): WorkspaceHookDispatchDecision {
    if (!this.matchesSnapshot(input)) {
      this.emitTelemetryOnce("workspace_hook.snapshot_mismatch", {
        workspaceIdentity: this.snapshot.workspaceIdentity,
        reasonCode: "workspace_hooks_snapshot_mismatch",
        bundleDigest: input.bundleDigest,
        declarationDigest: input.hookDeclarationDigest,
      });
      return {
        allowed: false,
        reasonCode: "workspace_hooks_snapshot_mismatch",
      };
    }
    if (this.invalidatedReason) {
      return { allowed: false, reasonCode: this.invalidatedReason };
    }
    if (!this.activated) {
      return { allowed: false, reasonCode: "workspace_hooks_pending_trust" };
    }
    if (!this.enabled) {
      return { allowed: false, reasonCode: "workspace_hooks_feature_disabled" };
    }
    if (this.bootstrapFailed) {
      this.emitTelemetryOnce("workspace_hook.trust_store_failure", {
        workspaceIdentity: this.snapshot.workspaceIdentity,
        reasonCode: "workspace_hooks_trust_store_corrupt",
      });
      return {
        allowed: false,
        reasonCode: "workspace_hooks_trust_store_corrupt",
      };
    }
    if (
      !this.validatedRevision ||
      !this.coordinator.validateSecurityRevision(
        this.snapshot.workspaceIdentity,
        this.validatedRevision,
      )
    ) {
      // Lazy refresh once updated only the evaluation and skipped the admission state: an external write to the trust store
      // (e.g. Settings pretrust) bumping revision left the banner pendingCount stale until the next
      // activate. Re-emit after refresh (also when pendingCount === 0, to clear the banner).
      this.refreshEvaluation();
      this.emitAdmissionState();
    }
    const item = this.evaluation?.items.find(
      (candidate) => candidate.reviewItemId === input.reviewItemId,
    );
    if (!item || item.hookDeclarationDigest !== input.hookDeclarationDigest) {
      this.emitTelemetryOnce("workspace_hook.snapshot_mismatch", {
        workspaceIdentity: this.snapshot.workspaceIdentity,
        bundleDigest: this.snapshot.bundleDigest,
        declarationDigest: input.hookDeclarationDigest,
        reasonCode: "workspace_hooks_snapshot_mismatch",
      });
      return {
        allowed: false,
        reasonCode: "workspace_hooks_snapshot_mismatch",
      };
    }
    if (item.effectiveRunnable) return { allowed: true };
    const reasonCode = item.reasonCode ?? "workspace_hooks_blocked_untrusted";
    if (reasonCode === "workspace_hooks_blocked_by_policy") {
      this.emitTelemetryOnce("workspace_hook.policy_blocked", {
        workspaceIdentity: this.snapshot.workspaceIdentity,
        bundleDigest: this.snapshot.bundleDigest,
        declarationDigest: item.hookDeclarationDigest,
        reasonCode,
      });
    }
    return {
      allowed: false,
      reasonCode,
      ...(!item.configuredEnabled ? { skipLifecycle: true } : {}),
    };
  }

  getCurrentSnapshot(): WorkspaceHookBundleSnapshot {
    return this.snapshot;
  }

  replaceSnapshot(snapshot: WorkspaceHookBundleSnapshot): void {
    if (snapshot.workspaceIdentity !== this.snapshot.workspaceIdentity) {
      // Invariant: callers may replace the current snapshot only with one of the same workspaceIdentity. Cross-identity
      // replacement means the caller confused workspace boundaries — a programming error, not a runtime condition — so throw
      // instead of silently no-oping or returning a soft result (fail-loud). Callers must:
      //   1. commit their own writes before calling (this runtime does not roll back external writes);
      //   2. wrap the call in try/catch — thrown exceptions must not bubble to turn level.
      // Sole caller today: the toggle path in workspace-hook-review-controller.ts, whose
      // writeCommitted logic already meets the above. New callers must handle this error at the call site.
      throw new Error("Cannot replace a Workspace Hook snapshot across workspace identities");
    }
    this.snapshot = snapshot;
    this.entriesByReviewItemId.clear();
    this.indexSnapshot(snapshot);
    this.evaluation = undefined;
    this.validatedRevision = undefined;
    this.invalidatedReason = undefined;
    if (this.activated) {
      this.refreshEvaluation();
      this.emitAdmissionState();
    }
  }

  invalidate(reasonCode: WorkspaceHookReasonCode): void {
    this.invalidatedReason = reasonCode;
    this.evaluation = undefined;
    this.validatedRevision = undefined;
  }

  private indexSnapshot(snapshot: WorkspaceHookBundleSnapshot): void {
    for (const entry of snapshot.hooks) {
      this.entriesByReviewItemId.set(entry.reviewItemId, entry.hookDeclarationDigest);
    }
  }

  private matchesSnapshot(input: WorkspaceHookDispatchInput): boolean {
    return (
      (input.bundleDigest === undefined || input.bundleDigest === this.snapshot.bundleDigest) &&
      this.entriesByReviewItemId.get(input.reviewItemId) === input.hookDeclarationDigest
    );
  }

  // Soft gate: report pending state. pendingCount = configuredEnabled && admissionClass === "pending".
  private emitAdmissionState(): void {
    if (!this.onAdmissionStateChanged) return;
    const evaluation = this.evaluation;
    const pendingCount = evaluation
      ? evaluation.items.filter(
          (item) => item.configuredEnabled && item.admissionClass === "pending",
        ).length
      : 0;
    this.onAdmissionStateChanged({
      pendingCount,
      bundleDigest: this.snapshot.bundleDigest,
      ...(this.snapshot.workspaceIdentity
        ? { workspaceIdentity: this.snapshot.workspaceIdentity }
        : {}),
    });
  }

  private emitTelemetryOnce(
    event: WorkspaceHookTelemetryEvent,
    fields: WorkspaceHookTelemetryFields,
  ): void {
    const key = [
      event,
      fields.reasonCode,
      fields.bundleDigest,
      fields.declarationDigest,
      fields.source,
    ].join(":");
    if (this.emittedTelemetry.has(key)) return;
    this.emittedTelemetry.add(key);
    emitWorkspaceHookTelemetry(this.logger, event, fields);
  }

  private refreshEvaluation(): void {
    if (!this.enabled || this.bootstrapFailed || this.invalidatedReason) return;
    const evaluation = this.coordinator.evaluateSnapshot({ snapshot: this.snapshot });
    this.evaluation = evaluation;
    this.validatedRevision = { ...evaluation.securityRevision };
  }

  /**
   * refreshEvaluation calls coordinator.evaluateSnapshot,
   * which throws on malformed persisted state (zod parse failure). That exception must not bubble out of activate →
   * runSessionStartHooks → the whole turn, or user/plugin hooks fail with it, retrying every turn
   * (the file's own comment says "the main task and other hook origins keep working").
   *
   * The evaluateDispatch path already falls back via resolveHookRunAdmission's try/catch;
   * activate needs the same: catch and set bootstrapFailed=true — fail-closed;
   * evaluateDispatch sees the flag and returns workspace_hooks_trust_store_corrupt to deny,
   * and refreshEvaluation short-circuits on it without retrying. The turn proceeds; non-workspace hooks are unaffected.
   */
  private safeRefreshEvaluation(): void {
    if (!this.enabled || this.bootstrapFailed || this.invalidatedReason) return;
    try {
      this.refreshEvaluation();
    } catch {
      this.bootstrapFailed = true;
      this.evaluation = undefined;
      this.validatedRevision = undefined;
    }
  }
}

function waitForWorkspaceHookAdmission<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Workspace Hook admission aborted"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function createWorkspaceHookRuntimeAdmission(
  options: WorkspaceHookRuntimeAdmissionOptions,
): WorkspaceHookRuntimeAdmission {
  return new WorkspaceHookRuntimeAdmission(options);
}
