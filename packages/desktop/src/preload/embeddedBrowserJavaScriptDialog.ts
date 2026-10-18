import { contextBridge, ipcRenderer } from "electron";
import { PlatformChannels } from "@zcode/shared";
import { installEmbeddedBrowserWheelForwarding } from "./embeddedBrowserWheel.js";

const BRIDGE_KEY = "__zcodeEmbeddedBrowserJavaScriptDialog__";

if (typeof window !== "undefined") {
  installEmbeddedBrowserWheelForwarding(window, (channel, payload) => {
    ipcRenderer.sendToHost(channel, payload);
  });
}

interface DialogBridgeResult {
  handled: boolean;
  value?: boolean;
}

contextBridge.exposeInMainWorld(BRIDGE_KEY, {
  show(type: "alert" | "confirm", message: string): DialogBridgeResult {
    try {
      const result = ipcRenderer.sendSync(PlatformChannels.EmbeddedBrowserJavaScriptDialog, {
        type,
        message,
      }) as unknown;
      if (typeof result !== "object" || result === null) return { handled: false };
      const candidate = result as Partial<DialogBridgeResult>;
      if (candidate.handled !== true) return { handled: false };
      return {
        handled: true,
        ...(typeof candidate.value === "boolean" ? { value: candidate.value } : {}),
      };
    } catch {
      // Fall back to Chromium's native dialog API when main is unavailable; never swallow the page dialog.
      return { handled: false };
    }
  },
});

contextBridge.executeInMainWorld({
  func: (bridgeKey: string) => {
    type Bridge = {
      show: (type: "alert" | "confirm", message: string) => DialogBridgeResult;
    };
    const bridge = (window as unknown as Record<string, Bridge | undefined>)[bridgeKey];
    if (!bridge) return;

    const installedConfirmByWindow = new WeakMap<Window, Window["confirm"]>();
    const observedFrames = new WeakSet<HTMLIFrameElement>();

    const installInWindow = (target: Window): void => {
      try {
        if (installedConfirmByWindow.get(target) === target.confirm) return;
        const nativeAlert = target.alert.bind(target);
        const nativeConfirm = target.confirm.bind(target);
        target.alert = (message?: unknown): void => {
          const text = message === undefined ? "" : String(message);
          const result = bridge.show("alert", text);
          if (!result.handled) nativeAlert(text);
        };
        const wrappedConfirm = (message?: string): boolean => {
          const text = message === undefined ? "" : String(message);
          const result = bridge.show("confirm", text);
          return result.handled ? result.value === true : nativeConfirm(text);
        };
        target.confirm = wrappedConfirm;
        installedConfirmByWindow.set(target, wrappedConfirm);
      } catch {
        // Cross-origin frames disallow host Window access; they load this same preload on real navigation.
      }
    };

    const installFrameTree = (target: Window): void => {
      installInWindow(target);
      try {
        for (const frame of target.document.querySelectorAll("iframe")) {
          if (!observedFrames.has(frame)) {
            observedFrames.add(frame);
            frame.addEventListener(
              "load",
              () => {
                if (frame.contentWindow) installFrameTree(frame.contentWindow);
              },
              true,
            );
          }
          if (frame.contentWindow) installFrameTree(frame.contentWindow);
        }
      } catch {
        // The cross-origin document's frame tree is handled by that frame's own preload.
      }
    };

    installFrameTree(window);
    const observeFrames = (): void => {
      installFrameTree(window);
      const root = window.document?.documentElement;
      if (!root) return;
      // A src-less inherited about:blank iframe never navigates documents, so Electron
      // never runs a dedicated preload; after page insert, install the same wrapper from the same-origin parent.
      new window.MutationObserver(() => installFrameTree(window)).observe(root, {
        childList: true,
        subtree: true,
      });
    };
    if (window.document?.documentElement) observeFrames();
    else window.addEventListener?.("DOMContentLoaded", observeFrames, { once: true });
  },
  args: [BRIDGE_KEY],
});

/**
 * Electron's Notification.permission getter never consults the session permission handler and
 * always returns denied (upstream feature request; no renderer override yet), so pages show
 * granted-permissions as denied. Override it in the main world over the same channel as the JS
 * dialog: present as default until decided, then write back requestPermission's real result.
 * The display behavior of new Notification stays Chromium-internal, untouched by this override.
 */
contextBridge.executeInMainWorld({
  func: () => {
    try {
      if (typeof Notification === "undefined") return;
      let permissionState: NotificationPermission = "default";
      const nativeRequestPermission = Notification.requestPermission;
      const wrappedRequestPermission = function (
        this: typeof Notification,
        deprecatedCallback?: NotificationPermissionCallback | undefined,
      ): Promise<NotificationPermission> {
        const settled = Promise.resolve(nativeRequestPermission.call(Notification)).then(
          (status: NotificationPermission) => {
            permissionState = status;
            return status;
          },
        );
        if (typeof deprecatedCallback === "function") {
          void settled.then(
            (status) => deprecatedCallback(status),
            () => undefined,
          );
        }
        return settled;
      };
      Notification.requestPermission = wrappedRequestPermission;
      Object.defineProperty(Notification, "permission", {
        get: () => permissionState,
        configurable: true,
      });
    } catch {
      // Page scripts may have replaced Notification; keep native behavior.
    }
  },
  args: [],
});
