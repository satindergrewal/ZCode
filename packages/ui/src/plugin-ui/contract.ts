import type {
  McpAppsAppToolCallRequest,
  McpAppsDisplayMode,
  McpToolUiCsp,
  PluginSandboxHandle,
  PluginUiScopeRef,
} from "@zcode/shared/mcp-apps";
import { buildPluginSandboxScopeId } from "@zcode/shared/mcp-apps";
import type { AttachmentRef, ConversationInputSource } from "@zcode/shared/zcode-protocol-v4";
import type { ReactNode } from "react";
import type { PluginUiImageBlock } from "./domain/pluginUiImageBlocks.js";

/**
 * Plugin-UI presentation read from ToolCallRow.display.ui; isomorphic to the agent-side display.ui schema,
 * parsed by readPluginUiPresentation; failure returns null and falls back to plain McpToolCallBlock.
 */
export interface PluginUiPresentation {
  /** display.serverName: namespaced server for UI-invoked tools; ownership validated agent-side. */
  serverName: string;
  pluginId: string;
  resourceUri: string;
  preferredDisplayMode?: McpAppsDisplayMode;
  prefersBorder?: boolean;
  csp?: McpToolUiCsp;
  structuredContent?: string;
  widgetMeta?: string;
  /** JSON text of the raw content array; absent means tool-result degrades to plain output text. */
  content?: string;
  truncated?: boolean;
  truncatedBytes?: number;
  /** MCP result isError (the v4 row is still success); tool-result carries isError, panes never overwrite success with it. */
  isError?: true;
  /** Tool-level forced inline (display.ui.showInline). */
  showInline?: true;
  /** Pane id owning this result; a matching open pane tab routes the result into the pane. */
  surface?: string;
}

/**
 * Open-side-pane request: tool cards pass toolCallId, pane entries (launcher/surface routing) surfaceId + serverName.
 * Exactly one of the two.
 */
export type PluginUiOpenTarget =
  | { toolCallId: string; surfaceId?: never; serverName?: string }
  | { surfaceId: string; serverName: string; toolCallId?: never };

export type OpenPluginUiSideTabRequest = PluginUiOpenTarget & {
  parentSessionId: string;
  pluginId: string;
  resourceUri: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
};

/**
 * Side-pane tab ids: tool cards plugin-ui:<ws>:<session>:<pluginId>:<toolCallId>, panes ...:surface:<surfaceId>
 * (distinct namespaces, prefixed against collisions); visible scoped by parentSessionId.
 */
export interface PluginUiSidePaneTab {
  id: string;
  type: "plugin-ui";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  parentSessionId: string;
  toolCallId?: string;
  surfaceId?: string;
  serverName?: string;
  pluginId: string;
  resourceUri: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
}

export const PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX = 240;
/** DOM placement is view; the page instance belongs to the window owner. Cross-container moves ride the keep-alive layer only. */
export interface SandboxPagePlacement {
  node: HTMLElement;
  kind: "flow" | "inline" | "sidebar";
  container?: HTMLElement;
  layer?: number;
}
export const PLUGIN_UI_CARD_MIN_HEIGHT_PX = 80;
export const PLUGIN_UI_CARD_MAX_HEIGHT_PX = 1200;
/**
 * Pane header (AnimatedSidePanePanel TabsList, !h-12 = 48px). fullscreen reports the host-occupied band above the
 * viewport via hostContext.titleBar; the viewport never overlaps it, so insets are 0.
 */
export const PLUGIN_UI_SIDE_PANE_TITLE_BAR = {
  height: 48,
  leftInset: 0,
  viewportLeftInset: 0,
} as const;

/** Request/tab scope: surfaceId first, else toolCallId; neither is an invalid request. */
export function readPluginUiScopeRef(
  input: Pick<OpenPluginUiSideTabRequest, "toolCallId" | "surfaceId">,
): PluginUiScopeRef | null {
  if (input.surfaceId) return { kind: "surface", surfaceId: input.surfaceId };
  if (input.toolCallId) return { kind: "toolCall", toolCallId: input.toolCallId };
  return null;
}

/** Every host binding shares one workspace identity; paths serve execution and display only. */
export interface PluginUiSessionScope {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  sessionId: string;
}

/**
 * Session actions SessionPane registers for plugin UI. Since 4a-0 only follow-up sends remain: widgetState is host memory
 * (app/pluginUiWidgetStateStore), no longer persisted via session commands.
 */
