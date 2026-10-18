import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { resolvePluginUiLogicalScope } from "./pluginUiLogicalScope.js";

/** Plugin cards from the last few turns expand by default; older ones collapse. */
export const PLUGIN_UI_AUTO_EXPAND_TURNS = 3;

/** One logical UI: only explicit surfaces or permission-compatible widgetSessionIds share; other calls stand alone. */
export interface PluginUiLogicalInstance {
  key: string;
  /** Current display: newest success (non-isError); the newest row when none succeeded. */
  activeToolCallId: string;
  /** Successes superseded by newer ones; no sandbox, plain records only. */
  supersededToolCallIds: string[];
}

/** Per-row display verdict; the render layer derives collapse and sandbox from it. */
export interface PluginUiRowDisposition {
  key: string;
  superseded: boolean;
  /** Turn within the last PLUGIN_UI_AUTO_EXPAND_TURNS. */
  autoExpand: boolean;
  /** Tool-level openai/widgetShowCodexWidgetInline (display.ui.showInline). */
  forcedInline: boolean;
}

export interface PluginUiInstanceDerivation {
  instances: PluginUiLogicalInstance[];
  byToolCallId: Readonly<Record<string, PluginUiRowDisposition>>;
}

export const EMPTY_PLUGIN_UI_INSTANCE_DERIVATION: PluginUiInstanceDerivation = {
  instances: [],
  byToolCallId: {},
};

function isPluginUiToolRow(row: ConversationRow): row is ToolCallRow {
  return (
    row.kind === "toolCall" && row.display?.kind === "mcp_tool" && row.display.ui !== undefined
  );
}

function isSuccessfulUiRow(row: ToolCallRow): boolean {
  return (
    row.status === "success" &&
    !(row.display?.kind === "mcp_tool" && row.display.ui?.isError === true)
  );
}

/**
 * Pure: derive logical UI instances and per-row verdicts from projection rows (V-a).
 * The key binds source, server, resource, permissions and logical view; within a key the newest success replaces earlier ones,
 * while running/failed/isError rows neither replace nor are replaced (each shows its own state).
 * autoExpand takes the most recent N turns across all rows (turns without plugin cards count too).
 */
export function deriveLogicalUiInstances(
  rows: readonly ConversationRow[],
  options: { autoExpandTurns?: number } = {},
): PluginUiInstanceDerivation {
  // domain avoids Map/Set (module boundary rule): arrays and plain objects only.
  const turnOrder: string[] = [];
  for (const row of rows) {
    if (!turnOrder.includes(row.turnId)) turnOrder.push(row.turnId);
  }
  const recentTurns = turnOrder.slice(-(options.autoExpandTurns ?? PLUGIN_UI_AUTO_EXPAND_TURNS));
  const groupKeys: string[] = [];
  const groups: Record<string, ToolCallRow[]> = {};
  for (const row of rows) {
    if (!isPluginUiToolRow(row)) continue;
    const display = row.display;
    if (display?.kind !== "mcp_tool" || !display.ui) continue;
    const logical = resolvePluginUiLogicalScope(display.ui, {
      kind: "toolCall",
      toolCallId: row.toolCallId,
    });
    const key = JSON.stringify([
      display.ui.pluginId,
      display.serverName,
      display.ui.resourceUri,
      logical,
    ]);
    const group = groups[key];
    if (group) group.push(row);
    else {
      groups[key] = [row];
      groupKeys.push(key);
    }
  }
  const instances: PluginUiLogicalInstance[] = [];
  const byToolCallId: Record<string, PluginUiRowDisposition> = {};
  for (const key of groupKeys) {
    const group = groups[key]!;
    const successes = group.filter(isSuccessfulUiRow);
    const active = successes.at(-1) ?? group.at(-1)!;
    const superseded = successes.filter((row) => row !== active).map((row) => row.toolCallId);
    instances.push({ key, activeToolCallId: active.toolCallId, supersededToolCallIds: superseded });
    for (const row of group) {
      byToolCallId[row.toolCallId] = {
        key,
        superseded: superseded.includes(row.toolCallId),
        autoExpand: recentTurns.includes(row.turnId),
        forcedInline: row.display?.kind === "mcp_tool" && row.display.ui?.showInline === true,
      };
    }
  }
  return { instances, byToolCallId };
}
