import { createPluginUiSampling } from "./pluginUiSampling.js";
import type { CallToolResult, Transport } from "@modelcontextprotocol/client";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { PluginSandboxHandle, PluginSandboxTransportPort } from "@zcode/shared/mcp-apps";
import {
  MCP_APPS_HANDSHAKE_TIMEOUT_MS,
  MCP_APPS_HOST_NAME,
  MCP_APPS_WIDGET_STATE_CONTEXT_KEY,
  buildPluginSandboxScopeId,
} from "@zcode/shared/mcp-apps";
import { createPluginUiAppTools } from "./pluginUiAppTools.js";
import {
  installPluginUiHostAppHandlers,
  installPluginUiHostNotificationHandlers,
} from "./pluginUiHostAppHandlers.js";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";
import type {
  PluginUiHostController,
  PluginUiHostControllerDeps,
  PluginUiHostPhase,
  PluginUiToolFeed,
} from "./pluginUiHostControllerContract.js";
import { runPluginUiHostTeardown } from "./pluginUiHostTeardown.js";
import { wirePluginUiInteractions } from "./pluginUiInteractionPorts.js";
import { createPluginUiResourceSubscriptions } from "./pluginUiResourceSubscriptions.js";

export type {
  PluginUiHostController,
  PluginUiHostControllerDeps,
  PluginUiHostPhase,
  PluginUiHostScope,
} from "./pluginUiHostControllerContract.js";
export function createPluginUiHostController(
  deps: PluginUiHostControllerDeps,
): PluginUiHostController {
  let phase: PluginUiHostPhase = "idle";
  let handle: PluginSandboxHandle | null = null;
  let bridge: PluginUiHostBridge | null = null;
  let boundScope:
    | (ReturnType<typeof baseScope> & { instance: PluginSandboxHandle["instance"] })
    | null = null;
  let transport: Transport | null = null;
  let unsubscribePorts: (() => void) | null = null;
  let hostContext: McpUiHostContext = deps.initialHostContext;
  let disposed = false;
  let disposal: Promise<void> | null = null;
  let preparation: Promise<void> | null = null;
  let recycling = false;
  let closedDuringRecycle = false;
  // initialized seen: send* direct; earlier notify* do not queue -- initialized reads the latest via getToolFeed.
  let attached = false;
  let cancelHandshakeTimer: (() => void) | null = null;
  // In-flight page tool-call ids; dispose cancels each toward the agent.
  const activeCalls = new Set<string>();
  let unregisterNotifications: (() => void) | null = null;
  const createCallId = deps.createCallId ?? (() => crypto.randomUUID());
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    });
  const createAppBridge =
    deps.createAppBridge ??
    ((hostInfo, hostCapabilities, initialContext) =>
      new AppBridge(null, hostInfo, hostCapabilities, {
        hostContext: initialContext,
      }) as unknown as PluginUiHostBridge);

  const setPhase = (
    next: PluginUiHostPhase,
    detail?: { handle?: PluginSandboxHandle; error?: string },
  ) => {
    phase = next;
    deps.onPhase(next, detail);
  };
  const fail = (error: unknown) => {
    if (disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    deps.log?.("[plugin-ui] host failed", { message });
    setPhase("error", { error: message });
  };

  // Ownership scope shared by all bridged requests: workspace + session + this plugin server.
  const baseScope = () => ({
    workspacePath: deps.scope.workspacePath,
    ...(deps.scope.workspaceIdentity ? { workspaceIdentity: deps.scope.workspaceIdentity } : {}),
    sessionId: deps.scope.sessionId,
    pluginId: deps.presentation.pluginId,
    serverName: deps.presentation.serverName,
  });

  const pluginScope = () => {
    if (!boundScope) throw new Error("MCP App is not prepared");
    return boundScope;
  };

  const sampling = deps.sampling
    ? createPluginUiSampling({
        bridge: deps.sampling,
        scope: pluginScope,
        canSample: () => Boolean(deps.getHostCapabilities().sampling),
        createCallId,
        activeCalls,
        onBusyChange: deps.onBusyChange,
      })
    : undefined;

  const resources = createPluginUiResourceSubscriptions({
    bridge: deps.bridge,
    pluginScope,
    scopeId: buildPluginSandboxScopeId(deps.scope.scope),
    currentGeneration: () => handle?.instance.generation,
    isDisposed: () => disposed,
  });

  // App-Provided Tools: discover/register page tools post-handshake; mailbox deliveries claim and run on the page. Skipped entirely without the channel.
  const appTools = deps.appTools
    ? createPluginUiAppTools({
        bridge: deps.appTools,
        pluginScope,
        scopeId: buildPluginSandboxScopeId(deps.scope.scope),
        currentGeneration: () => handle?.instance.generation,
        onBusyChange: deps.onBusyChange,
        setTimer,
        log: deps.log,
      })
    : null;

  const sendFeed = (active: PluginUiHostBridge, feed: PluginUiToolFeed) => {
    if (feed.toolInput) void active.sendToolInput(feed.toolInput).catch(() => undefined);
    if (feed.toolCancelled) {
      void active.sendToolCancelled({}).catch(() => undefined);
    } else if (feed.toolResult) {
      void active.sendToolResult(feed.toolResult as CallToolResult).catch(() => undefined);
    }
  };

  const attachPort = (port: PluginSandboxTransportPort) => {
    sampling?.reset();
    void transport?.close().catch(() => undefined);
    attached = false;
    cancelHandshakeTimer?.();
    // New port = reload/remount: drop old-generation subscriptions, unregister old tool claims; re-register notices per new generation.
    resources.unsubscribeAll();
    appTools?.resetForAttach();
    const widgetState = deps.getWidgetState();
    // Initial widgetState rides hostContext extension keys at handshake (extra keys allowed); never pushed from the host again.
    const contextAtCreate: McpUiHostContext =
      widgetState === undefined
        ? hostContext
        : { ...hostContext, [MCP_APPS_WIDGET_STATE_CONTEXT_KEY]: widgetState };
    const active = createAppBridge(
      { name: MCP_APPS_HOST_NAME, version: deps.hostVersion },
      deps.getHostCapabilities(),
      contextAtCreate,
    );
    const baseContext = hostContext;
    bridge = active;
    // Two Apps in one page (own + alias) each send initialize/initialized: enter running on the first and feed only then.
    let initializedOnce = false;
    active.oninitialized = () => {
      if (disposed || bridge !== active || initializedOnce) return;
      initializedOnce = true;
      cancelHandshakeTimer?.();
      cancelHandshakeTimer = null;
      attached = true;
      setPhase("running", { handle: handle ?? undefined });
      deps.onAppCapabilities?.(active.getAppCapabilities());
      appTools?.onInitialized(
        active,
        active.getAppCapabilities(),
        () => !disposed && bridge === active,
      );
      // Updates inside the handshake window cannot be dropped: refresh this instance's latest only, no second state owner.
      if (hostContext !== baseContext) active.setHostContext(hostContext);
      sendFeed(active, deps.getToolFeed());
    };
    installPluginUiHostAppHandlers(active, {
      currentContext: () => hostContext,
      applyDisplayMode: (mode) => {
        hostContext = { ...hostContext, displayMode: mode };
        if (attached && bridge === active) active.setHostContext(hostContext);
      },
      onDisplayModeRequest: deps.onDisplayModeRequest,
      pluginScope: () => {
        if (disposed) throw new Error("MCP App instance was closed");
        return pluginScope();
      },
      bridge: deps.bridge,
      createCallId,
      activeCalls,
      onBusyChange: deps.onBusyChange,
      onOpenExternal: deps.onOpenExternal,
    });
    sampling?.install(active, () => !disposed && bridge === active);
    resources.install(active);
    wirePluginUiInteractions(active, deps, deps.platform, () => handle);
    installPluginUiHostNotificationHandlers(active, {
      pluginId: deps.presentation.pluginId,
      onHeight: deps.onHeight,
      log: deps.log,
    });
    const activeTransport = deps.createTransport(port);
    transport = activeTransport;
    cancelHandshakeTimer = setTimer(() => {
      if (disposed || bridge !== active || attached) return;
      fail(new Error("plugin-ui: ui/initialize handshake timed out"));
    }, deps.handshakeTimeoutMs ?? MCP_APPS_HANDSHAKE_TIMEOUT_MS);
    active.connect(activeTransport).catch((error) => {
      if (bridge === active) fail(error);
    });
  };

  return {
    get phase() {
      return phase;
    },
    isBusy: () => activeCalls.size > 0 || (appTools?.isBusy() ?? false),
    async tryRecycle() {
      if (!handle || activeCalls.size || appTools?.isBusy()) return false;
      recycling = true;
      let closed = false;
      try {
        closed = await deps.bridge.recycleInstance(pluginScope());
        return closed;
      } finally {
        recycling = false;
        // A failed reclaim must not swallow source-revoke notices that arrived while waiting.
        if (!closed && closedDuringRecycle && !disposed) deps.onInstanceClosed?.();
        closedDuringRecycle = false;
      }
    },
    start() {
      if (phase !== "idle") return;
      setPhase("preparing");
      preparation = (async () => {
        try {
          const ownerWebContentsId = await deps.platform.getOwnerWebContentsId();
          if (disposed) return;
          const prepared = await deps.bridge.prepareSandbox({
            ...baseScope(),
            scopeId: buildPluginSandboxScopeId(deps.scope.scope),
            resourceUri: deps.presentation.resourceUri,
            ownerWebContentsId,
            ...(deps.presentation.csp ? { csp: deps.presentation.csp } : {}),
            ...(deps.presentation.prefersBorder !== undefined
              ? { prefersBorder: deps.presentation.prefersBorder }
              : {}),
          });
          // When Host/Main already registered the prepare, teardown cannot just ignore the reply: the sandbox would leak.
          if (disposed) {
            await deps.bridge.closeInstance({ ...baseScope(), instance: prepared.instance });
            await deps.platform.disposeSandbox(prepared.sandboxId, prepared.initId);
            return;
          }
          try {
            await deps.bridge.validateInstance({ ...baseScope(), instance: prepared.instance });
          } catch (error) {
            await deps.bridge
              .closeInstance({ ...baseScope(), instance: prepared.instance })
              .catch(() => undefined);
            await deps.platform.disposeSandbox(prepared.sandboxId, prepared.initId);
            throw error;
          }
          if (disposed) {
            await deps.bridge
              .closeInstance({ ...baseScope(), instance: prepared.instance })
              .catch(() => undefined);
            await deps.platform.disposeSandbox(prepared.sandboxId, prepared.initId);
            return;
          }
          handle = prepared;
          boundScope = { ...baseScope(), instance: prepared.instance };
          // Subscribe to the port before mounting the webview: main delivers after guest dom-ready; late subscription misses it.
          unsubscribePorts?.();
          unsubscribePorts = deps.platform.onPorts((event) => {
            if (disposed || !handle || event.sandboxId !== handle.sandboxId) return;
            // Ports of older initIds are always dropped (guest reload / remount anti-crosstalk).
            if (event.initId < handle.initId) return;
            handle = { ...handle, initId: event.initId };
            attachPort(event.port);
          });
          unregisterNotifications?.();
          unregisterNotifications =
            deps.resourceNotifications?.register(
              prepared.instance.generation,
              {
                notifyInstanceClosed: () => {
                  if (recycling) closedDuringRecycle = true;
                  else if (!disposed) deps.onInstanceClosed?.();
                },
                notifyResourceUpdated: (uri) => {
                  if (!bridge || !attached || !resources.has(uri)) return;
                  void bridge
                    .notification({ method: "notifications/resources/updated", params: { uri } })
                    .catch(() => undefined);
                },
                notifyResourceListChanged: () => {
                  if (!bridge || !attached) return;
                  void bridge
                    .notification({ method: "notifications/resources/list_changed", params: {} })
                    .catch(() => undefined);
                },
                notifyAppToolCall: (call) => {
                  if (!bridge || !attached) return;
                  appTools?.execute(bridge, call);
                },
              },
              prepared.instance,
            ) ?? null;
          setPhase("mounted", { handle: prepared });
        } catch (error) {
          fail(error);
        }
      })();
    },
    updateHostContext(patch) {
      hostContext = { ...hostContext, ...patch };
      if (bridge && attached) bridge.setHostContext(hostContext);
    },
    notifyToolInput(input) {
      if (disposed || !bridge || !attached) return;
      void bridge.sendToolInput(input).catch(() => undefined);
    },
    notifyToolResult(result) {
      if (disposed || !bridge || !attached) return;
      void bridge.sendToolResult(result as CallToolResult).catch(() => undefined);
    },
    notifyToolCancelled() {
      if (disposed || !bridge || !attached) return;
      void bridge.sendToolCancelled({}).catch(() => undefined);
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      cancelHandshakeTimer?.();
      cancelHandshakeTimer = null;
      unsubscribePorts?.();
      unsubscribePorts = null;
      const current = handle;
      const scope = current ? { ...baseScope(), instance: current.instance } : null;
      unregisterNotifications?.();
      unregisterNotifications = null;
      const active = bridge,
        activeTransport = transport,
        wasAttached = attached;
      // Unregister requests capture the original credential; never read the generation from a new handle after await.
      bridge = null;
      transport = null;
      attached = false;
      handle = null;
      setPhase("disposed");
      disposal = (async () => {
        if (scope) await deps.bridge.closeInstance(scope).catch(() => undefined);
        sampling?.reset();
        await preparation;
        resources.unsubscribeAll();
        appTools?.dispose();
        activeCalls.clear();
        await runPluginUiHostTeardown({
          bridge: active,
          transport: activeTransport,
          wasAttached,
          handle: current,
          platform: deps.platform,
          setTimer,
          ...(deps.teardownTimeoutMs !== undefined
            ? { teardownTimeoutMs: deps.teardownTimeoutMs }
            : {}),
        });
      })();
      return disposal;
    },
  };
}
