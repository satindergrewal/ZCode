/**
 * Preload for the CUA permission drag panel.
 *
 * Exposes only what this panel needs instead of the main window's large preload: the panel is a
 * focus-less window floating over System Settings; the smaller the attack surface the better.
 *
 * startDrag must be send, not invoke: Electron requires the native drag to start synchronously
 * inside the dragstart chain; an invoke round trip misses the OS gesture and nothing gets dragged.
 */
import { contextBridge, ipcRenderer } from "electron";
import { PlatformChannels, type CuaPermissionKind, type Locale } from "@zcode/shared";

const CUA_PERMISSION_PANEL_STATE_CHANNEL = "zcode:cua-permission-panel-state";

interface CuaPermissionPanelState {
  permission: CuaPermissionKind;
  /** App UI locale maintained by main; the panel must not read system locale or localStorage. */
  locale: Locale;
  /** Real ZCode icon (data URL); null when unavailable and the page keeps its placeholder. */
  iconDataUrl: string | null;
}

contextBridge.exposeInMainWorld("cuaPermissionPanel", {
  /** Prewarm the verified Helper path + fingerprint at mount so later dragstart can startDrag synchronously. */
  prepareDrag: () => ipcRenderer.invoke(PlatformChannels.PrepareCuaHelperPermissionDrag),
  /** Start the native file drag synchronously. Call directly inside the dragstart handler. */
  startDrag: () => ipcRenderer.send(PlatformChannels.StartCuaHelperPermissionDrag),
  /** Drag gesture finished; the panel can be dismissed. */
  notifyDragEnded: () => ipcRenderer.send(PlatformChannels.NotifyCuaHelperPermissionDragEnded),
  /// Main-pushed permission stage and app icon, driving copy and tile icon swaps.
  onState: (callback: (state: CuaPermissionPanelState) => void) => {
    const listener = (_event: unknown, payload: CuaPermissionPanelState) => callback(payload);
    ipcRenderer.on(CUA_PERMISSION_PANEL_STATE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(CUA_PERMISSION_PANEL_STATE_CHANNEL, listener);
  },
});
