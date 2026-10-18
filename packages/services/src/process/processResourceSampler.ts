import { execFile as nodeExecFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import os from "node:os";
import {
  formatZCodeAgentProcessName,
  type HostResourceUsageProcess,
  type ZCodeProcessChildProcess,
} from "@zcode/shared";

/**
 * Host-side sampler for the resource manager.
 *
 * Boundaries:
 * - runs only in the window host (utility process), one table read per resource-window request;
 *   main may not spawn external processes (sync ps/PowerShell once froze the whole app).
 * - attribute host descendants from the machine-wide table; plugin attribution via CLI process/childProcesses.
 * - CPU is machine-normalized percent (100 = all logical cores), differenced from two cputime samples.
 */

const POSIX_TABLE_TIMEOUT_MS = 3_000;
const WINDOWS_TABLE_TIMEOUT_MS = 5_000;
const TABLE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/** Linux /proc utime/stime are always USER_HZ=100, independent of kernel HZ. */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;
const WINDOWS_100NS_PER_MS = 10_000;
/** Drop a stale cputime baseline after this long unseen (PID-reuse guard) */
const CPU_BASELINE_TTL_MS = 60_000;

interface ProcessResourceRow {
  pid: number;
  ppid: number;
  rssKb: number;
  /** Cumulative CPU time (user+system), ms */
  cpuTimeMs: number;
  /** Command name or executable path (platform verbatim) */
  command: string;
}

type ProcessResourceTableReader = (
  signal?: AbortSignal,
) => Promise<ProcessResourceRow[] | undefined>;

interface ExecFileResult {
  error?: unknown;
  stdout: string;
}

type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; windowsHide?: boolean; signal?: AbortSignal },
) => Promise<ExecFileResult>;

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; windowsHide?: boolean; signal?: AbortSignal },
): Promise<ExecFileResult> {
  return new Promise((resolve) => {
    nodeExecFile(file, [...args], { ...options, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? { error, stdout: "" } : { stdout });
    });
  });
}

function parseNonNegativeInteger(text: string | undefined): number | undefined {
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Parses ps cputime: macOS [[dd-]hh:]mm:ss.cc, Linux [dd-]hh:mm:ss.
 * Returns ms, or undefined when unparseable.
 */
function parseCpuTimeText(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  let days = 0;
  let clock = trimmed;
  const dayIndex = trimmed.indexOf("-");
  if (dayIndex > 0) {
    days = Number(trimmed.slice(0, dayIndex));
    clock = trimmed.slice(dayIndex + 1);
    if (!Number.isInteger(days) || days < 0) return undefined;
  }
  const parts = clock.split(":");
  if (parts.length === 0 || parts.length > 3) return undefined;
  const seconds = Number(parts[parts.length - 1]);
  const minutes = parts.length >= 2 ? Number(parts[parts.length - 2]) : 0;
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (![seconds, minutes, hours].every((value) => Number.isFinite(value) && value >= 0)) {
    return undefined;
  }
  return Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000);
}

/** ps -axo pid=,ppid=,rss=,cputime=,comm= row; comm may contain spaces - first 4 fields then the rest */
function parseDarwinProcessTable(stdout: string): ProcessResourceRow[] {
  const rows: ProcessResourceRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = parseNonNegativeInteger(match[1]);
    const ppid = parseNonNegativeInteger(match[2]);
    const rssKb = parseNonNegativeInteger(match[3]);
    const cpuTimeMs = parseCpuTimeText(match[4] ?? "");
    if (pid === undefined || pid <= 0 || ppid === undefined || rssKb === undefined) continue;
    if (cpuTimeMs === undefined) continue;
    rows.push({ pid, ppid, rssKb, cpuTimeMs, command: (match[5] ?? "").trim() });
  }
  return rows;
}

