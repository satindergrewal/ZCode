import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { PluginUiRowDisposition } from "./pluginUiInstancePolicy.js";

/** Render-layer per-toolCallId verdicts: derived result plus manual pin/collapse. */
export interface PluginUiRowPinContext {
  disposition?: PluginUiRowDisposition;
  /** Manual pin (true) or collapse (false); undefined follows the default rule. */
  manualPinned?: boolean;
}

export type PluginUiRowPinResolver = (toolCallId: string) => PluginUiRowPinContext | undefined;

/**
 * Should a plugin-UI tool row stay outside the worked-for-N-seconds collapse?
 * Failed/cancelled rows collapse as usual; rows superseded by newer success collapse (plain records); else manual state, forced-inline, then last-three-turns auto-expand.
 * Callers without a resolver (read-only share timelines) keep everything inline.
 */
export function isPluginUiPinnedToolRow(
  row: ConversationRow,
  resolve?: PluginUiRowPinResolver,
): boolean {
  if (row.kind !== "toolCall") return false;
  if (row.status === "error" || row.status === "cancelled") return false;
  const display = row.display;
  if (display?.kind !== "mcp_tool" || display.ui === undefined) return false;
  // MCP isError does not imply a row error; exclude first, then pin/recent-turn rules, so error cards do not stick.
  if (display.ui.isError === true) return false;
  if (!resolve) return true;
  const context = resolve(row.toolCallId);
  if (!context) return true;
  if (context.disposition?.superseded) return false;
  if (context.manualPinned !== undefined) return context.manualPinned;
  if (!context.disposition) return true;
  return context.disposition.forcedInline || context.disposition.autoExpand;
}
