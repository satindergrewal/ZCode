import type { PluginUiHostScope } from "@/plugin-ui/app/pluginUiHostController.js";
import type { PluginUiInteractionCallbacks } from "@/plugin-ui/app/pluginUiInteractionPorts.js";
import type { PluginUiPresentation } from "@/plugin-ui/contract.js";
import type { IPluginUiBridgeService, PluginUiReadResourceResult } from "@zcode/services";
import type { IPlatformService, SaveFileRequest, SaveFileResult } from "@zcode/shared";
import type { McpAppsDownloadFileItem } from "@zcode/shared/mcp-apps";
import { MCP_APPS_DOWNLOAD_FILE_MAX_BYTES } from "@zcode/shared/mcp-apps";
import {
  decodedBase64Length,
  planPluginUiDownload,
  resolvePluginUiDownloadFileName,
} from "../domain/pluginUiDownloadFile.js";

export interface PluginUiDownloadHandlerDeps {
  /** Desktop IPlatformService.saveFile: native save dialog; main re-validates 50 MiB and the name. */
  saveFile(payload: SaveFileRequest): Promise<SaveFileResult>;
  /** uri-only items (ResourceLink / contentless EmbeddedResource) read via the same plugin server first. */
  readResource(uri: string): Promise<PluginUiReadResourceResult>;
}

const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code });

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Host side of ui/download-file { contents }: parse per item, save per item (multiple dialogs for multiples),
 * no gesture required (settled: the dialog is the confirmation). Any cancel/write failure answers { isError: true } (SDK semantics);
 * argument errors (over 50 MiB, bad blob, contentless link) answer -32602; resource read failures throw -32603 to the page.
 */
/**
 * downloadFile interaction for this host instance: only with native saveFile (desktop); link items read via this plugin's readResource.
 * undefined = this instance declares no downloadFile, the port answers -32601 (same rule as every interaction).
 */
export function createPluginUiDownloadInteraction(input: {
  platform: Pick<IPlatformService, "saveFile"> | null;
  bridge: Pick<IPluginUiBridgeService, "readResource">;
  scope: PluginUiHostScope;
  getInstance(): import("@zcode/shared/mcp-apps").McpAppInstance;
  presentation: Pick<PluginUiPresentation, "pluginId" | "serverName">;
}): Required<Pick<PluginUiInteractionCallbacks, "onDownloadFile">> | undefined {
  const saveFile = input.platform?.saveFile;
  if (!saveFile) return undefined;
  const { scope, presentation } = input;
  return {
    onDownloadFile: createPluginUiDownloadHandler({
      saveFile: (payload) => saveFile.call(input.platform, payload),
      readResource: (uri) =>
        input.bridge.readResource({
          instance: input.getInstance(),
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
          sessionId: scope.sessionId,
          pluginId: presentation.pluginId,
          serverName: presentation.serverName,
          uri,
        }),
    }),
  };
}

export function createPluginUiDownloadHandler(deps: PluginUiDownloadHandlerDeps) {
  const resolveBytes = async (
    plan: ReturnType<typeof planPluginUiDownload>,
  ): Promise<{ data: ArrayBuffer; name: string }> => {
    const source = plan.source;
    if (source.kind === "text") {
      return { data: toArrayBuffer(new TextEncoder().encode(source.text)), name: plan.name };
    }
    if (source.kind === "blob") {
      if (decodedBase64Length(source.blob) > MCP_APPS_DOWNLOAD_FILE_MAX_BYTES) {
        throw rpcError(
          -32602,
          `file_too_large: ${plan.name} exceeds ${MCP_APPS_DOWNLOAD_FILE_MAX_BYTES} bytes`,
        );
      }
      try {
        return { data: toArrayBuffer(decodeBase64(source.blob)), name: plan.name };
      } catch {
        throw rpcError(-32602, `invalid_blob: ${plan.name} is not valid base64`);
      }
    }
    const result = await deps.readResource(source.uri);
    const content = result.contents.find((entry) => entry.uri === source.uri) ?? result.contents[0];
    if (!content || (typeof content.text !== "string" && typeof content.blob !== "string")) {
      throw rpcError(-32602, `resource_not_found: ${source.uri} has no downloadable content`);
    }
    // Link items take name/mimeType from the read resource to fill the extension.
    const name = resolvePluginUiDownloadFileName(
      { name: plan.name, mimeType: plan.mimeType ?? content.mimeType },
      0,
    );
    return resolveBytes({
      name,
      mimeType: plan.mimeType ?? content.mimeType,
      source:
        typeof content.text === "string"
          ? { kind: "text", text: content.text }
          : { kind: "blob", blob: content.blob as string },
    });
  };

  return async (contents: McpAppsDownloadFileItem[]): Promise<{ isError?: boolean }> => {
    let failed = false;
    for (const [index, item] of contents.entries()) {
      const { data, name } = await resolveBytes(planPluginUiDownload(item, index));
      if (data.byteLength === 0 || data.byteLength > MCP_APPS_DOWNLOAD_FILE_MAX_BYTES) {
        throw rpcError(
          -32602,
          `file_too_large: ${name} must be 1..${MCP_APPS_DOWNLOAD_FILE_MAX_BYTES} bytes`,
        );
      }
      const saved = await deps.saveFile({ data, suggestedName: name });
      if (!saved.success) failed = true;
    }
    return failed ? { isError: true } : {};
  };
}
