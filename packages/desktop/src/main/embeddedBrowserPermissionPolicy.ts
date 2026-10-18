import type { Session, Streams } from "electron";
import type { EmbeddedBrowserPermissionDeviceOption } from "@zcode/shared";
import { readDeviceOptions } from "./embeddedBrowserDeviceOptions.js";
import {
  getEmbeddedBrowserSitePermission,
  initEmbeddedBrowserSitePermissions,
  writeEmbeddedBrowserSitePermission,
} from "./embeddedBrowserSitePermissions.js";

/**
 * Permission gate for the embedded-browser partition (fix for the CNVD "embedded browser
 * unauthorized access" finding; spec: see
 * docs/browser-use/2026-10-08-embedded-browser-permission-governance-spec.md）。
 *
 * A session without permission handlers auto-approves every request, letting a malicious page
 * silently take camera/microphone/clipboard/geolocation; device APIs without select-* listeners
 * also silently grant the first matching device. This module registers default-deny
 * request/check/device/displayMedia handlers on that partition: harmless permissions pass via
 * allowlist, sensitive ones go through a product-grade dialog, the rest fail closed.
 *
 * Phased rollout: while the prompt layer is absent, sensitive permissions are always denied
 * (security closure first); once wired, user choices write back to in-memory sessionAllow or the
 * persistent store.
 */

export const EMBEDDED_BROWSER_SILENT_ALLOW_PERMISSIONS: ReadonlySet<string> = new Set([
  // Clipboard-write maps to page copy buttons, fullscreen/pointerLock to video fullscreen and
  // interaction, mediaKeySystem to DRM playback: denying these breaks broad functionality, and
  // none leak user data.
  "clipboard-sanitized-write",
  "fullscreen",
  "pointerLock",
  "mediaKeySystem",
]);

const PROMPT_PERMISSIONS: ReadonlySet<string> = new Set([
  "media",
  "clipboard-read",
  "geolocation",
  "notifications",
  "midi",
  "midiSysex",
  "idle-detection",
  "speaker-selection",
  "window-management",
  "storage-access",
  "top-level-storage-access",
  "keyboardLock",
  "fileSystem",
]);

/** Device-class permissions in the check-handler enum: pass through to the select-* chooser (see the check handler comment). */
const DEVICE_CHECK_PERMISSIONS: ReadonlySet<string> = new Set(["usb", "hid", "serial"]);

export type EmbeddedBrowserPermissionPromptAction =
  | "allow-always"
  | "allow-session"
  | "block-always"
  | "dismiss";

export interface EmbeddedBrowserPermissionPromptRequest {
  origin: string;
  permission: string;
  mediaTypes?: readonly string[];
  /** Host renderer webContents id of the requesting guest; the dialog routes to that window. */
  hostWebContentsId?: number;
  /** The requesting guest's own webContents id; the renderer renders only in the owning tab. */
  guestWebContentsId?: number;
}

export interface EmbeddedBrowserSitePermissionRecord {
  [origin: string]: { [permission: string]: "allow" | "deny" };
}

export interface EmbeddedBrowserSitePermissionStore {
  load(): Promise<EmbeddedBrowserSitePermissionRecord>;
  persist(record: EmbeddedBrowserSitePermissionRecord): Promise<void>;
}

export interface EmbeddedBrowserPermissionLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export type EmbeddedBrowserPermissionSession = Session;

export interface EmbeddedBrowserDevicePickerSession {
  result: Promise<{ deviceId: string } | null>;
  updateDevices(devices: EmbeddedBrowserPermissionDeviceOption[]): void;
}

