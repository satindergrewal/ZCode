import type { Locale } from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";
import type { PluginSandboxHandle, PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";
import {
  BrowserWindow,
  clipboard,
  nativeImage,
  MessageChannelMain,
  app,
  dialog,
  session as electronSession,
  webContents as electronWebContents,
  ipcMain,
  systemPreferences,
  type WebContents,
} from "electron";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PluginSandboxRecord, PluginSandboxRegistryPort } from "./contract.js";
import { attachPluginSandboxGuest, configurePluginSandboxGuest } from "./guestPolicy.js";
import { createPluginSandboxPermissionGate } from "./permissionGate.js";
import { formatPluginSandboxPermissionDialogText } from "./permissions.js";
import type { PluginSandboxAssetSource } from "./protocol.js";
import { createPluginSandboxRegistry } from "./registry.js";
import { preparePluginSandboxSession } from "./session.js";
import { sandboxCaptureSchema, scaleCaptureRect } from "./capture.js";

export interface PluginSandboxHost {
  clearBrowserData(): Promise<void>;
  /** The host process registers via parentPort; partition session preparation completes before the handle returns. */
  registerFromHost(input: PluginSandboxRegisterInput): PluginSandboxHandle;
  /** desktopWindowChrome's will-attach branch. */
  configureGuest(input: {
    webPreferences: Electron.WebPreferences;
    params: Record<string, string>;
    ownerWebContentsId: number;
  }): ReturnType<typeof configurePluginSandboxGuest>;
  /** desktopWindowChrome's did-attach branch. */
  attachGuest(input: { guest: WebContents; hostWebContents: WebContents; sandboxId: string }): void;
}

let installedHost: PluginSandboxHost | null = null;

export function getPluginSandboxHost(): PluginSandboxHost | null {
  return installedHost;
}

/**
 * Installed once after app ready: creates the registry and the two renderer-callable IPC
 * endpoints (dispose / gesture consume, validated by sender ownership).
 * The scheme's privileged registration must happen before app ready in the same call as
 * zcode-media — not here.
 */
