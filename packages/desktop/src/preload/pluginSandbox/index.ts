import { ipcRenderer } from "electron";
import { PluginSandboxChannels } from "@zcode/shared";

/**
 * Preload for the plugin UI sandbox guest. Does one thing only: forward the MessagePort sent by
 * main verbatim to the trusted relay shell via window.postMessage (contextBridge wraps
 * MessagePort in a Proxy losing native methods, same reason as preload/index.ts).
 * Exposes no contextBridge API; the plugin iframe lives in a child frame of the shell and
 * nodeIntegrationInSubFrames=false, so this code runs only in the shell top frame.
 */
const PLUGIN_SANDBOX_SCHEME = "zcode-sandbox:";

if (window.location.protocol === PLUGIN_SANDBOX_SCHEME && window.top === window) {
  ipcRenderer.on(
    PluginSandboxChannels.Init,
    (event, payload: { sandboxId?: unknown; initId?: unknown; allow?: unknown }) => {
      if (
        typeof payload?.sandboxId !== "string" ||
        typeof payload?.initId !== "number" ||
        event.ports.length !== 1
      ) {
        return;
      }
      window.postMessage(
        {
          type: "init",
          sandboxId: payload.sandboxId,
          initId: payload.initId,
          ...(typeof payload.allow === "string" ? { allow: payload.allow } : {}),
        },
        window.location.origin,
        event.ports,
      );
    },
  );
}