export interface EmbeddedBrowserPermissionPolicyOptions {
  logger: EmbeddedBrowserPermissionLogger;
  /** Injected by the dialog layer (step 2); absent, sensitive permissions are always denied. */
  prompt?: (
    request: EmbeddedBrowserPermissionPromptRequest,
  ) => Promise<EmbeddedBrowserPermissionPromptAction>;
  /** Persistent per-site consent store (step 2/3); absent, decisions rely on memory only. */
  store?: EmbeddedBrowserSitePermissionStore;
  /**
   * Device chooser (step 2) injection; returns a session handle: result settles the chosen
   * deviceId (null cancels), updateDevices hot-updates the list while the chooser is open
   * (Bluetooth scans / USB enumeration fire select-* repeatedly; one chooser per permission).
   * Absent, select-* always cancels (blocking Electron's silent first-device grant).
   */
  devicePicker?: (input: {
    origin: string;
    permission: string;
    devices: EmbeddedBrowserPermissionDeviceOption[];
    hostWebContentsId?: number;
    guestWebContentsId?: number;
  }) => EmbeddedBrowserDevicePickerSession;
  /**
   * Screen-share source picker (step 2) injection; source list and callback semantics need
   * desktopCapturer context, so it forwards wholesale to the bridge — the policy keeps only
   * logging and default-deny.
   */
  onDisplayMediaRequest?: (input: { origin: string }, callback: (result: unknown) => void) => void;
}

export const EMBEDDED_BROWSER_PERMISSION_LOG_TAG = "[embedded-browser-permission]";
const LOG_TAG = EMBEDDED_BROWSER_PERMISSION_LOG_TAG;
const UNKNOWN_ORIGIN = "unknown";

export function originFromUrl(url: string | undefined): string {
  try {
    return new URL(url ?? "").origin;
  } catch {
    return UNKNOWN_ORIGIN;
  }
}

