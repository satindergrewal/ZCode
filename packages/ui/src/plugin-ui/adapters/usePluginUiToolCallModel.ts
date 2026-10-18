import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildTaskSidePaneMemoryKey,
  claimPluginUiSidePaneAutoOpen,
} from "@/lib/taskSidePaneMemory.js";
import { createPluginUiInteractions } from "@/plugin-ui/adapters/pluginUiInteractions.js";
import { usePluginUiHost } from "@/plugin-ui/adapters/usePluginUiHost.js";
import {
  getPluginUiManualPin,
  setPluginUiManualPin,
  subscribePluginUiDisclosure,
} from "@/plugin-ui/app/pluginUiDisclosureStore.js";
import {
  getPluginUiRowDisposition,
  subscribePluginUiInstances,
} from "@/plugin-ui/app/pluginUiInstanceStore.js";
import {
  claimPluginUiSurface,
  getPluginUiSurface,
  subscribePluginUiSurfaces,
} from "@/plugin-ui/app/pluginUiSurfaceStore.js";
import { buildPluginUiSurfaceKey } from "@/plugin-ui/contract.js";
import { appAllowsDisplayMode } from "@/plugin-ui/domain/buildPluginUiHostContext.js";
import {
  buildPluginUiToolResult,
  isPluginUiToolCancelled,
  readPluginUiToolInput,
} from "@/plugin-ui/domain/pluginUiToolFeed.js";
import { readPluginUiPresentation } from "@/plugin-ui/domain/readPluginUiPresentation.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { resolveTheme } from "@/useTheme.js";
import type {
  McpAppsDisplayMode,
  PluginSandboxHandle,
  PluginUiScopeRef,
} from "@zcode/shared/mcp-apps";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { resolvePluginUiLogicalScope } from "../domain/pluginUiLogicalScope.js";

import type { PluginUiToolCallViewProps } from "@/plugin-ui/contract.js";

const INLINE_AND_FULLSCREEN: readonly McpAppsDisplayMode[] = ["inline", "fullscreen"];
const host_resourceShowInline = (handle: PluginSandboxHandle | null) =>
  handle?.resourceMeta?.showInline === true;
const INLINE_ONLY: readonly McpAppsDisplayMode[] = ["inline"];