export function installPluginSandboxHost(input: {
  preloadPath: string;
  rendererDir: string;
  aliasDir: string;
  /** Vite dev server URL; when set, shell assets proxy from it (see PluginSandboxAssetSource). */
  devServerUrl?: string;
  logger?: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
  registry?: PluginSandboxRegistryPort;
  /** Registry capacity (default 64); e2e L05 uses 1 to verify quota rejection. */
  registryMaxEntries?: number;
}): PluginSandboxHost {
  if (installedHost) return installedHost;
  const detachByKey = new Map<string, () => void>();
  const watchedOwners = new Set<number>();
  const guests = new Map<string, WebContents>();
  const stopping = new WeakMap<WebContents, Promise<void>>();
  const partitions = new Set<string>();
  let clearing = false;
  const assets: PluginSandboxAssetSource = {
    rendererDir: input.rendererDir,
    aliasDir: input.aliasDir,
    ...(input.devServerUrl ? { devServerUrl: input.devServerUrl } : {}),
  };
  const stopGuest = (guest: WebContents): Promise<void> => {
    if (guest.isDestroyed()) return Promise.resolve();
    const existing = stopping.get(guest);
    if (existing) return existing;
    // In Electron 41, close on an attached guest destroys only the wrapper; the iframe can
    // still write storage. Navigate to a native blank page first to really drop the old
    // document; do not guess via destroyed or delays that the page has stopped.
    const stopped = Promise.resolve().then(async () => {
      if (guest.isDestroyed()) return;
      const allowUnload = (event: Electron.Event) => event.preventDefault();
      guest.on("will-prevent-unload", allowUnload);
      try {
        await guest.loadURL("about:blank");
      } catch (error) {
        // Removing the webview from the renderer or closing the owner aborts navigation; the
        // document is already released by then.
        if (!guest.isDestroyed()) throw error;
      } finally {
        guest.removeListener("will-prevent-unload", allowUnload);
      }
      if (guest.isDestroyed()) return;
      const destroyed = new Promise<void>((resolve) => guest.once("destroyed", resolve));
      guest.close({ waitForBeforeUnload: false });
      await destroyed;
    });
    stopping.set(guest, stopped);
    return stopped;
  };
  // The partition is persistent and isolated per trusted app identity: dispose closes the guest
  // and ports, keeps the protocol handler and storage; storage cleanup uses the existing
  // clear-all-data entry.
  const onDispose = (record: PluginSandboxRecord) => {
    detachByKey.get(record.sandboxId)?.();
    detachByKey.delete(record.sandboxId);
    const guest = guests.get(record.sandboxId);
    // Retain the guest until fully stopped: clear-data must be able to wait on an instance
    // already entering dispose.
    if (guest)
      void stopGuest(guest).catch((error: unknown) =>
        input.logger?.warn("[plugin-sandbox] guest stop failed", String(error)),
      );
  };
  const registry =
    input.registry ??
    createPluginSandboxRegistry({
      onDispose,
      ...(input.registryMaxEntries !== undefined ? { maxEntries: input.registryMaxEntries } : {}),
    });

  // Page browser-permission gate: the confirm dialog is native, parented by the host window that
  // registered the sandbox; the page cannot forge it.
  const resolveLocale = (): Locale =>
    app.getLocale().toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
  const permissions = createPluginSandboxPermissionGate({
    registry,
    async prompt({ record, permissions: pending }) {
      const text = formatPluginSandboxPermissionDialogText(
        { serverName: record.serverName ?? "ZCode Gen UI", permissions: pending },
        resolveLocale(),
      );
      const owner = electronWebContents.fromId(record.ownerWebContentsId);
      const parent = owner ? BrowserWindow.fromWebContents(owner) : null;
      const options = {
        type: "question" as const,
        buttons: [text.allowButton, text.denyButton],
        defaultId: 1,
        cancelId: 1,
        title: text.title,
        message: text.message,
        detail: text.detail,
        noLink: true,
      };
      const { response } =
        parent && !parent.isDestroyed()
          ? await dialog.showMessageBox(parent, options)
          : await dialog.showMessageBox(options);
      return response === 0;
    },
    ...(process.platform === "darwin"
      ? {
          async requestSystemMediaAccess(kind: "camera" | "microphone") {
            const status = systemPreferences.getMediaAccessStatus(kind);
            if (status === "granted") return true;
            if (status !== "not-determined") return false;
            return systemPreferences.askForMediaAccess(kind);
          },
        }
      : {}),
    ...(input.logger ? { logger: input.logger } : {}),
  });

  const host: PluginSandboxHost = {
    async clearBrowserData() {
      clearing = true;
      for (const owner of watchedOwners) registry.disposeOwner(owner);
      await Promise.all([...guests.values()].map(stopGuest));
      guests.clear();
      const names = await readdir(join(app.getPath("sessionData"), "Partitions")).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      for (const name of names)
        if (/^plugin-sandbox-v[12]-[a-f0-9]+$/.test(name)) partitions.add(`persist:${name}`);
      await Promise.all(
        [...partitions].map(async (partition) => {
          const session = electronSession.fromPartition(partition);
          await session.clearStorageData();
          await session.clearCache();
        }),
      );
    },
    registerFromHost(registerInput) {
      if (clearing) throw new Error("MCP App browser data is being cleared");
      const owner = electronWebContents.fromId(registerInput.ownerWebContentsId);
      if (!owner || owner.isDestroyed()) throw new Error("MCP App window is no longer available");
      const handle = registry.register(registerInput);
      partitions.add(handle.partition);
      // Registrations prepared but not yet attached still belong to the window; close and
      // clear-data must not miss them.
      if (!watchedOwners.has(owner.id)) {
        watchedOwners.add(owner.id);
        owner.once("destroyed", () => {
          watchedOwners.delete(owner.id);
          registry.disposeOwner(owner.id);
        });
      }
      preparePluginSandboxSession({
        session: electronSession.fromPartition(handle.partition),
        registry,
        assets,
        permissions,
        logger: input.logger,
      });
      // One line per sandbox registration, for tri-segment renderer/host/main handshake tracing.
      input.logger?.info?.("[plugin-sandbox] registered", {
        sandboxId: handle.sandboxId,
        initId: handle.initId,
        scopeId: registerInput.scopeId,
        ownerWebContentsId: registerInput.ownerWebContentsId,
      });
      return handle;
    },
    configureGuest(guestInput) {
      return configurePluginSandboxGuest({
        ...guestInput,
        registry,
        preloadPath: input.preloadPath,
      });
    },
    attachGuest({ guest, hostWebContents, sandboxId }) {
      if (clearing) {
        void stopGuest(guest).catch((error: unknown) =>
          input.logger?.warn("[plugin-sandbox] late guest stop failed", String(error)),
        );
        return;
      }
      guests.set(sandboxId, guest);
      guest.once("destroyed", () => {
        if (guests.get(sandboxId) === guest) guests.delete(sandboxId);
      });
      // H14: when the host webContents is destroyed (window closed/crash), release every
      // registration it owns; hook each owner once.
      if (!watchedOwners.has(hostWebContents.id)) {
        watchedOwners.add(hostWebContents.id);
        const ownerId = hostWebContents.id;
        hostWebContents.once("destroyed", () => {
          watchedOwners.delete(ownerId);
          registry.disposeOwner(ownerId);
        });
      }
      detachByKey.get(sandboxId)?.();
      detachByKey.set(
        sandboxId,
        attachPluginSandboxGuest({
          guest,
          hostWebContents,
          registry,
          sandboxId,
          createMessageChannel: () => new MessageChannelMain(),
          logger: input.logger,
        }),
      );
    },
  };

  ipcMain.handle(PlatformChannels.PluginSandboxOwnerWebContentsId, (event) => event.sender.id);
  ipcMain.handle(PlatformChannels.PluginSandboxCopyImage, async (event, value: unknown) => {
    const request = sandboxCaptureSchema.parse(value);
    const record = registry.get(request.sandboxId);
    const guest = guests.get(request.sandboxId);
    const isCurrent = () =>
      record &&
      registry.get(request.sandboxId) === record &&
      record.ownerWebContentsId === event.sender.id &&
      record.initId === request.initId &&
      !event.sender.isDestroyed() &&
      guest &&
      !guest.isDestroyed() &&
      guests.get(request.sandboxId) === guest;
    if (!isCurrent() || !guest) throw new Error("Sandbox capture is no longer available");
    const captured = await guest.capturePage();
    // The page may be released or regenerated during capture; a stale request must not write
    // the wrong page's image to the clipboard.
    if (!isCurrent()) throw new Error("Sandbox capture is no longer available");
    const cropped = captured.crop(scaleCaptureRect(request, captured.getSize()));
    clipboard.writeImage(
      process.platform === "win32"
        ? nativeImage.createFromBitmap(cropped.toBitmap(), cropped.getSize())
        : cropped,
    );
  });
  ipcMain.handle(
    PlatformChannels.PluginSandboxDispose,
    (event, sandboxId: unknown, initId: unknown) => {
      if (typeof sandboxId !== "string") return;
      const record = registry.get(sandboxId);
      // Only the host window that registered a sandbox may dispose it; other senders are
      // silently ignored.
      if (!record || record.ownerWebContentsId !== event.sender.id) return;
      input.logger?.info?.("[plugin-sandbox] dispose requested", {
        sandboxId,
        initId,
        currentInitId: record.initId,
      });
      registry.dispose(sandboxId, typeof initId === "number" ? initId : undefined);
      const guest = guests.get(sandboxId);
      // A late dispose with a stale initId must not stop a still-valid registration.
      if (guest && !registry.get(sandboxId)) return stopGuest(guest);
    },
  );
  ipcMain.handle(PlatformChannels.PluginSandboxConsumeUserGesture, (event, sandboxId: unknown) => {
    if (typeof sandboxId !== "string") return false;
    const record = registry.get(sandboxId);
    if (!record || record.ownerWebContentsId !== event.sender.id) return false;
    return registry.consumeUserGesture(sandboxId);
  });

  installedHost = host;
  return host;
}
