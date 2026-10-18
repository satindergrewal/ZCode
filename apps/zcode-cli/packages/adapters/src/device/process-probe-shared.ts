import { execFile as nodeExecFile } from "node:child_process";
import type { ExecFileOptionsWithStringEncoding } from "node:child_process";

/**
 * Shared contracts and platform-agnostic helpers for the process probe.
 * Each platform (darwin / linux / win32) lives in its own file depending only on this one.
 */
export interface ProcessProbeSample {
  pid: number;
  rssKb: number;
  /** Cumulative CPU time since start; Windows lacks it: field absent, never 0 */
  cpuTimeMs?: number;
}

export interface ProcessProbeCommandResult {
  error?: unknown;
  status: number | null;
  stderr: string;
  stdout: string;
}

export type ProcessProbeExecFile = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<ProcessProbeCommandResult>;

/** Process relations and CPU times; RSS is fetched per platform (Linux needs an extra `status` read). */
export interface ProcessRelation {
  cpuTimeMs?: number;
  parentPid?: number;
  pid: number;
  processGroupId?: number;
}

export interface ProcessRow extends ProcessRelation {
  rssKb: number;
}

export const PROCESS_PROBE_SAMPLE_TIMEOUT_MS = 1_000;

const PROCESS_PROBE_MAX_BUFFER_BYTES = 8 * 1_024 * 1_024;

/** Sample failure: callers always translate it to no-sample-this-round and count consecutive failures. */
export class ProcessProbeFailure extends Error {}

/** Expand the process table into one tree per root pid by parentPid; missing roots are absent. */
export function groupProcessTrees(
  rows: readonly ProcessRow[],
  rootPids: readonly number[],
): ReadonlyMap<number, readonly ProcessProbeSample[]> {
  const rowByPid = new Map(rows.map((row) => [row.pid, row]));
  const trees = new Map<number, readonly ProcessProbeSample[]>();
  for (const [rootPid, treePids] of collectProcessTreePids(rows, rootPids)) {
    trees.set(
      rootPid,
      treePids.flatMap((pid) => {
        const row = rowByPid.get(pid);
        return row ? [toSample(row)] : [];
      }),
    );
  }
  return trees;
}

/** Member pids per root (root included) in DFS order; the whole tree is absent if the root is missing. */
export function collectProcessTreePids(
  relations: readonly ProcessRelation[],
  rootPids: readonly number[],
): ReadonlyMap<number, readonly number[]> {
  const knownPids = new Set(relations.map((relation) => relation.pid));
  const childrenByParent = new Map<number, number[]>();
  for (const relation of relations) {
    if (relation.parentPid === undefined) continue;
    const children = childrenByParent.get(relation.parentPid) ?? [];
    children.push(relation.pid);
    childrenByParent.set(relation.parentPid, children);
  }
  const trees = new Map<number, readonly number[]>();
  for (const rootPid of rootPids) {
    if (!knownPids.has(rootPid)) continue;
    const treePids: number[] = [];
    const visited = new Set<number>();
    const visit = (pid: number): void => {
      if (visited.has(pid)) return;
      visited.add(pid);
      treePids.push(pid);
      for (const childPid of childrenByParent.get(pid) ?? []) visit(childPid);
    };
    visit(rootPid);
    trees.set(rootPid, treePids);
  }
  return trees;
}

export async function runProbeCommand(
  execFile: ProcessProbeExecFile,
  file: string,
  args: readonly string[],
  extraOptions: Partial<ExecFileOptionsWithStringEncoding> = {},
): Promise<string> {
  const result = await execFile(file, args, {
    encoding: "utf8",
    maxBuffer: PROCESS_PROBE_MAX_BUFFER_BYTES,
    timeout: PROCESS_PROBE_SAMPLE_TIMEOUT_MS,
    ...extraOptions,
  });
  if (result.error || result.status !== 0) {
    throw new ProcessProbeFailure(
      `${file} probe failed: ${result.stderr.trim() || String(result.status)}`,
    );
  }
  return result.stdout;
}

export function toSample(row: ProcessRow): ProcessProbeSample {
  return {
    pid: row.pid,
    rssKb: row.rssKb,
    ...(row.cpuTimeMs === undefined ? {} : { cpuTimeMs: row.cpuTimeMs }),
  };
}

export function isSamplablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

export function defaultProbeExecFile(
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
): Promise<ProcessProbeCommandResult> {
  return new Promise((resolve) => {
    nodeExecFile(file, [...args], options, (error, stdout, stderr) => {
      resolve({
        ...(error ? { error } : {}),
        status: resolveExitStatus(error),
        stderr,
        stdout,
      });
    });
  });
}

function resolveExitStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("code" in error)) return 0;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}
