import { readdir, readFile } from "node:fs/promises";
import { readDarwinProcessGroup, readDarwinProcessTable } from "./process-probe-darwin.js";
import {
  sampleLinuxProcessGroup,
  sampleLinuxProcessTrees,
  type LinuxProcReaders,
} from "./process-probe-linux.js";
import {
  defaultProbeExecFile,
  groupProcessTrees,
  isSamplablePid,
  toSample,
  PROCESS_PROBE_SAMPLE_TIMEOUT_MS,
  type ProcessProbeExecFile,
  type ProcessProbeSample,
} from "./process-probe-shared.js";
import { readWindowsProcessMemory } from "./process-probe-windows.js";

export {
  PROCESS_PROBE_SAMPLE_TIMEOUT_MS,
  type ProcessProbeCommandResult,
  type ProcessProbeExecFile,
  type ProcessProbeSample,
} from "./process-probe-shared.js";

/** What tree sampling really covers: Windows tasklist has no ppid, only direct children. */
export type ProcessTreeScope = "direct_process" | "process_tree";

/**
 * Generic process probe: given pids or a process-group id, return per-process RSS and cumulative CPU time.
 * Shared by the MCP 5-minute sample and Bash slow-command sample.
 *
 * Performance red lines for this module:
 * - external process allowlist is macOS `ps` and Windows `tasklist`, at most one call per sample;
 * - Linux reads /proc only, never spawning processes;
 * - 1s timeout per sample; timeout or failure means no-sample, no retry, no queueing;
 * - after 3 consecutive failures the instance disables itself until the caller resets() next window.
 *
 * The failure budget belongs to the probe instance: each sampling scenario in a CLI process (MCP, Bash)
 * holds its own long-lived instance; scenarios never affect each other; callers reset() on window switch.
 */
export interface ProcessProbe {
  /**
   * Sample a whole process tree by root pid (root included), mapping root pid to per-process samples.
   * Roots already gone at sampling time are absent; undefined means no sample this round.
   */
  sampleProcessTrees(
    rootPids: readonly number[],
  ): Promise<ReadonlyMap<number, readonly ProcessProbeSample[]> | undefined>;
  /** Sample by process-group id; Windows has no group semantics: always no-sample, never spawns. */
  sampleProcessGroup(processGroupId: number): Promise<readonly ProcessProbeSample[] | undefined>;
  /** Clear consecutive-failure counts on window switch so a disabled probe becomes usable again. */
  reset(): void;
  /** This platform's sampleProcessTrees coverage; callers label sample scope without testing the platform. */
  readonly treeScope: ProcessTreeScope;
}

export interface CreateProcessProbeOptions {
  execFile?: ProcessProbeExecFile;
  /** List /proc entries, Linux only. */
  listProcDirectory?: () => Promise<readonly string[]>;
  /** Why the last sample failed (timeout included); goes to the caller's debug log, the probe does no I/O. */
  onSampleFailed?: (reason: string) => void;
  platform?: NodeJS.Platform;
  /** Read /proc/<pid>/stat and /proc/<pid>/status, Linux only. */
  readProcFile?: (path: string) => Promise<string>;
}

export const PROCESS_PROBE_MAX_CONSECUTIVE_FAILURES = 3;

const PROBE_TIMED_OUT = Symbol("process-probe-timed-out");

export function createProcessProbe(options: CreateProcessProbeOptions = {}): ProcessProbe {
  const platform = options.platform ?? process.platform;
  const execFile = options.execFile ?? defaultProbeExecFile;
  const listProcDirectory = options.listProcDirectory ?? (() => readdir("/proc"));
  const readProcFile = options.readProcFile ?? ((path: string) => readFile(path, "utf8"));
  let consecutiveFailures = 0;

  const reportFailure = (reason: string): undefined => {
    consecutiveFailures += 1;
    try {
      options.onSampleFailed?.(reason);
    } catch {
      // Observer callbacks must never break sampling or the caller.
    }
    return undefined;
  };

  /// Single funnel per sample: timeout, throw or command failure all mean no-sample and burn failure budget. */
  const sampleWithinBudget = async <T>(
    collect: (readers: LinuxProcReaders) => Promise<T>,
  ): Promise<T | undefined> => {
    if (consecutiveFailures >= PROCESS_PROBE_MAX_CONSECUTIVE_FAILURES) return undefined;
    const deadline = Date.now() + PROCESS_PROBE_SAMPLE_TIMEOUT_MS;
    let outcome: T | typeof PROBE_TIMED_OUT;
    try {
      outcome = await raceProbeTimeout(
        collect({
          isExpired: () => Date.now() >= deadline,
          listProcDirectory,
          readProcFile,
        }),
      );
    } catch (error) {
      return reportFailure(error instanceof Error ? error.message : String(error));
    }
    if (outcome === PROBE_TIMED_OUT) {
      return reportFailure(`Sampling exceeded ${PROCESS_PROBE_SAMPLE_TIMEOUT_MS}ms`);
    }
    consecutiveFailures = 0;
    return outcome;
  };

  return {
    treeScope: platform === "win32" ? "direct_process" : "process_tree",
    async sampleProcessTrees(rootPids) {
      const roots = [...new Set(rootPids.filter(isSamplablePid))];
      if (roots.length === 0) return new Map();
      if (platform === "win32") {
        const samples = await sampleWithinBudget(() => readWindowsProcessMemory(execFile, roots));
        if (!samples) return undefined;
        // tasklist has no ppid: the Windows tree degenerates to the root itself, see treeScope.
        return new Map(samples.map((sample) => [sample.pid, [sample]]));
      }
      return await sampleWithinBudget(async (readers) =>
        platform === "linux"
          ? await sampleLinuxProcessTrees(readers, roots)
          : groupProcessTrees(await readDarwinProcessTable(execFile), roots),
      );
    },
    async sampleProcessGroup(processGroupId) {
      if (!isSamplablePid(processGroupId)) return undefined;
      // Windows has neither group semantics nor a free tree source; give up on this sample.
      if (platform === "win32") return undefined;
      return await sampleWithinBudget(async (readers) =>
        platform === "linux"
          ? await sampleLinuxProcessGroup(readers, processGroupId)
          : (await readDarwinProcessGroup(execFile, processGroupId)).map(toSample),
      );
    },
    reset() {
      consecutiveFailures = 0;
    },
  };
}

/**
 * 1s hard timeout: execFile's timeout kills ps/tasklist;
 // /proc reads cannot be cancelled, readers.isExpired abort at batch bounds; this side just declares defeat.
 */
async function raceProbeTimeout<T>(work: Promise<T>): Promise<T | typeof PROBE_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof PROBE_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(PROBE_TIMED_OUT), PROCESS_PROBE_SAMPLE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
