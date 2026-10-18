/* eslint-disable max-lines -- Windows process-tree cleanup concentrates cross-phase safety bounds and deadlines */
import type { ChildProcess } from "node:child_process";
import {
  captureProcessGroupSnapshot,
  captureExitedRootDescendantsSnapshot,
} from "#src/process/processTreeSnapshot.js";
import {
  captureExitedRootDescendantsSnapshotAsync,
  captureProcessTreeSnapshotAsync,
  verifyWindowsProcessIdentityAsync,
} from "#src/process/processTreeSnapshotAsync.js";
import {
  resolveCurrentOwnedIdentities,
  resolveCurrentOwnedIdentitiesAsync,
} from "#src/process/processTreeOwnership.js";
import { waitForProcessTreeTermination } from "#src/process/processTreeWaiter.js";
import { defaultWindowsTaskkillRunner } from "#src/process/windowsTaskkillRunner.js";
import type {
  ProcessIdentity,
  ProcessTreeOwnershipResolution,
  ProcessTreeTerminationResult,
  ProcessTreeTerminatorOptions,
  ProcessTreeTerminatorWaitOptions,
} from "#src/process/processTreeTypes.js";

export {
  captureProcessGroupSnapshot,
  captureExitedRootDescendantsSnapshot,
  captureProcessTreeSnapshot,
} from "#src/process/processTreeSnapshot.js";
export {
  captureExitedRootDescendantsSnapshotAsync,
  captureProcessTreeSnapshotAsync,
  filterCurrentProcessIdentitiesAsync,
} from "#src/process/processTreeSnapshotAsync.js";
export type {
  ProcessIdentity,
  ProcessTreeSnapshot,
  ProcessTreeTerminationResult,
  ProcessTreeTerminatorLogger,
  ProcessTreeTerminatorOptions,
  ProcessTreeTerminatorWaitOptions,
  WindowsTaskkillRequest,
  WindowsTaskkillResult,
  WindowsTaskkillRunner,
} from "#src/process/processTreeTypes.js";

const POSIX_TERMINATION_SIGNAL = "SIGTERM";
const POSIX_FORCE_SIGNAL = "SIGKILL";
const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;
const WINDOWS_FORCE_IDENTITY_RECHECK_BUDGET_MS = 750;
const DEFAULT_FORCE_AFTER_MS = 2_000;

interface InternalProcessTreeTerminatorOptions extends ProcessTreeTerminatorOptions {
  knownIdentities?: readonly ProcessIdentity[];
  onForceCleanup?: (result: ForceCleanupResult) => void;
  onForceTimerScheduled?: (timer: ReturnType<typeof setTimeout>) => void;
  onGracefulCleanupScheduled?: (flight: Promise<void>) => void;
  resolvedOwnership?: ProcessTreeOwnershipResolution;
  /** Identity query failed: observe the original ChildProcess only, never taskkill a bare PID. */
  unverifiedRootOnly?: boolean;
}

interface ForceCleanupResult {
  identities: ProcessIdentity[];
  unverifiedRootPid?: number;
}

export function shouldSpawnInDetachedProcessGroup(): boolean {
  return process.platform !== "win32";
}

function warn(options: ProcessTreeTerminatorOptions, message: string, ...args: unknown[]): void {
  options.log?.warn(options.traceId, message, ...args);
}

function debug(options: ProcessTreeTerminatorOptions, message: string, ...args: unknown[]): void {
  options.log?.debug?.(options.traceId, message, ...args);
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isMissingProcessError(error: unknown): boolean {
  return getErrorCode(error) === "ESRCH";
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function scheduleForceCleanup(
  callback: () => void,
  timeoutMs: number,
  keepTimerRef: boolean,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, Math.max(timeoutMs, 0));
  if (!keepTimerRef) {
    timer.unref();
  }
  return timer;
}

function killPid(
  pid: number,
  signal: NodeJS.Signals,
  options: ProcessTreeTerminatorOptions,
): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (!isMissingProcessError(error)) {
      warn(options, `Failed to signal runtime process pid=${pid} signal=${signal}:`, error);
    }
    return false;
  }
}

function killPosixProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  options: ProcessTreeTerminatorOptions,
): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (!isMissingProcessError(error)) {
      warn(options, `Failed to signal runtime process group pgid=${pid} signal=${signal}:`, error);
    }
    return false;
  }
}

