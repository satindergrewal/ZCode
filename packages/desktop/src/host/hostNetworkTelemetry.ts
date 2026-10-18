import { HostResponseTypes } from "@zcode/shared";
import { setNetworkTelemetrySink, type NetworkObservation } from "@zcode/rpc";

interface HostNetworkTelemetryParentPort {
  postMessage(message: unknown): void;
}

const pending: NetworkObservation[] = [];
const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_MAX_BATCH = 200;

let flushTimer: ReturnType<typeof setInterval> | null = null;
let activeParentPort: HostNetworkTelemetryParentPort | null = null;

function flushHostNetworkTelemetryBatch(): void {
  if (!activeParentPort || pending.length === 0) {
    return;
  }
  const observations = pending.splice(0, FLUSH_MAX_BATCH);
  try {
    activeParentPort.postMessage({
      type: HostResponseTypes.NetworkTelemetryBatch,
      observations,
    });
  } catch {
    // A failed telemetry batch must not affect the main host flow.
  }
}

export function registerHostNetworkTelemetry(
  parentPort: HostNetworkTelemetryParentPort | null | undefined,
): void {
  // Bugfix: the desktop host is an Electron utility process whose channel is process.parentPort;
  // node:worker_threads.parentPort is null here, so LLM/RPC network telemetry batches could never reach main.
  activeParentPort = parentPort ?? null;
  setNetworkTelemetrySink((observation) => {
    pending.push(observation);
    if (pending.length >= FLUSH_MAX_BATCH) {
      flushHostNetworkTelemetryBatch();
    }
  });

  flushTimer = setInterval(flushHostNetworkTelemetryBatch, FLUSH_INTERVAL_MS);
}

export function stopHostNetworkTelemetry(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  setNetworkTelemetrySink(null);
  flushHostNetworkTelemetryBatch();
  activeParentPort = null;
}
