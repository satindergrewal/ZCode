import { randomUUID } from "node:crypto";
import { BrowserWindow, desktopCapturer, ipcMain, webContents } from "electron";
import {
  PlatformChannels,
  type EmbeddedBrowserPermissionDeviceOption,
  type EmbeddedBrowserPermissionResolveRequest,
} from "@zcode/shared";
import type {
  EmbeddedBrowserPermissionLogger,
  EmbeddedBrowserPermissionPromptAction,
  EmbeddedBrowserPermissionPromptRequest,
} from "./embeddedBrowserPermissionPolicy.js";

/**
 * main↔renderer bridge for the embedded-browser permission dialog:
 * - promptPermission / devicePicker / onDisplayMediaRequest turn policy decision points into
 *   EmbeddedBrowserPermissionPrompt events pushed to the guest's host window;
 * - the renderer's decision returns via EmbeddedBrowserPermissionResolve;
 * - no response within 20s settles as dismiss/cancel (natural decline when the panel is hidden
 *   or the agent runs in the background).
 */
export interface EmbeddedBrowserPermissionUiBridge {
  promptPermission(
    request: EmbeddedBrowserPermissionPromptRequest,
  ): Promise<EmbeddedBrowserPermissionPromptAction>;
  devicePicker(input: {
    origin: string;
    permission: string;
    devices: EmbeddedBrowserPermissionDeviceOption[];
    hostWebContentsId?: number;
    guestWebContentsId?: number;
  }): {
    result: Promise<{ deviceId: string } | null>;
    updateDevices(devices: EmbeddedBrowserPermissionDeviceOption[]): void;
  };
  onDisplayMediaRequest(input: { origin: string }, callback: (result: unknown) => void): void;
  registerResolveListener(): void;
}

const ALLOWED_ACTIONS = new Set([
  "allow-always",
  "allow-session",
  "block-always",
  "dismiss",
  "cancel",
]);

/**
 * Module-level bridge holder (same pattern as getPluginSandboxHost): assembled at index.ts
 * startup, consumed directly by window layers like desktopWindowChrome, avoiding options
 * drilling.
 */
let activeBridge: EmbeddedBrowserPermissionUiBridge | null = null;

export function setActiveEmbeddedBrowserPermissionUiBridge(
  bridge: EmbeddedBrowserPermissionUiBridge | null,
): void {
  activeBridge = bridge;
}

/** Device chooser for the Bluetooth guard; undefined until the bridge is assembled (the guard then falls back to cancel). */
export function getEmbeddedBrowserDevicePicker():
  | EmbeddedBrowserPermissionUiBridge["devicePicker"]
  | undefined {
  return activeBridge?.devicePicker.bind(activeBridge);
}

/** Runtime validation of the IPC payload: requestId must be a pending request, resolution shape must be recognizable. */
export function parseEmbeddedBrowserPermissionResolveRequest(
  payload: unknown,
): EmbeddedBrowserPermissionResolveRequest | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as {
    requestId?: unknown;
    resolution?: { action?: unknown; sourceId?: unknown; deviceId?: unknown };
  };
  if (typeof candidate.requestId !== "string" || !candidate.requestId) return null;
  const action = candidate.resolution?.action;
  if (typeof action !== "string") return null;
  if (action === "share-screen") {
    if (typeof candidate.resolution?.sourceId !== "string" || !candidate.resolution.sourceId) {
      return null;
    }
    return {
      requestId: candidate.requestId,
      resolution: { action, sourceId: candidate.resolution.sourceId },
    };
  }
  if (action === "select-device") {
    if (typeof candidate.resolution?.deviceId !== "string" || !candidate.resolution.deviceId) {
      return null;
    }
    return {
      requestId: candidate.requestId,
      resolution: { action, deviceId: candidate.resolution.deviceId },
    };
  }
  if (!ALLOWED_ACTIONS.has(action)) return null;
  return { requestId: candidate.requestId, resolution: { action } as { action: "allow-always" } };
}

