import type { ChildProcess } from "node:child_process";
import type {
  ProcessIdentity,
  ProcessTreeOwnershipResolution,
  ProcessTreeTerminationResult,
  ProcessTreeTerminatorOptions,
  ProcessTreeTerminatorWaitOptions,
} from "#src/process/processTreeTypes.js";

const DEFAULT_FORCE_AFTER_MS = 2_000;
const DEFAULT_WAIT_AFTER_FORCE_MS = 250;
const DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;
const WINDOWS_LATE_EXIT_OBSERVATION_MS = 750;

interface WaitInternalOptions extends ProcessTreeTerminatorWaitOptions {
  knownIdentities?: readonly ProcessIdentity[];
  onForceCleanup?: (result: ForceCleanupResult) => void;
  onForceTimerScheduled?: (timer: ReturnType<typeof setTimeout>) => void;
  onGracefulCleanupScheduled?: (flight: Promise<void>) => void;
  resolvedOwnership?: ProcessTreeOwnershipResolution;
}

interface ForceCleanupResult {
  identities: ProcessIdentity[];
  unverifiedRootPid?: number;
}

type TerminateProcessTree = (child: ChildProcess, options: ProcessTreeTerminatorOptions) => void;

function warn(options: ProcessTreeTerminatorWaitOptions, message: string): void {
  options.log?.warn(options.traceId, message);
}

