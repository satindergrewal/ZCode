import type { ZCodeProtocolSessionRecord } from "../server-types.js";
import type { McpUiPluginScope, McpUiSessionAccess } from "./contract.js";
import { mcpUiInstances } from "./instances.js";

/**
 * Narrows the session record to the view the handlers need. Ownership truth is this session's MCP server table
 // (plugin and plain servers alike); any configured server may render an MCP App.
 */
export function createMcpUiSessionAccess(
  record: ZCodeProtocolSessionRecord,
  scope: McpUiPluginScope,
): McpUiSessionAccess {
  const validate = () =>
    mcpUiInstances.validate(
      scope.instance,
      scope,
      record.app.getMcpAppConnectionSnapshot(scope.serverName),
    );
  const guard = async <T>(
    run: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const current = validate();
    const combined = signal
      ? AbortSignal.any([signal, current.cancel.signal])
      : current.cancel.signal;
    combined.throwIfAborted();
    const result = await run(combined);
    validate();
    combined.throwIfAborted();
    return result;
  };
  return {
    hasMcpServer: async (serverName) =>
      guard(async () => Object.hasOwn(await record.app.listMcpServers(), serverName)),
    getToolVisibility: (serverName, toolName) =>
      guard(() => record.app.getMcpToolVisibility(serverName, toolName)),
    readResource: (serverName, uri, options) =>
      guard((signal) => record.app.readMcpResource(serverName, uri, { signal }), options?.signal),
    callTool: (serverName, toolName, args, options) =>
      guard(async (signal) => {
        const pin = mcpUiInstances.retain(scope.instance.token, "ui-call");
        try {
          return await record.app.callMcpToolForUi(serverName, toolName, args, { signal });
        } finally {
          pin.release();
        }
      }, options?.signal),
    readResourceForUi: (serverName, uri, options) =>
      guard(
        (signal) => record.app.readMcpResourceForUi(serverName, uri, { signal }),
        options?.signal,
      ),
    listResourcesForUi: (serverName, cursor, options) =>
      guard(
        (signal) => record.app.listMcpResourcesForUi(serverName, cursor, { signal }),
        options?.signal,
      ),
    listResourceTemplatesForUi: (serverName, cursor, options) =>
      guard(
        (signal) => record.app.listMcpResourceTemplatesForUi(serverName, cursor, { signal }),
        options?.signal,
      ),
    subscribeResourceForUi: (serverName, uri, subscriberKey, options) =>
      guard(
        (signal) =>
          record.app.subscribeMcpResourceForUi(serverName, uri, subscriberKey, { signal }),
        options?.signal,
      ),
    unsubscribeResourceForUi: (serverName, uri, subscriberKey, options) =>
      guard(
        (signal) =>
          record.app.unsubscribeMcpResourceForUi(serverName, uri, subscriberKey, { signal }),
        options?.signal,
      ),
  };
}
