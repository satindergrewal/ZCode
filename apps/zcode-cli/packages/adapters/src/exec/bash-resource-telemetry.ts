import { randomUUID } from "node:crypto";
import { freemem } from "node:os";
import {
  BASH_RESOURCE_MAX_SAMPLES,
  BASH_RESOURCE_SAMPLE_INTERVAL_MS,
  type ZCodeToolExecResource,
} from "@zcode/shared";
import { createProcessProbe, type ProcessProbe } from "../device/process-probe.js";

import { subscribeBashOutputProgress } from "./bash-progress-poller.js";
import { DEFAULT_PROGRESS_INTERVAL_MS } from "./execution-utils.js";

const BYTES_PER_KB = 1024;

interface BashResourceTelemetryOptions {
  processGroupId?: number;
  platform?: NodeJS.Platform;
  probe?: Pick<ProcessProbe, "sampleProcessGroup">;
  onComplete: (sample: ZCodeToolExecResource) => void;
  readContext?: () => Pick<ZCodeToolExecResource, "cliRssKb" | "systemFreeMemoryKb">;
}

/** Per-command state and probe failure budget; finish seals synchronously, never awaiting telemetry IO. */
export function createBashResourceTelemetry(options: BashResourceTelemetryOptions): {
  finish(exitKind: ZCodeToolExecResource["exitKind"]): void;
} {
  const platform = options.platform ?? process.platform;
  const startedAt = performance.now();
  const probe = options.probe ?? createProcessProbe({ platform });
  const cpuByPid = new Map<number, number>();
  let finished = false;
  let lastSampleElapsedMs = 0;
  let attempts = 0;
  let sampleCount = 0;
  let treeRssKbPeak = 0;
  let treeCpuTimeMs = 0;
  let unsubscribe: (() => void) | undefined;

  const sample = async () => {
    const elapsedMs = performance.now() - startedAt;
    if (finished || elapsedMs - lastSampleElapsedMs < BASH_RESOURCE_SAMPLE_INTERVAL_MS) return;
    lastSampleElapsedMs = elapsedMs;
    attempts += 1;
    try {
      const rows = await probe.sampleProcessGroup(options.processGroupId!);
      // Sealed at root exit; late /proc or ps results must not alter an already-sent summary.
      if (finished || !rows?.length) return;
      sampleCount += 1;
      let rssKb = 0;
      for (const row of rows) {
        rssKb += row.rssKb;
        if (row.cpuTimeMs === undefined) continue;
        const previous = cpuByPid.get(row.pid) ?? 0;
        treeCpuTimeMs += Math.max(0, row.cpuTimeMs - previous);
        cpuByPid.set(row.pid, row.cpuTimeMs);
      }
      treeRssKbPeak = Math.max(treeRssKbPeak, rssKb);
    } catch {
      // Telemetry failure drops only the current sample; Bash exit, output and timeout behavior are untouched.
    } finally {
      if (attempts === BASH_RESOURCE_MAX_SAMPLES) unsubscribe?.();
    }
  };
  if (platform !== "win32" && options.processGroupId !== undefined) {
    // Reuse the Bash one-second shared poller, gated at command start: a phase shift delays at most one tick, never samples early.
    unsubscribe = subscribeBashOutputProgress(DEFAULT_PROGRESS_INTERVAL_MS, sample);
  }

  return {
    finish(exitKind) {
      if (finished) return;
      finished = true;
      unsubscribe?.();
      cpuByPid.clear();
      const durationMs = performance.now() - startedAt;
      if (durationMs < BASH_RESOURCE_SAMPLE_INTERVAL_MS) return;
      try {
        const context = options.readContext?.() ?? {
          cliRssKb: process.memoryUsage.rss() / BYTES_PER_KB,
          systemFreeMemoryKb: freemem() / BYTES_PER_KB,
        };
        options.onComplete({
          // Multiple connections/windows may forward the same fact; emit once after sealing for main-side dedup.
          completionToken: randomUUID(),
          platform,
          toolName: "bash",
          durationMs,
          exitKind,
          sampleCount,
          ...context,
          ...(platform === "win32" ? {} : { treeRssKbPeak, treeCpuTimeMs }),
        });
      } catch {
        // With IPC closed or context read failed, drop the notification; command results are unaffected.
      }
    },
  };
}