export async function applyEmbeddedBrowserPermissionPolicy(
  targetSession: EmbeddedBrowserPermissionSession,
  options: EmbeddedBrowserPermissionPolicyOptions,
): Promise<void> {
  const { logger } = options;

  // Site consent records stay in memory (the check handler reads synchronously); a dedicated
  // manager owns loading/persistence. Settings "site permissions" and "clear browser data" go
  // through the same manager so decisions stay consistent.
  await initEmbeddedBrowserSitePermissions({
    ...(options.store ? { store: options.store } : {}),
    logger,
  });

  const sessionAllow = new Map<string, Set<string>>();
  const inflight = new Map<string, Promise<EmbeddedBrowserPermissionPromptAction>>();

  const logDecision = (
    decision: "granted" | "denied",
    meta: Record<string, unknown>,
    warn = false,
  ): void => {
    const message = `${LOG_TAG} decision=${decision}`;
    if (warn) logger.warn(message, meta);
    else logger.info(message, meta);
  };

  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    // details is Electron's four-member PermissionRequest union (media carries mediaTypes,
    // fileSystem carries filePaths, etc.); assert-and-read as needed, no structural assumptions.
    const requestingUrl = (details as { requestingUrl?: string }).requestingUrl;
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes;
    const origin = originFromUrl(requestingUrl);
    // The guest's host renderer is the window the dialog belongs in; outside webviews, fall back
    // to the guest itself.
    const hostWebContentsId = webContents.hostWebContents?.id ?? webContents.id;
    const guestWebContentsId = webContents.id;

    if (EMBEDDED_BROWSER_SILENT_ALLOW_PERMISSIONS.has(permission)) {
      logDecision("granted", { permission, origin, source: "allowlist" });
      callback(true);
      return;
    }

    if (PROMPT_PERMISSIONS.has(permission)) {
      const persisted = getEmbeddedBrowserSitePermission(origin, permission);
      if (persisted === "allow" || persisted === "deny") {
        logDecision(persisted === "allow" ? "granted" : "denied", {
          permission,
          origin,
          source: "site-setting",
        });
        callback(persisted === "allow");
        return;
      }
      if (sessionAllow.get(origin)?.has(permission)) {
        logDecision("granted", { permission, origin, source: "session-allow" });
        callback(true);
        return;
      }
      if (!options.prompt) {
        logDecision("denied", { permission, origin, source: "default-deny" });
        callback(false);
        return;
      }
      // Concurrent same origin+permission requests share one dialog (same inflight pattern as
      // the pluginSandbox permissionGate).
      const key = `${origin}|${permission}`;
      let flight = inflight.get(key);
      if (!flight) {
        flight = options
          .prompt({
            origin,
            permission,
            hostWebContentsId,
            guestWebContentsId,
            ...(mediaTypes ? { mediaTypes } : {}),
          })
          .finally(() => {
            inflight.delete(key);
          });
        inflight.set(key, flight);
      }
      void flight.then(
        (action) => {
          const granted = action === "allow-always" || action === "allow-session";
          logDecision(granted ? "granted" : "denied", {
            permission,
            origin,
            source: "user-prompt",
            action,
          });
          if (action === "allow-always") {
            void writeEmbeddedBrowserSitePermission(origin, permission, "allow");
          } else if (action === "allow-session") {
            const grantedSet = sessionAllow.get(origin) ?? new Set<string>();
            grantedSet.add(permission);
            sessionAllow.set(origin, grantedSet);
          } else if (action === "block-always") {
            void writeEmbeddedBrowserSitePermission(origin, permission, "deny");
          }
          callback(granted);
        },
        (error: unknown) => {
          logger.warn(`${LOG_TAG} permission prompt failed: ${String(error)}`);
          callback(false);
        },
      );
      return;
    }

    // openExternal is owned by the embedded browser's existing window-opening path; unknown
    // permissions fail closed so future Electron enum additions cannot bypass the allowlist.
    logDecision("denied", { permission, origin, source: "default-deny" }, true);
    callback(false);
  });

  targetSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    if (EMBEDDED_BROWSER_SILENT_ALLOW_PERMISSIONS.has(permission)) return true;
    // Device-class permission check: in practice false here hard-blocks requestDevice/requestPort
    // at the check layer (zero select-* logs, page gets NotAllowedError) and the chooser never
    // fires — the select-serial-port docs say serial permission is governed by the check handler.
    // Like setDevicePermissionHandler=true, pass through to the chooser; actual grants are owned
    // exclusively by the select-* listeners (no choice, no grant). Bluetooth is not in the check
    // enum and is unaffected.
    if (DEVICE_CHECK_PERMISSIONS.has(permission)) return true;
    if (!PROMPT_PERMISSIONS.has(permission)) return false;
    if (getEmbeddedBrowserSitePermission(requestingOrigin, permission) === "allow") return true;
    return sessionAllow.get(requestingOrigin)?.has(permission) === true;
  });

  // Semantics correction from testing: setDevicePermissionHandler returning false hard-blocks
  // requestDevice (NotAllowedError) and the select-* chooser never fires (permission.site
  // USB/HID/Serial requests used to get no dialog and no select logs). The real security gate is
  // the select-* listener below: only when unlistening does Electron silently grant the first
  // device. Our apply always registers listeners (unit-tested), so handler=true only means
  // "proceed to chooser", never a grant.
  targetSession.setDevicePermissionHandler(() => true);

  targetSession.setDisplayMediaRequestHandler((request, callback) => {
    const frameUrl = (request as { frame?: { url?: string } }).frame?.url;
    const origin = originFromUrl(frameUrl);
    if (options.onDisplayMediaRequest) {
      // Source selection needs desktopCapturer context and Electron-specific callback semantics;
      // forward wholesale to the bridge.
      logDecision("granted", { permission: "display-capture", origin, source: "source-picker" });
      options.onDisplayMediaRequest({ origin }, (result) => callback(result as Streams));
      return;
    }
    logDecision("denied", { permission: "display-capture", origin, source: "default-deny" });
    callback({});
  });

  // Without select-* listeners Electron silently grants the first matching device; registering
  // listeners blocks that path. Cancel semantics: hid/usb take no arg, serial takes an empty
  // string. Once the chooser is injected, the user's choice is the callback deviceId.
  const cancelArgFor = (permission: string): string | undefined =>
    permission === "select-hid-device" || permission === "select-usb-device" ? undefined : "";

  // One chooser per permission globally: select-* fires repeatedly during discovery (Bluetooth
  // scans drip devices; USB enumeration likewise) and later fires only hot-update the list.
  // Chromium semantics: repeated fires of the same request before the callback settles, so later
  // callbacks are not invoked.
  const devicePickerSessions = new Map<string, EmbeddedBrowserDevicePickerSession>();

  const settleDeviceSelection = (
    permission: string,
    input: {
      origin: string;
      devices: EmbeddedBrowserPermissionDeviceOption[];
      hostWebContentsId?: number;
      guestWebContentsId?: number;
    },
    callback: (value?: string) => void,
  ): void => {
    const cancel = cancelArgFor(permission);
    if (!options.devicePicker) {
      logDecision("denied", { permission, origin: input.origin, source: "device-picker" });
      callback(cancel);
      return;
    }
    const existing = devicePickerSessions.get(permission);
    if (existing) {
      // Diagnostics for Bluetooth/USB drip enumeration: log visible device count on hot update
      // (an empty list points at TCC permission problems).
      logger.info(`${LOG_TAG} device list updated`, {
        permission,
        origin: input.origin,
        deviceCount: input.devices.length,
      });
      existing.updateDevices(input.devices);
      return;
    }
    let session: EmbeddedBrowserDevicePickerSession;
    try {
      session = options.devicePicker({ ...input, permission });
    } catch (error) {
      logger.warn(`${LOG_TAG} device picker failed: ${String(error)}`);
      callback(cancel);
      return;
    }
    devicePickerSessions.set(permission, session);
    logger.info(`${LOG_TAG} device picker opened`, {
      permission,
      origin: input.origin,
      deviceCount: input.devices.length,
    });
    void session.result.then(
      (picked) => {
        devicePickerSessions.delete(permission);
        if (!picked) {
          logDecision("denied", { permission, origin: input.origin, source: "device-picker" });
          callback(cancel);
          return;
        }
        logDecision("granted", { permission, origin: input.origin, source: "device-picker" });
        callback(picked.deviceId);
      },
      (error: unknown) => {
        devicePickerSessions.delete(permission);
        logger.warn(`${LOG_TAG} device picker failed: ${String(error)}`);
        callback(cancel);
      },
    );
  };

  // hid/usb: (event, details { deviceList, frame }, callback)
  const handleFramedDeviceSelection = (permission: string) => {
    return (event: unknown, details: unknown, callback: (value?: string) => void) => {
      // preventDefault is required: otherwise Chromium cancels the page request with
      // "no device chosen" right after the event fires and the async callback never applies
      // (A/B tested: with preventDefault, a 4s delayed choice works).
      (event as { preventDefault?: () => void }).preventDefault?.();
      const frameUrl = (details as { frame?: { url?: string } | null })?.frame?.url;
      const deviceList = (details as { deviceList?: unknown })?.deviceList;
      settleDeviceSelection(
        permission,
        {
          origin: originFromUrl(frameUrl),
          devices: readDeviceOptions(deviceList),
        },
        callback,
      );
    };
  };
  targetSession.on("select-hid-device", handleFramedDeviceSelection("select-hid-device"));
  targetSession.on("select-usb-device", handleFramedDeviceSelection("select-usb-device"));

  // serial: (event, portList, webContents, callback(portId: string)); empty string cancels
  targetSession.on(
    "select-serial-port",
    (
      event: unknown,
      portList: unknown,
      webContents: unknown,
      callback: (portId: string) => void,
    ) => {
      // Like hid/usb: prevent the default cancel and wait for the user's choice.
      (event as { preventDefault?: () => void }).preventDefault?.();
      const contents = webContents as {
        hostWebContents?: { id?: number };
        id?: number;
        getURL?: () => string;
      } | null;
      const hostWebContentsId = contents?.hostWebContents?.id ?? contents?.id;
      settleDeviceSelection(
        "select-serial-port",
        {
          origin: originFromUrl(contents?.getURL?.()),
          devices: readDeviceOptions(portList),
          ...(hostWebContentsId !== undefined ? { hostWebContentsId } : {}),
        },
        (value) => callback(value ?? ""),
      );
    },
  );
}
