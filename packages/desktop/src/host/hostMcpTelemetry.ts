import type { IDisposable } from "@zcode/rpc";
import type { IZCodeAgentService } from "@zcode/services";
import type { ProcessResourceRuntimeSurface } from "@zcode/shared";
import { HostResponseTypes } from "@zcode/shared";

interface RegisterHostMcpTelemetryOptions {
  agentService: Pick<IZCodeAgentService, "onDynamicMcpTelemetry">;
  postMessage(message: unknown): void;
  runtimeSurface: ProcessResourceRuntimeSurface;
}

export function registerHostMcpTelemetry(options: RegisterHostMcpTelemetryOptions): IDisposable {
  return options.agentService.onDynamicMcpTelemetry()((event) => {
    try {
      options.postMessage({
        type: HostResponseTypes.McpTelemetry,
        runtimeSurface: options.runtimeSurface,
        event,
      });
    } catch {
      // On main exit or unusable IPC, drop only the current telemetry; never touch the MCP lifecycle.
    }
  });
}