async function runWindowsTaskkill(
  pid: number,
  force: boolean,
  options: ProcessTreeTerminatorOptions,
): Promise<void> {
  const timeoutMs = Math.max(options.windowsTaskkillTimeoutMs ?? WINDOWS_TASKKILL_TIMEOUT_MS, 1);
  const runner = options.windowsTaskkillRunner ?? defaultWindowsTaskkillRunner;
  const startedAt = Date.now();
  debug(options, "Windows runtime process tree taskkill started", { force, pid, timeoutMs });
  let result;
  try {
    result = await runner({ force, pid, timeoutMs });
  } catch (error) {
    result = { error };
  }
  debug(options, "Windows runtime process tree taskkill completed", {
    durationMs: Date.now() - startedAt,
    force,
    pid,
    success: !result.error,
  });
  if (result.error && isPidAlive(pid)) {
    warn(
      options,
      `${force ? "force" : "graceful"} runtime process tree exit failed pid=${pid} status=${String(
        typeof result.error === "object" && result.error !== null && "code" in result.error
          ? ((result.error as { code?: unknown }).code ?? "unknown")
          : "unknown",
      )}:`,
      result.error,
      result.stderr,
    );
  }
}

async function forceTerminateWindowsProcessTree(
  child: ChildProcess,
  knownIdentities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
  verifiedOwnership?: ProcessTreeOwnershipResolution,
  deadlineSnapshotOnly = false,
  deadlineVerifiedIdentities: readonly ProcessIdentity[] = [],
): Promise<ForceCleanupResult> {
  const { childStillOwned, currentIdentities } =
    verifiedOwnership ??
    (await resolveCurrentOwnedIdentitiesAsync(child, knownIdentities, options, false));
  // Neither the old snapshot nor a late Node exitCode proves the PID is still the same tree at deadline;
  // the deadline path only force-kills roots/descendants whose CreationDate reverified inside the
  // reserved window; failed identities go to the waiter for leftover reporting, never /F targets.
  const targets = new Set(
    deadlineSnapshotOnly
      ? deadlineVerifiedIdentities.map((identity) => identity.pid)
      : currentIdentities.map((identity) => identity.pid),
  );
  const unverifiedRootOnly = (options as InternalProcessTreeTerminatorOptions).unverifiedRootOnly;
  if (childStillOwned && child.pid != null && !unverifiedRootOnly && !deadlineSnapshotOnly) {
    targets.add(child.pid);
  }
  // A timed-out targeted CIM recheck must not leave a handle-held root leftover forever:
  // a live handle proves the root; taskkill /T targets that root only, claiming no new PIDs.
  if (
    deadlineSnapshotOnly &&
    !unverifiedRootOnly &&
    child.pid != null &&
    typeof child.kill === "function" &&
    child.exitCode === null &&
    child.signalCode === null &&
    isPidAlive(child.pid)
  ) {
    targets.add(child.pid);
  }
  await Promise.all([...targets].map((targetPid) => runWindowsTaskkill(targetPid, true, options)));
  const hasVerifiedRoot = currentIdentities.some((identity) => identity.pid === child.pid);
  return {
    identities: currentIdentities,
    ...(childStillOwned && !hasVerifiedRoot ? { unverifiedRootPid: child.pid } : {}),
  };
}