/** Parses /proc/<pid>/stat: comm is parenthesized with spaces/parens; split at the last ) */
function parseLinuxProcStat(
  content: string,
): { pid: number; ppid: number; command: string; cpuTimeMs: number } | undefined {
  const open = content.indexOf("(");
  const close = content.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const pid = parseNonNegativeInteger(content.slice(0, open).trim());
  const command = content.slice(open + 1, close);
  const rest = content
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // rest[0]=state, rest[1]=ppid, ... rest[11]=utime, rest[12]=stime (raw fields 14/15)
  const ppid = parseNonNegativeInteger(rest[1]);
  const utime = parseNonNegativeInteger(rest[11]);
  const stime = parseNonNegativeInteger(rest[12]);
  if (
    pid === undefined ||
    pid <= 0 ||
    ppid === undefined ||
    utime === undefined ||
    stime === undefined
  ) {
    return undefined;
  }
  return {
    pid,
    ppid,
    command,
    cpuTimeMs: Math.round(((utime + stime) * 1000) / LINUX_CLOCK_TICKS_PER_SECOND),
  };
}

/** Parses VmRSS:\t 1234 kB from /proc/<pid>/status */
export function parseLinuxVmRssKb(content: string): number {
  const match = /^VmRSS:\s*(\d+)\s*kB/m.exec(content);
  return match ? Number(match[1]) : 0;
}

/** PowerShell row: pid ppid workingSetBytes cpu100ns name... */
function parseWindowsProcessTable(stdout: string): ProcessResourceRow[] {
  const rows: ProcessResourceRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const pid = parseNonNegativeInteger(match[1]);
    const ppid = parseNonNegativeInteger(match[2]);
    const workingSetBytes = parseNonNegativeInteger(match[3]);
    const cpu100ns = parseNonNegativeInteger(match[4]);
    if (pid === undefined || pid <= 0 || ppid === undefined || workingSetBytes === undefined)
      continue;
    if (cpu100ns === undefined) continue;
    rows.push({
      pid,
      ppid,
      rssKb: Math.round(workingSetBytes / 1024),
      cpuTimeMs: cpu100ns / WINDOWS_100NS_PER_MS,
      command: (match[5] ?? "").trim(),
    });
  }
  return rows;
}

interface CreateProcessResourceTableReaderOptions {
  platform?: NodeJS.Platform;
  execFile?: ExecFileFn;
  readdir?: (path: string) => Promise<string[]>;
  readFile?: (path: string) => Promise<string>;
}

/** Per-platform machine table; any failure returns undefined (skip this round), never throws */
export function createProcessResourceTableReader(
  options: CreateProcessResourceTableReaderOptions = {},
): ProcessResourceTableReader {
  const platform = options.platform ?? process.platform;
  const execFile = options.execFile ?? defaultExecFile;

  if (platform === "win32") {
    return async (signal) => {
      signal?.throwIfAborted();
      const result = await execFile(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2} {3} {4}' -f $_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, ($_.KernelModeTime + $_.UserModeTime), $_.Name }",
        ],
        {
          timeout: WINDOWS_TABLE_TIMEOUT_MS,
          maxBuffer: TABLE_MAX_BUFFER_BYTES,
          windowsHide: true,
          signal,
        },
      );
      return result.error ? undefined : parseWindowsProcessTable(result.stdout);
    };
  }

  if (platform === "linux") {
    const readDirectory = options.readdir ?? ((path: string) => readdir(path));
    return async (signal) => {
      signal?.throwIfAborted();
      const readText =
        options.readFile ?? ((path: string) => readFile(path, { encoding: "utf8", signal }));
      let entries: string[];
      try {
        entries = await readDirectory("/proc");
      } catch {
        return undefined;
      }
      const rows = await Promise.all(
        entries
          .filter((entry) => /^\d+$/.test(entry))
          .map(async (entry): Promise<ProcessResourceRow | undefined> => {
            try {
              signal?.throwIfAborted();
              const [stat, status] = await Promise.all([
                readText(`/proc/${entry}/stat`),
                readText(`/proc/${entry}/status`),
              ]);
              const parsed = parseLinuxProcStat(stat);
              if (!parsed) return undefined;
              return { ...parsed, rssKb: parseLinuxVmRssKb(status) };
            } catch {
              // Processes exiting mid-read are normal; skip.
              return undefined;
            }
          }),
      );
      return rows.filter((row): row is ProcessResourceRow => row !== undefined);
    };
  }

  return async (signal) => {
    signal?.throwIfAborted();
    const result = await execFile("ps", ["-axo", "pid=,ppid=,rss=,cputime=,comm="], {
      timeout: POSIX_TABLE_TIMEOUT_MS,
      maxBuffer: TABLE_MAX_BUFFER_BYTES,
      signal,
    });
    return result.error ? undefined : parseDarwinProcessTable(result.stdout);
  };
}

