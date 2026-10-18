import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  runXdgCommand,
  XDG_COMMAND_TIMEOUT_MS,
  type LinuxDesktopCommandRunner,
  type LinuxDeepLinkRegistrationLogger,
} from "./desktopLinuxXdg.js";

// // AppImage user-level icon install, split out of desktopLinuxDeepLinkRegistration:
// icon integration is optional polish, separate from deep-link registration, so each can evolve alone.

const LINUX_APP_ICON_NAME = "zcode";
const LINUX_APP_ICON_SIZE = "512x512";

function resolveLinuxUserIconFilePath(dataDir: string): string {
  return join(
    dataDir,
    "icons",
    "hicolor",
    LINUX_APP_ICON_SIZE,
    "apps",
    `${LINUX_APP_ICON_NAME}.png`,
  );
}

function copyFileIfChanged(sourcePath: string, targetPath: string): boolean {
  if (existsSync(targetPath) && readFileSync(sourcePath).equals(readFileSync(targetPath))) {
    return false;
  }

  copyFileSync(sourcePath, targetPath);
  return true;
}

function shouldInstallAppImageDesktopIcon(params: {
  env?: { APPIMAGE?: string };
  iconSourcePath?: string;
}): boolean {
  return Boolean(params.env?.APPIMAGE?.trim() && params.iconSourcePath);
}

function installLinuxAppImageDesktopIcon(params: {
  dataDir: string;
  iconSourcePath: string;
  logger: LinuxDeepLinkRegistrationLogger;
  runCommand?: LinuxDesktopCommandRunner;
}): { iconFilePath: string; installed: boolean; changed: boolean } {
  const iconFilePath = resolveLinuxUserIconFilePath(params.dataDir);
  if (!existsSync(params.iconSourcePath)) {
    params.logger.warn(
      "[deep-link] Linux AppImage icon source missing; skipping user-level install",
      {
        iconSourcePath: params.iconSourcePath,
        iconFilePath,
      },
    );
    return { iconFilePath, installed: false, changed: false };
  }
  // A directly-run AppImage, unlike deb installs, never writes Icon=zcode into the hicolor theme.
  mkdirSync(dirname(iconFilePath), { recursive: true });
  const changed = copyFileIfChanged(params.iconSourcePath, iconFilePath);
  //
  //
  if (!changed) {
    return { iconFilePath, installed: true, changed };
  }

  const runCommand = params.runCommand ?? runXdgCommand;
  const cacheResult = runCommand("gtk-update-icon-cache", [
    "-f",
    "-t",
    join(params.dataDir, "icons", "hicolor"),
  ]);
  if (cacheResult.error) {
    params.logger.warn("[deep-link] gtk-update-icon-cache unavailable; skipped", {
      iconFilePath,
      message: cacheResult.error.message,
    });
  } else if (cacheResult.signal === "SIGTERM") {
    params.logger.warn("[deep-link] Linux user icon cache refresh timed out; skipped", {
      iconFilePath,
      timeoutMs: XDG_COMMAND_TIMEOUT_MS,
    });
  } else if (cacheResult.status !== 0) {
    params.logger.warn("[deep-link] Linux user icon cache refresh failed", {
      iconFilePath,
      status: cacheResult.status,
      stderr: cacheResult.stderr?.trim(),
    });
  }

  return { iconFilePath, installed: true, changed };
}

export function installLinuxAppImageDesktopIconBestEffort(params: {
  dataDir: string;
  env?: { APPIMAGE?: string };
  iconSourcePath?: string;
  logger: LinuxDeepLinkRegistrationLogger;
  runCommand?: LinuxDesktopCommandRunner;
}): { iconFilePath: string; installed: boolean; changed: boolean } | null {
  if (
    !shouldInstallAppImageDesktopIcon({
      env: params.env,
      iconSourcePath: params.iconSourcePath,
    }) ||
    !params.iconSourcePath
  ) {
    return null;
  }

  try {
    return installLinuxAppImageDesktopIcon({
      dataDir: params.dataDir,
      iconSourcePath: params.iconSourcePath,
      logger: params.logger,
      runCommand: params.runCommand,
    });
  } catch (error) {
    params.logger.warn("[deep-link] Linux AppImage icon install failed; degraded", {
      iconSourcePath: params.iconSourcePath,
      error,
    });
    return null;
  }
}
