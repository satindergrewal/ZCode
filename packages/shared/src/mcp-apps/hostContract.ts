/**
 * Second half of the MCP Apps host-side contract: ui/download-file items, tool-input / tool-result payloads, and the host-provided titleBar and style variables.
 * hostInfo / hostCapabilities / hostContext reuse the official SDK `McpUiHostCapabilities` / `McpUiHostContext`; no local duplicates.
 */

/**
 * One item of `ui/download-file { contents }` -- an MCP EmbeddedResource (inline text / blob)
 * or a ResourceLink (uri only; the host fetches content via the same plugin server's `resources/read`).
 */
export type McpAppsDownloadFileItem =
  | {
      type: "resource";
      resource: { uri: string; name?: string; mimeType?: string; text?: string; blob?: string };
    }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string };
/** Per-call ui/download-file item cap and per-file decoded size cap (same 50 MiB as desktop saveFile). */
export const MCP_APPS_DOWNLOAD_FILE_MAX_ITEMS = 16;
export const MCP_APPS_DOWNLOAD_FILE_MAX_BYTES = 50 * 1024 * 1024;

/** MCP content blocks (text / image / resource...); the host passes them through and never interprets non-text blocks. */
export type McpAppsContentBlock = Record<string, unknown>;

/** Payloads for `ui/notifications/tool-input` and `tool-result` (same shape as the official SDK notification params). */
export interface McpAppsToolInputPayload {
  arguments?: Record<string, unknown>;
}
export interface McpAppsToolResultPayload {
  content?: McpAppsContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/** Panel chrome the host draws above the page viewport; provided in fullscreen only (hostContext allows extra keys). */
export interface McpAppsHostTitleBar {
  height: number;
  leftInset: number;
  viewportLeftInset: number;
}
/** Standard MCP Apps style variables (keys per official `McpUiStyleVariableKey`); values are CSS text the page can use directly. */
export type McpAppsStyleVariables = Record<string, string>;