export interface ProcessResourceSample {
  pid: number;
  ppid: number;
  rssKb: number;
  /** Machine-normalized CPU percent; 0 for the first sample (no baseline) */
  cpuPercent: number;
  command: string;
}

export interface ProcessResourceSampler {
  sample(signal?: AbortSignal): Promise<Map<number, ProcessResourceSample> | undefined>;
}

interface CreateProcessResourceSamplerOptions {
  readTable: ProcessResourceTableReader;
  now?: () => number;
  logicalCpuCount?: number;
}

export function createProcessResourceSampler(
  options: CreateProcessResourceSamplerOptions,
): ProcessResourceSampler {
  const now = options.now ?? Date.now;
  const logicalCpuCount = Math.max(1, options.logicalCpuCount ?? os.cpus().length);
  const baselines = new Map<number, { cpuTimeMs: number; at: number; command: string }>();

  return {
    async sample(signal) {
      const rows = await options.readTable(signal);
      // Late IO after window close must not seed the next open's baseline.
      signal?.throwIfAborted();
      if (!rows) return undefined;
      const at = now();
      const samples = new Map<number, ProcessResourceSample>();
      for (const row of rows) {
        const baseline = baselines.get(row.pid);
        let cpuPercent = 0;
        // PID-reuse guard: changed command or regresset cputime means a new process baseline.
        const reusable =
          baseline &&
          baseline.command === row.command &&
          row.cpuTimeMs >= baseline.cpuTimeMs &&
          at > baseline.at;
        if (reusable) {
          const elapsedMs = at - baseline.at;
          cpuPercent = (((row.cpuTimeMs - baseline.cpuTimeMs) / elapsedMs) * 100) / logicalCpuCount;
        }
        baselines.set(row.pid, { cpuTimeMs: row.cpuTimeMs, at, command: row.command });
        samples.set(row.pid, {
          pid: row.pid,
          ppid: row.ppid,
          rssKb: row.rssKb,
          cpuPercent: Math.max(0, Math.min(100, roundPercent(cpuPercent))),
          command: row.command,
        });
      }
      for (const [pid, baseline] of baselines) {
        if (!samples.has(pid) && at - baseline.at > CPU_BASELINE_TTL_MS) {
          baselines.delete(pid);
        }
      }
      return samples;
    },
  };
}

