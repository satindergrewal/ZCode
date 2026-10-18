import type {
  ZCodeMcpReadResourceResult,
  ZCodeMcpUiCallToolResult,
  ZCodeMcpUiCancelCallResult,
  ZCodeMcpUiListResourceTemplatesResult,
  ZCodeMcpUiListResourcesResult,
  ZCodeMcpUiReadResourceResult,
  ZCodePluginsListUiSurfacesResult,
} from "@zcode/shared";
import type {
  McpAppResourceMeta,
  PluginSandboxHandle,
  PluginSandboxRegisterInput,
} from "@zcode/shared/mcp-apps";
import {
  MCP_APPS_HTML_MAX_BYTES,
  MCP_APPS_HTML_MIME_TYPES,
  MCP_APPS_UI_READ_RESOURCE_MAX_BYTES,
  normalizeMcpAppResourceMeta,
} from "@zcode/shared/mcp-apps";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  IPluginUiBridgeService,
  PluginUiCallToolParams,
  PluginUiCancelToolCallParams,
  PluginUiListResourcesParams,
  PluginUiPrepareSandboxParams,
  PluginUiReadResourceParams,
  PluginUiResourceSubscriptionParams,
  PluginUiWorkspaceTarget,
} from "./contract.js";

export interface PluginUiBridgeServiceDependencies {
  recycleInstance?: (params: import("./contract.js").PluginUiPluginScope) => Promise<boolean>;
  validateInstance?: (params: import("./contract.js").PluginUiPluginScope) => Promise<void>;
  openInstance?: (
    params: PluginUiPrepareSandboxParams,
  ) => Promise<import("@zcode/shared/mcp-apps").McpAppInstance>;
  closeInstance?: (params: import("./contract.js").PluginUiPluginScope) => Promise<void>;

  readMcpResource?: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    pluginId: string;
    serverName: string;
    uri: string;
    instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  }) => Promise<ZCodeMcpReadResourceResult>;
  callMcpToolForUi?: (
    params: PluginUiCallToolParams,
    options?: { signal?: AbortSignal },
  ) => Promise<ZCodeMcpUiCallToolResult>;
  //* Cancels the in-flight call by id. */
  cancelMcpToolCallForUi?: (
    params: PluginUiCancelToolCallParams,
  ) => Promise<ZCodeMcpUiCancelCallResult>;
  /** Page-initiated resources/read; the agent's mcp/uiReadResource checks ownership and mime. */
  readMcpResourceForUi?: (
    params: PluginUiReadResourceParams,
  ) => Promise<ZCodeMcpUiReadResourceResult>;
  //* Resource list/templates/subscribe proxy; methods throw unavailable without a backend (web/remote). */
  listMcpResourcesForUi?: (
    params: PluginUiListResourcesParams,
  ) => Promise<ZCodeMcpUiListResourcesResult>;
  listMcpResourceTemplatesForUi?: (
    params: PluginUiListResourcesParams,
  ) => Promise<ZCodeMcpUiListResourceTemplatesResult>;
  subscribeMcpResourceForUi?: (params: PluginUiResourceSubscriptionParams) => Promise<unknown>;
  unsubscribeMcpResourceForUi?: (params: PluginUiResourceSubscriptionParams) => Promise<unknown>;
  registerSandbox?: (input: PluginSandboxRegisterInput) => Promise<PluginSandboxHandle>;
  //* Workspace-level plugins/listUiSurfaces. */
  listPluginUiSurfaces?: (
    params: PluginUiWorkspaceTarget,
  ) => Promise<ZCodePluginsListUiSurfacesResult>;
  //* display.ui CSP/prefersBorder arrive via prepare params; passed through untouched. */
}

export class PluginUiBridgeError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "resource_not_found"
      | "resource_too_large"
      | "unsupported_mime_type"
      | "invalid_server_uri",
    message: string,
  ) {
    super(message);
    this.name = "PluginUiBridgeError";
  }
}

