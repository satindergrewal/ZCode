import {
  runProbeCommand,
  type ProcessProbeExecFile,
  type ProcessProbeSample,
} from "./process-probe-shared.js";

/**
 * Windows: the only allowed external process is `tasklist`, one call for all process memory.
 * Do not switch to Windows management-interface script hosts (see the spec performance red line):
 * past incidents spawned a heavy process every few seconds and visibly slowed the machine.
 * tasklist has no ppid and no cumulative CPU time, so only direct-children RSS is returned.
 */
export async function readWindowsProcessMemory(
  execFile: ProcessProbeExecFile,
  pids: readonly number[],
): Promise<readonly ProcessProbeSample[]> {
  const stdout = await runProbeCommand(execFile, "tasklist", ["/FO", "CSV", "/NH"], {
    windowsHide: true,
  });
  const wanted = new Set(pids);
  const samples: ProcessProbeSample[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const fields = parseCsvFields(line);
    const pid = Number(fields[1]);
    if (!wanted.has(pid)) continue;
    const memoryDigits = (fields[4] ?? "").replace(/\D/g, "");
    if (!memoryDigits) continue;
    const rssKb = Number(memoryDigits);
    if (!Number.isFinite(rssKb) || rssKb < 0) continue;
    samples.push({ pid, rssKb });
  }
  return samples;
}

function parseCsvFields(line: string): string[] {
  const fields: string[] = [];
  for (const match of line.matchAll(/"((?:[^"]|"")*)"/g)) {
    fields.push((match[1] ?? "").replace(/""/g, '"'));
  }
  return fields;
}
