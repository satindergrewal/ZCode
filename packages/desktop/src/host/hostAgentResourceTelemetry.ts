import type { IDisposable } from "@zcode/rpc";
import type { IZCodeAgentService } from "@zcode/services";
import type { ProcessResourceRuntimeSurface } from "@zcode/shared";
import { HostResponseTypes } from "@zcode/shared";

interface RegisterHostAgentResourceTelemetryOptions {
  agentService: Pick<IZCodeAgentService, "onDynamicProcessResourceSample">;
  postMessage(message: unknown): void;
  runtimeSurface: ProcessResourceRuntimeSurface;
  environmentKey?: string;
}

/**
 * Host forwarding for CLI resource samples.
 *
 * The Host only relays: the sample lane is already assigned by services when parsing protocol notifications, per owning process manager.
 * New fields (heap/uptime/machine memory/instanceToken and so on) go to main unchanged;
 * main decides role attribution and aggregation. The Host keeps no stats and holds no window.
 */
export function registerHostAgentResourceTelemetry(
  options: RegisterHostAgentResourceTelemetryOptions,
): IDisposable {
  return options.agentService.onDynamicProcessResourceSample()((sample) => {
    try {
      options.postMessage({
        type: HostResponseTypes.AgentResourceSample,
        runtimeSurface: options.runtimeSurface,
        ...(options.environmentKey === undefined ? {} : { environmentKey: options.environmentKey }),
        sample,
      });
    } catch {
      // If main exited or IPC is unusable, drop only the current sample; never disturb Agent service notification dispatch.
    }
  });
}
