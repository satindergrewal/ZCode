/**
  * engine.ts sat at oxlint's max-lines cap (400); the engine's private-state seam lives here;
  * the public surface still exports from engine.ts.
 *
  * Several WorkflowEngine method groups (user-facing artifacts, report, world nodes and the import cache, run settlement) were split into free
  * functions in sibling modules (engine-artifacts.ts / engine-report.ts / engine-world.ts / engine-settlement.ts).
  * They hold no state of their own; they read and write the engine's private fields through this seam, assembled by the engine's constructor with arrow
  * closures -- fields stay private, so the engine's public face is untouched; the class keeps only thin delegates.
 *
  * Mutable scalars (report count, import gate) expose a read plus a one-way write, not getter/setter -- the write direction is
  * single (the count only grows, the gate only closes), stated on the seam face itself.
 */

import type { ImportedWorldQueue } from "./imported-cache.js";
import type { ArtifactOp } from "../facade/registry.js";
import type {
  ImportedRunCache,
  InstanceRef,
  JournalStorePort,
  RunEvent,
  RunStopReason,
  WorkflowDriver,
  WorkflowError,
} from "./types.js";

/**
  * The run's final settlement: completed (script return) /
  * errored (the script's fault, not resumable) / stopped (halted, always resumable; error present only
  * for provider / interrupted).
 */
export type RunSettlement =
  | { status: "completed"; artifact: unknown }
  | { status: "errored"; error: WorkflowError }
  | { status: "stopped"; reason: RunStopReason; supersededBy?: string; error?: WorkflowError };

/**
  * One user-facing artifact id's state within this run: member kind, successful-version count, and (presets only) the
  * normalized spec. All three derive from journal rows, so resume rebuild and live accounting yield the same table.
 */
export interface ArtifactIdState {
  kind: ArtifactOp;
    /** Successful-version count (content members +1 per success; preset declarations always 1). */
  versions: number;
    /** The preset spec's canonicalJson (re-declaration idempotence compared by it). Absent for content members. */
  spec?: string;
    /** This id is the run's deliverable (primary). At most one id per run carries it; rebuilt from completed rows. */
  primary?: true;
}

/** The engine private-state seam: sibling free functions read and write WorkflowEngine's private fields through it. */
export interface EngineState {
  readonly runId: string;
  readonly driver: WorkflowDriver;
  readonly journal: JournalStorePort;
  /**
      * Per-user-facing-artifact id state for this run. Rebuilt on resume from the journal's
      * kind-artifact rows, maintained in memory afterwards -- caps and version counts are run-level facts, continuous across resumes.
   *
      * ⚠ Terminology: artifact = user-facing deliverable, not RunSettlement.artifact (the top-level return value).
   */
  readonly artifacts: Map<string, ArtifactIdState>;
    /** The amend-resume import cache (pure data; absent means this is not an amended resume). */
  readonly importedCache: ImportedRunCache | undefined;
    /** Consumption cursor of the world import queue (nth occurrence vs nth entry). */
  readonly importedWorld: ImportedWorldQueue;

  isRunSettled(): boolean;
    /** The error used to reject/throw once the run has settled. */
  runError(): WorkflowError;
    /** Run-level failure (first-wins; see settleFailed in engine-settlement.ts). */
  failRun(error: WorkflowError): void;
    /** Persist the event and fan it out (Boundary C); birth phases are stamped in the engine's funnel. */
  record(event: RunEvent): void;
    /** The sole mint of site ordinals. */
  nextOrdinal(siteId: string): number;
  /**
      * Release one cache hit under replay-settlement-order constraints.
      * Non-resume, or the instance absent from the order table: release immediately.
   */
  holdForReplay(instance: InstanceRef, release: () => void): void;

    /** Reports published in this run (the REPORT_CAPS.maxItemsPerRun counter, continuous across resumes). */
  reportCount(): number;
    /** A report passed the cap check, about to persist: count +1. */
  countReport(): void;

    /** Whether the import cache has closed. */
  importClosed(): boolean;
    /** Close the gate (never reopens). */
  closeImport(): void;

    /** Mark the run settled; with a failure, also record the run-level failure cause (reused by runError). */
  markSettled(failure?: WorkflowError): void;
    /** Abort every in-flight ask (delegates to the scheduler). */
  abortInFlight(error: WorkflowError, emitCancelled: boolean): void;
    /** Fulfill engine.settled. */
  resolveSettled(settlement: RunSettlement): void;
}