/**
 * The agent catalog validates ui:// server ownership; this only splits the server name out of the URI.
 * The namespaced server for ui://<plugin-name>/<path> comes explicitly via params.serverName,
 * never guessed from the URI.
 */
export function createPluginUiBridgeService(
  dependencies: PluginUiBridgeServiceDependencies = {},
): IPluginUiBridgeService {
  // prepare runs once or twice per sandbox: info-level lifecycle trail (read/register/failure) for e2e and field debugging.
  // Fix: create the logger inside the factory, not at module top. This file ships in the renderer bundle via @zcode/services,
  // and a top-level createServiceLogger reads process.pid at import, ReferenceError-ing the whole main UI.
  const log = createServiceLogger("plugin-ui-bridge");
  const preparing = new Map<string, Promise<PluginSandboxHandle>>();
  const prepareSandboxOnce = async (
    params: PluginUiPrepareSandboxParams,
    instance: import("@zcode/shared/mcp-apps").McpAppInstance,
  ) => {
    if (
      !dependencies.readMcpResource ||
      !dependencies.registerSandbox ||
      !dependencies.openInstance
    ) {
      throw new PluginUiBridgeError(
        "unavailable",
        "Plugin UI sandbox is unavailable in this runtime",
      );
    }
    const bound = { ...params, instance };
    const startedAt = Date.now();
    log.info("prepareSandbox start", {
      sessionId: params.sessionId,
      pluginId: params.pluginId,
      scopeId: params.scopeId,
      resourceUri: params.resourceUri,
    });
    let result: ZCodeMcpReadResourceResult;
    try {
      result = await dependencies.readMcpResource({ ...bound, uri: params.resourceUri });
    } catch (error) {
      log.warn("prepareSandbox readResource failed", {
        scopeId: params.scopeId,
        resourceUri: params.resourceUri,
        error: error instanceof Error ? error.message : String(error),
      });
      await dependencies.closeInstance?.(bound);
      throw error;
    }
    try {
      const picked = pickHtmlResource(result, params.resourceUri);
      const { html } = picked;
      // Resource-level _meta wins: check the resources/read HTML item, else fall back to its resources/list entry
      // (the spec puts csp/prefersBorder on list-entry _meta, and the official SDK writes only there);
      // tool-level declarations apply only when both lack the field; csp is taken wholesale, never unioned per directive.
      const meta =
        picked.meta ?? (await readListLevelResourceMeta(dependencies.listMcpResourcesForUi, bound));
      const csp = meta?.csp ?? params.csp;
      const prefersBorder = meta?.prefersBorder ?? params.prefersBorder;
      log.info("prepareSandbox resource ready", {
        scopeId: params.scopeId,
        htmlBytes: Buffer.byteLength(html, "utf8"),
        hasResourceMeta: meta !== null,
        durationMs: Date.now() - startedAt,
      });
      const handle = await dependencies.registerSandbox({
        instance,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ownerWebContentsId: params.ownerWebContentsId,
        sessionId: params.sessionId,
        pluginId: params.pluginId,
        // partition derives from server identity (plugin servers shared across workspaces; plain MCP per workspace).
        serverName: params.serverName,
        scopeId: params.scopeId,
        html,
        ...(csp ? { csp } : {}),
        // Resource-level _meta zcode/csp: relaxations honor only the resource's own declaration.
        ...(meta?.cspRelaxations ? { cspRelaxations: meta.cspRelaxations } : {}),
        ...(meta?.permissions ? { permissions: meta.permissions } : {}),
        ...(prefersBorder !== undefined ? { prefersBorder } : {}),
        ...(meta?.heightHint !== undefined ? { heightHint: meta.heightHint } : {}),
        ...(meta?.minFrameHeight !== undefined ? { minFrameHeight: meta.minFrameHeight } : {}),
        ...(meta?.showInline !== undefined ? { showInline: meta.showInline } : {}),
      });
      log.info("prepareSandbox registered", {
        scopeId: params.scopeId,
        sandboxId: handle.sandboxId,
        initId: handle.initId,
        durationMs: Date.now() - startedAt,
      });
      return handle;
    } catch (error) {
      log.warn("prepareSandbox register failed", {
        scopeId: params.scopeId,
        error: error instanceof Error ? error.message : String(error),
      });
      await dependencies.closeInstance?.(bound);
      throw error;
    }
  };

  return {
    async recycleInstance(params) {
      return dependencies.recycleInstance ? dependencies.recycleInstance(params) : false;
    },
    async validateInstance(params) {
      await dependencies.validateInstance?.(params);
    },
    async closeInstance(params) {
      await dependencies.closeInstance?.(params);
    },
    async prepareSandbox(params) {
      if (!dependencies.openInstance) throw unavailable("instance identity");
      const instance = await dependencies.openInstance(params);
      // The merge key comes from the agent's live connection; a post-disconnect init never reuses the previous generation's in-flight HTML.
      const key = JSON.stringify([
        instance.runtimeId,
        instance.token,
        instance.generation,
        params.resourceUri,
      ]);
      const existing = preparing.get(key);
      if (existing) return existing;
      const pending = prepareSandboxOnce(params, instance).finally(() => {
        if (preparing.get(key) === pending) preparing.delete(key);
      });
      preparing.set(key, pending);
      return pending;
    },
    async callTool(params, options) {
      if (!dependencies.callMcpToolForUi) {
        throw new PluginUiBridgeError(
          "unavailable",
          "Plugin UI tool calls are unavailable in this runtime",
        );
      }
      return dependencies.callMcpToolForUi(params, options);
    },
    async cancelToolCall(params) {
      // Without an agent (web/remote) there is nothing to cancel: stay silent, cancel is best-effort cleanup.
      if (!dependencies.cancelMcpToolCallForUi) return { cancelled: false };
      return dependencies.cancelMcpToolCallForUi(params);
    },
    async readResource(params) {
      if (!dependencies.readMcpResourceForUi) {
        throw new PluginUiBridgeError(
          "unavailable",
          "Plugin UI resource reads are unavailable in this runtime",
        );
      }
      const result = await dependencies.readMcpResourceForUi(params);
      assertUiReadResourceSize(result, params.uri);
      return result;
    },
    async listResources(params) {
      if (!dependencies.listMcpResourcesForUi) throw unavailable("resource listing");
      return dependencies.listMcpResourcesForUi(params);
    },
    async listResourceTemplates(params) {
      if (!dependencies.listMcpResourceTemplatesForUi) throw unavailable("resource listing");
      return dependencies.listMcpResourceTemplatesForUi(params);
    },
    async subscribeResource(params) {
      if (!dependencies.subscribeMcpResourceForUi) throw unavailable("resource subscriptions");
      await dependencies.subscribeMcpResourceForUi(params);
    },
    async unsubscribeResource(params) {
      // Unsubscribe is cleanup: silently succeed without a backend (like cancelToolCall).
      if (!dependencies.unsubscribeMcpResourceForUi) return;
      await dependencies.unsubscribeMcpResourceForUi(params);
    },
    async listSurfaces(params) {
      // Web/remote workspaces have no local agent runtime: an empty list, not an error, so launchers hide the group.
      if (!dependencies.listPluginUiSurfaces) return [];
      return (await dependencies.listPluginUiSurfaces(params)).surfaces;
    },
  };
}

