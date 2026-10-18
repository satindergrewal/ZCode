// Run-history grouping and presentation.
// Attribution matches only `dwf_run.name === workflow name`; a run the model renamed belongs to no
// workflow rather than being guessed.
import type { ZCodeSavedWorkflowRun, ZCodeSavedWorkflowRunStatus } from "@zcode/shared";

/** The newest `updatedAt` row per name (the server sorts by time_updated desc; keep first sight only). */
export function lastRunByWorkflowName(
  runs: readonly ZCodeSavedWorkflowRun[],
): Map<string, ZCodeSavedWorkflowRun> {
  const byName = new Map<string, ZCodeSavedWorkflowRun>();
  const sorted = [...runs].sort((left, right) => right.updatedAt - left.updatedAt);
  for (const run of sorted) {
    if (run.name === undefined || byName.has(run.name)) continue;
    byName.set(run.name, run);
  }
  return byName;
}

type SavedWorkflowRunBadgeKind = "completed" | "errored" | "running" | "stopped" | "never";

/**
 * The card's "last run" badge: four states plus "never". pending renders as running.
 * Terminal vocabulary is errored/stopped; older CLIs may still send `failed`/`cancelled` — fold them
 * in by the same semantics instead of leaving the badge absent.
 */
export function savedWorkflowRunBadgeKind(
  status: ZCodeSavedWorkflowRunStatus | "errored" | "stopped" | "failed" | "cancelled" | undefined,
): SavedWorkflowRunBadgeKind {
  switch (status) {
    case undefined:
      return "never";
    case "pending":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "errored":
    case "failed":
      return "errored";
    case "stopped":
    case "cancelled":
      return "stopped";
  }
}

/** Run-history argument chips: `key=value`, values JSON-compacted. */
export function formatSavedWorkflowRunArgs(args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  return Object.entries(args).map(
    ([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
}

/** A run's duration (ms); non-terminal states count up to now. */
export function savedWorkflowRunDurationMs(run: ZCodeSavedWorkflowRun, now: number): number {
  const end = run.status === "pending" || run.status === "running" ? now : run.updatedAt;
  return Math.max(0, end - run.createdAt);
}

export function formatSavedWorkflowTokens(spent: number): string {
  if (!Number.isFinite(spent)) return "—";
  if (spent >= 1_000_000) return `${(spent / 1_000_000).toFixed(1)}M`;
  if (spent >= 1_000) return `${(spent / 1_000).toFixed(1)}k`;
  return String(Math.round(spent));
}
