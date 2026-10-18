/* oxlint-disable eslint(max-lines) -- share error/preflight contracts and cross-RPC redaction rules share one boundary so UI, Host and API never drift. */
import type {
  ConversationShareAccessMode,
  ConversationShareCapabilities,
  ConversationShareContinuation,
  ConversationSharePreview,
  ConversationShareRecord,
  Locale,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { Event as RpcEvent, type Event } from "@zcode/rpc";

import { createServiceDescriptor } from "../descriptors.js";
import type { ConversationShareClientErrorKind } from "./conversationShareHttpClient.js";

export type ConversationShareSelection =
  | { kind: "all" }
  | { kind: "productTurns"; productTurnIds: string[] }
  | { kind: "rowAnchors"; rowIds: number[] };

export interface PublishTextConversationInput {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  title: string;
  accessMode: ConversationShareAccessMode;
  selection: ConversationShareSelection;
  clientRequestId: string;
  disclosureAcceptedAt: number;
  /** UI locale; decides whether the returned share_url points at the zh or en site. By default the server-issued URL is untouched. */
  locale?: Locale;
}

export interface ConversationSharePreflightInput {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  selection: ConversationShareSelection;
}

export interface ConversationShareAllowedArtifact {
  type: string;
  extensions: readonly string[];
  mimeTypes: readonly string[];
  displayName?: string;
}

export interface ConversationShareTurnPreflightResult {
  /** 已转换的公开行数；选择变化时可按轮重新聚合，不缓存整组选中项的容量错误。 */
  rowBudget?: { count: number; limit: number };
  productTurnId: string;
  turnFingerprint?: string;
  blockingIssues: readonly ConversationShareFailureIssue[];
  skippableWarnings: readonly ConversationShareFailureIssue[];
  deferredIssues: readonly ConversationShareFailureIssue[];
}

export interface ConversationSharePreflightResult {
  revision: number;
  logEpoch: string;
  capabilitiesFingerprint: string;
  blockingIssues: readonly ConversationShareFailureIssue[];
  skippableWarnings: readonly ConversationShareFailureIssue[];
  deferredIssues: readonly ConversationShareFailureIssue[];
  supportedArtifactTypes: readonly ConversationShareAllowedArtifact[];
  turnResults: readonly ConversationShareTurnPreflightResult[];
}

export type ConversationShareServiceErrorKind =
  | ConversationShareClientErrorKind
  | "artifact_protocol_not_ready"
  | "connection_unavailable"
  | "invalid_selection"
  | "safety_check_timeout";

export type ConversationShareFailureReasonCode =
  | "running_turn"
  | "streaming_row"
  | "active_tool_call"
  | "active_subagent"
  | "input_attachment"
  | "input_attachment_unavailable"
  | "inline_tool_image"
  | "unsupported_timeline"
  | "unsafe_url"
  | "missing_product_turn"
  | "invalid_selection"
  | "artifact_type_not_allowed"
  | "artifact_extension_missing"
  | "artifact_outside_workspace"
  | "artifact_changed"
  | "artifact_read_failed"
  // Known size overflow: the artifact exceeds the server max_artifact_bytes or the channel limit.
  // Unlike artifact_read_failed (uncertain), it is a definite block at selection time.
  | "artifact_size_limit"
  | "artifact_manifest"
  | "payload_limit"
  | "no_shareable_content"
  | "stale_conversation"
  | "artifact_protocol_not_ready"
  | "invalid_conversation";

export type ConversationShareFailureIssueCode =
  | ConversationShareFailureReasonCode
  | "rows_limit"
  | "artifact_count_limit"
  | "artifact_total_size_limit"
  | "payload_size_limit"
  | "upload_incomplete"
  | "unknown";

export interface ConversationShareFailureIssue {
  code: ConversationShareFailureIssueCode;
  scope: "conversation" | "turn" | "artifact" | "transport";
  rowId?: number;
  turnOrdinal?: number;
  /**
   * Product-turn identity of the question.
   *
   // The UI's deselect-turn once indexed its per-query list by turnOrdinal, but turnOrdinal is
   // the service's index over ALL turnHeaders; the two numberings misalign in conversations with
   // system-context turns or multiple steer queries, deselecting the wrong turn. Address turns by
   // identity; turnOrdinal is display copy only.
   */
  productTurnId?: string;
  artifactDisplayName?: string;
  artifactType?: string;
  extension?: string;
  mimeType?: string;
  actual?: number;
  limit?: number;
  retryAfterMs?: number;
  phase?: ConversationSharePublishProgress["phase"] | "downloading" | "installing" | "committing";
  allowedFormats?: readonly string[];
  allowedArtifacts?: readonly ConversationShareAllowedArtifact[];
  availability?:
    | "not_found"
    | "permission_denied"
    | "connection_unavailable"
    | "changed"
    | "unknown";
}

export type ConversationShareFailureDiagnosticValue = string | number | boolean;
export type ConversationShareFailureDiagnostics = Readonly<
  Record<string, ConversationShareFailureDiagnosticValue>
>;

function inferFailureReasonCode(message: string): ConversationShareFailureReasonCode {
  if (/Running turns/iu.test(message)) return "running_turn";
  if (/Streaming rows/iu.test(message)) return "streaming_row";
  if (/Active tool calls/iu.test(message)) return "active_tool_call";
  if (/Active subagents|subagent detail/iu.test(message)) return "active_subagent";
  if (/attachments?|public input contains local write identity/iu.test(message)) {
    return "input_attachment";
  }
  if (/Inline tool images/iu.test(message)) return "inline_tool_image";
  if (/Timeline|fork|checkpoint|summary references/iu.test(message)) {
    return "unsupported_timeline";
  }
  if (/Local and inline URLs/iu.test(message)) return "unsafe_url";
  if (/missing its product turn|product turn identity/iu.test(message)) {
    return "missing_product_turn";
  }
  if (/Selected product turns|selected row|selection/iu.test(message)) {
    return "invalid_selection";
  }
  if (/not allowed by server capabilities/iu.test(message)) return "artifact_type_not_allowed";
  if (/extension is missing/iu.test(message)) return "artifact_extension_missing";
  if (/outside the workspace/iu.test(message)) return "artifact_outside_workspace";
  if (/changed after|file changed|size\/mtime/iu.test(message)) return "artifact_changed";
  // The local/remote artifact sources' fallback message is artifact-cannot-be-read; the old regex
  // covered only ended|source|chunk|readable, so read failures were misjudged invalid_conversation.
  if (/artifact (?:ended|source|chunk|readable|cannot be read)/iu.test(message)) {
    return "artifact_read_failed";
  }
  if (/artifact (?:identifiers|manifest|acknowledgement|missing)/iu.test(message)) {
    return "artifact_manifest";
  }
  if (/payload|too many rows|too many artifacts/iu.test(message)) return "payload_limit";
  return "invalid_conversation";
}

export interface ConversationShareFailureDetails {
  requestId?: string;
  status?: number;
  code?: number;
  reasonCode?: ConversationShareFailureReasonCode;
  diagnostics?: ConversationShareFailureDiagnostics;
  issues?: readonly ConversationShareFailureIssue[];
  issueCount?: number;
  omittedIssueCount?: number;
  /** Underlying error for host-side diagnostics only; never enters the details sent to renderers. */
  cause?: unknown;
}

const SAFE_FAILURE_DIAGNOSTIC_KEYS = new Set([
  "rowKind",
  "rowId",
  "field",
  "artifactType",
  "extension",
  "phase",
  "expectedBytes",
  "actualBytes",
  "errno",
]);

const MAX_FAILURE_ISSUES = 5;

function sanitizeFailureIssue(
  issue: ConversationShareFailureIssue,
): ConversationShareFailureIssue | null {
  const safeString = (value: string | undefined): string | undefined =>
    value && value.length <= 128 && !/[\\/]|:\/\//u.test(value) ? value : undefined;
  const safeMimeType = (value: string | undefined): string | undefined =>
    value && value.length <= 128 && /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/u.test(value)
      ? value
      : undefined;
  const artifactDisplayName = issue.artifactDisplayName?.trim();
  // When displayName holds a path/URL or is overlong, returning null filters the whole issue -
  // redaction should hide the path, not discard the diagnosis. Strip only the field and keep
  // code/scope and other locators.
  const safeArtifactDisplayName =
    artifactDisplayName &&
    artifactDisplayName.length <= 128 &&
    !/[\\/]|:\/\//u.test(artifactDisplayName)
      ? artifactDisplayName
      : undefined;
  const allowedFormats = issue.allowedFormats
    ?.map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 128 && !/[\\/]|:\/\//u.test(value));
  const allowedArtifacts = issue.allowedArtifacts
    ?.map((artifact) => ({
      type: artifact.type.trim(),
      extensions: artifact.extensions
        .map((extension) => extension.trim().replace(/^\./u, ""))
        .filter((extension) => extension.length > 0 && extension.length <= 32),
      mimeTypes: artifact.mimeTypes
        .map((mimeType) => mimeType.trim().toLowerCase())
        .filter((mimeType) => /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/u.test(mimeType)),
      ...(artifact.displayName &&
      artifact.displayName.length <= 64 &&
      !/[\\/]|:\/\//u.test(artifact.displayName)
        ? { displayName: artifact.displayName.trim() }
        : {}),
    }))
    .filter(
      (artifact) =>
        artifact.type.length > 0 &&
        !/[\\/]|:\/\//u.test(artifact.type) &&
        artifact.extensions.length > 0,
    );
  return {
    code: issue.code,
    scope: issue.scope,
    ...(issue.rowId === undefined ? {} : { rowId: issue.rowId }),
    ...(issue.turnOrdinal === undefined ? {} : { turnOrdinal: issue.turnOrdinal }),
    ...(typeof issue.productTurnId === "string" && issue.productTurnId.length > 0
      ? { productTurnId: issue.productTurnId }
      : {}),
    ...(safeArtifactDisplayName ? { artifactDisplayName: safeArtifactDisplayName } : {}),
    ...(safeString(issue.artifactType) ? { artifactType: safeString(issue.artifactType) } : {}),
    ...(safeString(issue.extension) ? { extension: safeString(issue.extension) } : {}),
    ...(safeMimeType(issue.mimeType) ? { mimeType: safeMimeType(issue.mimeType) } : {}),
    ...(issue.actual === undefined ? {} : { actual: issue.actual }),
    ...(issue.limit === undefined ? {} : { limit: issue.limit }),
    ...(issue.retryAfterMs === undefined ? {} : { retryAfterMs: issue.retryAfterMs }),
    ...(issue.phase === undefined ? {} : { phase: issue.phase }),
    ...(allowedFormats && allowedFormats.length > 0 ? { allowedFormats } : {}),
    ...(allowedArtifacts && allowedArtifacts.length > 0 ? { allowedArtifacts } : {}),
    ...(issue.availability === undefined ? {} : { availability: issue.availability }),
  };
}

/**
 * Trim and sanitize an issue list into an RPC-safe payload; returns the dropped count.
 * Non-blocking warnings and blocking issues share one redaction ruleset.
 */
export function sanitizeConversationShareIssues(issues: readonly ConversationShareFailureIssue[]): {
  issues: readonly ConversationShareFailureIssue[];
  issueCount: number;
  omittedIssueCount: number;
} {
  const sanitized = issues
    .slice(0, MAX_FAILURE_ISSUES)
    .map(sanitizeFailureIssue)
    .filter((issue): issue is ConversationShareFailureIssue => issue !== null);
  return {
    issues: sanitized,
    issueCount: issues.length,
    omittedIssueCount: Math.max(0, issues.length - sanitized.length),
  };
}

function sanitizeFailureDiagnostics(
  diagnostics: ConversationShareFailureDiagnostics | undefined,
): ConversationShareFailureDiagnostics | undefined {
  if (!diagnostics) return undefined;
  const safe: Record<string, ConversationShareFailureDiagnosticValue> = {};
  for (const [key, value] of Object.entries(diagnostics)) {
    if (!SAFE_FAILURE_DIAGNOSTIC_KEYS.has(key)) continue;
    if (typeof value === "string" && (/[\\/]|:\/\//u.test(value) || value.length > 128)) continue;
    safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export class ConversationShareServiceError extends Error {
  readonly kind: ConversationShareServiceErrorKind;
  readonly requestId?: string;
  readonly status?: number;
  readonly code?: number;
  readonly reasonCode: ConversationShareFailureReasonCode;
  readonly diagnostics?: ConversationShareFailureDiagnostics;
  readonly issues?: readonly ConversationShareFailureIssue[];
  readonly issueCount: number;
  readonly omittedIssueCount: number;
  /** Safety-error payload delivered to the renderer via the existing RPC details field. */
  readonly details?: ConversationShareFailureDetails;

  constructor(
    kind: ConversationShareServiceErrorKind,
    message: string,
    details: ConversationShareFailureDetails = {},
  ) {
    super(message, ...(details.cause === undefined ? [] : [{ cause: details.cause }]));
    this.name = "ConversationShareServiceError";
    this.kind = kind;
    const requestId = details.requestId?.trim();
    if (requestId && /^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)) {
      this.requestId = requestId;
    }
    if (Number.isSafeInteger(details.status)) this.status = details.status;
    if (Number.isSafeInteger(details.code)) this.code = details.code;
    this.reasonCode = details.reasonCode ?? inferFailureReasonCode(message);
    const diagnostics = sanitizeFailureDiagnostics(details.diagnostics);
    if (diagnostics) {
      this.diagnostics = diagnostics;
    }
    const sanitized = sanitizeConversationShareIssues(details.issues ?? []);
    this.issueCount = sanitized.issueCount;
    this.omittedIssueCount = sanitized.omittedIssueCount;
    if (sanitized.issues.length > 0) {
      this.issues = sanitized.issues;
    }
    const safeDetails: ConversationShareFailureDetails = {
      ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.code === undefined ? {} : { code: this.code }),
      reasonCode: this.reasonCode,
      ...(this.diagnostics === undefined ? {} : { diagnostics: this.diagnostics }),
      ...(this.issues === undefined ? {} : { issues: this.issues }),
      ...(this.issueCount > 0 ? { issueCount: this.issueCount } : {}),
      ...(this.issueCount > 0 ? { omittedIssueCount: this.omittedIssueCount } : {}),
    };
    if (Object.keys(safeDetails).length > 0) {
      this.details = safeDetails;
    }
  }
}

export interface ConversationSharePublishProgress {
  operationId: string;
  phase: "collecting" | "uploading" | "checking" | "complete";
  completedArtifacts: number;
  totalArtifacts: number;
  /**
   * Non-blocking: publishing continues but these artifacts are skipped (e.g. a referenced file no
   * longer exists). Already sanitized via sanitizeConversationShareIssues; RPC-safe.
   */
  warnings?: readonly ConversationShareFailureIssue[];
  omittedWarningCount?: number;
}

export interface ConversationShareImportProgress {
  operationId: string;
  phase: "downloading" | "installing" | "committing" | "complete";
  completedArtifacts: number;
  totalArtifacts: number;
}

export interface ImportConversationShareInput {
  shareCode: string;
  clientRequestId: string;
  /** Target captured by the current renderer; the deep link itself carries no path or identity. */
  targetWorkspacePath?: string;
  targetWorkspaceIdentity?: string;
  targetWorkspaceKind?: "local" | "remote";
  /** UI locale; decides the imported session title prefix. The back link always stores the canonical path. */
  locale?: Locale;
}

/** Public-rows copy persisted at import; renders the read-only block offline, no re-fetch. */
export interface ImportedConversationShare {
  shareId: string;
  contextId: string;
  title: string;
  rows: ConversationRow[];
  /**
   * Rows skipped because this build cannot render them (newer row kind or formatVersion).
   * When >0 the read-only block must show a soft notice, or users assume content is lost.
   */
  unsupportedRowCount: number;
  artifacts: Array<{
    artifactId: string;
    displayName: string;
    mimeType?: string;
    workspaceRelativePath?: string;
  }>;
}

export interface ImportConversationShareResult {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  contextId: string;
  shareUrl: string;
  title: string;
  reused: boolean;
  fallbackReason?: "remote_workspace" | "default_workspace";
}

export interface IConversationShareService {
  getCapabilities(): Promise<ConversationShareCapabilities>;
  preflight(input: ConversationSharePreflightInput): Promise<ConversationSharePreflightResult>;
  publish(
    input: PublishTextConversationInput,
    operationId: string,
  ): Promise<ConversationShareRecord>;
  onDynamicPublishProgress(operationId: string): Event<ConversationSharePublishProgress>;
  importShare(
    input: ImportConversationShareInput,
    operationId: string,
  ): Promise<ImportConversationShareResult>;
  onDynamicImportProgress(operationId: string): Event<ConversationShareImportProgress>;
  /** Reads the public rows persisted at import; null when absent (no read-only block renders). */
  getImportedConversation(input: {
    workspacePath: string;
    contextId: string;
  }): Promise<ImportedConversationShare | null>;
  getPreview(shareCode: string): Promise<ConversationSharePreview>;
  getContinuation(input: {
    shareCode: string;
    clientRequestId: string;
  }): Promise<ConversationShareContinuation>;
}

export const IConversationShareService = createServiceDescriptor<IConversationShareService>(
  ServiceChannels.ConversationShare,
);

/**
 * Uniform unavailable-share gate.
 *
 * Every host without share support (desktop-attached remote, server remote, ...) must reject all
 * writes and return empty event streams. Hand-writing one per host misses methods when
 * IConversationShareService grows, so generate them here.
 */
export function createUnsupportedConversationShareService(options: {
  message: string;
  /** Optional audit hook for hosts that log rejected action names. */
  onRejected?: (action: string) => void;
}): IConversationShareService {
  const reject = (action: string) => async (): Promise<never> => {
    options.onRejected?.(action);
    throw new ConversationShareServiceError("feature_disabled", options.message);
  };
  const noEvents = () => RpcEvent.None;
  return {
    getCapabilities: reject("getCapabilities"),
    preflight: reject("preflight"),
    publish: reject("publish"),
    onDynamicPublishProgress: noEvents,
    importShare: reject("importShare"),
    onDynamicImportProgress: noEvents,
    // Read-only query: return null instead of throwing when unavailable - the read-only block simply does not render.
    getImportedConversation: async () => null,
    getPreview: reject("getPreview"),
    getContinuation: reject("getContinuation"),
  };
}
