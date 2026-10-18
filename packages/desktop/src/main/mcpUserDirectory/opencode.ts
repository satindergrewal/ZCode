/**
 * MCP user-directory module - OpenCode format conversion.
 */

import type { McpServerConfig } from "@zcode/shared";
import type { OpenCodeMcpServerConfig } from "./types.js";

/**
 * Convert the OpenCode config shape to the standard McpServerConfig.
 * OpenCode: { type: "local", command: ["npx", "-y", "server"], env: {...} }
 * Standard: { command: "npx", args: ["-y", "server"], env: {...} }
 */
export function convertOpenCodeToStandard(config: OpenCodeMcpServerConfig): McpServerConfig {
  const result: McpServerConfig = {};

  if (config.type === "local" && config.command && config.command.length > 0) {
    // The first command element is the binary.
    result.command = config.command[0];
    // The rest are arguments.
    if (config.command.length > 1) {
      result.args = config.command.slice(1);
    }
  } else if (config.type === "remote" && config.url) {
    result.type = "http";
    result.url = config.url;
  }

  if (config.env) {
    result.env = config.env;
  }
  if (config.headers) {
    result.headers = config.headers;
  }

  return result;
}

/**
 * Convert standard McpServerConfig back to the OpenCode shape.
 */
export function convertStandardToOpenCode(config: McpServerConfig): OpenCodeMcpServerConfig {
  const result: OpenCodeMcpServerConfig = {
    type: config.url ? "remote" : "local",
  };

  if (result.type === "local") {
    // Merge command and args into one array.
    const commandParts: string[] = [];
    if (config.command) {
      commandParts.push(config.command);
    }
    if (config.args && config.args.length > 0) {
      commandParts.push(...config.args);
    }
    if (commandParts.length > 0) {
      result.command = commandParts;
    }
  } else {
    if (config.url) {
      result.url = config.url;
    }
  }

  if (config.env) {
    result.env = config.env;
  }
  if (config.headers) {
    result.headers = config.headers;
  }

  return result;
}

/**
 * Check whether a config uses the OpenCode shape.
 */
export function isOpenCodeFormat(config: McpServerConfig): boolean {
  return "type" in config || Array.isArray((config as unknown as OpenCodeMcpServerConfig).command);
}
