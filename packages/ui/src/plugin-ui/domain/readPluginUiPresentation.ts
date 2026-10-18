import { mcpToolDisplayUiSchema } from "@zcode/shared/mcp-apps";
import type { PluginUiPresentation } from "../contract.js";

/**
 * Read plugin-UI presentation from ToolCallRow legacy raw.display. display.ui is agent-projected and strict-schema
 * validated at rest; re-validating here defends against old snapshots or hand edits, falling back to plain McpToolCallBlock.
 */
export function readPluginUiPresentation(raw: unknown): PluginUiPresentation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const display = (raw as { display?: unknown }).display;
  if (typeof display !== "object" || display === null) return null;
  const record = display as Record<string, unknown>;
  if (record.kind !== "mcp_tool" || typeof record.serverName !== "string") return null;
  const parsed = mcpToolDisplayUiSchema.safeParse(record.ui);
  if (!parsed.success) return null;
  return { serverName: record.serverName, ...parsed.data };
}

/** Parse JSON-text structuredContent/widgetMeta from display.ui; invalid JSON means absent. */
export function parseJsonText(text: string | undefined): unknown {
  if (typeof text !== "string" || text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
