/**
 * The engine's structured errors
 * (docs/execution-engine.md "Errors are first-class"): stable codes, their serializable shape, and
 * {@link WorkflowError} itself, thrown across Boundary A.
 *
 * Split out for the same reason as run-terminal.ts: types.ts is at oxlint's 400-line gate, and
 * this family is self-contained - only schema's Violation and the terminal details, nothing else
 * from the vocabulary. Consumers still import from types.ts (re-exported verbatim), so no
 * import path changes.
 */

import type { Violation } from "../schema/types.js";
import type { ProviderStopDetails } from "./run-terminal.js";

/**
 * Stable codes. Node-level (reject one ask's promise) vs run-level (fail the whole run):
 * - node: ValidationFailed / ResultNotSubmitted / DriverError / Cancelled / ContextLimit /
 *   WorldReadCapExceeded - a world read over its op's cap (files.grep: 2000 hits or 256KB
 *   serialized, first breached; git.diff: 512KB; facade/world-read-caps.ts). Node-level via the
 *   rejection channel, not severity: the read returns a catchable promise, so "narrow the pattern
 *   / add a glob" is a path the script can walk. Deliberately not folded into DriverError - the
 *   cap is a contract the script can rewrite itself against; telling them apart by message text is
 *   what this union exists to prevent.
 * - run: InputHashMismatch / UnknownActor / MissingAskSpec /
 *   DuplicateActorName - two createActor calls in one run yielding the same non-empty effective
 *   name (post-normalizePersona spec.name; persona.name beats the argument). The rule binds ALL
 *   runs, not just amended ones: named actors are amend-resume cache-import identity keys and any
 *   run is a potential predecessor whose duplicates would make matching ambiguous
 *   (docs/execution-engine.md, the naming-uniqueness row). Anonymous (absent/empty) unchecked,
 *   unlimited - the cost: no cache eligibility. Literal duplicates also get a compile-time
 *   courtesy diagnostic (analysis/actor-names.ts); dynamic names are runtime-only, hence this gate.
 *   ReportCapExceeded - a run over 65,536 reports, one item over 1MiB serialized, or all items
 *   over 1GiB (facade/report-caps.ts). Run-level, the same boundary logic as WorldReadCapExceeded
 *   with the opposite verdict: report returns void, no catchable channel - nowhere but the run.
 *   Hence both numbers are generous enough that reasonable scripts never hit them (authors cannot
 *   write recovery). Also not DriverError: the cap is a contract the script can rewrite against.
 * - Construction (pre-run, thrown synchronously from the engine constructor): ScriptHashMismatch
 * - Host-level (never produced by the engine): Interrupted - the owning process died before
 *   settlement; the host reconciles the forever-running row at next construction
 *   (bootstrap/src/app/dynamic-workflow-run-service.ts orphan sweep; desktop field bug
 *   2026-08-19). A distinct code, not DriverError: script throws also code as DriverError
 *   (dynamic-workflow-runtime/src/harness.ts:311); same code would leave process-killed vs
 *   script-failed to message matching - what this union avoids.
 *   ProviderStop - a subagent (or tool-side) model request hit a DETERMINISTIC model-side error
 *   (auth expiry, plan missing the model, quota..., the policy table in
 *   docs/execution-engine.md); the driver stops the run stopped(provider) rather than failing the
 *   node; structured detail in providerStop. Host-level too: the engine only records it verbatim
 *   in stop("provider", error).
 * Control flow keys on these codes, never on error text.
 */
export type WorkflowErrorCode =
  | "ValidationFailed"
  | "ResultNotSubmitted"
  | "DriverError"
  | "WorldReadCapExceeded"
  | "Cancelled"
  | "ContextLimit"
  | "ReportCapExceeded"
  | "InputHashMismatch"
  | "UnknownActor"
  | "MissingAskSpec"
  | "DuplicateActorName"
  | "ScriptHashMismatch"
  | "Interrupted"
  | "ProviderStop"
  // —— User-facing artifacts (docs/dynamic-workflow/authoring.md "Publishing content") ——
  // ⚠ Every artifact here is user-facing (shown to the user by the script); unrelated to
  // RunSettlement.artifact (the top-level return).
  //
  // The channel splits by member family, the same argument as the WorldRead/ReportCap boundary:
  // content members (file/markdown) return a catchable promise -> node-level rejection; preset
  // members return void with nowhere to reject -> failRun for the same fact. The driver-side codes
  // (Missing/Outside/TooLarge/StoreUnavailable) arise only from content members, hence node-level.
  | "ArtifactSourceMissing"
  | "ArtifactPathOutsideWorkspace"
  | "ArtifactTooLarge"
  | "ArtifactStoreUnavailable"
  | "ArtifactVersionCapExceeded"
  | "ArtifactKindMismatch"
  | "ArtifactCapExceeded"
  | "ArtifactSpecInvalid"
  | "ArtifactRedeclared"
  | "ArtifactUndeclared"
  // A second id claiming primary (docs/dynamic-workflow/authoring.md "Ids, tags and versions"):
  // node-level rejection for content, failRun for preset - the same boundary as above.
  | "ArtifactPrimaryConflict";

/**
 * Structured mismatch (which side changed): the recorded value is expected, this call's got.
 * Whoever debugges a refused resume needs both, not a regex over message - control flow and
 * display must not parse error text.
 */
export interface WorkflowErrorMismatch {
  expected: string;
  got: string;
}

/** Serializable shape persisted to the journal (dwf_node.error_json / dwf_run.failure_json). */
export interface WorkflowErrorJson {
  code: WorkflowErrorCode;
  message: string;
  violations?: Violation[];
  finalText?: string;
  mismatch?: WorkflowErrorMismatch;
  /** Present only when code === ProviderStop. */
  providerStop?: ProviderStopDetails;
}

/**
 * the upper layers handle structurally, never by string matching.
 */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly violations?: Violation[];
  readonly finalText?: string;
  readonly mismatch?: WorkflowErrorMismatch;
  readonly providerStop?: ProviderStopDetails;

  constructor(
    code: WorkflowErrorCode,
    message: string,
    extra?: {
      violations?: Violation[];
      finalText?: string;
      mismatch?: WorkflowErrorMismatch;
      providerStop?: ProviderStopDetails;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    if (extra?.violations !== undefined) this.violations = extra.violations;
    if (extra?.finalText !== undefined) this.finalText = extra.finalText;
    if (extra?.mismatch !== undefined) this.mismatch = extra.mismatch;
    if (extra?.providerStop !== undefined) this.providerStop = extra.providerStop;
    if (extra?.cause !== undefined) (this as { cause?: unknown }).cause = extra.cause;
  }

  /** The serializable shape, for the journal. */
  toJSON(): WorkflowErrorJson {
    const json: WorkflowErrorJson = { code: this.code, message: this.message };
    if (this.violations !== undefined) json.violations = this.violations;
    if (this.finalText !== undefined) json.finalText = this.finalText;
    if (this.mismatch !== undefined) json.mismatch = this.mismatch;
    if (this.providerStop !== undefined) json.providerStop = this.providerStop;
    return json;
  }

  /** Rebuilds from a journal record (replay hitting a failed node). */
  static fromJSON(json: WorkflowErrorJson): WorkflowError {
    return new WorkflowError(json.code, json.message, {
      violations: json.violations,
      finalText: json.finalText,
      mismatch: json.mismatch,
      providerStop: json.providerStop,
    });
  }
}
