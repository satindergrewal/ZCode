/**
 * MCP user directory module - types and constants
 */

import type { CliMcpSource, McpFileFormat } from "@zcode/shared";

/**
 * MCP config key names
 * - mcpServers: generic JSON directory format (.agents/mcp.json)
 * - mcp.servers: zcode CLI config.json format
 */
export type McpConfigKeyName = "mcpServers" | "mcp.servers";

export interface McpSourceDescriptor {
  source: CliMcpSource;
  configDirSegments: string[];
  fileName: string;
  format: McpFileFormat;
  configKeyName: McpConfigKeyName;
}

export const MCP_SOURCE_DESCRIPTORS: McpSourceDescriptor[] = [
  {
    source: "zcodeagentmcp",
    configDirSegments: [".zcode", "cli"],
    fileName: "config.json",
    format: "json",
    configKeyName: "mcp.servers",
  },
];

export function getSourceDescriptor(source: CliMcpSource): McpSourceDescriptor {
  const descriptor = MCP_SOURCE_DESCRIPTORS.find((item) => item.source === source);
  if (!descriptor) {
    throw new Error(`Unsupported MCP source: ${source}`);
  }
  return descriptor;
}