function terminateWindowsProcessTreeWithOwnership(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions,
  ownership: ProcessTreeOwnershipResolution,
  startedAtMs: number,
): void {
  const pid = child.pid!;
  const internalOptions = options as InternalProcessTreeTerminatorOptions;
  const childHandleOwnsLiveRoot =
    !internalOptions.unverifiedRootOnly &&
    typeof child.kill === "function" &&
    child.exitCode === null &&
    child.signalCode === null &&
    isPidAlive(pid);
  const gracefulTargets =
    ownership.childStillOwned && !internalOptions.unverifiedRootOnly
      ? [pid]
      : ownership.currentIdentities.map((identity) => identity.pid);
  // CIM can exceed one cleanup deadline under load, but a live ChildProcess handle still proves
  // the root belongs to this host; allow root /T as the safe fallback, widened only to that
  // handle's live process, never bare-PID rediscovery.
  if (gracefulTargets.length === 0 && childHandleOwnsLiveRoot) gracefulTargets.push(pid);
  const gracefulFlight = Promise.all(
    [...new Set(gracefulTargets)].map((targetPid) => runWindowsTaskkill(targetPid, false, options)),
  ).then(() => undefined);
  // Awaiting cleanup used to fire graceful taskkill and wait only for the force window; a late
  // taskkill callback/ChildProcess exit then misreports a clean exit as remaining PID.
  // Fire-and-forget stays unawaited; the awaiting waiter folds the flight into its completion barrier.
  internalOptions.onGracefulCleanupScheduled?.(gracefulFlight);
  void gracefulFlight;
  const forceDelayMs = Math.max(
    (options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS) - (Date.now() - startedAtMs),
    0,
  );
  const identitiesToRecheck = ownership.currentIdentities.filter(
    (identity) => !internalOptions.unverifiedRootOnly || identity.pid !== pid,
  );
  const canRecheckIdentitiesWithinDeadline =
    identitiesToRecheck.length > 0 && forceDelayMs >= WINDOWS_FORCE_IDENTITY_RECHECK_BUDGET_MS;
  const forceTimer = scheduleForceCleanup(
    () => {
      // Non-awaiting shutdown injectes no observation callback; force-reclaim must run standalone,
      // not as an optional-call argument (unevaluated when the callback is missing).
      void (async () => {
        // Killing the reverified root alone is not enough: if graceful /T fails or descendants get
        // reparented, known MCP/runtime descendants never get a force flight. Reverify all known
        // identities concurrently inside the pre-reserved force budget - no extra deadline; only
        // CreationDate-matching PIDs enter /F, query failure stays fail-closed.
        const deadlineVerifiedIdentities = canRecheckIdentitiesWithinDeadline
          ? (
              await Promise.all(
                identitiesToRecheck.map(async (identity) =>
                  (await verifyWindowsProcessIdentityAsync(
                    identity,
                    WINDOWS_FORCE_IDENTITY_RECHECK_BUDGET_MS,
                    options,
                  ))
                    ? identity
                    : undefined,
                ),
              )
            ).filter((identity): identity is ProcessIdentity => identity !== undefined)
          : [];
        return await forceTerminateWindowsProcessTree(
          child,
          ownership.knownIdentities,
          options,
          ownership,
          true,
          deadlineVerifiedIdentities,
        );
      })().then((result) => internalOptions.onForceCleanup?.(result));
    },
    canRecheckIdentitiesWithinDeadline
      ? forceDelayMs - WINDOWS_FORCE_IDENTITY_RECHECK_BUDGET_MS
      : forceDelayMs,
    Boolean(options.keepForceTimerRef),
  );
  internalOptions.onForceTimerScheduled?.(forceTimer);
}

function terminateWindowsProcessTree(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions,
): void {
  const internalOptions = options as InternalProcessTreeTerminatorOptions;
  const startedAtMs = Date.now();
  if (internalOptions.resolvedOwnership) {
    terminateWindowsProcessTreeWithOwnership(
      child,
      options,
      internalOptions.resolvedOwnership,
      startedAtMs,
    );
    return;
  }
  void resolveCurrentOwnedIdentitiesAsync(
    child,
    internalOptions.knownIdentities ?? [],
    options,
  ).then((ownership) => {
    terminateWindowsProcessTreeWithOwnership(child, options, ownership, startedAtMs);
  });
}

function forceTerminatePosixProcessTree(
  child: ChildProcess,
  knownIdentities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
): ForceCleanupResult {
  const pid = child.pid!;
  const { childStillOwned, currentIdentities } = resolveCurrentOwnedIdentities(
    child,
    knownIdentities,
    options,
    false,
  );
  const canSignalOwnedGroup =
    childStillOwned || currentIdentities.some((identity) => identity.processGroupId === pid);
  if (canSignalOwnedGroup) {
    killPosixProcessGroup(pid, POSIX_FORCE_SIGNAL, options);
  }
  for (const identity of currentIdentities.toReversed()) {
    if (identity.pid !== pid) {
      killPid(identity.pid, POSIX_FORCE_SIGNAL, options);
    }
  }
  if (!canSignalOwnedGroup) {
    const rootIdentity = currentIdentities.find((identity) => identity.pid === pid);
    if (rootIdentity) {
      killPid(rootIdentity.pid, POSIX_FORCE_SIGNAL, options);
    }
  }
  const hasVerifiedRoot = currentIdentities.some((identity) => identity.pid === pid);
  return {
    identities: currentIdentities,
    ...(childStillOwned && !hasVerifiedRoot ? { unverifiedRootPid: pid } : {}),
  };
}

