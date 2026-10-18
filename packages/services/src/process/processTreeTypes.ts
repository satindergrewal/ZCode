import type { TraceId } from "@zcode/shared";

export interface ProcessTreeTerminatorLogger {
  debug?: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  warn: (traceId: TraceId | undefined, ...args: unknown[]) => void;
}

export interface WindowsTaskkillRequest {
  force: boolean;
  pid: number;
  timeoutMs: number;
}

export interface WindowsTaskkillResult {
  error?: unknown;
  stderr?: string;
}

export type WindowsTaskkillRunner = (
  request: WindowsTaskkillRequest,
) => Promise<WindowsTaskkillResult>;

export interface ProcessTreeTerminatorOptions {
  traceId?: TraceId;
  log?: ProcessTreeTerminatorLogger;
  forceAfterMs?: number;
  keepForceTimerRef?: boolean;
  /** POSIX process group owned by the host spawn(detached=true); cleanup-boundary use only. */
  ownedProcessGroupId?: number;
  /** Windows host spawn time; with exit time it bounds post-exit descendant ownership. */
  ownedProcessStartedAtMs?: number;
  /** Windows time the root was observed exited; never claim descendants created after PID reuse. */
  ownedProcessExitedAtMs?: number;
  /** Real exit time from the managed ChildProcess, read when the async query completes. */
  resolveOwnedProcessExitedAtMs?: () => number | undefined;
  /** Windows taskkill injection; prod keeps async execFile, tests may swap for determinism. */
  windowsTaskkillRunner?: WindowsTaskkillRunner;
  /** Per-command taskkill budget; 2s default, shorter in tests. */
  windowsTaskkillTimeoutMs?: number;
  /** Absolute Windows cleanup deadline (unix ms) across snapshot/EOF/taskkill/exit observation. */
  windowsCleanupDeadlineAtMs?: number;
}

export interface ProcessIdentity {
  parentPid: number;
  pid: number;
  processGroupId?: number;
  startTime: string;
}

export interface ProcessTreeOwnershipResolution {
  childStillOwned: boolean;
  currentIdentities: ProcessIdentity[];
  knownIdentities: ProcessIdentity[];
}

export interface ProcessTreeTerminationResult {
  remainingPids: number[];
}

export interface ProcessTreeSnapshot {
  rootPid: number;
  descendantPids: readonly number[];
  identities: readonly ProcessIdentity[];
  /** On Windows table-query failure, empty identities do not mean the tree exited. */
  identityVerification?: "verified" | "unavailable";
}

export interface ProcessTreeTerminatorWaitOptions extends ProcessTreeTerminatorOptions {
  snapshot?: ProcessTreeSnapshot;
  waitAfterForceMs?: number;
}