function unavailable(feature: string): PluginUiBridgeError {
  return new PluginUiBridgeError(
    "unavailable",
    `Plugin UI ${feature} are unavailable in this runtime`,
  );
}

/**
 * 8 MiB total guard: results reach the sandbox via MessagePort structured clone,
 * already capped by the same constant agent-side; recompute decoded size here (UTF-8 text, base64 len for blobs) for older agents.
 */
export function assertUiReadResourceSize(result: ZCodeMcpUiReadResourceResult, uri: string): void {
  let total = 0;
  for (const content of result.contents) {
    if (typeof content.text === "string") total += Buffer.byteLength(content.text, "utf8");
    if (typeof content.blob === "string") total += decodedBase64Length(content.blob);
  }
  if (total > MCP_APPS_UI_READ_RESOURCE_MAX_BYTES) {
    throw new PluginUiBridgeError(
      "resource_too_large",
      `MCP resource ${uri} decodes to ${total} bytes, exceeding the ${MCP_APPS_UI_READ_RESOURCE_MAX_BYTES} byte limit for resources/read`,
    );
  }
}

function decodedBase64Length(value: string): number {
  const trimmed = value.replace(/\s+/g, "");
  if (trimmed.length === 0) return 0;
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.floor((trimmed.length * 3) / 4) - padding;
}

