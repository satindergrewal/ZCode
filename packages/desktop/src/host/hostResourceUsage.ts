import type { IZCodeAgentService } from "@zcode/services";
import {
  attributeHostProcessTree,
  createProcessResourceSampler,
  createProcessResourceTableReader,
  type ProcessResourceSampler,
} from "@zcode/services/node";
import {
  HostResponseTypes,
  type HostResourceUsageSnapshotRequestMessage,
  type HostResourceUsageSnapshotResultResponse,
} from "@zcode/shared";

interface CreateHostResourceUsageResponderOptions {
  getAgentService: () => Pick<IZCodeAgentService, "collectLocalRuntimeChildProcesses"> | undefined;
  postMessage: (message: HostResourceUsageSnapshotResultResponse) => void;
  hostPid?: number;
  sampler?: ProcessResourceSampler;
  /** Built-in plugin processes owned directly by the Host (e.g. Windows CUA Helper): pid -> plugin name */
  getBuiltinPluginPids?: () => ReadonlyMap<number, string>;
  now?: () => number;
}

interface HostResourceUsageResponder {
  handleRequest(message: HostResourceUsageSnapshotRequestMessage): Promise<void>;
  cancelRequest(requestId: string): void;
}

/**
 * Resource-manager Host-side responder.
 * Samples once per main request: read the machine process table, ask each local Agent for its MCP child map, attribute by Host subtree, reply.
 * At most one pass, no sampling queue; after window-close cancellation, late results are never published.
 */
export function createHostResourceUsageResponder(
  options: CreateHostResourceUsageResponderOptions,
): HostResourceUsageResponder {
  const hostPid = options.hostPid ?? process.pid;
  const now = options.now ?? Date.now;
  const sampler =
    options.sampler ??
    createProcessResourceSampler({ readTable: createProcessResourceTableReader() });
  let active: { requestId: string; controller: AbortController } | undefined;

  async function respond(
    message: HostResourceUsageSnapshotRequestMessage,
    signal: AbortSignal,
  ): Promise<void> {
    const [samples, agents] = await Promise.all([
      sampler.sample(signal).catch(() => undefined),
      options
        .getAgentService()
        ?.collectLocalRuntimeChildProcesses(signal)
        .catch(() => []) ?? Promise.resolve([]),
    ]);
    if (signal.aborted) return;
    const processes = samples
      ? attributeHostProcessTree({
          samples,
          hostPid,
          agents,
          builtinPluginPids: options.getBuiltinPluginPids?.(),
        })
      : [];
    options.postMessage({
      type: HostResponseTypes.ResourceUsageSnapshotResult,
      requestId: message.requestId,
      sampledAt: now(),
      processes,
    });
  }

  return {
    async handleRequest(message) {
      let current: typeof active;
      try {
        // A main-side display timeout is not completion; per-second queries must not queue into an unbounded FIFO.
        if (active) {
          options.postMessage({
            type: HostResponseTypes.ResourceUsageSnapshotResult,
            requestId: message.requestId,
            sampledAt: now(),
            processes: [],
          });
          return;
        }
        current = { requestId: message.requestId, controller: new AbortController() };
        active = current;
        await respond(message, current.controller.signal);
      } catch {
        // On observation failure or exit, a failed reply just drops the round; never let an unhandled exception touch the Host lifecycle.
      } finally {
        if (current && active === current) active = undefined;
      }
    },
    cancelRequest(requestId) {
      if (active?.requestId === requestId) active.controller.abort();
    },
  };
}
