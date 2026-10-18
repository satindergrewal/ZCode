/**
 * Model-side failure policy for workflows.
 *
 * failure-classifier.ts answers whether the main conversation auto-retries; this table answers
 * whether the workflow stops for a human. They disagree on 3008/3009/3010 (concurrency caps), which is
 * why it exists: workflow subagents and tool-side requests hold unbounded retry budgets (`modelRetryBudget`),
 * and for them only deterministic human-required failures justify stopping the run; everything else
 * (classifier-nonretryable unknown codes, TLS, 5xx included) retries internally, with stall notices as the escape hatch.
 *
 * The runner (attempt-loop retry gate) and the bootstrap driver (reject to stopRun/askFailed) share one
 * function: runner-retryable failures never stop at the driver, and runner-stop failures are always
 * judged stop there (same function, same inputs).
 */

import { ModelErrorCode, ModelFailureReason } from "@zcode/contracts";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { isRetryableFailure } from "./failure-classifier.js";
import type { ModelRetryBudget } from "@zcode/contracts";
import { isUnboundedRetryBudget } from "./retry-budget.js";

/** Verdict key for `ProviderStop`: the notice copy table is keyed by it, not by reason. */
export type WorkflowProviderStopKind =
  | "auth"
  | "not_configured"
  | "model_unavailable"
  | "invalid_request"
  | "quota"
  | "other";

/**
 * Quota-class business codes (one row of the Stop set). Kept deliberately separate from
 * TERMINAL_RATE_LIMIT_MAPPING in failure-provider-business-codes.ts: that one gates main-conversation auto-retry, this one
 * stops the workflow to await quota reset/top-up. 1005 is invalid_request in the classifier, so test the code
 * for quota before the reason.
 */
export const WORKFLOW_QUOTA_PROVIDER_CODES: ReadonlySet<string> = new Set([
  "1005",
  "1308",
  "1310",
  "1313",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
  "2056",
  "20097",
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "exceeded_current_quota_error",
]);

/** ModelErrorCode family for provider misconfiguration / invalid selection (reason need not be provider_not_configured). */
const NOT_CONFIGURED_ERROR_CODES: ReadonlySet<string> = new Set([
  ModelErrorCode.ProviderNotFound,
  ModelErrorCode.ProviderNotConfigured,
  ModelErrorCode.ModelConfigMissing,
  ModelErrorCode.InvalidModelSelection,
  ModelErrorCode.ModelRequestAuthMissing,
]);

export type WorkflowModelFailurePolicy =
  | { decision: "retry" }
  | { decision: "stop"; kind: WorkflowProviderStopKind }
  /** Reached only after core compaction failed: the node fails with `ContextLimit`, script-catchable, else errored. */
  | { decision: "context_exceeded" }
  | { decision: "cancelled" };

/**
 * The policy table. Inputs: the classifier verdict (code/reason/retryable only) and the provider business code.
 * Order matters: cancellation first (not an error); quota by code before reason (1005's reason is
 * invalid_request); the rest by reason/code; anything unlisted = retry.
 */
export function resolveWorkflowModelFailurePolicy(
  failure: Pick<ClassifiedModelFailure, "code" | "reason" | "retryable">,
  providerCode: string | undefined,
): WorkflowModelFailurePolicy {
  if (failure.reason === ModelFailureReason.Cancelled) return { decision: "cancelled" };
  if (providerCode !== undefined && WORKFLOW_QUOTA_PROVIDER_CODES.has(providerCode)) {
    return { decision: "stop", kind: "quota" };
  }
  if (failure.reason === ModelFailureReason.AuthFailed) return { decision: "stop", kind: "auth" };
  if (
    failure.reason === ModelFailureReason.ProviderNotConfigured ||
    NOT_CONFIGURED_ERROR_CODES.has(failure.code)
  ) {
    return { decision: "stop", kind: "not_configured" };
  }
  if (failure.code === ModelErrorCode.ModelNotFound) {
    return { decision: "stop", kind: "model_unavailable" };
  }
  if (failure.reason === ModelFailureReason.ContextExceeded)
    return { decision: "context_exceeded" };
  // Invalid request means only provider rejection of the request itself (3001, HTTP 400/422). The classifier also
  // marks invalid_model_response invalid_request, but that is a response-parse failure, likely fine on retry.
  if (
    failure.reason === ModelFailureReason.InvalidRequest &&
    failure.code !== ModelErrorCode.InvalidModelResponse
  ) {
    return { decision: "stop", kind: "invalid_request" };
  }
  return { decision: "retry" };
}