/** Tool row to plugin-UI adaptation; React lifecycle and host actions concentrate here, the view gets a display model. */
export function usePluginUiToolCallModel(
  context: ToolCallBlockRenderContext,
): Omit<PluginUiToolCallViewProps, "fallback"> {
  const { intl, locale } = useZCodeIntl();
  const presentation = useMemo(
    () => readPluginUiPresentation(context.toolCallNode.toolCall.raw),
    [context.toolCallNode.toolCall.raw],
  );
  const scope = context.pluginUi?.scope;
  const onOpenSidePane = context.pluginUi?.onOpenSidePane;
  const toolCall = context.toolCallNode.toolCall;
  const [width, setWidth] = useState(0);
  const [displayMode, setDisplayMode] = useState<McpAppsDisplayMode>("inline");
  // Resource-level showInline arrives with the handle; read via ref so host results stay out of render-time derives.
  const hostHandleRef = useRef<PluginSandboxHandle | null>(null);
  const sessionId = scope?.sessionId ?? "";
  const toolScope = useMemo<PluginUiScopeRef>(
    () =>
      presentation?.surface
        ? { kind: "surface", surfaceId: presentation.surface }
        : { kind: "toolCall", toolCallId: toolCall.toolId },
    [toolCall.toolId, presentation?.surface],
  );
  const surfaceTarget = {
    workspacePath: scope?.workspacePath ?? context.workspacePath,
    workspaceIdentity: scope?.workspaceIdentity,
    sessionId,
    pluginId: presentation?.pluginId ?? "",
    serverName: presentation?.serverName,
    resourceUri: presentation?.resourceUri,
  };
  const toolSurfaceKey = buildPluginUiSurfaceKey(
    surfaceTarget,
    resolvePluginUiLogicalScope(presentation ?? {}, toolScope),
  );
  // Pane routing target: when the tool declares a surface, pane-taken-over is judged on the pane tab, not the tool-card tab.
  const routedSurfaceKey = presentation?.surface
    ? buildPluginUiSurfaceKey(surfaceTarget, { kind: "surface", surfaceId: presentation.surface })
    : null;
  const sidePaneActive = useSyncExternalStore(
    subscribePluginUiSurfaces,
    () =>
      getPluginUiSurface(toolSurfaceKey) === "side-pane" ||
      (routedSurfaceKey !== null && getPluginUiSurface(routedSurfaceKey) === "side-pane"),
    () => false,
  );

  const toolInput = useMemo(() => readPluginUiToolInput(toolCall), [toolCall]);
  const toolResult = useMemo(
    () => buildPluginUiToolResult(toolCall, presentation),
    [presentation, toolCall],
  );
  // 4b-1: timeline-derived verdicts (superseded/forced-inline) plus the user's manual pin state.
  const disposition = useSyncExternalStore(
    subscribePluginUiInstances,
    () => getPluginUiRowDisposition(sessionId, toolCall.toolId),
    () => undefined,
  );
  const manualPin = useSyncExternalStore(
    subscribePluginUiDisclosure,
    () => getPluginUiManualPin(sessionId, toolCall.toolId),
    () => undefined,
  );
  const superseded = disposition?.superseded === true;
  const forcedInline =
    disposition?.forcedInline === true || host_resourceShowInline(hostHandleRef.current);
  const pinned = manualPin ?? (forcedInline || disposition?.autoExpand === true);
  const togglePin = useCallback(() => {
    setPluginUiManualPin(sessionId, toolCall.toolId, !pinned);
  }, [pinned, sessionId, toolCall.toolId]);

  const openInSidePane = useCallback(() => {
    if (!presentation) return;

    onOpenSidePane?.({
      // surface tools open the pane tab (results route there); plain tools open the tool-card tab.
      ...(presentation.surface
        ? { surfaceId: presentation.surface, serverName: presentation.serverName }
        : { toolCallId: toolCall.toolId, serverName: presentation.serverName }),
      pluginId: presentation.pluginId,
      resourceUri: presentation.resourceUri,
      title: toolCall.title ?? presentation.pluginId,
    });
  }, [
    onOpenSidePane,
    presentation,
    routedSurfaceKey,
    toolCall.title,
    toolCall.toolId,
    toolSurfaceKey,
  ]);

  const handleDisplayModeRequest = useCallback(
    (mode: McpAppsDisplayMode) => {
      if (mode === "fullscreen" && onOpenSidePane) {
        openInSidePane();
        return "fullscreen";
      }
      setDisplayMode(mode);
      return mode;
    },
    [onOpenSidePane, openInSidePane],
  );
  const handleOpenExternal = useCallback(
    (url: string) => context.onOpenBrowserUrl?.(url),
    [context.onOpenBrowserUrl],
  );

  // MCP business failures can still be completed with UI metadata; result-only checks let error rows fight over one page and leave blanks.
  // Display rule: failed/cancelled stay plain records -- no anchor, no auto-pane; the raw tool-result is untouched.
  const supportedScope =
    Boolean(presentation && scope?.sessionId) &&
    toolCall.status !== "failed" &&
    !isPluginUiToolCancelled(toolCall) &&
    presentation?.isError !== true;
  // availableDisplayModes from the page handshake is a hard constraint (spec MUST NOT): no pane entry, no auto-open without fullscreen.
  // Capabilities arrive at initialized; assume both until then, then push host-context-changed on changes.
  const [appAllowsFullscreen, setAppAllowsFullscreen] = useState(true);
  const canOpenSidePane = Boolean(onOpenSidePane) && appAllowsFullscreen;
  const interactions = useMemo(
    () =>
      scope?.sessionId && presentation
        ? createPluginUiInteractions({
            ...scope,
            sessionId: scope.sessionId,
            pluginId: presentation.pluginId,
            scope: toolScope,
          })
        : undefined,
    [presentation, scope, toolScope],
  );
  // On pane takeover the inline anchor detaches; the manager keeps the same live page.
  // Superseded rows stay plain records; pending/running results placeholder only -- sandboxes wait for results.
  const resultReady = toolResult !== undefined;
  const inlineActive = supportedScope && !sidePaneActive && !superseded && resultReady;
  const host = usePluginUiHost({
    presentation: presentation ?? { serverName: "", pluginId: "", resourceUri: "" },
    scope: {
      workspacePath: scope?.workspacePath ?? context.workspacePath,
      remoteSessionId: scope?.remoteSessionId ?? undefined,
      ...(scope?.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      sessionId,
      scope: toolScope,
    },
    theme: resolveTheme(context.theme ?? "system"),
    locale,
    displayMode,
    toolInput,
    toolResult,
    toolCancelled: isPluginUiToolCancelled(toolCall),
    hostVersion: "zcode",
    // Without a pane entry (read-only/non-desktop shells) or without fullscreen support, declare inline only.
    availableDisplayModes: canOpenSidePane ? INLINE_AND_FULLSCREEN : INLINE_ONLY,
    onDisplayModeRequest: handleDisplayModeRequest,
    onOpenExternal: handleOpenExternal,
    width,
    enabled: inlineActive,
    ...(interactions ? { interactions } : {}),
  });
  hostHandleRef.current = host.handle;
  useEffect(() => {
    setAppAllowsFullscreen(appAllowsDisplayMode(host.appCapabilities, "fullscreen"));
  }, [host.appCapabilities]);
  // Resource-level showInline (with the handle): pin when no manual record exists; collapse bounds recompute from it.
  useEffect(() => {
    if (!supportedScope || host.handle?.resourceMeta?.showInline !== true || !sessionId) return;
    if (getPluginUiManualPin(sessionId, toolCall.toolId) === undefined) {
      setPluginUiManualPin(sessionId, toolCall.toolId, true);
    }
  }, [host.handle, sessionId, supportedScope, toolCall.toolId]);

  useEffect(() => {
    if (!inlineActive || !host.supported) return;
    return claimPluginUiSurface(toolSurfaceKey, "inline");
  }, [inlineActive, host.supported, toolSurfaceKey]);

  // preferredDisplayMode fullscreen: auto-open the pane once, when the card appears.
  // Do not wait for results: on replay/blazing models the result and turn-collapse can land in one commit and the effect would never run.
  // Results are read later by the pane from the live projection via toolCallId/surfaceId.
  const autoOpenKey =
    presentation?.preferredDisplayMode === "fullscreen"
      ? buildPluginUiSurfaceKey(surfaceTarget, { kind: "toolCall", toolCallId: toolCall.toolId })
      : null;
  const sidePaneMemoryKey = buildTaskSidePaneMemoryKey({
    workspacePath: surfaceTarget.workspacePath,
    workspaceIdentity: surfaceTarget.workspaceIdentity,
    taskId: sessionId,
  });
  useEffect(() => {
    if (
      !supportedScope ||
      // History expansion remounts old fullscreen rows; suppress auto-open synchronously or old cards steal the pane back.
      superseded ||
      !host.supported ||
      !autoOpenKey ||
      !canOpenSidePane
    )
      return;
    // Consume already-pane'd calls too, or remount after close re-fires and overrides the user's close.
    if (!claimPluginUiSidePaneAutoOpen(sidePaneMemoryKey, autoOpenKey)) return;
    if (getPluginUiSurface(routedSurfaceKey ?? toolSurfaceKey) === "side-pane") return;
    openInSidePane();
  }, [
    supportedScope,
    superseded,
    host.supported,
    autoOpenKey,
    sidePaneMemoryKey,
    canOpenSidePane,
    openInSidePane,
    routedSurfaceKey,
    toolSurfaceKey,
  ]);

  return {
    supported: supportedScope && host.supported,
    surface: presentation?.surface,
    preferredDisplayMode: presentation?.preferredDisplayMode ?? "inline",
    sidePaneActive,
    host,
    // Resource-level declaration wins, tool-level falls back, neither draws the default border.
    prefersBorder: host.handle?.resourceMeta?.prefersBorder ?? presentation?.prefersBorder ?? true,
    superseded,
    ...(supportedScope && !superseded ? { pinned, onTogglePin: togglePin } : {}),
    pinLabel: intl.formatMessage({ id: "pluginUi.pin" }),
    unpinLabel: intl.formatMessage({ id: "pluginUi.unpin" }),
    loadingLabel: intl.formatMessage({ id: "pluginUi.loading" }),
    errorLabel: intl.formatMessage({ id: "pluginUi.loadFailed" }),
    retryLabel: intl.formatMessage({ id: "pluginUi.retry" }),
    openedLabel: intl.formatMessage({ id: "pluginUi.openedInSidePane" }),
    openLabel: intl.formatMessage({ id: "pluginUi.openInSidePane" }),
    onWidthChange: setWidth,
    onOpenSidePane: canOpenSidePane ? openInSidePane : undefined,
  };
}
