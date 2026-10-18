import type { WebContents } from "electron";

/**
 * autoInject only runs its executeJavaScript init on dom-ready; with Vite, window.load
 * often finishes earlier, so perf-collector's onLoad/sendPerf never run (webvitals still
 * reports, hence perf=0 in beforeReport). Re-dispatch load after did-finish-load and
 * dom-ready, and wait for RumSDK to be ready.
 */
export const ARMS_BROWSER_PERF_LOAD_NUDGE_SCRIPT = `(function () {
  function dispatchLoad() {
    try {
      window.dispatchEvent(new Event("load"));
    } catch (e) {}
  }
  function tryNudge(attempt) {
    if (typeof window.RumSDK !== "undefined" && window.RumSDK.default) {
      if (document.readyState === "complete") {
        dispatchLoad();
      }
      return;
    }
    if (attempt < 80) {
      setTimeout(function () {
        tryNudge(attempt + 1);
      }, 25);
    }
  }
  if (document.readyState === "complete") {
    tryNudge(0);
  } else {
    window.addEventListener(
      "load",
      function () {
        tryNudge(0);
      },
      { once: true }
    );
  }
})();`;

export function scheduleArmsBrowserPerfLoadNudge(webContents: WebContents): void {
  const nudge = (): void => {
    if (webContents.isDestroyed()) {
      return;
    }
    void webContents.executeJavaScript(ARMS_BROWSER_PERF_LOAD_NUDGE_SCRIPT, true).catch(() => {
      // Ignore non-main windows and injection failures.
    });
  };

  webContents.on("did-finish-load", nudge);
  // Attached on dom-ready like the SDK autoInject, delayed one tick to let RumSDK.default.init finish.
  webContents.on("dom-ready", () => {
    setTimeout(nudge, 0);
    setTimeout(nudge, 150);
  });
}
