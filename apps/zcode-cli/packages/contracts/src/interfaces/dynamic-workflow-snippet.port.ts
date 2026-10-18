// ============================================================
// Dynamic Workflow Snippet Port - synchronous compile-and-run boundary for snippets
// ============================================================
// Kept beside, not merged with, {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunPort}:
// the run port presupposes a durable journal (no persistence, no run), while a snippet is fully transient and
// needs only two execution ports - hanging it off the run port would make the experimental lane inherit the durability precondition.

import type { TraceContext } from "../tracing/tracer.js";

/** JSON shape of one compile diagnostic (same shape as CreateWorkflow's; the port imports no zod schema). */
export interface DynamicWorkflowSnippetDiagnostic {
  code: number;
  column: number;
  line: number;
  message: string;
}

export interface DynamicWorkflowSnippetEvalRequest {
  /** Snippet source (scratch facade vocabulary: files.*, git.*, log, plain TS). */
  code: string;
  /** Working directory (sandbox child cwd, world-read root). */
  cwd: string;
  /** Wall-clock budget for the whole snippet (ms). Clamping is the tool layer's; the port executes as given. */
  timeoutMs: number;
  trace: TraceContext;
}

export interface DynamicWorkflowSnippetEvalOptions {
  signal?: AbortSignal;
}

/**
 * Structured eval result. The three shapes are mutually exclusive:
 *   - compile failure: `diagnostics` non-empty, nothing executed;
 *   - completed: `artifact` is the top-level return value (an `undefined` artifact means the field is absent);
 *   - failed: `error` carries a stable code (timeout / thrown error / cap refusal all land here).
 * `logs` present in both latter shapes (the pre-failure narrative has value too).
 */
export type DynamicWorkflowSnippetEvalResult =
  | { kind: "diagnostics"; diagnostics: DynamicWorkflowSnippetDiagnostic[] }
  | { kind: "completed"; artifact?: unknown; logs: string[]; logsTruncated: boolean }
  | {
      kind: "failed";
      error: { code: string; message: string };
      logs: string[];
      logsTruncated: boolean;
    };

export interface DynamicWorkflowSnippetPort {
  /** Compile once and run synchronously to settlement (fully transient: no dwf_* rows, no background task). */
  evalSnippet(
    request: DynamicWorkflowSnippetEvalRequest,
    options?: DynamicWorkflowSnippetEvalOptions,
  ): Promise<DynamicWorkflowSnippetEvalResult>;
}
