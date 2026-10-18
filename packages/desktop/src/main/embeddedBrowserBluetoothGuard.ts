import type { WebContents } from "electron";
import type { EmbeddedBrowserPermissionDeviceOption } from "@zcode/shared";
import {
  EMBEDDED_BROWSER_PERMISSION_LOG_TAG as LOG_TAG,
  originFromUrl,
  type EmbeddedBrowserDevicePickerSession,
} from "./embeddedBrowserPermissionPolicy.js";
import { readDeviceOptions } from "./embeddedBrowserDeviceOptions.js";

/**
 * Bluetooth device-selection events hang off the guest's WebContents, not the Session
 * (Electron 41 API layout), so each browser-guest branch of did-attach-webview must install one;
 * an empty string cancels the request. `log` receives whatever logger the host has (windowChrome's
 * logger only has warn, so this trail logs at warn too). With options.devicePicker injected the
 * chooser dialog runs; default cancels the request (blocking Electron's silent grant).
 */
export function installEmbeddedBrowserBluetoothDeviceGuard(
  guestWebContents: Pick<WebContents, "getURL" | "id" | "on">,
  log: (...args: unknown[]) => void = console.info,
  options: {
    devicePicker?: (input: {
      origin: string;
      permission: string;
      devices: EmbeddedBrowserPermissionDeviceOption[];
      hostWebContentsId?: number;
      guestWebContentsId?: number;
    }) => EmbeddedBrowserDevicePickerSession;
    hostWebContentsId?: number;
  } = {},
): void {
  // During scans Chromium fires select-bluetooth-device repeatedly (devices appear gradually);
  // one dialog per request until the callback settles, later fires hot-update the list.
  let session: EmbeddedBrowserDevicePickerSession | null = null;
  guestWebContents.on(
    "select-bluetooth-device",
    (event: unknown, devices: unknown, callback: (deviceId: string) => void) => {
      // Same as hid/usb/serial: prevent the default cancel and wait for the user (Chromium
      // otherwise ends the page request with "nothing chosen" right after the event).
      (event as { preventDefault?: () => void }).preventDefault?.();
      if (!options.devicePicker) {
        log(`${LOG_TAG} decision=denied`, {
          permission: "select-bluetooth-device",
          source: "device-picker",
        });
        callback("");
        return;
      }
      // event.sender has no reliable URL on webview guests (observed origin=unknown); use the
      // guest itself.
      const origin = originFromUrl(guestWebContents.getURL());
      const deviceOptions = readDeviceOptions(devices);
      if (session) {
        log(`${LOG_TAG} device list updated`, {
          permission: "select-bluetooth-device",
          origin,
          deviceCount: deviceOptions.length,
        });
        session.updateDevices(deviceOptions);
        return;
      }
      try {
        session = options.devicePicker({
          origin,
          permission: "select-bluetooth-device",
          devices: deviceOptions,
          ...(options.hostWebContentsId !== undefined
            ? { hostWebContentsId: options.hostWebContentsId }
            : {}),
          guestWebContentsId: guestWebContents.id,
        });
      } catch (error) {
        log(`${LOG_TAG} decision=denied`, {
          permission: "select-bluetooth-device",
          origin,
          source: "device-picker",
          error: String(error),
        });
        callback("");
        return;
      }
      log(`${LOG_TAG} device picker opened`, {
        permission: "select-bluetooth-device",
        origin,
        deviceCount: deviceOptions.length,
      });
      void session.result.then(
        (picked) => {
          session = null;
          log(`${LOG_TAG} decision=${picked ? "granted" : "denied"}`, {
            permission: "select-bluetooth-device",
            origin,
            source: "device-picker",
          });
          callback(picked?.deviceId ?? "");
        },
        (error: unknown) => {
          session = null;
          log(`${LOG_TAG} decision=denied`, {
            permission: "select-bluetooth-device",
            origin,
            source: "device-picker",
            error: String(error),
          });
          callback("");
        },
      );
    },
  );
}
