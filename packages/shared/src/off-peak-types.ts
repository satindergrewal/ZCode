import type { ZCodeTaskMode } from "./zcode-task-types-core.js";
import type { ModelSelection } from "./model-selection.js";

// ---- Off-peak task domain types ----
// off_peak_tasks lives in tasks-index.sqlite.
// Shares the scheduler process and dispatch pipeline with automation, but tables, message types, and the state machine are fully independent;
// never add fields onto ZCodeAutomation. sqlite columns are snake_case; these are the cross-domain camelCase domain types.

/**
 * Client execution states, six (the server admission states queued/ready/active/expired/settled are another axis):
 * queued=waiting for server ready; paused=user Pause stopped dispatch; running=executing;
 * permission/elicitation wait inside the normal session while aggregate state stays running; completed/failed/cancelled=terminal.
 */
export type ZCodeOffPeakTaskStatus =
  | "queued"
  | "paused"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Terminal set: irreversible exits (state-machine invariant). */
export const OFF_PEAK_TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

export function isOffPeakTerminalStatus(
  status: ZCodeOffPeakTaskStatus,
): status is "completed" | "failed" | "cancelled" {
  return (OFF_PEAK_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Stable error marker for an unusable ticket (server 400/3102: active 3h expiry / ready 5min invalidation / settled / not owner).
 * The zcode-cli adapter classifies this business code as non-retryable and embeds the marker in the error message;
 * the host terminal writeback then routes to "re-take a number under the same task_id -> resume" instead of settling failed.
 * Cross-process this can only ride the error text, so the marker must be unique and stable end to end--do not change it; same value as the
 * same-named constant in apps/zcode-cli/packages/adapters/src/model/offpeak-retry.ts (cross-package twin).
 */
export const OFF_PEAK_TICKET_EXPIRED_MARKER = "off-peak-ticket-expired";

/** The Off-Peak Provider has the same identity as the account's current Family; tasks pin the exact choice, never silently migrate across Families. */
export const OFF_PEAK_PROVIDER_IDS = {
  zai: "account:zai-offpeak-idle-plan",
  bigmodel: "account:bigmodel-offpeak-idle-plan",
} as const;

export function resolveOffPeakProviderId(
  family: "zai" | "bigmodel",
): (typeof OFF_PEAK_PROVIDER_IDS)[typeof family] {
  return OFF_PEAK_PROVIDER_IDS[family];
}

/// The real Coding Plan shape of the current selected connection available to Off-Peak.
// zai/bigmodel Team Plan symmetrized; adds the zai-team kind.
export type OffPeakCodingPlanKind =
  | "zai-personal"
  | "bigmodel-personal"
  | "bigmodel-team"
  | "zai-team";

/**
 * Redacted Coding Plan support surface. The renderer consumes only this result, never the JWT/API key.
 * `connection_unavailable` covers missing provider, disabled, expired, and Team runtime-key failure alike;
 * none of these may fall back to another cached connection.
 */
export type OffPeakCodingPlanUnsupportedReason =
  | "provider_family_unselected"
  | "provider_family_api_key_mode"
  | "provider_identity_mismatch"
  | "connection_unselected"
  | "start_plan_not_supported"
  | "connection_unavailable"
  | "selection_changed"
  | "jwt_missing";

export type OffPeakCodingPlanSupport =
  | {
      supported: true;
      kind: OffPeakCodingPlanKind;
      providerFamily: "zai" | "bigmodel";
      providerId: string;
    }
  | {
      supported: false;
      reason: OffPeakCodingPlanUnsupportedReason;
    };

/**
 * Live snapshot of the server's ticket-taking quota.
 * Only judges whether a new ticket can be created; the real POST /ticket remains the final admission authority.
 */
export interface OffPeakTakeNumberAvailability {
  canTakeNumber: boolean;
  /// Earliest recovery time given by the server when tickets are unavailable, Unix millis.
  nextTakeAt?: number;
}

export function isOffPeakTicketExpiredError(message: string | undefined): boolean {
  return Boolean(message?.includes(OFF_PEAK_TICKET_EXPIRED_MARKER));
}

/// One off-peak task: form creation takes a number and queues; dispatch createTask mints the session.
export interface ZCodeOffPeakTask {
  /// Local primary key, also the server task_id (stable across tickets).
  offPeakTaskId: string;
  /// Snowflake ticket_id from the server; updated on every re-take (3h-expiry resume / Continue retake).
  serverTicketId?: string;
  /// Task title from the form.
  title: string;
  /// Host conversation taskId; backfilled after the first successful dispatch (form: new session; in-session: bound to the session's first run); non-null = has run.
  conversationId?: string;
  /**
   * The running session. Backfilled after the form-created first run; in-session creation writes the current session id at creation
   * and the first run resumes it instead of minting a new one. Resume/interrupt-recovery resume the same session.
   */
  sessionId?: string;
  /// Bound session's current title (joined from tasks-index on list; read-only derived, not stored).
  sessionTitle?: string;
  /// Instructions from the form.
  prompt: string;
  /// All four permission tiers open; maps the existing ZCodeTaskMode, default "default" (Ask for approval).
  permissionMode: ZCodeTaskMode;
  /**
   * The structured Submission choice fixed when creation was accepted.
   *
   * Legacy DB rows may carry only model/thought_level, empty on read for now; such tasks stay reserved for user repair
   * and must not enter scheduling until the full Selection is backfilled.
   */
  modelSelection?: ModelSelection;
  /// Read-only diagnostic facts when legacy records cannot restore the Selection reliably.
  modelSelectionIssue?: {
    code: "repair-required";
    legacyModelId?: string;
    legacyReasoningLevel?: string;
  };
  /** workspaceIdentity?.trim() || workspacePath */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  status: ZCodeOffPeakTaskStatus;
  /// FIFO order basis (the server's authoritative order is ticket-taking order; local use is display/dispatch sorting only).
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  failureReason?: string;
  /// Completion notice and status-bar display; backfilled by the existing task diff.
  filesChanged?: number;
  /// Terminal settle ack time from the server; undefined=not settled, the outbox reports later.
  settledAt?: number;
  /**
   * When the user deleted the local History row.
   * Controls History visibility only; never deletes the task/session nor clears execution fields.
   */
  historyDeletedAt?: number;
  // -- Server sync snapshot (written by host offPeakTaskSync, read cross-process by the scheduler) --
  /// Ticket-taken time (POST /ticket ack); undefined=not taken.
  registeredAt?: number;
  /// Server ready (coarse gate): true = off-peak window open and number reached; the scheduler may claim and dispatch.
  schedulable?: boolean;
  /// Queue position, UI "#N in queue".
  queuePosition?: number;
  /// Next poll time (interval handed down by the server's next_poll_after).
  nextPollAt?: number;
  createdAt: number;
  updatedAt: number;
}

/// Input of off-peak task creation (workspace injected by the caller; the ticket is taken in the service layer first, persisted only on success).
export interface ZCodeOffPeakTaskCreateParams {
  title: string;
  prompt: string;
  permissionMode: ZCodeTaskMode;
  modelSelection: ModelSelection;
  workspacePath: string;
  workspaceIdentity?: string;
  /// In-session creation: bind the creating session, first run resumes it (mirrors CronCreate targetTaskId). Form creation omits it.
  boundSessionId?: string;
}

/// Stable ticket state returned by the creation boundary; same values as the server's, without exposing the server ticket ID.
export type OffPeakTaskTicketInitialState =
  | "queued"
  | "ready"
  | "active"
  | "expired"
  | "settled"
  | "not_found";

export type OffPeakTaskCreateFailureStage =
  | "client_validation"
  | "ticket_request"
  | "local_persist";

export type OffPeakTaskCreateErrorCategory =
  | "client_validation"
  | "eligibility_3101"
  | "quota_3103"
  | "network"
  | "invalid_response"
  | "local_persist"
  | "unknown";

/**
 * Discriminated union of the create RPC. Failures keep only stable classes/business codes; never carry raw errors or response bodies over RPC.
 * providerName is narrowed host-side to an explicit safe hostname; full URLs are not allowed.
 */
export type OffPeakTaskCreateResult =
  | {
      ok: true;
      task: ZCodeOffPeakTask;
      ticketInitialState: OffPeakTaskTicketInitialState;
      queuePosition?: number;
      providerName: string;
    }
  | {
      ok: false;
      failureStage: OffPeakTaskCreateFailureStage;
      errorCategory: OffPeakTaskCreateErrorCategory;
      errorCode: string;
      providerName: string;
    };
