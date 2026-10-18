import type { McpUiAppCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { IPluginUiAppToolsService, PluginUiPluginScope } from "@zcode/services";
import {
  MCP_APPS_APP_TOOLS_MAX_PER_INSTANCE,
  MCP_APPS_APP_TOOLS_REFRESH_INTERVAL_MS,
  MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS,
  MCP_APPS_APP_TOOL_ERROR_MESSAGE_MAX_CHARS,
  normalizeMcpAppsAppTools,
  type McpAppsAppToolCallRequest,
  type McpAppsAppToolCallResult,
} from "@zcode/shared/mcp-apps";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";

/** tools/list paging cap: enough for 50 tools, guarding against endless cursors. */
const MAX_TOOL_LIST_PAGES = 10;
/**
 * Claim/return are idempotent by callId: transport failures retry; accepted false is the agent's verdict, no retry.
 * Total wait (0.5s + 1s) fits inside the 5s claim window.
 */
export const PLUGIN_UI_APP_TOOL_RPC_ATTEMPTS = 3;
export const PLUGIN_UI_APP_TOOL_RPC_RETRY_DELAY_MS = 500;

export interface PluginUiAppTools {
  isBusy(): boolean;
  /** New port: unregister the previous page instance (it re-registers per its own capabilities post-handshake). */
  resetForAttach(): void;
  /** Handshake done: discover/register only when appCapabilities.tools is declared; listen for listChanged when declared. */
  onInitialized(
    active: PluginUiHostBridge,
    capabilities: McpUiAppCapabilities | undefined,
    isCurrent: () => boolean,
  ): void;
  /** Mailbox delivery: claim and run on the page (dedup by callId). */
  execute(active: PluginUiHostBridge, call: McpAppsAppToolCallRequest): void;
  /** Instance destroyed: unregister (best effort). */
  dispose(): void;
}

/**
 * Render-side of App-Provided Tools: discover page tools and register with the agent; model calls arrive via the instance mailbox,
 * claim, page tools/call, return. The agent owns the registry and call state; here only callIds this instance began.
 */
export function createPluginUiAppTools(deps: {
  bridge: IPluginUiAppToolsService;
  pluginScope: () => PluginUiPluginScope;
  scopeId: string;
  /** Current instance generation; undefined until the port arrives. */
  currentGeneration: () => number | undefined;
  setTimer: (callback: () => void, ms: number) => () => void;
  now?: () => number;
  onBusyChange?(): void;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}): PluginUiAppTools {
  const now = deps.now ?? Date.now;
  const pins = new Set<string>();
  let registeredGeneration: number | null = null;
  let refreshing = false;
  let pendingRefresh = false;
  let lastRefreshAt = 0;
  let cancelRefreshTimer: (() => void) | null = null;
  let epoch = 0;
  const started = new Set<string>();
  const calls = new Map<string, AbortController>();

  const instanceParams = (generation: number) => ({
    ...deps.pluginScope(),
    scopeId: deps.pluginScope().instance.token,
    generation,
  });

  const unregister = () => {
    const generation = registeredGeneration;
    registeredGeneration = null;
    if (generation === null) return;
    void deps.bridge.unregisterAppTools(instanceParams(generation)).catch(() => undefined);
  };

  const listTools = async (active: PluginUiHostBridge) => {
    const tools: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
      const result = await active.listTools(cursor ? { cursor } : {});
      tools.push(...result.tools);
      if (tools.length >= MCP_APPS_APP_TOOLS_MAX_PER_INSTANCE || !result.nextCursor) break;
      if (result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  };

  const refresh = async (active: PluginUiHostBridge, isCurrent: () => boolean) => {
    const generation = deps.currentGeneration();
    if (generation === undefined) return;
    const runEpoch = epoch;
    const bound = instanceParams(generation);
    refreshing = true;
    lastRefreshAt = now();
    try {
      const { tools, skipped } = normalizeMcpAppsAppTools(await listTools(active));
      if (skipped.length > 0) deps.log?.("[plugin-ui] app tools skipped", { skipped });
      if (!isCurrent() || runEpoch !== epoch) return;
      await deps.bridge.registerAppTools({ ...bound, tools });
      if (!isCurrent() || runEpoch !== epoch) {
        // The instance was replaced/destroyed mid-registration: add a cleanup unregister so closed pages vanish from the agent.
        void deps.bridge.unregisterAppTools(bound).catch(() => undefined);
        return;
      }
      registeredGeneration = generation;
    } catch (error) {
      deps.log?.("[plugin-ui] app tools registration failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      refreshing = false;
    }
    if (pendingRefresh && isCurrent() && runEpoch === epoch) {
      pendingRefresh = false;
      schedule(active, isCurrent);
    }
  };

  // list_changed throttle: re-registrations at least 1s apart; bursts in the window collapse into one trailing refresh.
  const schedule = (active: PluginUiHostBridge, isCurrent: () => boolean) => {
    if (refreshing) {
      pendingRefresh = true;
      return;
    }
    if (cancelRefreshTimer) return;
    const wait = Math.max(0, lastRefreshAt + MCP_APPS_APP_TOOLS_REFRESH_INTERVAL_MS - now());
    if (wait === 0) {
      void refresh(active, isCurrent);
      return;
    }
    cancelRefreshTimer = deps.setTimer(() => {
      cancelRefreshTimer = null;
      if (isCurrent()) void refresh(active, isCurrent);
    }, wait);
  };

  const withRetry = async <T>(run: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        if (attempt >= PLUGIN_UI_APP_TOOL_RPC_ATTEMPTS) throw error;
        await new Promise<void>((resolve) => {
          deps.setTimer(resolve, PLUGIN_UI_APP_TOOL_RPC_RETRY_DELAY_MS * attempt);
        });
      }
    }
  };

  const run = async (
    active: PluginUiHostBridge,
    call: McpAppsAppToolCallRequest,
    cancel: AbortController,
  ) => {
    const generation = deps.currentGeneration();
    if (generation === undefined) return;
    const scope = { ...instanceParams(generation), callId: call.callId };
    const { accepted } = await withRetry(() => deps.bridge.claimAppToolCall(scope));
    if (!accepted || cancel.signal.aborted) return;
    let outcome: { result: McpAppsAppToolCallResult } | { error: { message: string } };
    try {
      const result = await active.callTool(
        { name: call.toolName, arguments: call.arguments },
        { timeout: MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS, signal: cancel.signal },
      );
      outcome = { result: result as McpAppsAppToolCallResult };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = { error: { message: message.slice(0, MCP_APPS_APP_TOOL_ERROR_MESSAGE_MAX_CHARS) } };
    }
    await withRetry(() => deps.bridge.resolveAppToolCall({ ...scope, ...outcome }));
  };

  return {
    isBusy: () => calls.size > 0 || pins.size > 0,
    resetForAttach() {
      epoch += 1;
      for (const cancel of calls.values()) cancel.abort();
      calls.clear();
      pins.clear();
      cancelRefreshTimer?.();
      cancelRefreshTimer = null;
      pendingRefresh = false;
      started.clear();
      unregister();
    },
    onInitialized(active, capabilities, isCurrent) {
      if (!capabilities?.tools) return;
      if (capabilities.tools.listChanged) {
        active.setNotificationHandler("notifications/tools/list_changed", () => {
          if (isCurrent()) schedule(active, isCurrent);
        });
      }
      void refresh(active, isCurrent);
    },
    execute(active, call) {
      if (call.activity !== undefined) {
        if (call.activity) pins.add(call.callId);
        else pins.delete(call.callId);
        deps.onBusyChange?.();
        return;
      }
      if (call.cancelled) {
        calls.get(call.callId)?.abort();
        started.add(call.callId);
        return;
      }
      // Mailbox dedup by callId: replays/redeliveries never run the page twice.
      if (started.has(call.callId)) return;
      started.add(call.callId);
      const cancel = new AbortController();
      calls.set(call.callId, cancel);
      deps.onBusyChange?.();
      void run(active, call, cancel)
        .catch((error) => {
          deps.log?.("[plugin-ui] app tool call relay failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          calls.delete(call.callId);
          deps.onBusyChange?.();
        });
    },
    dispose() {
      epoch += 1;
      for (const cancel of calls.values()) cancel.abort();
      calls.clear();
      pins.clear();
      cancelRefreshTimer?.();
      cancelRefreshTimer = null;
      unregister();
    },
  };
}
