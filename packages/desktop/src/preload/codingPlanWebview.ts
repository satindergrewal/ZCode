import { contextBridge, ipcRenderer } from "electron";
import {
  CodingPlanWebviewChannels,
  isTrustedCodingPlanWebviewOrigin,
  PlatformChannels,
} from "@zcode/shared";

// Coding Plan storefront preload:
// - mounts window.zcodeBridge in the page main world, exposing:
//   1) notifyPurchaseComplete: tells the host renderer via sendToHost once purchase completes;
//   2) getLang / onLangChange: reads the app locale and subscribes to runtime switches;
//   3) getReportContext: reads the app-injected purchase attribution context;
//   4) openExternal: opens external links in the system browser. <a target="_blank"> in the webview
//      is routed into an internal browser tab by setWindowOpenHandler, but the storefront wants
//      terms/admin links in the real browser; its script intercepts and forwards via this method.
// - getLang reads window.__zcodeLang__ in the main world (injected via app executeJavaScript);
//   onLangChange listens for the zcode-coding-plan-lang-change CustomEvent in the main world
//   (also dispatched via app executeJavaScript on locale change).
//   The whole bridge mounts via contextBridge.executeInMainWorld, sharing the page window,
//   so the event is received.
// - The storefront main world has no Node/ipcRenderer primitives; only business functions are exposed.
// Pattern copied from embeddedBrowserJavaScriptDialog.ts contextBridge.executeInMainWorld
// (usable with sandbox=true + contextIsolation=true; precedent exists).
//
// Injection timing: in will-attach-webview, when params.src is the storefront purchase page,
// switch webPreferences.preload to this file (see desktopWindowChrome.ts).

const PUBLIC_BRIDGE_KEY = "zcodeBridge";
const NATIVE_BRIDGE_KEY = "__zcodeCodingPlanWebviewNativeBridge__";
const LANG_VAR = "__zcodeLang__";
const LANG_CHANGE_EVENT = "zcode-coding-plan-lang-change";
const REPORT_CONTEXT_VAR = "__zcodeReportContext__";

function isTrustedCodingPlanBridgeLocation(): boolean {
  try {
    const url = new URL(window.location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (!url.pathname.includes("coding-plan")) return false;
    if (url.searchParams.get("embedded") === "app") return true;
    // The PayPal return page lacks embedded=app but returnTo points back to the embedded purchase page;
    // after payment it still needs zcodeBridge.notifyPurchaseComplete so the app refreshes model settings.
    if (!url.pathname.endsWith("/coding-plan/payment/callback")) return false;
    const returnTo = url.searchParams.get("returnTo");
    if (!returnTo) return false;
    const target = new URL(returnTo, url.origin);
    return (
      target.origin === url.origin &&
      target.pathname.includes("coding-plan") &&
      target.searchParams.get("embedded") === "app" &&
      !target.pathname.endsWith("/coding-plan/payment/callback")
    );
  } catch {
    return false;
  }
}

interface NotifyPurchaseCompletePayload {
  provider: "zai" | "bigmodel";
}

type CodingPlanReportContext = Record<string, string>;

interface CodingPlanNativeBridge {
  notifyPurchaseComplete(payload: NotifyPurchaseCompletePayload): void;
  openExternal(url: string): void;
}

// The Coding Plan guest keeps the same preload config when navigating to PayPal.
// Expose the bridge only to the trusted storefront purchase page; third-party auth pages inherit nothing.
if (isTrustedCodingPlanBridgeLocation()) {
  contextBridge.exposeInMainWorld(NATIVE_BRIDGE_KEY, {
    notifyPurchaseComplete(payload: NotifyPurchaseCompletePayload) {
      try {
        ipcRenderer.sendToHost(CodingPlanWebviewChannels.PurchaseComplete, {
          provider: payload.provider,
          timestamp: Date.now(),
        } satisfies import("@zcode/shared").CodingPlanPurchaseCompletePayload);
      } catch {
        // sendToHost throws once the host renderer detaches or the webview is destroyed;
        // the page does not depend on success, so stay silent.
      }
    },
    openExternal(url: string) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
        ipcRenderer.send(PlatformChannels.OpenExternal, {
          sourceUrl: window.location.href,
          url: parsed.toString(),
        });
      } catch {
        // Ignore malformed URLs; keep arbitrary IPC payloads off the bridge.
      }
    },
  } satisfies CodingPlanNativeBridge);

  contextBridge.executeInMainWorld({
    func: (
      publicBridgeKey: string,
      nativeBridgeKey: string,
      langVar: string,
      langChangeEvent: string,
      reportContextVar: string,
    ) => {
      const nativeBridge = (
        window as unknown as Record<string, CodingPlanNativeBridge | undefined>
      )[nativeBridgeKey];
      if (!nativeBridge) return;
      const bridge = {
        notifyPurchaseComplete(payload: NotifyPurchaseCompletePayload) {
          if (payload?.provider !== "zai" && payload?.provider !== "bigmodel") {
            return;
          }
          nativeBridge.notifyPurchaseComplete(payload);
        },
        // Returns the app locale, null before injection (the site detects embed mode with it).
        getLang() {
          // executeInMainWorld function bodies skip TS compilation: no as-casts or TS-only syntax.
          const value = (window as unknown as Record<string, unknown>)[langVar];
          return value === "zh-CN" || value === "en-US" ? value : null;
        },
        getReportContext() {
          const value = (window as unknown as Record<string, unknown>)[reportContextVar];
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return null;
          }
          return value as CodingPlanReportContext;
        },
        // Subscribe to runtime app-locale changes; returns an unsubscribe function.
        // Locale changes dispatch zcode-coding-plan-lang-change via executeJavaScript.
        onLangChange(callback: (locale: "zh-CN" | "en-US") => void) {
          const handler = (event: Event) => {
            const detail = (event as CustomEvent<{ locale?: unknown }>).detail;
            if (detail && (detail.locale === "zh-CN" || detail.locale === "en-US")) {
              callback(detail.locale);
            }
          };
          window.addEventListener(langChangeEvent, handler);
          return () => window.removeEventListener(langChangeEvent, handler);
        },
        openExternal(url: string) {
          nativeBridge.openExternal(url);
        },
      };
      Object.defineProperty(window, publicBridgeKey, {
        value: bridge,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    },
    args: [PUBLIC_BRIDGE_KEY, NATIVE_BRIDGE_KEY, LANG_VAR, LANG_CHANGE_EVENT, REPORT_CONTEXT_VAR],
  });
}