/** Legacy signature: HTML text only. */
export function pickHtmlContent(result: ZCodeMcpReadResourceResult, uri: string): string {
  return pickHtmlResource(result, uri).html;
}

const LIST_LEVEL_META_MAX_PAGES = 8;

/**
 * When the resources/read HTML item lacks _meta, scan resources/list for the same uri (up to 8 pages).
 * Missing list, pagination failure, or no match all mean undeclared and never block preparation.
 */
async function readListLevelResourceMeta(
  list: PluginUiBridgeServiceDependencies["listMcpResourcesForUi"],
  params: PluginUiPrepareSandboxParams & {
    instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  },
): Promise<McpAppResourceMeta | null> {
  if (!list) return null;
  const scope = {
    instance: params.instance,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    sessionId: params.sessionId,
    pluginId: params.pluginId,
    serverName: params.serverName,
  };
  let cursor: string | undefined;
  try {
    for (let page = 0; page < LIST_LEVEL_META_MAX_PAGES; page += 1) {
      const result = await list({ ...scope, ...(cursor ? { cursor } : {}) });
      const entry = result.resources.find((item) => item.uri === params.resourceUri);
      if (entry) return normalizeMcpAppResourceMeta(entry._meta);
      if (!result.nextCursor) return null;
      cursor = result.nextCursor;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Picks the HTML item actually used: first contents entry whose mime is HTML-allow-listed
 * (same-uri preferred); resource-level csp/prefersBorder/size hints come from that item's _meta.
 * Blobs and oversize reject outright, no degrade/truncate; with no HTML item, error using the first entry's mime.
 */
export function pickHtmlResource(
  result: ZCodeMcpReadResourceResult,
  uri: string,
): { html: string; meta: McpAppResourceMeta | null } {
  if (result.contents.length === 0) {
    throw new PluginUiBridgeError("resource_not_found", `MCP resource has no contents: ${uri}`);
  }
  const isHtml = (mimeType: string | undefined) => {
    const normalized = normalizeMimeType(mimeType);
    return (
      normalized !== null && (MCP_APPS_HTML_MIME_TYPES as readonly string[]).includes(normalized)
    );
  };
  const content =
    result.contents.find((item) => item.uri === uri && isHtml(item.mimeType)) ??
    result.contents.find((item) => isHtml(item.mimeType));
  if (!content) {
    const first = result.contents[0]!;
    throw new PluginUiBridgeError(
      "unsupported_mime_type",
      `MCP resource mimeType is not HTML: ${first.mimeType ?? "(missing)"}`,
    );
  }
  if (typeof content.text !== "string") {
    throw new PluginUiBridgeError(
      "unsupported_mime_type",
      "MCP resource must return HTML as text, blob is not accepted",
    );
  }
  if (Buffer.byteLength(content.text, "utf8") > MCP_APPS_HTML_MAX_BYTES) {
    throw new PluginUiBridgeError(
      "resource_too_large",
      `MCP resource exceeds ${MCP_APPS_HTML_MAX_BYTES} bytes`,
    );
  }
  return { html: content.text, meta: normalizeMcpAppResourceMeta(content._meta) };
}

function normalizeMimeType(value: string | undefined): string | null {
  if (!value) return null;
  // Drop secondary params like charset but keep profile=mcp-app for the allow-list.
  const parts = value
    .split(";")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part && !part.startsWith("charset="));
  return parts.join(";");
}
