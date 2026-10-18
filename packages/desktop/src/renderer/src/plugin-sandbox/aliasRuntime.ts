import type {
  CallToolResult,
  Implementation,
  ListResourceTemplatesResult,
  ListResourcesResult,
  ReadResourceResult,
  RequestOptions,
  Transport,
} from "@modelcontextprotocol/client";
import { EmptyResultSchema, ListResourceTemplatesResultSchema } from "@modelcontextprotocol/core";
import type {
  McpUiDisplayMode,
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiToolCancelledNotification,
  McpUiToolInputNotification,
  McpUiToolResultNotification,
} from "@modelcontextprotocol/ext-apps";
import type { McpAppsDownloadFileItem } from "@zcode/shared/mcp-apps";
import {
  MCP_APPS_SET_WIDGET_STATE_METHOD,
  MCP_APPS_WIDGET_STATE_CONTEXT_KEY,
} from "@zcode/shared/mcp-apps";
import type { OpenAiCompatApi, ZcodeAliasApi } from "./aliasApi.js";
import { createOpenAiCompatApi, readOpenAiGlobals } from "./openaiAlias.js";

/**
 * Runtime behind the in-iframe `window.zcode` / `window.openai` aliases: a thin wrapper over the
 * official ext-apps `App`. Protocol, handshake and error codes all come from the SDK; no JSON-RPC
 * of our own. Pure logic (messages via the injected App); alias.ts owns the DOM wiring.
 *
 * Lazy connect: the alias ships into every plugin page, while pages building their own official
 * `App` never touch `window.zcode`; handshake waits for the first member access so one page never
 * sends ui/initialize twice.
 */
export interface AliasAppLike {
  connect(transport?: Transport, options?: RequestOptions): Promise<void>;
  getHostVersion(): Implementation | undefined;
  getHostCapabilities(): McpUiHostCapabilities | undefined;
  getHostContext(): McpUiHostContext | undefined;
  ontoolinput: ((params: McpUiToolInputNotification["params"]) => void) | undefined;
  ontoolresult: ((params: McpUiToolResultNotification["params"]) => void) | undefined;
  ontoolcancelled: ((params: McpUiToolCancelledNotification["params"]) => void) | undefined;
  onhostcontextchanged: ((params: McpUiHostContext) => void) | undefined;
  callServerTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<CallToolResult>;
  readServerResource(params: { uri: string }): Promise<ReadResourceResult>;
  listServerResources(params?: { cursor?: string }): Promise<ListResourcesResult>;
  /** Spec methods (resources/templates list, resources/subscribe, ...) and ZCode extensions all go through the base request. */
  request(
    request: { method: string; params?: Record<string, unknown> },
    resultSchema: unknown,
  ): Promise<unknown>;
  setNotificationHandler(
    method: "notifications/resources/updated" | "notifications/resources/list_changed",
    handler: (notification: { params?: { uri?: string } }) => void,
  ): void;
  openLink(params: { url: string }): Promise<unknown>;
  requestDisplayMode(params: { mode: McpUiDisplayMode }): Promise<{ mode: McpUiDisplayMode }>;
  sendSizeChanged(params: { width?: number; height?: number }): Promise<void>;
  sendMessage(params: {
    role: "user";
    content: Array<Record<string, unknown>>;
    structuredContent?: Record<string, unknown>;
  }): Promise<unknown>;
  updateModelContext(params: {
    content?: Array<Record<string, unknown>>;
    structuredContent?: Record<string, unknown>;
  }): Promise<unknown>;
  downloadFile(params: { contents: McpAppsDownloadFileItem[] }): Promise<{ isError?: boolean }>;
}

export const ZCODE_GLOBALS_EVENT = "zcode:globals";

