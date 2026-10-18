import { contextBridge, ipcRenderer } from "electron";
import { InternalChannels, PlatformChannels } from "@zcode/shared";
import type { PluginSandboxCaptureRequest } from "@zcode/shared/mcp-apps";
import { enableSandboxRetainedMoves } from "./retainedMoves.js";

export function installPluginSandboxHostBridge(): void {
  const supportsRetainedMove =
    contextBridge.executeInMainWorld({ func: enableSandboxRetainedMoves }) === true;
  /**
   * Plugin UI sandbox: its own namespace, not on window.zcode. Only explicit sandbox operations
   * are exposed; ports cannot cross contextBridge, use the window.postMessage transfer below.
   */
  contextBridge.exposeInMainWorld("zcodePluginSandbox", {
    supportsRetainedMove,
    copyImage: (input: PluginSandboxCaptureRequest) =>
      ipcRenderer.invoke(PlatformChannels.PluginSandboxCopyImage, input) as Promise<void>,
    getOwnerWebContentsId: () =>
      ipcRenderer.invoke(PlatformChannels.PluginSandboxOwnerWebContentsId) as Promise<number>,
    disposeSandbox: (sandboxId: string, initId?: number) =>
      ipcRenderer.invoke(PlatformChannels.PluginSandboxDispose, sandboxId, initId) as Promise<void>,
    consumeUserGesture: (sandboxId: string) =>
      ipcRenderer.invoke(
        PlatformChannels.PluginSandboxConsumeUserGesture,
        sandboxId,
      ) as Promise<boolean>,
  });

  ipcRenderer.on(
    InternalChannels.PluginSandboxPorts,
    (event, payload: { sandboxId?: unknown; initId?: unknown }) => {
      if (typeof payload?.sandboxId !== "string" || typeof payload?.initId !== "number") {
        return;
      }
      window.postMessage(
        {
          type: InternalChannels.PluginSandboxPorts,
          sandboxId: payload.sandboxId,
          initId: payload.initId,
        },
        "*",
        event.ports,
      );
    },
  );
}
