import type {
  CallToolResult,
  Implementation,
  ListResourceTemplatesResult,
  ListResourcesResult,
  ReadResourceResult,
} from "@modelcontextprotocol/client";
import type {
  McpUiDisplayMode,
  McpUiHostCapabilities,
  McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { McpAppsDownloadFileItem } from "@zcode/shared/mcp-apps";

/** Public shape of `window.zcode` / `window.openai`; implemented in aliasRuntime/openaiAlias, both depending only on this. */
export interface ZcodeAliasApi {
  readonly toolInput: Record<string, unknown> | null;
  readonly toolOutput: unknown;
  readonly toolResponseMetadata: Record<string, unknown> | null;
  readonly toolCancelled: { reason?: string } | null;
  readonly theme: "light" | "dark" | null;
  readonly locale: string | null;
  readonly displayMode: McpUiDisplayMode | null;
  readonly maxHeight: number | null;
  readonly safeArea: McpUiHostContext["safeAreaInsets"] | null;
  readonly userAgent: string | null;
  /** Handshake result exposed verbatim (mirrors the SDK's getHostVersion/getHostCapabilities/getHostContext); null before handshake. */
  readonly hostInfo: Implementation | null;
  readonly hostCapabilities: McpUiHostCapabilities | null;
  readonly hostContext: McpUiHostContext | null;
  readonly protocolVersion: string | null;
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** Read resources from this plugin's server (MCP `resources/read`); MCP-shaped result, blob is base64. */
  readResource(uri: string): Promise<ReadResourceResult>;
  listResources(input?: { cursor?: string }): Promise<ListResourcesResult>;
  listResourceTemplates(input?: { cursor?: string }): Promise<ListResourceTemplatesResult>;
  /**
   * Subscribe to resource changes (ZCode extension; the host advertises
   * `experimental["zcode/resourceSubscribe"]`, the server must declare resources.subscribe).
   * Notifications carry the uri only - pages call readResource themselves; the host unsubscribes
   * when the sandbox is destroyed.
   */
  subscribeResource(uri: string): Promise<void>;
  unsubscribeResource(uri: string): Promise<void>;
  onResourceUpdated(listener: (uri: string) => void): () => void;
  onResourceListChanged(listener: () => void): () => void;
  requestDisplayMode(input: { mode: McpUiDisplayMode }): Promise<{ mode: McpUiDisplayMode }>;
  openExternal(input: { href: string }): void;
  /** Ask the host to save a file (`<a download>` is blocked in the sandbox); any cancel/failure resolves `{ isError: true }`. */
  downloadFile(contents: McpAppsDownloadFileItem[]): Promise<{ isError?: boolean }>;
  notifyIntrinsicHeight(height: number): void;
  /** Widget state: the initial value arrives via the hostContext extension key at handshake; readable locally right after setWidgetState. */
  readonly widgetState: unknown;
  /**
   * ZCode extension `ui/set-widget-state` (host advertises `experimental["zcode/widgetState"]`):
   * kept in host memory for the session with no cross-process restore promise; rejects -32601 when
   * the host is unavailable. Use updateModelContext for model-visible information.
   */
  setWidgetState(widgetState: unknown): Promise<void>;
  /** Send a follow-up message as the user; without a fresh user gesture the host confirms via dialog, and user cancel rejects. */
  sendFollowUpMessage(input: {
    prompt: string;
    structuredContent?: Record<string, unknown>;
  }): Promise<void>;
  /** Context attached to the next prompt (visible and removable in the composer). */
  updateModelContext(input: {
    content?: Array<Record<string, unknown>>;
    structuredContent?: Record<string, unknown>;
  }): Promise<void>;
  /** Called after every tool-input / tool-result / tool-cancelled / host-context-changed / setWidgetState. */
  subscribe(listener: () => void): () => void;
  /** Trigger the handshake explicitly; otherwise the first access of any member does. */
  ready(): Promise<void>;
}

/** The `window.openai` compat intersection: compat-interface members, all delegating to one instance; unsupported members stay undefined. */
export interface OpenAiCompatApi {
  readonly toolInput: Record<string, unknown> | null;
  readonly toolOutput: unknown;
  readonly toolResponseMetadata: Record<string, unknown> | null;
  readonly widgetState: unknown;
  readonly theme: "light" | "dark" | null;
  readonly locale: string | null;
  readonly displayMode: McpUiDisplayMode | null;
  readonly maxHeight: number | null;
  readonly safeArea: McpUiHostContext["safeAreaInsets"] | null;
  readonly userAgent: string | null;
  setWidgetState(state: unknown): Promise<void>;
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  sendFollowUpMessage(input: { prompt: string }): Promise<void>;
  requestDisplayMode(input: { mode: McpUiDisplayMode }): Promise<{ mode: McpUiDisplayMode }>;
  openExternal(input: { href: string }): void;
  notifyIntrinsicHeight(height: number): void;
}