function debug(
  options: ProcessTreeTerminatorWaitOptions,
  message: string,
  context?: Record<string, unknown>,
): void {
  options.log?.debug?.(options.traceId, message, context);
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessTreeTermination(
  child: ChildProcess,
  options: ProcessTreeTerminatorWaitOptions,
  initialOwnership: ProcessTreeOwnershipResolution,
  hasWindowsTaskkillTargets: boolean,
  terminateProcessTree: TerminateProcessTree,
): Promise<ProcessTreeTerminationResult> {
  if (child.pid == null) {
    return { remainingPids: [] };
  }

  const waiterStartedAtMs = Date.now();
  const forceAfterMs = Math.max(options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS, 0);
  const waitAfterForceMs = Math.max(options.waitAfterForceMs ?? DEFAULT_WAIT_AFTER_FORCE_MS, 0);
  const isWindows = process.platform === "win32";
  const windowsTaskkillBudgetMs = hasWindowsTaskkillTargets
    ? Math.max(options.windowsTaskkillTimeoutMs ?? DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS, 1)
    : 0;
  // Windows graceful taskkill races the force timer; while any verified signal target exists, keep
  // one terminal taskkill budget. With no identity and no targets both taskkill flights are empty,
  // and reserving command timeouts would just idle the host.
  const windowsRelativeDeadlineMs = forceAfterMs + windowsTaskkillBudgetMs + waitAfterForceMs;
  const windowsTransportDeadlineRemainingMs =
    options.windowsCleanupDeadlineAtMs === undefined
      ? windowsRelativeDeadlineMs
      : Math.max(options.windowsCleanupDeadlineAtMs - waiterStartedAtMs, 0);
  // With transport-only force decrements, a slow CIM exhausting the 2s force window lets the
  // waiter re-add full taskkill+exit grace and blow the host 3.5s phase. Clamp waiter-relative
  // boundaries to the absolute deadline fixed at cleanup start; decrements come only from
  // measured wall-clock consumption, never promise settle states.
  // The final retry without verifiable identity has no taskkill target; do not compress the
  // remaining observation budget to waitAfterForceMs (250ms in prod) or a later code=0 exit
  // reads as a permanent leftover. No bare-PID signals here; keep observing inside the deadline -
  // the 750ms cap keeps this path plus the first 3.25s cleanup under the 4s force point.
  const windowsObservationDeadlineMs = Math.max(
    windowsRelativeDeadlineMs,
    WINDOWS_LATE_EXIT_OBSERVATION_MS,
  );
  const windowsCleanupDeadlineMs =
    !hasWindowsTaskkillTargets && options.windowsCleanupDeadlineAtMs !== undefined
      ? Math.min(windowsObservationDeadlineMs, windowsTransportDeadlineRemainingMs)
      : Math.min(windowsRelativeDeadlineMs, windowsTransportDeadlineRemainingMs);
  const knownIdentities = initialOwnership.knownIdentities;

  // Root child exit does not mean detached MCP exited; wait boundaries use the pre-mortem snapshot only.
  // Force callbacks replace the tracked set with reverified identities; never wait/reclaim bare PIDs.
  return await new Promise<ProcessTreeTerminationResult>((resolve) => {
    let settled = false;
    let trackedIdentities = initialOwnership.currentIdentities;
    let unverifiedRootPid =
      initialOwnership.childStillOwned &&
      !trackedIdentities.some((identity) => identity.pid === child.pid)
        ? child.pid
        : undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let forceWaitTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let treePollTimer: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      child.off?.("exit", onExit);
      if (forceTimer) clearTimeout(forceTimer);
      if (forceWaitTimer) clearTimeout(forceWaitTimer);
      if (cleanupDeadlineTimer) clearTimeout(cleanupDeadlineTimer);
      if (treePollTimer) clearInterval(treePollTimer);
      forceTimer = undefined;
      forceWaitTimer = undefined;
      cleanupDeadlineTimer = undefined;
      treePollTimer = undefined;
    };
    const settle = (remainingPids: number[] = []) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ remainingPids });
    };
    const settleIfTreeExited = () => {
      const hasRunningVerifiedProcess = trackedIdentities.some((identity) =>
        isPidAlive(identity.pid),
      );
      const hasRunningUnverifiedRoot =
        unverifiedRootPid !== undefined && !hasChildExited(child) && isPidAlive(unverifiedRootPid);
      if (!hasRunningVerifiedProcess && !hasRunningUnverifiedRoot) {
        // The Windows taskkill callback can beat the Node ChildProcess exit event.
        // Wait one more exit delivery once the OS PID is gone so transport/lifecycle do not see
        // stale state after the cleanup promise resolves; a lost exit still resolves at the deadline.
        if (isWindows && !hasChildExited(child)) return;
        settle();
      }
    };
    const startTreePolling = () => {
      if (!treePollTimer && !settled) {
        treePollTimer = setInterval(settleIfTreeExited, 25);
      }
    };
    const collectRemainingPids = (): number[] => {
      const remainingPids = trackedIdentities
        .filter((identity) => isPidAlive(identity.pid))
        .map((identity) => identity.pid);
      if (
        unverifiedRootPid !== undefined &&
        !hasChildExited(child) &&
        isPidAlive(unverifiedRootPid)
      ) {
        remainingPids.push(unverifiedRootPid);
      }
      return remainingPids;
    };
    const onExit = () => {
      unverifiedRootPid = undefined;
      // A sync CIM refresh inside the exit callback would block the host deadline again;
      // only observe pinned-identity PID liveness here; force still reverifies creation identity.
      settleIfTreeExited();
      if (!settled) startTreePolling();
    };
    const scheduleForceWait = () => {
      if (forceWaitTimer || settled) return;
      if (waitAfterForceMs === 0) {
        settle(collectRemainingPids());
        return;
      }
      forceWaitTimer = setTimeout(() => {
        const remainingPids = collectRemainingPids();
        if (remainingPids.length > 0) {
          warn(options, `runtime process tree still has leftovers after force reclaim pid=${remainingPids.join(",")}`);
        }
        settle(remainingPids);
      }, waitAfterForceMs);
    };
    const scheduleWindowsCleanupDeadline = () => {
      if (!isWindows || cleanupDeadlineTimer || settled) return;
      debug(options, "Windows runtime process tree cleanup deadline scheduled", {
        forceAfterMs,
        hasWindowsTaskkillTargets,
        waitAfterForceMs,
        windowsRelativeDeadlineMs,
        windowsTaskkillBudgetMs,
        windowsCleanupDeadlineMs,
        windowsCleanupDeadlineAtMs: options.windowsCleanupDeadlineAtMs,
      });
      cleanupDeadlineTimer = setTimeout(() => {
        const remainingPids = collectRemainingPids();
        if (remainingPids.length > 0) {
          warn(options, `runtime process tree leftovers past the absolute deadline pid=${remainingPids.join(",")}`);
        }
        settle(remainingPids);
      }, windowsCleanupDeadlineMs);
    };
    const onForceCleanup = (result: ForceCleanupResult) => {
      debug(options, "Windows runtime process tree force cleanup completed", {
        trackedPids: result.identities.map((identity) => identity.pid),
        unverifiedRootPid: result.unverifiedRootPid,
      });
      // Replace, never merge: stale snapshot identities would misread new processes as leftovers
      // and lose process-ownership semantics for waiting/logging.
      trackedIdentities = result.identities;
      unverifiedRootPid = result.unverifiedRootPid;
      settleIfTreeExited();
      if (!settled) {
        startTreePolling();
        if (!isWindows) scheduleForceWait();
      }
    };

    child.once("exit", onExit);
    const waitOptions: WaitInternalOptions = {
      ...options,
      forceAfterMs,
      keepForceTimerRef: true,
      knownIdentities,
      resolvedOwnership: initialOwnership,
      onForceCleanup,
      onForceTimerScheduled: (timer) => {
        forceTimer = timer;
      },
      onGracefulCleanupScheduled: (flight) => {
        // The runner has its own timeout and runWindowsTaskkill normalizes rejections; either way,
        // re-observe OS/ChildProcess facts after the flight settles; the deadline decides failure.
        void flight.then(() => {
          debug(options, "Windows runtime process tree graceful cleanup flight settled");
          settleIfTreeExited();
          if (!settled) startTreePolling();
        });
      },
    };
    scheduleWindowsCleanupDeadline();
    terminateProcessTree(child, waitOptions);

    settleIfTreeExited();
    if (!settled && hasChildExited(child)) {
      startTreePolling();
    }
  });
}
