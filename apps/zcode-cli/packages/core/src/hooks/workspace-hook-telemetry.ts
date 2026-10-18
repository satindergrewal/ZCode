import { createHash } from "node:crypto";
import type { Logger, WorkspaceHookReasonCode } from "@zcode/contracts";

export type WorkspaceHookTelemetryEvent =
  | "workspace_hook.feature_disabled"
  | "workspace_hook.review_request_created"
  | "workspace_hook.trust_selected"
  | "workspace_hook.review_timeout"
  | "workspace_hook.review_superseded"
  | "workspace_hook.snapshot_mismatch"
  | "workspace_hook.policy_blocked"
  | "workspace_hook.trust_store_failure"
  | "workspace_hook.toggle_failure"
  | "workspace_hook.config_rebuild_failure"
  // revoke needs dedicated observability: when triaging "panel dead after revoke", logs must show
  // whether the revoke succeeded and attribute later failures to revoke vs grant, or triage crawls.
  | "workspace_hook.revoked"
  | "workspace_hook.stale_response";

export interface WorkspaceHookTelemetryFields {
  workspaceIdentity?: string;
  bundleDigest?: string;
  declarationDigest?: string;
  reasonCode?: WorkspaceHookReasonCode;
  source?: string;
  action?: string;
  generation?: number;
  /**
   * The caller-supplied errorMessage must be forwarded: otherwise the original error is silently dropped at emit,
   * leaving only reasonCode in logs, and the real cause becomes unlocatable.
   * Carries only the domain error's short message; never commands, script contents, or Trust payloads.
   */
  errorMessage?: string;
  /**
   * Trust persistence-count diagnostics: when the store persists fewer records than accepted decisions (decisionAccepted
   * did not throw), logs cannot tell a request missing items from records lost on write.
   *
   * requestItemCount / requestEnabledCount record what the review request actually carried;
   * grantedRecordCount records what was truly written. Any mismatch is a silent loss.
   */
  requestItemCount?: number;
  requestEnabledCount?: number;
  grantedRecordCount?: number;
  /** Decisions actually revoked (kept separate from grantedRecordCount to avoid semantic mixing). */
  revokedCount?: number;
}

const MAX_TELEMETRY_ERROR_MESSAGE_LENGTH = 300;

/**
 * Workspace Hook observability reuses the existing Logger Port.
 * Only stable reasons, generations, and summaries are sent — never commands, script contents, paths, or Trust payloads.
 */
export function emitWorkspaceHookTelemetry(
  logger: Logger | undefined,
  event: WorkspaceHookTelemetryEvent,
  fields: WorkspaceHookTelemetryFields = {},
): void {
  if (!logger) return;
  logger.info("Workspace Hook Trust telemetry", {
    event,
    module: "workspace_hook_trust",
    ...(fields.workspaceIdentity
      ? { workspaceIdentityDigest: workspaceIdentitySummary(fields.workspaceIdentity) }
      : {}),
    ...(fields.bundleDigest ? { bundleDigest: digestSummary(fields.bundleDigest) } : {}),
    ...(fields.declarationDigest
      ? { declarationDigest: digestSummary(fields.declarationDigest) }
      : {}),
    ...(fields.reasonCode ? { reasonCode: fields.reasonCode } : {}),
    ...(fields.source ? { source: fields.source } : {}),
    ...(fields.action ? { action: fields.action } : {}),
    ...(fields.generation === undefined ? {} : { generation: fields.generation }),
    ...(fields.errorMessage
      ? { errorMessage: fields.errorMessage.slice(0, MAX_TELEMETRY_ERROR_MESSAGE_LENGTH) }
      : {}),
    ...(fields.requestItemCount === undefined ? {} : { requestItemCount: fields.requestItemCount }),
    ...(fields.requestEnabledCount === undefined
      ? {}
      : { requestEnabledCount: fields.requestEnabledCount }),
    ...(fields.grantedRecordCount === undefined
      ? {}
      : { grantedRecordCount: fields.grantedRecordCount }),
    ...(fields.revokedCount === undefined ? {} : { revokedCount: fields.revokedCount }),
  });
}

export function digestSummary(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
}

/**
 * Short SHA-256 digest of the workspace identity.
 *
 * Here identity is the absolute path; requirements say telemetry must not upload the
 * full workspace path nor log source paths, so any text bound for telemetry
 * (domain-error messages included) must be redacted here, not left to downstream filtering.
 */
export function workspaceIdentitySummary(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
