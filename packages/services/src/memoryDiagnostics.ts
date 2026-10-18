import type { IDisposable } from "@zcode/rpc";
import {
  createMemoryDiagnosticsRegistry,
  type MemoryDiagnosticsProvider,
  type MemoryDiagnosticsRegistry,
} from "@zcode/shared";

/**
 * Process-level memory diagnostic counters registry for the services process.
 *
 * Each service factory registers a read-only provider on creation and unregisters on
 * disposeAll; the Host collects every 60 seconds and writes a local log. Kept off the service
 * interfaces so diagnostic methods are not exposed over the RPC channel.
 */
export const memoryDiagnosticsRegistry: MemoryDiagnosticsRegistry =
  createMemoryDiagnosticsRegistry();

export function registerMemoryDiagnosticsProvider(
  name: string,
  provider: MemoryDiagnosticsProvider,
): IDisposable {
  return memoryDiagnosticsRegistry.register(name, provider);
}

export function collectServiceMemoryDiagnostics(): Record<string, number> {
  return memoryDiagnosticsRegistry.collect();
}
