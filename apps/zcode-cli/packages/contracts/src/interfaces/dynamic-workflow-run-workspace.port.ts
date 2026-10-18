// Dynamic Workflow Run Port: read types for the workspace operation transcript.
// Listing rows and bodies of `files.*`, `git.*`, and `world.run` calls,
// re-exported via dynamic-workflow-run.port.ts; callers consume via `@zcode/contracts`.

// The structured-failure shape stays in the main file (two fields here reference it), hence one type imported back:
// type-only, no runtime edge; each file describes only its own group.
import type { DynamicWorkflowRunError } from "./dynamic-workflow-run.port.js";

/** Workspace node kind: the two world values of journal `dwf_node.kind`. */
export type DynamicWorkflowRunWorkspaceNodeKind = "world-read" | "world-run";

/** Node row status, = journal `NodeRecordStatus` (restated here deliberately; reason as lifecycle status). */
export type DynamicWorkflowRunWorkspaceNodeStatus = "running" | "completed" | "failed";

/**
 * The **summary** of a listing row: the few numbers reportable without decoding the body. Computed by the storage layer
 * in-query via SQLite JSON functions (`resultBytes` / `resultCount` / `exitCode` / `stdoutBytes` / `stderrBytes`),
 * passed through by the port. Which fields appear depends on op: array bodies (glob / grep / changedFiles) carry `resultCount`,
 * `world.run` carries exitCode plus byte counts of both streams; string bodies only `resultBytes`.
 */
export interface DynamicWorkflowRunWorkspaceNodeSummary {
  /** UTF-8 byte length of the serialized body. */
  resultBytes: number;
  resultCount?: number;
  exitCode?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
}

/**
 * One workspace transcript row: a single `files.*` / `git.*` / `world.run` call, **body excluded**.
 *
 * `op` / `args` come from the `input_json` added in migration 0030 (written at admission, <= 4 KB); pre-upgrade history rows
 * lack both, and the UI falls back to step labels on the static graph. `inputTruncated` means args are per-item string previews, not raw values.
 */
export interface DynamicWorkflowRunWorkspaceNode {
  siteId: string;
  ordinal: number;
  kind: DynamicWorkflowRunWorkspaceNodeKind;
  op?: string;
  args?: readonly unknown[];
  inputTruncated?: true;
  status: DynamicWorkflowRunWorkspaceNodeStatus;
  /** Structured failure of failed rows (code + message of journal `error_json`; no other fields leave the port). */
  error?: DynamicWorkflowRunError;
  /** Only rows settled successfully. */
  summary?: DynamicWorkflowRunWorkspaceNodeSummary;
  /** Creation / last-update time of the journal row (epoch ms); the difference is this step's duration. */
  createdAt: number;
  updatedAt: number;
}

/** Pagination bag for {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunPort.readWorkspaceNodeResult}: byte cap on the body. */
export interface DynamicWorkflowRunWorkspaceNodeResultQuery {
  /** Required; the port **bounds** the body by it (truncate, not reject - an audit surface, not the script's data surface). */
  maxBytes: number;
}

/**
 * The body of one workspace node: the shape-bounded `result`.
 *
 * Truncation is **shape-preserving**: strings tail-cut, arrays tail-cut, `world.run` stdout / stderr each tail-cut;
 * `truncated` says truncation happened, `totalBytes` is the pre-truncation size. running rows have no body; failed rows
 * carry only `error`.
 */
export interface DynamicWorkflowRunWorkspaceNodeResult {
  status: DynamicWorkflowRunWorkspaceNodeStatus;
  result?: unknown;
  error?: DynamicWorkflowRunError;
  truncated: boolean;
  totalBytes: number;
}
