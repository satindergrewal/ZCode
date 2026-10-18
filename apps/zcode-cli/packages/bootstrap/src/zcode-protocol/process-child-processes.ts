import type { McpTrackedProcess } from "@zcode/adapters";
import type { ZCodeProcessChildProcessesResult } from "@zcode/shared";
import { resolveOfficialPluginNameByHostMcpServerName } from "../app/official-plugin-definitions.js";

/**
 * `process/childProcesses`: shapes the MCP process registry's in-memory child map into a protocol result.
 * Attribution only (builtin host MCP -> official plugin name), no I/O; CPU/memory sampling is the desktop Host's job.
 */
export function listChildProcesses(
  tracked: readonly McpTrackedProcess[],
): ZCodeProcessChildProcessesResult {
  return {
    processes: tracked.map((process) => {
      const pluginName =
        process.pluginName ??
        (process.mcpSource === "builtin"
          ? resolveOfficialPluginNameByHostMcpServerName(process.serverName)
          : undefined);
      return {
        pid: process.pid,
        serverName: process.serverName,
        mcpSource: process.mcpSource,
        ...(pluginName ? { pluginName } : {}),
      };
    }),
  };
}
