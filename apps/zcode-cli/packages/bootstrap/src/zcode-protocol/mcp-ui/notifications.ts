import {
  SessionEventType,
  createEventId,
  type McpServerNotification,
  type PluginUiResourceSubscriberRef,
  type SessionEvent,
} from "@zcode/contracts";
import type { ZCodeProtocolAgentServerContext } from "../server-types.js";
import { parseMcpUiSubscriberKey } from "./contract.js";
import { mcpUiInstances } from "./instances.js";

/**
 * MCP server notifications -> session.
 // - resources/updated / list_changed: split per subscriberKey into one live-only event per session (v4Gateway.ingest, seq 0);
 //   no subscribers, drop; plugin attribution via the session-frozen catalog (server -> pluginId).
 // - notifications/message: into the agent log `mcp:<server>` (error+ -> error, warning -> warn, rest debug).
 // - tools/list_changed: the adapter already marked stale; log debug only (re-pull at turn boundary, A7).
 */
export function routeMcpServerNotification(
  context: ZCodeProtocolAgentServerContext,
  notification: McpServerNotification,
): void {
  switch (notification.kind) {
    case "loggingMessage": {
      const logger = context.logger?.child?.({ module: `mcp:${notification.serverName}` });
      const fields = {
        event: "mcp.server.log",
        mcpServerName: notification.serverName,
        ...(notification.logger ? { mcpLogger: notification.logger } : {}),
        data: notification.data,
      };
      const level = notification.level;
      if (["error", "critical", "alert", "emergency"].includes(level)) {
        logger?.error("MCP server log", undefined, fields);
      } else if (level === "warning") {
        logger?.warn("MCP server log", fields);
      } else {
        logger?.debug("MCP server log", fields);
      }
      return;
    }
    case "toolListChanged":
      context.logger?.debug("MCP tool list changed; refresh at next turn", {
        event: "mcp.tools.list_changed",
        mcpServerName: notification.serverName,
      });
      return;
    case "resourceUpdated":
    case "resourceListChanged": {
      const bySession = new Map<string, PluginUiResourceSubscriberRef[]>();
      for (const key of notification.subscribers) {
        const parsed = parseMcpUiSubscriberKey(key);
        if (!parsed) continue;
        const active = mcpUiInstances.find(parsed.scopeId);
        const record = context.sessions.get(parsed.sessionId);
        if (!active || !record || active.lease.generation !== parsed.generation) continue;
        try {
          mcpUiInstances.validate(
            active.lease,
            {
              sessionId: parsed.sessionId,
              pluginId: active.binding.pluginId,
              serverName: notification.serverName,
            },
            record.app.getMcpAppConnectionSnapshot(notification.serverName),
          );
        } catch {
          continue;
        }
        const list = bySession.get(parsed.sessionId) ?? [];
        list.push({
          scopeId: parsed.scopeId,
          generation: parsed.generation,
          instance: active.lease,
        });
        bySession.set(parsed.sessionId, list);
      }
      if (bySession.size === 0) return;
      const gateway = context.v4Gateway;
      if (!gateway) return;
      for (const [sessionId, subscribers] of bySession) {
        const record = context.sessions.get(sessionId);
        if (!record) continue;
        const pluginId =
          record.app
            .getPluginReferenceCatalog()
            .plugins.find((plugin) => plugin.mcpServerNames.includes(notification.serverName))
            ?.pluginId ?? "";
        const base = { pluginId, serverName: notification.serverName, subscribers };
        const event: SessionEvent = {
          id: createEventId(),
          sessionId: sessionId as never,
          type:
            notification.kind === "resourceUpdated"
              ? SessionEventType.PluginUiResourceUpdated
              : SessionEventType.PluginUiResourceListChanged,
          timestamp: new Date(),
          traceId: String(record.traceContext.traceId) as never,
          // Live projection only, never persisted: seq 0 lets the gateway assign the transport sequence (as with synthesized elicitation events).
          sequenceNumber: 0,
          payload: (notification.kind === "resourceUpdated"
            ? { ...base, uri: notification.uri }
            : base) as never,
        };
        gateway.ingest(sessionId, event);
      }
      return;
    }
  }
}