function roundPercent(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

export interface HostResourceUsageAgent {
  pid: number;
  provider: string;
  workspacePath: string;
  /** CLI process/childProcesses report; empty on failure, all descendants -> cli */
  children: readonly ZCodeProcessChildProcess[];
}

interface AttributeHostProcessTreeOptions {
  samples: ReadonlyMap<number, ProcessResourceSample>;
  hostPid: number;
  agents: readonly HostResourceUsageAgent[];
  /** Host-managed builtin plugin processes (e.g. Windows CUA helper): pid -> plugin name */
  builtinPluginPids?: ReadonlyMap<number, string>;
}

type Owner =
  | { kind: "agent"; agent: HostResourceUsageAgent }
  | { kind: "mcp"; child: ZCodeProcessChildProcess }
  | { kind: "builtin"; pluginName: string };

function commandDisplayName(command: string): string {
  const name = basename(command.trim()).replace(/\.exe$/i, "");
  return name || command.trim() || "process";
}

function ownerToRow(
  owner: Owner | undefined,
  sample: ProcessResourceSample,
  isOwnerRoot: boolean,
): HostResourceUsageProcess {
  const cpuPercent = sample.cpuPercent;
  const memoryBytes = sample.rssKb * 1024;
  if (!owner) {
    return {
      pid: sample.pid,
      name: commandDisplayName(sample.command),
      category: "base",
      groupKey: "host",
      groupLabel: "host",
      cpuPercent,
      memoryBytes,
    };
  }
  if (owner.kind === "agent") {
    return {
      pid: sample.pid,
      name: isOwnerRoot
        ? formatZCodeAgentProcessName(owner.agent.provider, owner.agent.workspacePath)
        : commandDisplayName(sample.command),
      category: "base",
      groupKey: "cli",
      groupLabel: "cli",
      cpuPercent,
      memoryBytes,
    };
  }
  if (owner.kind === "builtin") {
    return {
      pid: sample.pid,
      name: commandDisplayName(sample.command),
      category: "builtin-plugin",
      groupKey: owner.pluginName,
      groupLabel: owner.pluginName,
      cpuPercent,
      memoryBytes,
    };
  }
  const { child } = owner;
  const groupLabel = child.pluginName ?? child.serverName;
  return {
    pid: sample.pid,
    name: isOwnerRoot ? child.serverName : commandDisplayName(sample.command),
    // User ruling: official-marketplace plugins are builtin; third-party marketplaces and custom MCP are community.
    category: child.mcpSource === "builtin" ? "builtin-plugin" : "community-plugin",
    groupKey: `${child.mcpSource}:${groupLabel}`,
    groupLabel,
    cpuPercent,
    memoryBytes,
  };
}

/**
 * Attributes every host descendant to its nearest known ancestor:
 * MCP root pid -> that plugin; agent pid -> base service cli; unattributed -> base service host child.
 * The host itself is absent (main covers it via app.getAppMetrics).
 */
export function attributeHostProcessTree(
  options: AttributeHostProcessTreeOptions,
): HostResourceUsageProcess[] {
  const childrenByParent = new Map<number, number[]>();
  for (const sample of options.samples.values()) {
    const siblings = childrenByParent.get(sample.ppid) ?? [];
    siblings.push(sample.pid);
    childrenByParent.set(sample.ppid, siblings);
  }

  const ownerRoots = new Map<number, Owner>();
  for (const agent of options.agents) {
    ownerRoots.set(agent.pid, { kind: "agent", agent });
    for (const child of agent.children) {
      ownerRoots.set(child.pid, { kind: "mcp", child });
    }
  }
  for (const [pid, pluginName] of options.builtinPluginPids ?? []) {
    ownerRoots.set(pid, { kind: "builtin", pluginName });
  }

  const rows: HostResourceUsageProcess[] = [];
  const visited = new Set<number>([options.hostPid]);
  const visit = (pid: number, inheritedOwner: Owner | undefined): void => {
    for (const childPid of childrenByParent.get(pid) ?? []) {
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      const sample = options.samples.get(childPid);
      if (!sample) continue;
      const rootOwner = ownerRoots.get(childPid);
      const owner = rootOwner ?? inheritedOwner;
      rows.push(ownerToRow(owner, sample, rootOwner !== undefined));
      visit(childPid, owner);
    }
  };
  visit(options.hostPid, undefined);

  // Include registry-known processes outside the host subtree (extreme: ppid reparented to 1) so the topology keeps no holes.
  for (const [pid, owner] of ownerRoots) {
    if (visited.has(pid)) continue;
    const sample = options.samples.get(pid);
    if (!sample) continue;
    visited.add(pid);
    rows.push(ownerToRow(owner, sample, true));
    visit(pid, owner);
  }

  return rows.sort((left, right) => left.pid - right.pid);
}