/**
 * Replacement point for the runner retry gate: bounded budgets keep reading the classifier `retryable` (main conversation untouched);
 * unbounded budgets (workflow traffic) read this table: retry is retryable, stop/context_exceeded is not.
 * Cancellation is short-circuited by callers before this (both runners already do).
 */
export function retryAllowedByFailurePolicy(
  failure: ClassifiedModelFailure,
  retryBudget: ModelRetryBudget | undefined,
  providerCode: string | undefined,
): boolean {
  if (!isUnboundedRetryBudget(retryBudget)) return isRetryableFailure(failure);
  return resolveWorkflowModelFailurePolicy(failure, providerCode).decision === "retry";
}

/** What the driver reads out of the adapter error: policy verdict plus the fields ProviderStopDetails needs. */
export interface WorkflowModelFailureInspection {
  policy: WorkflowModelFailurePolicy;
  /** A contracts ModelFailureReason value. */
  reason: string;
  providerCode?: string;
  providerId?: string;
  modelId?: string;
  /** The adapter error message (the provider's own text under mapped business codes). */
  rawMessage?: string;
  /** Reset time (epoch ms) when quota-class and the provider sent Retry-After. */
  resetAt?: number;
}

/**
 * Read the adapter error by shape (`AiSdkModelAdapterError`: `name` + `context.reason` ...), directly or
 * one `cause` deep; bootstrap and adapters may hold duplicate class copies (dist boundary) but the shape cannot drift.
 * Returns undefined for non-model-layer errors (the driver keeps its own mapping).
 */
export function inspectWorkflowModelFailure(
  error: unknown,
): WorkflowModelFailureInspection | undefined {
  const direct = readAdapterError(error);
  const found =
    direct ?? readAdapterError((error as { cause?: unknown } | undefined)?.cause ?? undefined);
  if (found === undefined) return undefined;
  const { context, code, message } = found;
  const reason = stringValue(context.reason);
  if (reason === undefined) return undefined;
  const providerCode = codeValue(context.providerCode);
  const policy = resolveWorkflowModelFailurePolicy(
    {
      code: code as ClassifiedModelFailure["code"],
      reason: reason as ClassifiedModelFailure["reason"],
      retryable: context.retryable === true,
    },
    providerCode,
  );
  const retryAfterMs = context.retryAfterMs;
  const inspection: WorkflowModelFailureInspection = { policy, reason };
  if (providerCode !== undefined) inspection.providerCode = providerCode;
  const providerId = stringValue(context.providerId);
  if (providerId !== undefined) inspection.providerId = providerId;
  const modelId = stringValue(context.modelId);
  if (modelId !== undefined) inspection.modelId = modelId;
  if (message.length > 0) inspection.rawMessage = message;
  if (
    policy.decision === "stop" &&
    policy.kind === "quota" &&
    typeof retryAfterMs === "number" &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0
  ) {
    inspection.resetAt = Date.now() + retryAfterMs;
  }
  return inspection;
}

function readAdapterError(
  error: unknown,
): { context: Record<string, unknown>; code: string; message: string } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    context?: unknown;
    message?: unknown;
  };
  if (candidate.name !== "AiSdkModelAdapterError") return undefined;
  const context =
    typeof candidate.context === "object" && candidate.context !== null
      ? (candidate.context as Record<string, unknown>)
      : {};
  return {
    context,
    code: typeof candidate.code === "string" ? candidate.code : "",
    message: typeof candidate.message === "string" ? candidate.message : "",
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Provider business codes may be numeric (raw body) or strings; normalize to string keys. */
function codeValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return stringValue(value);
}