export function createEmbeddedBrowserPermissionUiBridge(deps: {
  logger: EmbeddedBrowserPermissionLogger;
  /** Dialog no-response settle timeout; tests inject a short value. */
  promptTimeoutMs?: number;
}): EmbeddedBrowserPermissionUiBridge {
  const { logger } = deps;
  const timeoutMs = deps.promptTimeoutMs ?? 20_000;
  const pending = new Map<string, (resolution: unknown) => void>();

  const sendPrompt = (
    hostWebContentsId: number | undefined,
    event: { requestId: string; kind: "permission" | "screen-share" | "device" } & Record<
      string,
      unknown
    >,
  ): boolean => {
    const host =
      (hostWebContentsId !== undefined ? webContents.fromId(hostWebContentsId) : undefined) ??
      BrowserWindow.getFocusedWindow()?.webContents ??
      BrowserWindow.getAllWindows()[0]?.webContents;
    if (!host || host.isDestroyed()) {
      logger.warn("[embedded-browser-permission] prompt target window unavailable");
      return false;
    }
    host.send(PlatformChannels.EmbeddedBrowserPermissionPrompt, event);
    return true;
  };

  /** Create a pending request: the resolver returns the renderer decision, timeout settles via fallback. */
  const openPendingPrompt = <T>(
    hostWebContentsId: number | undefined,
    event: { requestId: string; kind: "permission" | "screen-share" | "device" } & Record<
      string,
      unknown
    >,
    settle: (resolution: unknown) => T,
    fallbackValue: T,
  ): Promise<T> => {
    const { requestId } = event;
    return new Promise<T>((resolve) => {
      let settled = false;
      const finish = (value: T) => {
        if (settled) return;
        settled = true;
        pending.delete(requestId);
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        logger.info("[embedded-browser-permission] decision=denied", {
          requestId,
          source: "prompt-timeout",
        });
        finish(fallbackValue);
      }, timeoutMs);
      pending.set(requestId, (resolution) => finish(settle(resolution)));
      if (!sendPrompt(hostWebContentsId, event)) finish(fallbackValue);
    });
  };

  return {
    promptPermission(request) {
      return openPendingPrompt(
        request.hostWebContentsId,
        {
          requestId: randomUUID(),
          kind: "permission",
          origin: request.origin,
          permission: request.permission,
          ...(request.mediaTypes ? { mediaTypes: [...request.mediaTypes] } : {}),
          ...(request.guestWebContentsId !== undefined
            ? { guestWebContentsId: request.guestWebContentsId }
            : {}),
        },
        (resolution) => {
          const action = (resolution as { action?: string })?.action;
          return (["allow-always", "allow-session", "block-always", "dismiss"] as const).includes(
            action as never,
          )
            ? (action as EmbeddedBrowserPermissionPromptAction)
            : "dismiss";
        },
        "dismiss" as const,
      );
    },

    devicePicker(input) {
      // requestId is generated explicitly and kept in the closure: select-* fires repeatedly
      // during discovery, and later pushes with the same id are treated by the renderer as list
      // hot-updates, not new dialogs.
      const requestId = randomUUID();
      const result = openPendingPrompt(
        input.hostWebContentsId,
        {
          requestId,
          kind: "device",
          origin: input.origin,
          permission: input.permission,
          devices: input.devices,
          ...(input.guestWebContentsId !== undefined
            ? { guestWebContentsId: input.guestWebContentsId }
            : {}),
        },
        (resolution) => {
          const candidate = resolution as { action?: string; deviceId?: string };
          return candidate?.action === "select-device" && candidate.deviceId
            ? { deviceId: candidate.deviceId }
            : null;
        },
        null,
      );
      return {
        result,
        updateDevices: (devices) => {
          if (!pending.has(requestId)) return;
          sendPrompt(input.hostWebContentsId, {
            requestId,
            kind: "device",
            origin: input.origin,
            permission: input.permission,
            devices,
            ...(input.guestWebContentsId !== undefined
              ? { guestWebContentsId: input.guestWebContentsId }
              : {}),
          });
        },
      };
    },

    onDisplayMediaRequest(input, callback) {
      void desktopCapturer
        .getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } })
        .then(async (sources) => {
          const picked = await openPendingPrompt(
            undefined,
            {
              requestId: randomUUID(),
              kind: "screen-share",
              origin: input.origin,
              screens: sources.map((source) => ({
                sourceId: source.id,
                name: source.name,
                // source.id looks like "screen:0:0" / "window:12345:0"; group on it in the UI.
                kind: source.id.startsWith("screen:") ? ("screen" as const) : ("window" as const),
                thumbnailDataUrl: `data:image/jpeg;base64,${source.thumbnail.toJPEG(60).toString("base64")}`,
              })),
            },
            (resolution) => {
              const candidate = resolution as { action?: string; sourceId?: string };
              return candidate?.action === "share-screen" ? (candidate.sourceId ?? null) : null;
            },
            null,
          );
          const source = picked ? sources.find((candidate) => candidate.id === picked) : undefined;
          invokeDisplayMediaCallback(callback, source ? { video: source } : {});
        })
        .catch((error: unknown) => {
          logger.warn("[embedded-browser-permission] screen share sources unavailable:", error);
          invokeDisplayMediaCallback(callback, {});
        });
    },

    registerResolveListener() {
      ipcMain.on(PlatformChannels.EmbeddedBrowserPermissionResolve, (_event, payload: unknown) => {
        const parsed = parseEmbeddedBrowserPermissionResolveRequest(payload);
        const resolver = parsed ? pending.get(parsed.requestId) : undefined;
        if (!parsed || !resolver) {
          logger.warn("[embedded-browser-permission] ignored malformed or unknown resolve payload");
          return;
        }
        resolver(parsed.resolution);
      });
    },
  };
}

/**
 * Electron 41 throws a TypeError synchronously from inside the callback when the page requested
 * video but the callback supplies no stream (the normal user-cancels-share path); calling it
 * directly in the promise chain gets misrecorded by the outer catch as a source failure and
 * double-callbacks. Isolated here so it no longer propagates.
 */
function invokeDisplayMediaCallback(callback: (result: unknown) => void, result: unknown): void {
  try {
    callback(result);
  } catch {
    // The page side already finalized via the cancel/deny path; nothing to do.
  }
}
