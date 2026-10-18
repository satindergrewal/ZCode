/**
 * Whether a review just ended (the had-review to no-review transition).
 *
 * A runtime Trust mutation may come from another capable attachment; when a review settles the store
 * clears the binding, so this transition is the cue for one extra static Trust snapshot refresh.
 *
 * Do not test merely no-current-review: that is also true on first mount and would fire
 * a redundant load racing initialize.
 */
export function didWorkspaceHookReviewSettle(input: {
  previousInteractionId: string | undefined;
  currentInteractionId: string | undefined;
}): boolean {
  return input.previousInteractionId !== undefined && input.currentInteractionId === undefined;
}

/**
 * reasonCode to i18n key map.
 *
 * On rejection, inline trust/revoke once rendered the raw reasonCode
 * (e.g. workspace_hooks_review_superseded), unreadable in any language;
 * a missing key renders the raw id. Central map here; unknown codes fall back to the
 * generic action-rejected copy, never leaking internal enum literals.
 */
const WORKSPACE_HOOK_REASON_CODE_MESSAGE_IDS: Record<string, string> = {
  workspace_hooks_review_superseded: "settings.hooks.review.reason.review_superseded",
  workspace_hooks_snapshot_mismatch: "settings.hooks.review.reason.snapshot_mismatch",
  workspace_hooks_bundle_changed: "settings.hooks.review.reason.bundle_changed",
  workspace_hooks_config_unreadable: "settings.hooks.review.reason.config_unreadable",
  workspace_hooks_config_write_failed: "settings.hooks.review.reason.config_write_failed",
  workspace_hooks_config_rebuild_failed: "settings.hooks.review.reason.config_rebuild_failed",
  workspace_hooks_trust_store_corrupt: "settings.hooks.review.reason.trust_store_corrupt",
  workspace_hooks_blocked_by_policy: "settings.hooks.review.reason.blocked_by_policy",
  workspace_hooks_policy_requires_pretrust: "settings.hooks.review.reason.policy_requires_pretrust",
  workspace_hooks_interaction_timeout: "settings.hooks.review.reason.interaction_timeout",
  workspace_hooks_require_trust_capable_host: "settings.hooks.review.reason.host_unavailable",
};

const WORKSPACE_HOOK_REASON_CODE_FALLBACK_ID = "settings.hooks.review.reason.rejected";

export function resolveWorkspaceHookReasonCodeMessageId(reasonCode: string | undefined): string {
  if (!reasonCode) return WORKSPACE_HOOK_REASON_CODE_FALLBACK_ID;
  return (
    WORKSPACE_HOOK_REASON_CODE_MESSAGE_IDS[reasonCode] ?? WORKSPACE_HOOK_REASON_CODE_FALLBACK_ID
  );
}

/**
 * Decide whether one rejected command should settle silently (no user-facing error).
 *
 * Double-clicking inline Trust mints a commandId per click.
 * First click succeeds and the review flow ends (store clears the binding); the second click's commandId
 * resolves against the ended flow and returns workspace_hooks_review_superseded. The panel must not show that
 * as an error: the intent succeeded, the copy would confuse, and it trains distrust of
 * genuine superseded failures.
 *
 * Rule: stay silent only when the rejection is superseded-class AND no live pending binding remains
 * (review ended, binding cleared/advanced). A true superseded (bundle changed mid-review, binding
 * still pending, re-review needed) must show: never silent while
 * hasLivePendingBinding is true.
 *
 * Pure function, no store reads: hasLivePendingBinding is extracted by the caller from the current
 * store snapshot after its await (see useWorkspaceHookInlineTrust).
 */
export function shouldSilenceStaleRejection(input: {
  reasonCode: string | undefined;
  hasLivePendingBinding: boolean;
}): boolean {
  if (input.reasonCode !== "workspace_hooks_review_superseded") return false;
  return !input.hasLivePendingBinding;
}
