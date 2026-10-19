// ============================================================
// Dynamic Workflow Run Port - read and fill surfaces of holes
// ============================================================
// Split from dynamic-workflow-run.port.ts (the oxlint max-lines 400 gate), following the retune
// precedent (dynamic-workflow-run-retune.port.ts): snapshot hole entries and the `fillHole`
// request/result live here while the method stays on DynamicWorkflowRunPort; no public name
// changes, the main port file re-exports via `export type *`.
// spec: docs/dynamic-workflow/launch.md "The `FillWorkflowHole` tool";
// apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Holes".

import type { SessionId, ToolCallId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

/**
 * One hole as projected into the snapshot
 * (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "The run snapshot"): built
 * from `hole-reached` / `hole-filled` events plus the engine's in-memory parked table -
 * **`waiting` holds only while the engine says it waits** (after process death no promise waits;
 * events alone would report an unwaited hole as waiting); `filled` comes from events. The whole
 * field is absent when none, <=32.
 *
 * `line` / `before` / `after` are the three things the hole notification (core's progress
 * emitter) reads: the hole call's line in the draft and the phase names around it, all from
 * compiled artifacts; absent when unreadable, and the notification omits that clause. The draft
 * path is not here - it is the snapshot's `scriptPath`.
 */
export interface DynamicWorkflowRunHole {
  /** Hole site id (`hole#21b40fca`, name key); the only key `fillHole` accepts. */
  siteId: string;
  /** Ordinal of this occurrence (one site may be reached repeatedly in a loop). */
  ordinal: number;
  /** The hole's literal name. */
  name: string;
  /** Type argument verbatim (`Verdict`), as written in the script. */
  type: string;
  state: "waiting" | "filled";
  /** Reached-at (epoch ms); present while `waiting`. */
  since?: number;
  /** Filled-at (epoch ms); present when `filled`. */
  filledAt?: number;
  /** Session that filled it (the `fillHole` request's `parentSessionId`). */
  filledBy?: string;
  /** Line of the hole call in the run draft (1-based). */
  line?: number;
  /** Phase name before the hole. */
  before?: string;
  /** Phase name after the hole. */
  after?: string;
}

/**
 * Request of {@link DynamicWorkflowRunPort.fillHole}
 * (docs/dynamic-workflow/launch.md "The `FillWorkflowHole` tool"; engine docs
 * "The fill service's checks"). `body` is the hole function body's **statements**, verbatim;
 * splicing, compilation, site-stability checks, and draft rewrite all happen implementation-side.
 */
export interface DynamicWorkflowRunFillHoleRequest {
  runId: string;
  /** Hole site id (`hole#21b40fca`, name key). */
  holeId: string;
  body: string;
  /** Filling session, recorded into `hole-filled.filledBy`. */
  parentSessionId?: SessionId | string;
  /** FillWorkflowHole tool call that requested the fill. */
  toolCallId?: ToolCallId | string;
  trace: TraceContext;
}

/**
 * Structured refusal reasons of a fill. Four different next steps for the model: another run id
 * / check the run's state (ResumeWorkflowRun first if stopped) / fix the fill file and pass
 * `path` / change nothing, this is a host fault.
 */
export type DynamicWorkflowRunFillHoleRefusalReason =
  /** No such run in the journal. */
  | "run_not_found"
  /** Run not in flight, or this is not the hole it waits on (already filled, not yet reached, unknown id); `message` says which. */
  | "hole_not_waiting"
  /** The valid script does not compile; `diagnostics` present. Nothing spliced, nothing recorded; the hole keeps waiting. */
  | "compile_failed"
  /** The compiled valid script renumbered an existing site: the analyzer's numbering rule broke - a host fault, not the model's; the hole keeps waiting. */
  | "fill_ids_unstable";

/**
 * One fill diagnostic. When `inFill`, `line` / `column` are **inside the function body** (the
 * spliced segment), else script coordinates - the tool layer anchors it to the fill file or the
 * run draft accordingly.
 */
export interface DynamicWorkflowRunFillHoleDiagnostic {
  line: number;
  column: number;
  message: string;
  code: number;
  inFill: boolean;
}

/**
 * Structured result of `fillHole`. On success `scriptText` is the **valid script** (body
 * spliced in, the stored copy) from which the tool layer mints display; `scriptPath` is the
 * run's draft (rewritten in place into valid script; minted by the implementation when the run
 * had none); `phasesAdded` lists phase names the body introduced.
 */
export type FillWorkflowHoleResult =
  | { ok: true; phasesAdded: string[]; scriptPath?: string; scriptText: string }
  | {
      ok: false;
      reason: DynamicWorkflowRunFillHoleRefusalReason;
      message: string;
      diagnostics?: DynamicWorkflowRunFillHoleDiagnostic[];
    };
