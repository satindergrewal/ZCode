import { PlatformChannels, type WebRemoteControlStatus } from "@zcode/shared";

interface WebRemoteControlStatusEventTarget {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, status: WebRemoteControlStatus): void;
  };
}

export function sendWebRemoteControlStatusChangedToWindow(
  targetWindow: WebRemoteControlStatusEventTarget | null | undefined,
  status: WebRemoteControlStatus,
): void {
  if (!targetWindow || targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
    return;
  }

  // Bugfix: web remote-control status changes push asynchronously; during window close the
  // BrowserWindow may still exist while webContents is destroyed. Validate both layers before
  // sending so IPC send cannot throw on quit/refresh.
  targetWindow.webContents.send(PlatformChannels.WebRemoteControlStatusChanged, status);
}
