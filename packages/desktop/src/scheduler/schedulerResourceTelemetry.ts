/**
 * Resource telemetry for the cron scheduler process itself.
 *
 * The scheduler had no sampling; this adds its only unref timer: every 60s read
 * process.cpuUsage()/memoryUsage() and parentPort the sample to main,
 * feeding the scheduler role's heap. Read/send failures drop one sample, never the dispatch loop.
 * Zero external processes; timer is unref'd, no lifetime extension.
 */

import {
  createNodeSelfResourceSampler,
  NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS,
  type NodeSelfResourceSamplerOptions,
} from "@zcode/shared/node";
import type { SchedulerToMainMessage } from "./schedulerProtocol.js";

interface SchedulerResourceTelemetryTimerHandle {
  unref?(): void;
}

export interface StartSchedulerResourceTelemetryOptions extends NodeSelfResourceSamplerOptions {
  /** parentPort sink; pass a no-op when parentPort is unavailable. */
  postMessage: (message: SchedulerToMainMessage) => void;
  readMemoryUsage?: () => NodeJS.MemoryUsage;
  intervalMs?: number;
  timer?: {
    setInterval(callback: () => void, intervalMs: number): SchedulerResourceTelemetryTimerHandle;
    clearInterval(handle: SchedulerResourceTelemetryTimerHandle): void;
  };
}

export interface SchedulerResourceTelemetry {
  stop(): void;
}

export function startSchedulerResourceTelemetry(
  options: StartSchedulerResourceTelemetryOptions,
): SchedulerResourceTelemetry {
  const sampler = createNodeSelfResourceSampler(options);
  const readMemoryUsage = options.readMemoryUsage ?? (() => process.memoryUsage());
  const timer = options.timer ?? {
    setInterval: (callback: () => void, intervalMs: number) => setInterval(callback, intervalMs),
    clearInterval: (handle: SchedulerResourceTelemetryTimerHandle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  };

  const sampleNow = (): void => {
    try {
      const sample = sampler.sample(readMemoryUsage());
      if (!sample) {
        return;
      }
      options.postMessage({ type: "scheduler-resource-sample", sample });
    } catch {
      // Read errors, missing parentPort, or postMessage throws drop one sample only.
    }
  };

  let handle: SchedulerResourceTelemetryTimerHandle | undefined = timer.setInterval(
    sampleNow,
    options.intervalMs ?? NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS,
  );
  try {
    handle.unref?.();
  } catch {
    // Keep the handle for stop() even when unref is unavailable.
  }

  return {
    stop() {
      if (!handle) {
        return;
      }
      const current = handle;
      handle = undefined;
      try {
        timer.clearInterval(current);
      } catch {
        // Cleanup failures never block the scheduler's existing exit flow.
      }
    },
  };
}
