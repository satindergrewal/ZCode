import { app, Menu, Tray } from "electron";
import { join } from "node:path";
import {
  DesktopCommandIds,
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  ZCODE_PRODUCT_FLAVOR,
  type DesktopCommandId,
  type Locale,
} from "@zcode/shared";

let desktopTray: Tray | null = null;
let rebuildDesktopTrayContextMenu: (() => void) | null = null;

export function resolveDesktopTrayIconPath(platform: NodeJS.Platform = process.platform) {
  // Linux trays accept PNG only (.ico never renders); packaged icon.png lands in resources via
  // extraResources unconditionally (electron-builder.config.js). Windows keeps a dedicated tray
  // .ico to avoid high-DPI blur.
  if (platform === "linux") {
    return app.isPackaged
      ? join(process.resourcesPath, "icon.png")
      : join(import.meta.dirname, "../../build/icon.png");
  }
  return app.isPackaged
    ? join(process.resourcesPath, "tray_icon.ico")
    : join(import.meta.dirname, "../../build/icon.ico");
}

export function createDesktopTray(options: {
  platform?: NodeJS.Platform;
  getLocale: () => Locale;
  showCurrentWindow: () => Promise<void> | void;
  executeDesktopCommand: (command: DesktopCommandId) => Promise<unknown>;
  quitApp: () => void;
  logger: { warn: (...args: unknown[]) => void };
}) {
  const platform = options.platform ?? process.platform;
  // Linux close-to-tray capability is decided by createCloseToTrayCapabilityMonitor (spec:
  // docs/desktop/linux-close-to-tray.md); this only gates the platform - callers must not pass
  // linux when capability failed.
  if (platform !== "win32" && platform !== "linux") {
    return null;
  }

  if (desktopTray) {
    return desktopTray;
  }

  try {
    desktopTray = new Tray(resolveDesktopTrayIconPath(platform));
  } catch (error) {
    options.logger.warn("[desktop-tray] failed to create tray icon", error);
    return null;
  }

  const getLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
    getDesktopMenuMessage(options.getLocale(), id);
  const showTrayWindow = () => {
    void Promise.resolve(options.showCurrentWindow()).catch((error) => {
      options.logger.warn("[desktop-tray] failed to show current window", error);
    });
  };
  const executeTrayCommand = (command: DesktopCommandId) => {
    void Promise.resolve(options.showCurrentWindow())
      .then(() => options.executeDesktopCommand(command))
      .catch((error) => {
        options.logger.warn(`[desktop-tray] failed to execute tray command ${command}`, error);
      });
  };
  const rebuildContextMenu = () => {
    desktopTray?.setToolTip(getLabel(desktopMenuMessageIds.trayTooltip));
    desktopTray?.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: getLabel(desktopMenuMessageIds.trayOpenZCode),
          click: showTrayWindow,
        },
        { type: "separator" },
        {
          label: getLabel(desktopMenuMessageIds.fileNewTask),
          click: () => executeTrayCommand(DesktopCommandIds.NewTask),
        },
        {
          label: getLabel(desktopMenuMessageIds.fileOpenWorkspace),
          click: () => executeTrayCommand(DesktopCommandIds.OpenWorkspace),
        },
        { type: "separator" },
        // The update entry follows the product identity: Preview (including Preview against
        // the production backend) disables the updater, so the tray must not show the entry either.
        ...(ZCODE_PRODUCT_FLAVOR === "production"
          ? [
              {
                label: getLabel(desktopMenuMessageIds.helpCheckForUpdates),
                click: () => executeTrayCommand(DesktopCommandIds.CheckForUpdates),
              },
            ]
          : []),
        {
          label: getLabel(desktopMenuMessageIds.helpAbout),
          click: () => executeTrayCommand(DesktopCommandIds.ShowAbout),
        },
        {
          // The tray exposes a log-diagnostics entry only (no clear-all-data in the context menu);
          // reuse the app-menu export command.
          label: getLabel(desktopMenuMessageIds.helpExportLogs),
          click: () => executeTrayCommand(DesktopCommandIds.ExportLogs),
        },
        { type: "separator" },
        {
          label: getLabel(desktopMenuMessageIds.trayQuit),
          click: () => options.quitApp(),
        },
      ]),
    );
  };

  rebuildDesktopTrayContextMenu = rebuildContextMenu;
  desktopTray.on("click", showTrayWindow);
  desktopTray.on("double-click", showTrayWindow);
  rebuildContextMenu();

  return desktopTray;
}

export function updateWindowsDesktopTrayMenu() {
  rebuildDesktopTrayContextMenu?.();
}
