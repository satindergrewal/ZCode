import {
  createMemoryDiagnosticsRegistry,
  createMemorySampleWriteGate,
  formatMemorySampleLine,
  MEMORY_SAMPLE_INTERVAL_MS,
  type MemoryDiagnosticsRegistry,
  type MemorySample,
  type RendererHeapSample,
} from "@zcode/shared";
import { logMemoryDiagnostics } from "@/logger.js";

/**
 * Registry of renderer memory-diagnostic counters.
 * Cache/store modules register read-only providers at load; `startMemoryDiagnosticsLogger` samples
 * every 60s and, once gated, writes via `logger.logMemoryDiagnostics` to the desktop main log.
 */
export const uiMemoryDiagnosticsRegistry: MemoryDiagnosticsRegistry =
  createMemoryDiagnosticsRegistry();

interface RendererHeapSnapshot {
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
}

/** Chromium-specific `performance.memory`; undefined in browsers without it (web). */
export function readRendererHeapSnapshot(): RendererHeapSnapshot | undefined {
  if (typeof performance === "undefined") {
    return undefined;
  }
  const memory = (performance as Performance & { memory?: RendererHeapSnapshot }).memory;
  if (!memory || typeof memory.usedJSHeapSize !== "number") {
    return undefined;
  }
  return memory;
}

interface StartMemoryDiagnosticsLoggerOptions {
  intervalMs?: number;
  now?: () => number;
  readHeap?: () => RendererHeapSnapshot | undefined;
  write?: (line: string) => void;
  registry?: MemoryDiagnosticsRegistry;
  /**
   * Resource-telemetry sink: the same reading goes to the local
   * diagnostics log and, via the preload bridge, to main's renderer_main role event. App injectes
   * `platform.reportRendererHeapSample`; web/mobile-remote have no bridge -- uninjected means no-op.
   */
  reportHeapSample?: (sample: RendererHeapSample) => void;
}

export interface MemoryDiagnosticsLoggerHandle {
  sampleNow(): boolean;
  stop(): void;
}

export function startMemoryDiagnosticsLogger(
  options: StartMemoryDiagnosticsLoggerOptions = {},
): MemoryDiagnosticsLoggerHandle {
  const now = options.now ?? (() => Date.now());
  const readHeap = options.readHeap ?? readRendererHeapSnapshot;
  const write = options.write ?? logMemoryDiagnostics;
  const registry = options.registry ?? uiMemoryDiagnosticsRegistry;
  const reportHeapSample = options.reportHeapSample;
  const gate = createMemorySampleWriteGate();

  const sampleNow = (): boolean => {
    try {
      const heap = readHeap();
      const heapUsedKb = heap ? Math.round(heap.usedJSHeapSize! / 1024) : undefined;
      // Feed resource telemetry first: ARMS wants the full 60s series while the local log writes on-change only --
      // the two sinks cannot share one gate, and counter collection must not delay this heap sample.
      if (heapUsedKb !== undefined) {
        try {
          reportHeapSample?.({ heapUsedKb });
        } catch {
          // A bridge failure only drops this telemetry sample; local diagnostics and rendering are unaffected.
        }
      }
      const sample: MemorySample = {
        role: "renderer",
        counters: registry.collect(),
      };
      if (heap) {
        sample.heapUsedKb = heapUsedKb;
        if (typeof heap.totalJSHeapSize === "number") {
          sample.heapTotalKb = Math.round(heap.totalJSHeapSize / 1024);
        }
      }
      const reason = gate.evaluate(sample, now());
      if (!reason) {
        return false;
      }
      write(formatMemorySampleLine(sample, reason));
      return true;
    } catch {
      // A failed diagnostics sample drops only the current sample; rendering is unaffected.
      return false;
    }
  };

  let handle: ReturnType<typeof setInterval> | undefined = setInterval(
    sampleNow,
    options.intervalMs ?? MEMORY_SAMPLE_INTERVAL_MS,
  );

  return {
    sampleNow,
    stop() {
      if (handle === undefined) {
        return;
      }
      clearInterval(handle);
      handle = undefined;
    },
  };
}