export interface PluginSandboxAliasRuntime {
  zcode: ZcodeAliasApi;
  openai: OpenAiCompatApi;
  /** Handshake done or in flight; diagnostics only. */
  readonly connecting: boolean;
  /**
   * A page-owned official `App` is already talking to the host (host JSON-RPC seen before the
   * alias handshake): the alias stands down. Two `App`s on one page sharing the postMessage
   * channel would collide request ids (both from 0) and deliver initialized twice.
   */
  markForeignApp(): void;
}

export function createPluginSandboxAliasRuntime(options: {
  app: AliasAppLike;
  /** The official App connect defaults to window.parent's PostMessageTransport; inject to control the target window. */
  transport?: Transport;
  protocolVersion: string;
  onChange?: (globals: Record<string, unknown>) => void;
}): PluginSandboxAliasRuntime {
  const { app } = options;
  let toolInput: Record<string, unknown> | null = null;
  let toolOutput: unknown = null;
  let toolResponseMetadata: Record<string, unknown> | null = null;
  let toolCancelled: { reason?: string } | null = null;
  let widgetState: unknown = null;
  let widgetStateSeeded = false;
  let connectPromise: Promise<void> | null = null;
  let foreignApp = false;
  const listeners = new Set<() => void>();
  const resourceUpdatedListeners = new Set<(uri: string) => void>();
  const resourceListChangedListeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
    options.onChange?.(readOpenAiGlobals(openai));
  };

  app.ontoolinput = (params) => {
    toolInput = params.arguments ?? {};
    notify();
  };
  app.ontoolresult = (params) => {
    toolOutput = params.structuredContent ?? null;
    toolResponseMetadata = (params._meta as Record<string, unknown> | undefined) ?? null;
    notify();
  };
  app.ontoolcancelled = (params) => {
    toolCancelled = params.reason ? { reason: params.reason } : {};
    notify();
  };
  app.onhostcontextchanged = () => notify();
  app.setNotificationHandler("notifications/resources/updated", (notification) => {
    const uri = notification.params?.uri;
    if (typeof uri !== "string") return;
    for (const listener of resourceUpdatedListeners) listener(uri);
  });
  app.setNotificationHandler("notifications/resources/list_changed", () => {
    for (const listener of resourceListChangedListeners) listener();
  });

  /** Record failure once; later accesses never retry (same failure semantics as a page-owned App). */
  const ready = (): Promise<void> => {
    if (foreignApp && !connectPromise) {
      return Promise.reject(
        new Error(
          "window.zcode is unavailable: this page already connected its own MCP Apps App; use it directly",
        ),
      );
    }
    if (!connectPromise) {
      connectPromise = app.connect(options.transport).then(
        () => {
          // The widgetState initial value arrives with the handshake via the hostContext extension key (the host sends it once, at bridge creation).
          if (!widgetStateSeeded) {
            widgetStateSeeded = true;
            const seeded = (app.getHostContext() as Record<string, unknown> | undefined)?.[
              MCP_APPS_WIDGET_STATE_CONTEXT_KEY
            ];
            if (seeded !== undefined) widgetState = seeded;
          }
          notify();
        },
        (error) => {
          console.warn("[plugin-sandbox-alias] connect failed", error);
          throw error;
        },
      );
    }
    return connectPromise;
  };
  const whenReady = <T>(run: () => Promise<T>): Promise<T> => ready().then(run);

  const hostContext = () => app.getHostContext() ?? null;
  const zcodeTarget: ZcodeAliasApi = {
    get toolInput() {
      return toolInput;
    },
    get toolOutput() {
      return toolOutput;
    },
    get toolResponseMetadata() {
      return toolResponseMetadata;
    },
    get toolCancelled() {
      return toolCancelled;
    },
    get theme() {
      return hostContext()?.theme ?? null;
    },
    get locale() {
      return hostContext()?.locale ?? null;
    },
    get displayMode() {
      return hostContext()?.displayMode ?? null;
    },
    get maxHeight() {
      // The SDK types containerDimensions as a height|maxHeight union where both branches can carry values; read it as an object.
      const dimensions = hostContext()?.containerDimensions as
        | { height?: number; maxHeight?: number }
        | undefined;
      return dimensions?.maxHeight ?? dimensions?.height ?? null;
    },
    get safeArea() {
      return hostContext()?.safeAreaInsets ?? null;
    },
    get userAgent() {
      return hostContext()?.userAgent ?? null;
    },
    get hostInfo() {
      return app.getHostVersion() ?? null;
    },
    get hostCapabilities() {
      return app.getHostCapabilities() ?? null;
    },
    get hostContext() {
      return hostContext();
    },
    get protocolVersion() {
      return app.getHostVersion() ? options.protocolVersion : null;
    },
    callTool: (name, args) =>
      whenReady(() => app.callServerTool({ name, ...(args ? { arguments: args } : {}) })),
    readResource: (uri) => whenReady(() => app.readServerResource({ uri })),
    listResources: (input) =>
      whenReady(() => app.listServerResources(input?.cursor ? { cursor: input.cursor } : {})),
    listResourceTemplates: (input) =>
      whenReady(
        () =>
          app.request(
            {
              method: "resources/templates/list",
              params: input?.cursor ? { cursor: input.cursor } : {},
            },
            ListResourceTemplatesResultSchema,
          ) as Promise<ListResourceTemplatesResult>,
      ),
    subscribeResource: (uri) =>
      whenReady(() =>
        app.request({ method: "resources/subscribe", params: { uri } }, EmptyResultSchema),
      ).then(() => undefined),
    unsubscribeResource: (uri) =>
      whenReady(() =>
        app.request({ method: "resources/unsubscribe", params: { uri } }, EmptyResultSchema),
      ).then(() => undefined),
    onResourceUpdated(listener) {
      resourceUpdatedListeners.add(listener);
      return () => resourceUpdatedListeners.delete(listener);
    },
    onResourceListChanged(listener) {
      resourceListChangedListeners.add(listener);
      return () => resourceListChangedListeners.delete(listener);
    },
    requestDisplayMode: (input) => whenReady(() => app.requestDisplayMode(input)),
    openExternal(input) {
      void whenReady(() => app.openLink({ url: input.href })).catch(() => undefined);
    },
    downloadFile: (contents) => whenReady(() => app.downloadFile({ contents })),
    notifyIntrinsicHeight(height) {
      void whenReady(() => app.sendSizeChanged({ height })).catch(() => undefined);
    },
    get widgetState() {
      return widgetState;
    },
    setWidgetState(state) {
      widgetState = state;
      notify();
      return whenReady(() =>
        app.request(
          { method: MCP_APPS_SET_WIDGET_STATE_METHOD, params: { widgetState: state } },
          EmptyResultSchema,
        ),
      ).then(() => undefined);
    },
    sendFollowUpMessage: (input) =>
      whenReady(() =>
        app.sendMessage({
          role: "user",
          content: [{ type: "text", text: input.prompt }],
          ...(input.structuredContent ? { structuredContent: input.structuredContent } : {}),
        }),
      ).then(() => undefined),
    updateModelContext: (input) =>
      whenReady(() =>
        app.updateModelContext({
          ...(input.content ? { content: input.content } : {}),
          ...(input.structuredContent ? { structuredContent: input.structuredContent } : {}),
        }),
      ).then(() => undefined),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ready,
  };
  // The first access of any member triggers the handshake (reading toolInput counts: pages typically read first, then await events).
  const lazy = <T extends object>(target: T): T =>
    new Proxy(Object.freeze(target), {
      get(object, key, receiver) {
        if (typeof key === "string") void ready().catch(() => undefined);
        return Reflect.get(object, key, receiver);
      },
    });
  const zcode = lazy(zcodeTarget);
  const openai = lazy(createOpenAiCompatApi(zcodeTarget));

  return {
    zcode,
    openai,
    get connecting() {
      return connectPromise !== null;
    },
    markForeignApp() {
      if (!connectPromise) foreignApp = true;
    },
  };
}
