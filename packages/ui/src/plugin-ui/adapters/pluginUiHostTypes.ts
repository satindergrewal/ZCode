import type { McpUiAppCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  McpAppsDisplayMode,
  McpAppsHostTitleBar,
  McpAppsToolResultPayload,
  PluginSandboxHandle,
} from "@zcode/shared/mcp-apps";
import type {
  PluginUiHostControllerDeps,
  PluginUiHostPhase,
  PluginUiHostScope,
} from "../app/pluginUiHostController.js";
import type { PluginUiPresentation } from "../contract.js";
export interface UsePluginUiHostInput {
  presentation: PluginUiPresentation;
  scope: PluginUiHostScope;
  theme: "light" | "dark";
  locale: string;
  displayMode: McpAppsDisplayMode;
  toolInput: Record<string, unknown> | undefined;
  toolResult: McpAppsToolResultPayload | undefined;
  /** Which call is fed; on change (pane moves to a newer call) toolInput goes out as a tool-input notice. */
  toolCallId?: string;
  /** Host tool stopped: flips true once, sending one tool-cancelled. */
  toolCancelled?: boolean;
  hostVersion: string;
  /** Modes switchable here; both when absent. Changes push host-context-changed. */
  availableDisplayModes?: readonly McpAppsDisplayMode[];
  onDisplayModeRequest?: (mode: McpAppsDisplayMode) => McpAppsDisplayMode;
  onOpenExternal?: (url: string) => void;
  /** Container width for hostContext.containerDimensions; 0 when unknown. */
  width: number;
  /** fullscreen header; absent inline. */
  titleBar?: McpAppsHostTitleBar;
  /** false skips sandbox creation (e.g. pane already owns the scope); default true. */
  enabled?: boolean;
  /** Session interaction callbacks; without them requests answer -32601 and capabilities omit the entry. */
  interactions?: Pick<PluginUiHostControllerDeps, "onSendFollowUpMessage" | "onUpdateModelContext">;
}

export interface UsePluginUiHostResult {
  /** false when the platform/service cannot host plugin UI; callers fall back to the plain MCP card. */
  pageKey: string;
  supported: boolean;
  phase: PluginUiHostPhase;
  handle: PluginSandboxHandle | null;
  height: number;
  error: string | null;
  /** Capabilities declared at ui/initialize; undefined pre-handshake. availableDisplayModes gates fullscreen. */
  appCapabilities: McpUiAppCapabilities | undefined;
  /** Destroy and re-prepare (agent credentials rotated); the error-state button fires it after guest crash/load failure. */
  reload(): void;
}

export interface Page {
  readonly kind: "mcp";
  key: string;
  task: string;
  visible: boolean;
  snapshot(): UsePluginUiHostResult;
  subscribe(listener: () => void): () => void;
  update(input: UsePluginUiHostInput): void;
  bind(node: HTMLElement, sidebar: boolean): () => void;
  busy(): boolean;
  running(): boolean;
  suspend(force?: boolean): Promise<boolean>;
  destroy(): void;
}
