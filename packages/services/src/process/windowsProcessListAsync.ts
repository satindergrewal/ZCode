import { execFile } from "node:child_process";
import type {
  ProcessIdentity,
  ProcessTreeTerminatorOptions,
} from "#src/process/processTreeTypes.js";

const WINDOWS_PROCESS_LOOKUP_TIMEOUT_MS = 2_500;
const DOTNET_UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;
const TICKS_PER_MICROSECOND = 10n;
const WINDOWS_START_TIME_PREFIX = "windows-utc-us:";

type WindowsCimCapability = "cim" | "identity-unavailable";

interface WindowsProcessListFlight {
  promise: Promise<readonly ProcessIdentity[]>;
  startedAtMs: number;
}

let windowsProcessListInFlight: WindowsProcessListFlight | undefined;
let windowsCimCapability: WindowsCimCapability | undefined;

function isHardCimUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

function remainingWindowsCleanupMs(options: ProcessTreeTerminatorOptions): number | undefined {
  return options.windowsCleanupDeadlineAtMs === undefined
    ? undefined
    : Math.max(options.windowsCleanupDeadlineAtMs - Date.now(), 0);
}

function boundedWindowsLookupTimeoutMs(
  defaultTimeoutMs: number,
  options: ProcessTreeTerminatorOptions,
): number {
  const remainingMs = remainingWindowsCleanupMs(options);
  return remainingMs === undefined
    ? defaultTimeoutMs
    : Math.max(Math.min(defaultTimeoutMs, remainingMs), 0);
}

async function awaitWindowsProcessListWithinDeadline(
  request: Promise<readonly ProcessIdentity[]>,
  options: ProcessTreeTerminatorOptions,
): Promise<readonly ProcessIdentity[]> {
  const remainingMs = remainingWindowsCleanupMs(options);
  if (remainingMs === undefined) return await request;
  if (remainingMs <= 0) return [];

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<readonly ProcessIdentity[]>((resolve) => {
        deadlineTimer = setTimeout(() => resolve([]), remainingMs);
      }),
    ]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

function warn(options: ProcessTreeTerminatorOptions, message: string, ...args: unknown[]): void {
  options.log?.warn(options.traceId, message, ...args);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseWindowsProcessList(stdout: string): ProcessIdentity[] {
  const identities: ProcessIdentity[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [pidText, parentPidText, rawStartTime] = line.trim().split(/\s+/);
    const pid = parsePositiveInteger(pidText);
    const parentPid = parseNonNegativeInteger(parentPidText);
    const startTime = normalizePowerShellStartTime(rawStartTime);
    if (pid === undefined || parentPid === undefined || !startTime) continue;
    identities.push({ parentPid, pid, startTime });
  }
  return identities;
}

function normalizePowerShellStartTime(rawStartTime: string | undefined): string | undefined {
  if (!rawStartTime) return undefined;
  try {
    const unixMicroseconds =
      (BigInt(rawStartTime) - DOTNET_UNIX_EPOCH_TICKS) / TICKS_PER_MICROSECOND;
    return `${WINDOWS_START_TIME_PREFIX}${unixMicroseconds}`;
  } catch {
    return undefined;
  }
}

export async function verifyWindowsProcessIdentityAsync(
  identity: ProcessIdentity,
  timeoutMs: number,
  options: ProcessTreeTerminatorOptions = {},
): Promise<boolean> {
  if (process.platform !== "win32" || timeoutMs <= 0) return false;
  if (windowsCimCapability === "identity-unavailable") return false;
  // Windows 11 24H2 and some Win10 images dropped WMIC; Windows 10+ uses PowerShell/CIM, and a failed
  // query stays creation-unverified - never force-kill past the identity check.
  return await new Promise<boolean>((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ProcessId = ${identity.pid}" | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().Ticks }`,
      ],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error || !stdout) {
          if (isHardCimUnavailable(error)) windowsCimCapability = "identity-unavailable";
          warn(
            options,
            `Windows root identity PowerShell recheck failed pid=${identity.pid}:`,
            error ?? stderr,
          );
          resolve(false);
          return;
        }
        const current = parseWindowsProcessList(stdout).find(
          (processIdentity) => processIdentity.pid === identity.pid,
        );
        windowsCimCapability = "cim";
        resolve(current?.startTime === identity.startTime);
      },
    );
  });
}

export async function readWindowsProcessListAsync(
  options: ProcessTreeTerminatorOptions,
): Promise<readonly ProcessIdentity[]> {
  if (windowsCimCapability === "identity-unavailable") return [];
  const ownedProcessStartedAtMs = options.ownedProcessStartedAtMs;
  if (
    windowsProcessListInFlight &&
    (ownedProcessStartedAtMs === undefined ||
      ownedProcessStartedAtMs < windowsProcessListInFlight.startedAtMs)
  ) {
    return await awaitWindowsProcessListWithinDeadline(windowsProcessListInFlight.promise, options);
  }

  // Get-CimInstance can exceed 1s on some machines; awaiting synchronously would eat the host
  // exit deadline. Share one async query so multiple workspaces reuse a single system table;
  // a table from before a newer spawn degrades to unverified, so only queries strictly after
  // the root started are reusable.
  const startedAtMs = Date.now();
  const request = new Promise<readonly ProcessIdentity[]>((resolve) => {
    // Post-WMIC, go straight to the supported CIM backend (no ENOENT fallback burning cleanup
    // deadline); failure returns empty identities and callers keep fail-closed observation.
    const timeoutMs = boundedWindowsLookupTimeoutMs(WINDOWS_PROCESS_LOOKUP_TIMEOUT_MS, options);
    if (timeoutMs <= 0) {
      resolve([]);
      return;
    }

    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().Ticks }",
      ],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error || !stdout) {
          if (isHardCimUnavailable(error)) windowsCimCapability = "identity-unavailable";
          warn(
            options,
            "Failed to query the Windows runtime process table (async):",
            error ?? stderr,
          );
          resolve([]);
          return;
        }
        const identities = parseWindowsProcessList(stdout);
        if (identities.length === 0)
          warn(options, "PowerShell returned no parseable Windows runtime process table");
        if (identities.length > 0) windowsCimCapability = "cim";
        resolve(identities);
      },
    );
  }).finally(() => {
    if (windowsProcessListInFlight?.promise === request) windowsProcessListInFlight = undefined;
  });
  windowsProcessListInFlight = { promise: request, startedAtMs };
  return await awaitWindowsProcessListWithinDeadline(request, options);
}
