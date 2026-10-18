import { registerHostToolExecResourceTelemetry } from "./hostToolExecResourceTelemetry.js";
import { registerHostMcpResourceTelemetry } from "./hostMcpResourceTelemetry.js";
import type { IDisposable } from "@zcode/rpc";
import { IZCodeAgentService, type ServiceCollection } from "@zcode/services";
import type { ProcessResourceRuntimeSurface } from "@zcode/shared";
import { registerHostAgentResourceTelemetry } from "./hostAgentResourceTelemetry.js";
import { registerHostMcpTelemetry } from "./hostMcpTelemetry.js";

interface RegisterHostServiceResourceTelemetryOptions {
  services: Pick<ServiceCollection, "getOptional">;
  postMessage(message: unknown): void;
  runtimeSurface: ProcessResourceRuntimeSurface;
  /** Standalone servers must declare support explicitly; local and paired remote deployments support it by default. */
  telemetrySupported?: boolean;
  /** Host's hashed runtime-environment identity, passed to main for resource grouping only; never sent to ARMS. */
  environmentKey?: string;
  onError?(error: unknown): void;
}

const NO_TELEMETRY: IDisposable = { dispose() {} };

function disposeAll(registrations: IDisposable[]): void {
  while (registrations.length > 0) {
    try {
      registrations.pop()?.dispose();
    } catch {
      // One failing unsubscribe must not block the rest, or listeners linger after connection close.
    }
  }
}

/**
 * Resource-telemetry subscription for one service collection. Forwards CLI self-sampled resource data, MCP process-tree samples,
 * slow-Bash completion facts, and MCP lifecycle telemetry.
 *
 * Invoked once for local host services and once per remote workspace connection, with `runtimeSurface` given by the caller:
 * local for this machine's CLI, remote for the CLI inside a remote zcode-server; main overrides sample-reported hardware dims onto global defaults.
 * Subscription lifetime equals the collection's; the handle calls `dispose()` when the remote connection closes, leaving no listeners.
 * Multiple dedicated connections to one remote machine yield multiple subscriptions; main merges CLI/MCP latest readings by env and instance,
 * and dedupes Bash completion facts by completionToken so multi-connection/multi-window setups never double count.
 *
 * Attachments (desktop renderer / phone remote) are not an entry point here: they reuse an already-ready collection,
 * and these events stay trusted-host-relay within the Agent connection scope, never reaching the session message surface.
 */
export function registerHostServiceResourceTelemetry(
  options: RegisterHostServiceResourceTelemetryOptions,
): IDisposable {
  // Legacy-Server unknown-event throws happen in the peer's async read loop; the local try/catch below cannot cover them,
  // so on missing capability we must exit before acquiring services or sending any EventListen.
  if (options.telemetrySupported === false) {
    return NO_TELEMETRY;
  }
  const agentService = options.services.getOptional(IZCodeAgentService);
  if (!agentService) {
    return NO_TELEMETRY;
  }
  const registrations: IDisposable[] = [];
  try {
    registrations.push(
      registerHostAgentResourceTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
        environmentKey: options.environmentKey,
      }),
    );
    registrations.push(
      registerHostMcpTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
      }),
    );
    registrations.push(
      registerHostMcpResourceTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
        environmentKey: options.environmentKey,
      }),
    );
    registrations.push(
      registerHostToolExecResourceTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
      }),
    );
  } catch (error) {
    // Telemetry subscription failure must not alter Host service init or remote connection outcomes, nor leave a half-wired chain.
    disposeAll(registrations);
    options.onError?.(error);
    return NO_TELEMETRY;
  }
  let disposed = false;
  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      disposeAll(registrations);
    },
  };
}
