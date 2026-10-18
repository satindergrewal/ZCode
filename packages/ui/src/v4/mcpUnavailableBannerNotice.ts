import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { OfficialMcpToolErrorCode } from "@zcode/shared";

/**
 * The session-scoped official Server MCP unavailable fact (quota exhausted / no Coding Plan).
 *
 // The fact source is `display.unavailable` on the tool row - the CLI fills it only for official
 // MCP results with isError - so no further origin check is needed here.
 */
export interface McpUnavailableNotice {
  code: OfficialMcpToolErrorCode;
  serverName: string;
  toolName: string;
  /** Dedup: one notice per call; a new failing call notifies again. */
  rowId: number;
}

function readMcpToolCallRow(row: ConversationRow): ToolCallRow | null {
  return row.kind === "toolCall" ? row : null;
}

/**
 * The latest official-MCP tool call carrying the unavailable marker within the window.
 *
 * Latest, not first: one session can hit the quota, switch connections, then hit a missing
 // plan - the notice must follow the most recent fact. rows is a window view, so scrolled-far
 // markers leave it and the notice goes too; the freshest call is always in view. Accepted
 // trade-off.
 */
export function resolveMcpUnavailableNotice(
  rows: readonly ConversationRow[] | undefined,
): McpUnavailableNotice | null {
  if (!rows || rows.length === 0) return null;
  const seenTools = new Set<string>();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) continue;
    const toolCallRow = readMcpToolCallRow(row);
    if (!toolCallRow) continue;
    const display = toolCallRow.display;
    if (display?.kind !== "mcp_tool") continue;
    const toolKey = `${display.serverName}\u0000${display.toolName}`;
    if (seenTools.has(toolKey)) continue;
    seenTools.add(toolKey);
    // A tool's latest success fact overrides its older failure; keep looking for failures not yet covered by a success.
    if (!display.unavailable) continue;
    return {
      code: display.unavailable.code,
      rowId: toolCallRow.rowId,
      serverName: display.serverName,
      toolName: display.toolName,
    };
  }
  return null;
}
