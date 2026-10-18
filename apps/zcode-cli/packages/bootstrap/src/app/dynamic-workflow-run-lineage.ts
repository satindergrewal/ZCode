// ============================================================
// Lineage read surface for Dynamic Workflow Runs (a small slice of the observation surface).
// ============================================================
// Pointers to both ends of the revision chain: `resumedFrom` points at the predecessor,
// `supersededBy` at the successor that stopped this run. Snapshot, list, and detail views all carry both keys; the rule is written once.
// Split out of dynamic-workflow-run-observation.ts because that file hit the oxlint 400-line limit.

import type { RunStatus } from "@zcode/dynamic-workflow";

/** Terminal-state view exposing only the two keys lineage needs; both the registry entry's `terminal` and journal rows satisfy it. */
interface SupersedableSettlement {
  status: RunStatus;
  supersededBy?: string;
}

/**
 * Successor pointer: in-memory terminal state first, then journal rows; meaningful only for stopped(superseded) -- on other
 * states the key reads as absent even if the payload carries it (should not happen), so a completed run is never drawn as "superseded".
 */
export function supersededByOf(
  entry: { terminal?: SupersedableSettlement } | undefined,
  record: { status?: RunStatus; supersededBy?: string } | undefined,
): string | undefined {
  if (entry?.terminal !== undefined) {
    return entry.terminal.status === "stopped" ? entry.terminal.supersededBy : undefined;
  }
  return record?.status === "stopped" ? record.supersededBy : undefined;
}

/** Present only when both pointers exist (absent reads as "no such end"; `undefined` values would add noise keys to every row). */
export function lineageFields(
  resumedFrom: string | undefined,
  supersededBy: string | undefined,
): { resumedFrom?: string; supersededBy?: string } {
  return {
    ...(resumedFrom === undefined ? {} : { resumedFrom }),
    ...(supersededBy === undefined ? {} : { supersededBy }),
  };
}
