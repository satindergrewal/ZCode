import type { Transport } from "@modelcontextprotocol/client";
import type {
  McpUiAppCapabilities,
  McpUiDisplayMode,
  McpUiHostCapabilities,
  McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  IPluginUiAppToolsService,
  IPluginUiBridgeService,
  IPluginUiSamplingService,
} from "@zcode/services";
import type {
  McpAppsToolInputPayload,
  McpAppsToolResultPayload,
  PluginSandboxHandle,
  PluginSandboxPlatformPort,
  PluginSandboxTransportPort,
  PluginUiScopeRef,
} from "@zcode/shared/mcp-apps";
import type { PluginUiPresentation, PluginUiResourceNotificationTarget } from "../contract.js";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";
import { type PluginUiInteractionCallbacks } from "./pluginUiInteractionPorts.js";

/**
 * Host-side orchestration: prepareSandbox -> hang webview by handle -> await port matching initId -> AppBridge(null) over the transport ->
 * after initialized feed tool-input/tool-result -> serve tools/call, resources/*, open-link, size-changed.
 * All IO injected via deps; the page manager owns the controller, hooks only register display anchors.
 */
export type PluginUiHostPhase = "idle" | "preparing" | "mounted" | "running" | "error" | "disposed";

export interface PluginUiHostScope {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  /** Tool card { kind: "toolCall" } or pane { kind: "surface" }; maps to the sandbox scopeId in idempotency keys. */
  scope: PluginUiScopeRef;
}

/** Page-side feed; read once at initialized, later changes via notify*. */
export interface PluginUiToolFeed {
  toolInput?: McpAppsToolInputPayload;
  toolResult?: McpAppsToolResultPayload;
  toolCancelled?: boolean;
}

export interface PluginUiHostControllerDeps extends PluginUiInteractionCallbacks {
  onBusyChange?(): void;
  onInstanceClosed?(): void;
  createTransport(port: PluginSandboxTransportPort): Transport;
  bridge: Pick<
    IPluginUiBridgeService,
    | "closeInstance"
    | "recycleInstance"
    | "validateInstance"
    | "prepareSandbox"
    | "callTool"
    | "cancelToolCall"
    | "readResource"
    | "listResources"
    | "listResourceTemplates"
    | "subscribeResource"
    | "unsubscribeResource"
  >;
  /** App-Provided Tools channel; without it (web/remote) page tools are never discovered or registered. */
  sampling?: IPluginUiSamplingService;
  appTools?: IPluginUiAppToolsService;
  platform: PluginSandboxPlatformPort;
  /**
   * Per agent-generation resource-notice intake; the host routes projection server notices here.
   * Absent = no registration (subscribe still works, notices never arrive).
   */
  resourceNotifications?: {
    register(
      generation: number,
      target: PluginUiResourceNotificationTarget,
      instance: PluginSandboxHandle["instance"],
    ): () => void;
  };
  /** Id factory for UI-initiated calls; defaults to crypto.randomUUID. */
  createCallId?: () => string;
  /** Timers for handshake timeout/teardown wait; default setTimeout. Returns a cancel fn. */
  setTimer?: (callback: () => void, ms: number) => () => void;
  scope: PluginUiHostScope;
  presentation: PluginUiPresentation;
  /** Read once at initialized for the latest tool input/result. */
  getToolFeed(): PluginUiToolFeed;
  /** Initial widgetState (host memory store, single owner); read at port arrival, undefined = none. */
  getWidgetState(): unknown;
  /** Read at AppBridge creation; capabilities declared per then-available interactions. */
  getHostCapabilities(): McpUiHostCapabilities;
  initialHostContext: McpUiHostContext;
  hostVersion: string;
  onPhase(
    phase: PluginUiHostPhase,
    detail?: { handle?: PluginSandboxHandle; error?: string },
  ): void;
  onHeight(height: number): void;
  /** ui/request-display-mode: the host verdict returns the actual mode (inline-to-pane and pane-close happen here). */
  onDisplayModeRequest(mode: McpUiDisplayMode): McpUiDisplayMode;
  onOpenExternal(url: string): void;
  /** Once, after initialized: the page's declared appCapabilities (maybe undefined). */
  onAppCapabilities?: (capabilities: McpUiAppCapabilities | undefined) => void;
  log?: (message: string, detail?: Record<string, unknown>) => void;
  /** Defaults to new AppBridge(null, ...); tests inject fakes. */
  createAppBridge?: (
    hostInfo: { name: string; version: string },
    hostCapabilities: McpUiHostCapabilities,
    hostContext: McpUiHostContext,
  ) => PluginUiHostBridge;
  handshakeTimeoutMs?: number;
  teardownTimeoutMs?: number;
}

export interface PluginUiHostController {
  isBusy(): boolean;
  tryRecycle(): Promise<boolean>;
  start(): void;
  updateHostContext(patch: Partial<McpUiHostContext>): void;
  /** Pane moved to a newer call: push ui/notifications/tool-input. */
  notifyToolInput(input: McpAppsToolInputPayload): void;
  notifyToolResult(result: McpAppsToolResultPayload): void;
  /** Host tool stopped: ui/notifications/tool-cancelled. */
  notifyToolCancelled(): void;
  dispose(): Promise<void>;
  readonly phase: PluginUiHostPhase;
}
