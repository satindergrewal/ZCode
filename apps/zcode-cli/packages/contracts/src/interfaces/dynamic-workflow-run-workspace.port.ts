// ============================================================
// Dynamic Workflow Run Port: read-surface types of the workspace transcript
// ============================================================
// docs/dynamic-workflow/transcript-and-notifications.md. Same split rationale as the situation
// cross-section (dynamic-workflow-run-roster.port.ts) and retune
// (dynamic-workflow-run-retune.port.ts): dynamic-workflow-run.port.ts hits the oxlint max-lines
// ceiling (400); these six types form a group of their own (listing row and body of one
// `files.*` / `git.*` / `world.run` call). Public surface unchanged - re-exported verbatim
// there, `@zcode/contracts` import paths untouched.

// The structured-failure shape stays in the main file (two fields here reference it), so a type
// is imported back: types only, no runtime edge; each file describes its own group.
import type { DynamicWorkflowRunError } from "./dynamic-workflow-run.port.js";

/** Kind of workspace node: the two world values of journal `dwf_node.kind`. */
export type DynamicWorkflowRunWorkspaceNodeKind = "world-read" | "world-run";

/** Row status, = journal's `NodeRecordStatus` (deliberately restated here, same rationale as lifecycle status). */
export type DynamicWorkflowRunWorkspaceNodeStatus = "running" | "completed" | "failed";

/**
 * The **summary** of a listing row: the few numbers reportable without decoding the body,
 * computed by the storage layer in-query via SQLite JSON functions
 * (`resultBytes` / `resultCount` / `exitCode` / `stdoutBytes` / `stderrBytes`), passed
 * through by the port. Which fields appear depends on op: array bodies (glob / grep /
 * changedFiles) have `resultCount`; `world.run` has exitCode and both output byte counts;
 * string bodies only `resultBytes`.
 */
export interface DynamicWorkflowRunWorkspaceNodeSummary {
  /** UTF-8 bytes of the serialized body. */
  resultBytes: number;
  resultCount?: number;
  exitCode?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
}

/**
 * One row of the workspace transcript: one `files.*` / `git.*` / `world.run` call, **body not
 * included**.
 *
 * `op` / `args` come from `input_json` (migration 0030; written at admission, <= 4KB); legacy
 * pre-upgrade rows lack both and the UI falls back to the static graph's step label.
 * `inputTruncated` means args are per-item string previews, not raw values.
 */
export interface DynamicWorkflowRunWorkspaceNode {
  siteId: string;
  ordinal: number;
  kind: DynamicWorkflowRunWorkspaceNodeKind;
  op?: string;
  args?: readonly unknown[];
  inputTruncated?: true;
  status: DynamicWorkflowRunWorkspaceNodeStatus;
  /** Structured failure of a failed row (journal `error_json` code + message; no other fields cross the port). */
  error?: DynamicWorkflowRunError;
  /** Settled-successful rows only. */
  summary?: DynamicWorkflowRunWorkspaceNodeSummary;
  /** Row created / last-updated (epoch ms); their difference is this step's duration. */
  createdAt: number;
  updatedAt: number;
}

/** Pagination bag of {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunPort.readWorkspaceNodeResult}: the body's byte cap. */
export interface DynamicWorkflowRunWorkspaceNodeResultQuery {
  /** Required; the port **bounds** the body by it (truncate, never refuse - an audit surface, not the script's data path). */
  maxBytes: number;
}

/**
 * The body of one workspace node: the `result`, shape-preserving bounded.
 *
 * Truncation is **shape-preserving**: strings tail-cut, arrays tail-dropped, `world.run`'s
 * stdout / stderr cut each; `truncated` says it happened and `totalBytes` is the pre-cut size.
 * running rows have no body; failed rows only `error`.
 */
export interface DynamicWorkflowRunWorkspaceNodeResult {
  status: DynamicWorkflowRunWorkspaceNodeStatus;
  result?: unknown;
  error?: DynamicWorkflowRunError;
  truncated: boolean;
  totalBytes: number;
}
