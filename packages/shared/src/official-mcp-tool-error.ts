/* Structured marker sent when official-server MCP intercepts/fails a tool call.
 *
 * The server renders it as **JSON text in tool error content** (not `_meta`):
 * `{"error_code":"quota_exceeded","message":"...","request_id":"..."}`
 * see zcode-server internal/domain/servermcp/toolerror.go ToolError.Error().
 *
 * In shared because three consumers live in different packages:
 * - apps/zcode-cli/packages/core: parses MCP results into the tool result display;
 * - packages/shared/src/zcode-protocol-v4/rows.ts: the row schema validates the code;
 * - packages/ui: picks the above-composer hint copy and action by code.
 * All three must share one source, or a new code gets recognized one side and dropped the other.
 */

/**
 * Codes that change UI behavior.
 *
 * The server also has internal_error, deliberately absent: the catch-all "everything else"
 *(details only in server logs); users cannot self-serve it, so never prompt.
 */
export const OFFICIAL_MCP_TOOL_ERROR_CODES = ["quota_exceeded", "coding_plan_required"] as const;

export type OfficialMcpToolErrorCode = (typeof OFFICIAL_MCP_TOOL_ERROR_CODES)[number];

const OFFICIAL_MCP_TOOL_ERROR_CODE_SET = new Set<string>(OFFICIAL_MCP_TOOL_ERROR_CODES);

export interface OfficialMcpToolError {
  code: OfficialMcpToolErrorCode;
  /// Server's English readable copy; logs/diagnostics only, UI copy via i18n.
  message?: string;
  /// Server request id, for backend log correlation.
  requestId?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Parse the structured marker out of tool-error text.
 *
 * Strict: must be a JSON object whose error_code hits a known code, else undefined.
 * No copy-matching fallback--server rewording must not silently disable it.
 */
export function parseOfficialMcpToolError(text: string): OfficialMcpToolError | undefined {
  const trimmed = text.trim();
  // A first-char check filters most plain error texts before JSON.parse.
  if (!trimmed.startsWith("{")) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;

  const record = payload as Record<string, unknown>;
  const code = readString(record.error_code);
  if (!code || !OFFICIAL_MCP_TOOL_ERROR_CODE_SET.has(code)) return undefined;

  const message = readString(record.message);
  const requestId = readString(record.request_id);
  return {
    code: code as OfficialMcpToolErrorCode,
    ...(message ? { message } : {}),
    ...(requestId ? { requestId } : {}),
  };
}
