import { METHOD_NOT_FOUND, ProtocolError } from "@modelcontextprotocol/client";
import { EmptyResultSchema } from "@modelcontextprotocol/core";
import { McpUiMessageResultSchema } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  McpAppsDownloadFileItem,
  PluginSandboxHandle,
  PluginSandboxPlatformPort,
} from "@zcode/shared/mcp-apps";
import { MCP_APPS_SET_WIDGET_STATE_METHOD, concatMcpAppsTextContent } from "@zcode/shared/mcp-apps";
import { z } from "zod";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";

/** Interaction callbacks injected by the host instance; without one the request answers -32601 (declarations mirror callbacks). */
export interface PluginUiInteractionCallbacks {
  /** A rejected sendFollowUpMessage means user cancel or no permission. */
  onSendFollowUpMessage?(
    payload: {
      prompt: string;
      content?: Array<Record<string, unknown>>;
      structuredContent?: unknown;
    },
    context: { consumeUserGesture(): Promise<boolean>; assertCurrent(): void },
  ): Promise<void>;
  onUpdateModelContext?(payload: {
    content: Array<Record<string, unknown>>;
    structuredContent?: unknown;
  }): Promise<void>;
  /** Page ui/set-widget-state { widgetState }; host writes the memory store synchronously, then replies. */
  onUpdateWidgetState?(widgetState: unknown): Promise<void>;
  /** ui/download-file; per-item save, cancel/failure answers { isError: true }. */
  onDownloadFile?(contents: McpAppsDownloadFileItem[]): Promise<{ isError?: boolean }>;
}

/**
 * ui/message args: the official schema keeps only role + content and strips unknown top-level keys; the extension
 * structuredContent must survive (joined as a json fence), so the host registers it with a loose schema, not onmessage.
 */
const pluginUiMessageParamsSchema = z
  .object({
    role: z.literal("user"),
    content: z.array(z.record(z.string(), z.unknown())).min(1),
    structuredContent: z.unknown().optional(),
  })
  .loose();
const pluginUiSetWidgetStateParamsSchema = z.object({ widgetState: z.unknown() }).loose();

/** Errors carrying code (-32601/-32000/-32602) translate to JSON-RPC errors; the rest are internal. */
function toProtocolError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof ProtocolError) return error;
  if (error instanceof Error && typeof code === "number")
    return new ProtocolError(code, error.message);
  return error;
}
const unsupported = (method: string) =>
  new ProtocolError(METHOD_NOT_FOUND, `${method} is not available for this app`);

/**
 * Session interactions (ui/message, ui/update-model-context, ui/download-file, ZCode ui/set-widget-state) land on the official
 * AppBridge: missing callbacks answer -32601; the ui/message gesture token is recorded by main on guest input-event, single-use; no record means no gesture.
 */
export function wirePluginUiInteractions(
  bridge: PluginUiHostBridge,
  deps: PluginUiInteractionCallbacks,
  platform: Pick<PluginSandboxPlatformPort, "consumeUserGesture">,
  currentHandle: () => PluginSandboxHandle | null,
): void {
  bridge.setRequestHandler(
    "ui/message",
    { params: pluginUiMessageParamsSchema, result: McpUiMessageResultSchema },
    async (rawParams) => {
      if (!deps.onSendFollowUpMessage) throw unsupported("ui/message");
      const params = rawParams as z.infer<typeof pluginUiMessageParamsSchema>;
      const handle = currentHandle();
      const assertCurrent = () => {
        if (!handle || currentHandle()?.instance.token !== handle.instance.token)
          throw new Error("MCP App instance was closed");
      };
      assertCurrent();
      try {
        await deps.onSendFollowUpMessage(
          {
            prompt: concatMcpAppsTextContent(params.content),
            content: params.content,
            ...(params.structuredContent !== undefined
              ? { structuredContent: params.structuredContent }
              : {}),
          },
          {
            assertCurrent,
            consumeUserGesture: () =>
              handle ? platform.consumeUserGesture(handle.sandboxId) : Promise.resolve(false),
          },
        );
      } catch (error) {
        throw toProtocolError(error);
      }
      return {};
    },
  );
  bridge.onupdatemodelcontext = async (params) => {
    if (!currentHandle()) throw new Error("MCP App instance was closed");
    if (!deps.onUpdateModelContext) throw unsupported("ui/update-model-context");
    try {
      await deps.onUpdateModelContext({
        content: (params.content ?? []) as Array<Record<string, unknown>>,
        ...(params.structuredContent !== undefined
          ? { structuredContent: params.structuredContent }
          : {}),
      });
    } catch (error) {
      throw toProtocolError(error);
    }
    return {};
  };
  bridge.ondownloadfile = async (params) => {
    if (!deps.onDownloadFile) throw unsupported("ui/download-file");
    try {
      return await deps.onDownloadFile(params.contents as McpAppsDownloadFileItem[]);
    } catch (error) {
      throw toProtocolError(error);
    }
  };
  bridge.setRequestHandler(
    MCP_APPS_SET_WIDGET_STATE_METHOD,
    { params: pluginUiSetWidgetStateParamsSchema, result: EmptyResultSchema },
    async (rawParams) => {
      if (!currentHandle()) throw new Error("MCP App instance was closed");
      if (!deps.onUpdateWidgetState) throw unsupported(MCP_APPS_SET_WIDGET_STATE_METHOD);
      const params = rawParams as z.infer<typeof pluginUiSetWidgetStateParamsSchema>;
      await deps.onUpdateWidgetState(params.widgetState);
      return {};
    },
  );
}
