import {
  createMemorySampleWriteGate,
  formatMemorySampleLine,
  MEMORY_SAMPLE_INTERVAL_MS,
  memoryUsageToSampleFields,
  type MemorySample,
} from "@zcode/shared";

interface HostMemoryDiagnosticsLogger {
  info(...args: unknown[]): void;
}

interface HostMemoryDiagnosticsTimerHandle {
  unref?(): void;
}

export interface StartHostMemoryDiagnosticsLogOptions {
  logger: HostMemoryDiagnosticsLogger;
  /** Domain counters from the services layer (`collectServiceMemoryDiagnostics`). */
  collectCounters(): Record<string, number>;
  readMemoryUsage?: () => NodeJS.MemoryUsage;
  /**
   * A second outlet for the same `memoryUsage()` reading: the resource-telemetry host sample.
   *
   * Independent of the write gating: local logs may be skipped by the gate, but telemetry samples go out every 60s;
   * a throwing callback only drops the telemetry sample, never the local log.
   */
  onMemoryUsage?: (memoryUsage: NodeJS.MemoryUsage) => void;
  now?: () => number;
  intervalMs?: number;
  timer?: {
    setInterval(callback: () => void, intervalMs: number): HostMemoryDiagnosticsTimerHandle;
    clearInterval(handle: HostMemoryDiagnosticsTimerHandle): void;
  };
}

export interface HostMemoryDiagnosticsLog {
  /** Samples once immediately (tests/manual trigger); returns whether it wrote to disk. */
  sampleNow(): boolean;
  stop(): void;
}

/**
 * Memory diagnostics for the Local Host process itself.
 * Samples every 60s and, after change/heartbeat gating, writes one `[memory] role=utility_host ...` line through the
 * existing host logger into the Desktop main log; no new parentPort message types.
 */
export function startHostMemoryDiagnosticsLog(
  options: StartHostMemoryDiagnosticsLogOptions,
): HostMemoryDiagnosticsLog {
  const readMemoryUsage = options.readMemoryUsage ?? (() => process.memoryUsage());
  const now = options.now ?? (() => Date.now());
  const timer = options.timer ?? {
    setInterval: (callback: () => void, intervalMs: number) => setInterval(callback, intervalMs),
    clearInterval: (handle: HostMemoryDiagnosticsTimerHandle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const gate = createMemorySampleWriteGate();

  const sampleNow = (): boolean => {
    let memoryUsage: NodeJS.MemoryUsage;
    try {
      memoryUsage = readMemoryUsage();
    } catch {
      // On read failure neither outlet has data; drop only the current sample.
      return false;
    }

    try {
      options.onMemoryUsage?.(memoryUsage);
    } catch {
      // A telemetry-outlet failure drops only that sample; the local diagnostic log still writes.
    }

    try {
      const sample: MemorySample = {
        role: "utility_host",
        ...memoryUsageToSampleFields(memoryUsage),
        counters: options.collectCounters(),
      };
      const reason = gate.evaluate(sample, now());
      if (!reason) {
        return false;
      }
      options.logger.info(formatMemorySampleLine(sample, reason));
      return true;
    } catch {
      // A sampling failure drops only the current sample and must not affect Host services.
      return false;
    }
  };

  let handle: HostMemoryDiagnosticsTimerHandle | undefined = timer.setInterval(
    sampleNow,
    options.intervalMs ?? MEMORY_SAMPLE_INTERVAL_MS,
  );
  try {
    handle.unref?.();
  } catch {
    // Keep the handle for stop cleanup even when unref is unavailable.
  }

  return {
    sampleNow,
    stop() {
      if (!handle) {
        return;
      }
      const current = handle;
      handle = undefined;
      timer.clearInterval(current);
    },
  };
}
