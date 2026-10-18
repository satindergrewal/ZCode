import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  interface WebViewHTMLAttributes<T> extends HTMLAttributes<T> {
    nodeintegrationinsubframes?: string;
  }
}

type ElectronWebviewSimpleEventName =
  | "did-attach"
  | "dom-ready"
  | "did-start-loading"
  | "did-stop-loading";
type ElectronWebviewNavigationEventName =
  | "did-navigate"
  | "did-navigate-in-page"
  | "will-navigate"
  | "will-frame-navigate";
type ElectronWebviewRenderProcessGoneReason =
  | "clean-exit"
  | "abnormal-exit"
  | "killed"
  | "crashed"
  | "oom"
  | "launch-failed"
  | "integrity-failure"
  | "memory-eviction";

declare global {
  interface ElectronWebviewNavigationEvent extends Event {
    url: string;
    isMainFrame?: boolean;
  }

  interface ElectronWebviewDidFailLoadEvent extends Event {
    errorCode: number;
    errorDescription: string;
    validatedURL: string;
    isMainFrame: boolean;
  }

  interface ElectronWebviewTitleEvent extends Event {
    title: string;
    explicitSet: boolean;
  }

  interface ElectronWebviewFaviconEvent extends Event {
    favicons: string[];
  }

  interface ElectronWebviewIpcMessageEvent extends Event {
    channel: string;
    args: unknown[];
  }

  interface ElectronWebviewRenderProcessGoneEvent extends Event {
    details: {
      reason: ElectronWebviewRenderProcessGoneReason;
      exitCode: number;
    };
  }

  interface ElectronWebviewTag extends HTMLElement {
    src: string;
    getURL(): string;
    getTitle(): string;
    loadURL(url: string): Promise<void>;
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
    // Guest webContents id; valid after dom-ready. The renderer reports it to main for CDP attach (<webview>+CDP-on-guest).
    getWebContentsId(): number;
    canGoBack(): boolean;
    canGoForward(): boolean;
    goBack(): void;
    goForward(): void;
    reload(): void;
    openDevTools(): void;
    setZoomFactor(factor: number): void;
    addEventListener(
      type: ElectronWebviewSimpleEventName,
      listener: (event: Event) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: "did-fail-load",
      listener: (event: ElectronWebviewDidFailLoadEvent) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: ElectronWebviewNavigationEventName,
      listener: (event: ElectronWebviewNavigationEvent) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: "page-title-updated",
      listener: (event: ElectronWebviewTitleEvent) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: "page-favicon-updated",
      listener: (event: ElectronWebviewFaviconEvent) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: "ipc-message",
      listener: (event: ElectronWebviewIpcMessageEvent) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: "render-process-gone",
      listener: (event: ElectronWebviewRenderProcessGoneEvent) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    removeEventListener(
      type: ElectronWebviewSimpleEventName,
      listener: (event: Event) => void,
      options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(
      type: "did-fail-load",
      listener: (event: ElectronWebviewDidFailLoadEvent) => void,
      options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(
      type: ElectronWebviewNavigationEventName,
      listener: (event: ElectronWebviewNavigationEvent) => void,
      options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(
      type: "page-title-updated",
      listener: (event: ElectronWebviewTitleEvent) => void,
      options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(
      type: "page-favicon-updated",
      listener: (event: ElectronWebviewFaviconEvent) => void,
      options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(
      type: "ipc-message",
      listener: (event: ElectronWebviewIpcMessageEvent) => void,
      options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(
      type: "render-process-gone",
      listener: (event: ElectronWebviewRenderProcessGoneEvent) => void,
      options?: boolean | EventListenerOptions,
    ): void;
  }

  // React refs to <webview> rely on HTMLWebViewElement. Declaring only the custom
  // ElectronWebviewTag left ref callback params mismatched with the JSX intrinsic
  // element host type; align HTMLWebViewElement so events and refs resolve as Electron webview.
  interface HTMLWebViewElement extends ElectronWebviewTag {}

  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLWebViewElement>, HTMLWebViewElement> & {
        partition?: string;
        src?: string;
      };
    }
  }
}

export {};