function terminatePosixProcessTree(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions,
): void {
  const pid = child.pid!;
  const internalOptions = options as InternalProcessTreeTerminatorOptions;
  const ownership =
    internalOptions.resolvedOwnership ??
    resolveCurrentOwnedIdentities(child, internalOptions.knownIdentities ?? [], options);
  const canSignalOwnedGroup =
    ownership.childStillOwned ||
    ownership.currentIdentities.some((identity) => identity.processGroupId === pid);
  const signaledProcessGroup = canSignalOwnedGroup
    ? killPosixProcessGroup(pid, POSIX_TERMINATION_SIGNAL, options)
    : false;

  // Detached runtime/MCP descendants live outside the root group; signal only pre-mortem members
  // whose creation identity still matches, so delayed reclaim cannot kill a reused PID's new process.
  for (const identity of ownership.currentIdentities) {
    if (identity.pid !== pid) {
      killPid(identity.pid, POSIX_TERMINATION_SIGNAL, options);
    }
  }
  if (!signaledProcessGroup && ownership.childStillOwned) {
    killPid(pid, POSIX_TERMINATION_SIGNAL, options);
  }

  const forceTimer = scheduleForceCleanup(
    () => {
      // Non-awaiting shutdown injectes no observation callback; force-reclaim must run standalone,
      // not as an optional-call argument (unevaluated when the callback is missing).
      const result = forceTerminatePosixProcessTree(child, ownership.knownIdentities, options);
      internalOptions.onForceCleanup?.(result);
    },
    options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS,
    Boolean(options.keepForceTimerRef),
  );
  internalOptions.onForceTimerScheduled?.(forceTimer);
}

export function terminateProcessTree(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions = {},
): void {
  if (child.pid == null) {
    // Test doubles or very early spawn failures may have no pid:
    // no group/tree fallback exists, so keep the legacy child.kill() semantics.
    try {
      child.kill(POSIX_TERMINATION_SIGNAL);
    } catch (error) {
      warn(options, "Failed to signal runtime process pid=unknown:", error);
    }
    return;
  }

  if (process.platform === "win32") {
    terminateWindowsProcessTree(child, options);
    return;
  }
  terminatePosixProcessTree(child, options);
}

export async function terminateProcessTreeAndWait(
  child: ChildProcess,
  options: ProcessTreeTerminatorWaitOptions = {},
): Promise<ProcessTreeTerminationResult> {
  if (child.pid == null) return { remainingPids: [] };
  const cleanupSnapshot =
    options.snapshot?.rootPid === child.pid
      ? options.snapshot
      : options.ownedProcessGroupId === child.pid
        ? captureProcessGroupSnapshot(options.ownedProcessGroupId, options)
        : process.platform === "win32"
          ? await captureExitedRootDescendantsSnapshotAsync(child.pid, options)
          : captureExitedRootDescendantsSnapshot(child.pid, options);
  const snapshotIdentities = cleanupSnapshot?.identities ?? [];
  const identityVerificationUnavailable = cleanupSnapshot?.identityVerification === "unavailable";
  // The fresh async snapshot pins Windows creation identity, avoiding a costly duplicate CIM query
  // before EOF; force still reverifies asynchronously against PID reuse.
  const initialOwnership =
    process.platform === "win32" &&
    cleanupSnapshot &&
    child.exitCode === null &&
    child.signalCode === null
      ? {
          // Query failure is not process death: keep the unverified root for waiter observation within
          // the bounded budget, reporting failure via remainingPids while alive.
          childStillOwned:
            identityVerificationUnavailable ||
            snapshotIdentities.some((identity) => identity.pid === child.pid),
          currentIdentities: [...snapshotIdentities],
          knownIdentities: [...snapshotIdentities],
        }
      : await resolveCurrentOwnedIdentitiesAsync(child, snapshotIdentities, options);
  return await waitForProcessTreeTermination(
    child,
    identityVerificationUnavailable
      ? ({ ...options, unverifiedRootOnly: true } as ProcessTreeTerminatorWaitOptions)
      : options,
    initialOwnership,
    // With identity lookup failed and no verified identity, terminator graceful/force targets are
    // empty. Reserve command timeout for taskkill flights only when real targets exist; keep the
    // full budget otherwise, never shrinking boundaries on promise settle states.
    initialOwnership.currentIdentities.length > 0 ||
      (!identityVerificationUnavailable && initialOwnership.childStillOwned),
    terminateProcessTree,
  );
}
