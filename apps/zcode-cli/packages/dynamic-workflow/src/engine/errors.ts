/**
  * The engine's structured errors: stable codes, serializable shape, and the {@link WorkflowError} thrown across Boundary A.
  * This module depends on schema's Violation and the terminal-state detail; types.ts re-exports those types for callers.
 */

import type { Violation } from "../schema/types.js";
import type { ProviderStopDetails } from "./run-terminal.js";

/**
  * Stable error codes. Node-level (rejecting one ask's promise) vs run-level (failing the whole run):
  * - Node-level: ValidationFailed / ResultNotSubmitted / DriverError / Cancelled / ContextLimit /
  *   WorldReadCapExceeded -- one world read past its op's cap (files.grep: 2000 hits or
  *   256KB serialized, first-come rejection; git.diff: 512KB; see facade/world-read-caps.ts). Node-level rather than
  *   run-level by **rejection channel**, not severity: a world read returns a promise the script can catch, so
  *   narrowing the pattern or adding a glob is a path the script can really walk. Also deliberately **not** folded into
  *   DriverError -- the cap is contract the script may rewrite itself by; telling the two apart by matching message text is
  *   exactly what this union exists to avoid.
  * - Run-level: InputHashMismatch / UnknownActor / MissingAskSpec /
  *   DuplicateActorName -- two createActor calls in one run yielding the same **non-empty** effective name
  *   (effective name = spec.name after normalizePersona; persona.name beats the name arg). The rule applies to
  *   **every** run, not only amended ones: named actors are the amend-resume cache-import identity key, and any
  *   run is a future amendment's potential predecessor; duplicates in a predecessor make import matching ambiguous. Anonymous (absent or empty name) is unchecked, unrestricted -- the cost is no cache eligibility.
  *   Literal duplicates also get a compile-time courtesy diagnostic (analysis/actor-names.ts), but dynamic names are checkable only at runtime,
  *   so this is the real gate.
  *   ReportCapExceeded -- a run past 256 reports, or one item serializing past 32KB
  *   (see facade/report-caps.ts). Run-level not node-level, same reasoning as WorldReadCapExceeded above with the opposite
  *   conclusion: report returns void -- the script has **no** channel to catch; there is nowhere but the run to put it.
  *   And that is why both numbers must be wide enough that reasonable scripts never hit them -- authors cannot write a recovery path.
  *   Likewise deliberately not folded into DriverError: the cap is contract the script may rewrite itself by.
  * - Construction-time (run not started; the engine constructor throws synchronously): ScriptHashMismatch
  * - Host-level (**never produced by the engine**): Interrupted -- the process owning the died before settlement; the host
  *   converges the stuck-running row at the next construction (the orphan convergence in
  *   bootstrap/src/app/dynamic-workflow-run-service.ts). It must be its **own code**, not DriverError: a
  *   script's own throw also encodes as DriverError (dynamic-workflow-runtime/src/harness.ts:311); sharing a code would leave
  *   killed-process vs real-script-failure distinguishable only by message text -- what this union avoids.
  *   ProviderStop -- a subagent's (or tool-side) model request hit a **deterministic** model-side error (auth expired, model not in plan, quota), and the driver
  *   stops the run stopped(provider) instead of failing the node; structured detail in providerStop. The other host-level
  *   case: the engine only persists it verbatim in stop provider.
  * Flow logic uses these codes, never error-text matching.
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
    // ------------------------- user-facing artifacts -------------------------
    // ⚠ Terminology: every artifact here is a **user-facing deliverable** (output published to the user), unrelated to
    // RunSettlement.artifact (the top-level return value).
  //
    // The channel splits by **member family**, the same argument as the WorldReadCapExceeded / ReportCapExceeded boundary:
    // content members (file/markdown) return a promise the script can catch -- node-level rejection; preset members
    // return void, nowhere to reject into -- the same fact is failRun in that family. The three driver-side
    // codes (Missing/Outside/TooLarge/StoreUnavailable) arise only from content members, hence always node-level.
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
    // A second id wants primary: content members node-level rejection,
    // preset members failRun -- the same boundary as above.
  | "ArtifactPrimaryConflict";

/**
  * Structured mismatch of values (which side changed). The recorded value is expected; this call's is got.
  * Whoever debugging a rejected resume needs these two values, not a regex over message -- flow logic
  * and display alike must not depend on error text.
 */
export interface WorkflowErrorMismatch {
  expected: string;
  got: string;
}

/** The error's serializable form, persisted to the journal (dwf_node.error_json / dwf_run.failure_json). */
export interface WorkflowErrorJson {
  code: WorkflowErrorCode;
  message: string;
  violations?: Violation[];
  finalText?: string;
  mismatch?: WorkflowErrorMismatch;
    /** Present only when code is ProviderStop. */
  providerStop?: ProviderStopDetails;
}

/**
  * The structured error thrown across Boundary A. Stable code plus optional violations / finalText / mismatch,
  * so script-side try/catch andso script-side try/catch and callers handle structurally, never by string matching.
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

    /** To the serializable form for the journal. */
  toJSON(): WorkflowErrorJson {
    const json: WorkflowErrorJson = { code: this.code, message: this.message };
    if (this.violations !== undefined) json.violations = this.violations;
    if (this.finalText !== undefined) json.finalText = this.finalText;
    if (this.mismatch !== undefined) json.mismatch = this.mismatch;
    if (this.providerStop !== undefined) json.providerStop = this.providerStop;
    return json;
  }

    /** Rebuild from a journal row (used when replay hits a failed node). */
  static fromJSON(json: WorkflowErrorJson): WorkflowError {
    return new WorkflowError(json.code, json.message, {
      violations: json.violations,
      finalText: json.finalText,
      mismatch: json.mismatch,
      providerStop: json.providerStop,
    });
  }
}