export interface PluginUiSessionActions {
  /** Images become AttachmentRefs via the session upload path, then ride sendText. */
  sendFollowUp(input: {
    prompt: string;
    source: ConversationInputSource;
    images?: readonly PluginUiImageBlock[];
  }): Promise<void>;
}

/** Adapts the existing SessionPane send entry; admission/owner/ACK are never reimplemented. */
export interface PluginUiSessionCommandPort {
  sendText(
    prompt: string,
    options: { source: ConversationInputSource; attachments?: AttachmentRef[] },
  ): Promise<"sent" | "blocked" | "confirmationRequired" | undefined>;
  /** Inline images to session attachment refs (v4 attachmentPut, same path as composer paste). */
  uploadAttachment(input: {
    fileName: string;
    mime: string;
    dataBase64: string;
  }): Promise<AttachmentRef>;
}

export type PluginUiOpenSurfaceRequest = PluginUiOpenTarget & {
  pluginId: string;
  resourceUri: string;
  title: string;
};

export interface PluginUiToolBinding {
  scope: PluginUiSessionScope & { toolCallId: string };
  onOpenSidePane?: (request: PluginUiOpenSurfaceRequest) => void;
}

export function buildPluginUiSessionKey(target: PluginUiSessionScope): string {
  return JSON.stringify([
    target.workspaceIdentity?.trim() || target.workspacePath,
    target.sessionId,
  ]);
}

export function buildPluginUiSurfaceKey(
  target: PluginUiSessionScope & { pluginId: string; serverName?: string; resourceUri?: string },
  scope: PluginUiScopeRef,
): string {
  // Fix: surfaceIds are plugin-chosen and must isolate workspace, session and plugin.
  return JSON.stringify([
    buildPluginUiSessionKey(target),
    target.pluginId,
    target.serverName ?? "",
    target.resourceUri ?? "",
    buildPluginSandboxScopeId(scope),
  ]);
}

export function buildPluginUiSidePaneTabId(request: OpenPluginUiSideTabRequest): string {
  const scope = readPluginUiScopeRef(request);
  if (!scope) throw new Error("plugin-ui side tab needs toolCallId or surfaceId");
  return [
    "plugin-ui",
    request.workspaceIdentity?.trim() || request.workspacePath,
    request.parentSessionId,
    request.pluginId,
    request.serverName ?? "",
    request.resourceUri,
    ...(scope.kind === "toolCall" ? [scope.toolCallId] : ["surface", scope.surfaceId]),
  ]
    .map(encodeURIComponent)
    .join(":");
}

export interface PluginUiSidePaneViewProps {
  scopeRef: PluginUiScopeRef;
  host: {
    pageKey: string;
    handle: PluginSandboxHandle | null;
    phase: "idle" | "preparing" | "mounted" | "running" | "error" | "disposed";
    height: number;
    error: string | null;
    /** Error-state reload. */
    reload(): void;
  };
  loadingLabel: string;
  errorLabel: string;
  retryLabel: string;
  onWidthChange(width: number): void;
}

export interface PluginUiToolCallViewProps {
  supported: boolean;
  fallback: ReactNode;
  surface?: string;
  preferredDisplayMode: McpAppsDisplayMode;
  sidePaneActive: boolean;
  host: PluginUiSidePaneViewProps["host"];
  prefersBorder: boolean;
  /** Superseded by a newer success of the same logical UI: plain record only, no sandbox or auto-pane. */
  superseded: boolean;
  /** Manual pin/collapse (undefined = default); no button when the host gives no entry. */
  pinned?: boolean;
  pinLabel: string;
  unpinLabel: string;
  onTogglePin?: () => void;
  loadingLabel: string;
  errorLabel: string;
  retryLabel: string;
  openedLabel: string;
  openLabel: string;
  onWidthChange(width: number): void;
  onOpenSidePane?: () => void;
}

/**
 * Intake for one sandbox instance's server resource notices. The host registers by (session, plugin, scopeId, generation=initId)
 * and routes projection pluginUi.resourceUpdated/resourceListChanged deltas to instances per subscriber.
 */
export interface PluginUiResourceNotificationTarget {
  notifyInstanceClosed?(): void;
  notifyResourceUpdated(uri: string): void;
  notifyResourceListChanged(): void;
  /** App-Provided Tools instance mailbox: model-initiated page tool calls land here. */
  notifyAppToolCall(call: McpAppsAppToolCallRequest): void;
}
