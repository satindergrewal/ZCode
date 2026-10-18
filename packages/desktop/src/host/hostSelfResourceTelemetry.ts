/**
 * Resource telemetry for the Host process itself.
 *
 * Reuses the memory diagnostics log's existing 60s timer: one `process.memoryUsage()` reading feeds two outlets:
 * the local `[memory] role=utility_host` log line writes under the existing gate, and the same reading converts to a
 * `HostResourceSample` sent to main over parentPort, feeding heap for host-role events.
 * The process therefore keeps a single telemetry timer; any step failure drops only the current sample, leaving Host services untouched.
 */

import { HostResponseTypes } from "@zcode/shared";
import {
  createNodeSelfResourceSampler,
  type NodeSelfResourceSamplerOptions,
} from "@zcode/shared/node";
import {
  startHostMemoryDiagnosticsLog,
  type StartHostMemoryDiagnosticsLogOptions,
} from "./hostMemoryDiagnosticsLog.js";

interface StartHostSelfResourceTelemetryOptions
  extends
    Omit<StartHostMemoryDiagnosticsLogOptions, "onMemoryUsage">,
    NodeSelfResourceSamplerOptions {
  /**
   * parentPort send outlet. The Host has no parentPort outside utilityProcess (local debugging),
   * where it only writes local logs and sends no samples.
   */
  postMessage?: ((message: unknown) => void) | undefined;
}

interface HostSelfResourceTelemetry {
  /** Samples once immediately (tests/manual trigger); returns whether the local log wrote to disk. */
  sampleNow(): boolean;
  stop(): void;
}

export function startHostSelfResourceTelemetry(
  options: StartHostSelfResourceTelemetryOptions,
): HostSelfResourceTelemetry {
  const sampler = createNodeSelfResourceSampler(options);
  const postMessage = options.postMessage;

  // Pass options item by item instead of spreading: sampler-only options (readCpuUsage etc.) must not leak into the diagnostics-log module.
  return startHostMemoryDiagnosticsLog({
    logger: options.logger,
    collectCounters: options.collectCounters,
    readMemoryUsage: options.readMemoryUsage,
    now: options.now,
    intervalMs: options.intervalMs,
    timer: options.timer,
    onMemoryUsage: (memoryUsage) => {
      if (!postMessage) {
        return;
      }
      const sample = sampler.sample(memoryUsage);
      if (!sample) {
        return;
      }
      try {
        postMessage({ type: HostResponseTypes.HostResourceSample, sample });
      } catch {
        // If main exited or IPC is unusable, drop only the current sample.
      }
    },
  });
}
