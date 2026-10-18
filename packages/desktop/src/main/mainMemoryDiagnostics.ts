import { createMemoryDiagnosticsRegistry, type MemoryDiagnosticsRegistry } from "@zcode/shared";

/**
 * Main-process memory diagnostic counter registry.
 * index.ts registers providers after constructing TaskRealtimeBus/BroadcastHub/BrowserGuestManager;
 * desktopResourceTelemetry collects every 60s into the main log.
 */
export const mainMemoryDiagnosticsRegistry: MemoryDiagnosticsRegistry =
  createMemoryDiagnosticsRegistry();
