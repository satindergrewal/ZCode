// ============================================================
// Structured detail for run terminal states.
// ============================================================
// Split from types.ts (that file sits at the 400-line lint gate): the ProviderStop error-code detail and the payload of the run-level stall
// observation event. The vocabulary (RunStatus / RunStopReason / WorkflowErrorCode) stays in types.ts; only the
// detail lives here -- outside the unions, so exhaustive consumers are unaffected.

/**
 * Structured detail of ProviderStop: the notice and
 * GetWorkflowRun pick wording from it, never back-parsing the message. reason is a contracts
 * ModelFailureReason value (auth_failed / invalid_request / rate_limited ...); the pure package does not import
 * contracts, hence string. kind is the policy table's key (auth / not-configured / model-unavailable / invalid-request /
 * quota / fallback) -- read the wording table by it, never by reason.
 */
export interface ProviderStopDetails {
  kind: "auth" | "not_configured" | "model_unavailable" | "invalid_request" | "quota" | "other";
  reason: string;
  providerId?: string;
  providerLabel?: string;
  modelId?: string;
  providerCode?: string;
  /** The subagent that triggered the stop (refToString(instance)) plus its name / birth phase when known. */
  subagent?: string;
  subagentName?: string;
  phase?: string;
  /** The provider's verbatim text (bounded; truncated by the driver). */
  rawMessage?: string;
  /** Quota kind: the provider's reset instant (epoch ms), present only when parseable. */
  resetAt?: number;
}

/**
 * Run-level stall: the driver observed no successful model request for
 * sinceMs ms straight, with at least one retry scheduled in between. A pure observation event -- the engine only
 * records it, and core sends one mid-run notice from it. reason is the window's modal retry cause (a ModelRetryReason
 * value, open string); cap is that provider bucket's cap at that moment.
 */
export interface RunStallInfo {
  sinceMs: number;
  reason?: string;
  cap?: number;
}
