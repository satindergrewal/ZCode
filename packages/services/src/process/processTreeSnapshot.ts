import { spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type {
  ProcessIdentity,
  ProcessTreeSnapshot,
  ProcessTreeTerminatorOptions,
} from "#src/process/processTreeTypes.js";

const PROCESS_LOOKUP_TIMEOUT_MS = 1_000;
const DOTNET_UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;
const TICKS_PER_MILLISECOND = 10_000n;

let windowsProcessListCache: readonly ProcessIdentity[] | undefined;

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

function parsePosixProcessList(stdout: string, includeCommand: boolean): ProcessIdentity[] {
  const identities: ProcessIdentity[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const [pidText, parentPidText, processGroupIdText] = fields;
    const pid = parsePositiveInteger(pidText);
    const parentPid = parseNonNegativeInteger(parentPidText);
    const processGroupId = parsePositiveInteger(processGroupIdText);
    const lstart = fields.slice(3, 8).join(" ");
    const command = includeCommand ? fields.slice(8).join(" ") : "";
    // Darwin ps exposes only second-granularity lstart; the full command adds reuse-verification entropy.
    // Linux overrides it with /proc start ticks afterwards.
    const startTime = includeCommand ? `${lstart}|command:${command}` : lstart;
    if (pid === undefined || parentPid === undefined || !processGroupId || !startTime) {
      continue;
    }
    identities.push({ parentPid, pid, processGroupId, startTime });
  }
  return identities;
}

function parseWindowsProcessList(stdout: string): ProcessIdentity[] {
  const identities: ProcessIdentity[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [pidText, parentPidText, startTime] = line.trim().split(/\s+/);
    const pid = parsePositiveInteger(pidText);
    const parentPid = parseNonNegativeInteger(parentPidText);
    if (pid === undefined || parentPid === undefined || !startTime) {
      continue;
    }
    identities.push({ parentPid, pid, startTime });
  }
  return identities;
}

function parseWindowsCreationTimeMs(startTime: string): number | undefined {
  try {
    const unixTicks = BigInt(startTime) - DOTNET_UNIX_EPOCH_TICKS;
    const timestamp = Number(unixTicks / TICKS_PER_MILLISECOND);
    return Number.isSafeInteger(timestamp) ? timestamp : undefined;
  } catch {
    return undefined;
  }
}

function readPosixProcessList(options: ProcessTreeTerminatorOptions): ProcessIdentity[] {
  const includeCommand = process.platform === "darwin";
  const result = spawnSync(
    "ps",
    includeCommand
      ? ["-axo", "pid=,ppid=,pgid=,lstart=,command="]
      : ["-eo", "pid=,ppid=,pgid=,lstart="],
    {
      encoding: "utf8",
      timeout: PROCESS_LOOKUP_TIMEOUT_MS,
    },
  );
  if (result.error) {
    warn(options, "Failed to query runtime descendants (process table):", result.error);
    return [];
  }
  if (result.signal === "SIGTERM" || result.signal === "SIGKILL") {
    warn(
      options,
      `Failed to query runtime descendants (process table timeout) signal=${result.signal}`,
    );
    return [];
  }
  if (result.status !== 0 || !result.stdout) {
    warn(
      options,
      `Failed to query runtime descendants (process table) status=${result.status ?? "unknown"}`,
    );
    return [];
  }
  return parsePosixProcessList(result.stdout, includeCommand);
}

function readWindowsProcessList(options: ProcessTreeTerminatorOptions): readonly ProcessIdentity[] {
  if (windowsProcessListCache) {
    return windowsProcessListCache;
  }
  const result = spawnSync(
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
      timeout: PROCESS_LOOKUP_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || !result.stdout) {
    warn(
      options,
      `Failed to query the Windows runtime process table status=${result.status ?? "unknown"}:`,
      result.error ?? result.stderr,
    );
    return [];
  }
  const identities = parseWindowsProcessList(result.stdout);
  windowsProcessListCache = identities;
  // One app-quit round snapshots several workspaces; reuse one CreationDate-bearing system table and
  // invalidate it next microtask so a later restart/quit cannot misread PID reuse as an old process.
  queueMicrotask(() => {
    if (windowsProcessListCache === identities) {
      windowsProcessListCache = undefined;
    }
  });
  return identities;
}

function readProcessList(options: ProcessTreeTerminatorOptions): readonly ProcessIdentity[] {
  return process.platform === "win32"
    ? readWindowsProcessList(options)
    : readPosixProcessList(options);
}

function refineLinuxProcessIdentity(identity: ProcessIdentity): ProcessIdentity | undefined {
  if (process.platform !== "linux") {
    return identity;
  }
  try {
    const stat = readFileSync(`/proc/${identity.pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) {
      return undefined;
    }
    // /proc/<pid>/stat field 22 is start ticks since boot; finer than ps lstart seconds, so
    // same-second PID reuse cannot pass as an old runtime member.
    const fieldsAfterCommand = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    const parentPid = parseNonNegativeInteger(fieldsAfterCommand[1]);
    const processGroupId = parsePositiveInteger(fieldsAfterCommand[2]);
    const startTimeTicks = fieldsAfterCommand[19];
    if (
      parentPid === undefined ||
      !processGroupId ||
      !startTimeTicks ||
      parentPid !== identity.parentPid ||
      processGroupId !== identity.processGroupId
    ) {
      // PID reuse/reparent between the ps and /proc reads would fabricate a mixed identity.
      return undefined;
    }
    return {
      ...identity,
      parentPid,
      processGroupId,
      startTime: `linux-ticks:${startTimeTicks}`,
    };
  } catch {
    return undefined;
  }
}

function refineProcessIdentities(identities: readonly ProcessIdentity[]): ProcessIdentity[] {
  if (process.platform !== "linux") {
    return [...identities];
  }
  return identities
    .map((identity) => refineLinuxProcessIdentity(identity))
    .filter((identity): identity is ProcessIdentity => identity !== undefined);
}

function collectDescendantIdentitiesFromProcessList(
  rootPid: number,
  identities: readonly ProcessIdentity[],
): ProcessIdentity[] {
  const childrenByParentPid = new Map<number, ProcessIdentity[]>();
  for (const identity of identities) {
    const children = childrenByParentPid.get(identity.parentPid) ?? [];
    children.push(identity);
    childrenByParentPid.set(identity.parentPid, children);
  }

  const descendants: ProcessIdentity[] = [];
  const seen = new Set<number>([rootPid]);
  const visit = (pid: number) => {
    for (const child of childrenByParentPid.get(pid) ?? []) {
      if (seen.has(child.pid)) {
        continue;
      }
      seen.add(child.pid);
      descendants.push(child);
      visit(child.pid);
    }
  };
  visit(rootPid);
  return descendants;
}

export function filterCurrentProcessIdentities(
  identities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
): ProcessIdentity[] {
  if (identities.length === 0) {
    return [];
  }
  const trackedPids = new Set(identities.map((identity) => identity.pid));
  const currentByPid = new Map(
    refineProcessIdentities(
      readProcessList(options).filter((identity) => trackedPids.has(identity.pid)),
    ).map((identity) => [identity.pid, identity]),
  );
  return identities.filter((identity) => {
    const current = currentByPid.get(identity.pid);
    return (
      current?.startTime === identity.startTime &&
      (identity.processGroupId === undefined || current.processGroupId === identity.processGroupId)
    );
  });
}

export function captureProcessTreeSnapshot(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions = {},
): ProcessTreeSnapshot | undefined {
  if (child.pid == null) {
    return undefined;
  }
  const processList = readProcessList(options);
  const rootIdentity = processList.find((identity) => identity.pid === child.pid);
  if (!rootIdentity) {
    // A rootPid without creation identity cannot own a tree; a partial snapshot would let
    // delayed-reclaim re-claim an unrelated tree by bare PID after reuse.
    return undefined;
  }
  const descendantIdentities = collectDescendantIdentitiesFromProcessList(child.pid, processList);
  // A POSIX detached root leads its own process group; if it exits mid-scan its children get
  // reparented and a PPID-only walk misses members of the owned PGID. Merge same-group members
  // only when PGID == root PID, keeping ordinary host groups of children out of the snapshot.
  const ownedProcessGroupIdentities =
    process.platform !== "win32" && rootIdentity.processGroupId === child.pid
      ? processList.filter((identity) => identity.processGroupId === child.pid)
      : [];
  const snapshotCandidates = new Map(
    [rootIdentity, ...descendantIdentities, ...ownedProcessGroupIdentities].map((identity) => [
      identity.pid,
      identity,
    ]),
  );
  const identities = refineProcessIdentities([...snapshotCandidates.values()]);
  if (!identities.some((identity) => identity.pid === child.pid)) {
    return undefined;
  }
  return {
    rootPid: child.pid,
    descendantPids: identities
      .filter((identity) => identity.pid !== child.pid)
      .map((identity) => identity.pid),
    identities,
  };
}

export function captureProcessGroupSnapshot(
  processGroupId: number,
  options: ProcessTreeTerminatorOptions = {},
): ProcessTreeSnapshot | undefined {
  if (process.platform === "win32" || !Number.isInteger(processGroupId) || processGroupId <= 0) {
    return undefined;
  }
  // A detached agent root may exit before its same-group MCP/tools; PPID changes but the kernel
  // keeps the PGID until the last member exits. Query by the host-spawned PGID at the cleanup
  // boundary only, keeping process-table scans off the protocol hot path.
  const identities = refineProcessIdentities(
    readProcessList(options).filter((identity) => identity.processGroupId === processGroupId),
  );
  if (identities.length === 0) {
    return undefined;
  }
  return {
    rootPid: processGroupId,
    descendantPids: identities
      .filter((identity) => identity.pid !== processGroupId)
      .map((identity) => identity.pid),
    identities,
  };
}

export function captureExitedRootDescendantsSnapshot(
  rootPid: number,
  options: ProcessTreeTerminatorOptions = {},
): ProcessTreeSnapshot | undefined {
  const startedAtMs = options.ownedProcessStartedAtMs;
  const exitedAtMs = options.ownedProcessExitedAtMs;
  if (
    process.platform !== "win32" ||
    !Number.isInteger(rootPid) ||
    rootPid <= 0 ||
    typeof startedAtMs !== "number" ||
    !Number.isFinite(startedAtMs) ||
    typeof exitedAtMs !== "number" ||
    !Number.isFinite(exitedAtMs)
  ) {
    return undefined;
  }
  // Win32_Process keeps the creator ParentProcessId even after the CLI root exits; a bare PPID
  // would claim unrelated processes after PID reuse, so a candidate's CreationDate must also fall
  // inside the host-recorded root lifetime; the force phase rechecks the same CreationDate and
  // never signals a reused descendant PID.
  const processList = readProcessList(options).filter((identity) => {
    const createdAtMs = parseWindowsCreationTimeMs(identity.startTime);
    return createdAtMs !== undefined && createdAtMs >= startedAtMs && createdAtMs <= exitedAtMs;
  });
  const identities = collectDescendantIdentitiesFromProcessList(rootPid, processList);
  if (identities.length === 0) {
    return undefined;
  }
  return {
    rootPid,
    descendantPids: identities.map((identity) => identity.pid),
    identities,
  };
}
