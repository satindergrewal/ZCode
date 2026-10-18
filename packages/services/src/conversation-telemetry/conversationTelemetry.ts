import type { Event } from "@zcode/rpc";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";

export interface ConversationTelemetryWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * Workspace-scoped read-only service surface for conversation telemetry. Wraps only the
 * connection-scoped agent service whose clientMode auth already passed; no extra RPC channel,
 // and Web/mobile cannot bypass the desktop-continuous gate.
 */
export interface IConversationTelemetryService {
  onFact(target: ConversationTelemetryWorkspaceTarget): Event<ConversationTelemetryFact>;
}

export function createConversationTelemetryService(
  zcodeAgentService: Pick<IZCodeAgentService, "onDynamicConversationTelemetryFact">,
): IConversationTelemetryService {
  return {
    onFact: (target) =>
      // RPC events carrying a workspace argument must use onDynamic* names, or ProxyChannel treats
      // them as plain events and reads target as a listener.
      zcodeAgentService.onDynamicConversationTelemetryFact(target),
  };
}
