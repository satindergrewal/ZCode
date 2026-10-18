import type { Logger } from "@zcode/contracts";
import {
  createMemorySampleWriteGate,
  memoryUsageToSampleFields,
  zcodeProtocolNotifications,
  type MemorySample,
  type ZCodeProtocolNotification,
} from "@zcode/shared";
import {
  createZCodeProcessResourceSampler,
  type ZCodeProcessResourceSampler,
} from "../process-resource-sampler.js";
import type { ZCodeProtocolAgentServer } from "./server.js";

export function startProtocolResourceSampler(
  server: ZCodeProtocolAgentServer,
  send: (message: ZCodeProtocolNotification) => void,
  logger: Logger,
): ZCodeProcessResourceSampler | undefined {
  try {
    // Local in-memory diagnostics log: reuses the same 60s tick,
    // writing a line only after change/heartbeat gating, never at message-flow frequency.
    const memoryDiagnosticsGate = createMemorySampleWriteGate();
    const sampler = createZCodeProcessResourceSampler({
      onSample: (sample, memoryUsage) => {
        send({
          method: zcodeProtocolNotifications.processResourceSample,
          params: sample,
        });
        // Resident-session TTL / watermark convergence piggybacks on the resource sampling tick (60s) as a fallback, no new timer;
        // the sampler already guards onSample failures, so one failed rebalance never affects telemetry.
        server.rebalanceResidentSessions();
        try {
          // Each tick runs the transient-event expiry fallback before sampling, so logged eventRows reflect post-eviction residency.
          server.pruneSessionEventStores();
          server.pruneDetachedChildPublishers();
        } catch {
          // A failed expiry fallback never affects resource reporting or the diagnostics log.
        }
        try {
          const memorySample: MemorySample = {
            role: "agent_node",
            ...memoryUsageToSampleFields(memoryUsage),
            counters: server.collectMemoryDiagnostics(),
          };
          const reason = memoryDiagnosticsGate.evaluate(memorySample, Date.now());
          if (reason) {
            const { role: _role, counters, ...memoryFields } = memorySample;
            logger.info("Process memory sample", {
              event: "zcode_protocol.process.memory_sample",
              reason,
              ...memoryFields,
              counters,
            });
          }
        } catch {
          // A diagnostics-log failure only drops the current sample; resource reporting and rebalance continue.
        }
      },
    });
    sampler.start();
    return sampler;
  } catch {
    // Resource telemetry is best effort; initialization failure must not change the Agent start outcome.
    return undefined;
  }
}
