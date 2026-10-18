import { InternalChannels, PluginSandboxChannels } from "@zcode/shared";
import { buildMcpAppsIframeAllow } from "@zcode/shared/mcp-apps";
import type { WebContents, WebPreferences } from "electron";
import type { PluginSandboxRegistryPort } from "./contract.js";
import { PLUGIN_SANDBOX_SCHEME, buildPluginSandboxPluginOrigin } from "./contract.js";
import { parsePluginSandboxUrl } from "./protocol.js";

/** Whether will-attach-webview's `params.src` points at the plugin sandbox shell. */
export function isPluginSandboxSrc(src: string | undefined): boolean {
  return typeof src === "string" && src.startsWith(`${PLUGIN_SANDBOX_SCHEME}://`);
}

export type PluginSandboxGuestDecision =
  | { ok: true; sandboxId: string }
  | {
      ok: false;
      reason: "not-shell-url" | "unknown-sandbox" | "partition-mismatch" | "owner-mismatch";
    };

/**
 * webPreferences hardening for sandbox guests. Unlike built-in browser guests: no allowpopups
 * restore, no nodeIntegrationInSubFrames, webviewTag off, and sandboxId/partition/owner must all
 * match.
 */
export function configurePluginSandboxGuest(input: {
  webPreferences: WebPreferences;
  params: Record<string, string>;
  registry: PluginSandboxRegistryPort;
  ownerWebContentsId: number;
  preloadPath: string;
}): PluginSandboxGuestDecision {
  const target = parsePluginSandboxUrl(input.params.src ?? "");
  if (!target || target.kind !== "shell") return { ok: false, reason: "not-shell-url" };
  const record = input.registry.get(target.sandboxId);
  if (!record || input.params.src !== record.shellUrl)
    return { ok: false, reason: "unknown-sandbox" };
  if (input.params.partition !== record.partition)
    return { ok: false, reason: "partition-mismatch" };
  if (record.ownerWebContentsId !== input.ownerWebContentsId) {
    return { ok: false, reason: "owner-mismatch" };
  }

  input.webPreferences.preload = input.preloadPath;
  input.webPreferences.contextIsolation = true;
  input.webPreferences.sandbox = true;
  input.webPreferences.webSecurity = true;
  input.webPreferences.nodeIntegration = false;
  input.webPreferences.nodeIntegrationInSubFrames = false;
  input.webPreferences.webviewTag = false;
  input.webPreferences.plugins = false;
  input.webPreferences.disableDialogs = true;
  input.webPreferences.allowRunningInsecureContent = false;
  delete input.params.preload;
  delete input.params.nodeintegration;
  delete input.params.nodeintegrationinsubframes;
  delete input.params.disablewebsecurity;
  delete input.params.allowpopups;
  delete input.params.webpreferences;
  return { ok: true, sandboxId: target.sandboxId };
}

export interface PluginSandboxMessageChannel {
  port1: PluginSandboxMessagePort;
  port2: PluginSandboxMessagePort;
}
export interface PluginSandboxMessagePort {
  close(): void;
}

export interface AttachPluginSandboxGuestInput {
  guest: Pick<WebContents, "on" | "once" | "setWindowOpenHandler" | "postMessage" | "isDestroyed">;
  hostWebContents: Pick<WebContents, "postMessage" | "isDestroyed">;
  registry: PluginSandboxRegistryPort;
  sandboxId: string;
  createMessageChannel: () => PluginSandboxMessageChannel;
  logger?: {
    warn: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
}

/**
 * Post did-attach-webview guest policy: reject all popups, navigation only within the sandbox
 * origin. After dom-ready open a MessageChannel carrying raw JSON-RPC: port1 to the guest (via
 * preload to the relay shell), port2 to the host renderer's AppBridge; input-event records user
 * gestures (before-input-event covers keys only, mouse clicks never fire it).
 */
export function attachPluginSandboxGuest(input: AttachPluginSandboxGuestInput): () => void {
  const record = input.registry.get(input.sandboxId);
  if (!record) {
    input.logger?.warn(`[plugin-sandbox] attach for unknown sandbox ${input.sandboxId}`);
    return () => {};
  }
  const shellOrigin = `${new URL(record.shellUrl).protocol}//${new URL(record.shellUrl).host}`;
  const pluginOrigin = buildPluginSandboxPluginOrigin(record.instance.appIdentity);
  const allowedOrigins = new Set([shellOrigin, pluginOrigin]);
  let initialized = false;
  let pluginLoaded = false;
  const openPorts: PluginSandboxMessagePort[] = [];

  // H14: pin on attach, unpin on guest destroy/host detach (exactly once); live instances are
  // never evicted by TTL or capacity.
  input.registry.pin(input.sandboxId);
  let pinned = true;
  const unpin = () => {
    if (!pinned) return;
    pinned = false;
    input.registry.unpin(input.sandboxId);
  };
  input.guest.once("destroyed", unpin);

  input.guest.setWindowOpenHandler(() => ({ action: "deny" }));
  input.guest.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url, allowedOrigins)) {
      event.preventDefault();
      input.logger?.warn(`[plugin-sandbox] blocked navigation ${url}`);
    }
  });
  input.guest.on("will-frame-navigate", (event) => {
    const details = event as unknown as { url?: string; isMainFrame?: boolean };
    if (details.url && !isAllowedNavigation(details.url, allowedOrigins)) {
      event.preventDefault();
    }
  });
  // Forward guest console to main logs: CSP rejections and script errors are invisible otherwise.
  input.guest.on("console-message", (event: unknown, ...legacy: unknown[]) => {
    const detail = event as { level?: unknown; message?: unknown } | undefined;
    const level = detail?.level ?? legacy[0];
    const message = detail?.message ?? legacy[1];
    const line = `[plugin-sandbox] guest console(${String(level)}): ${String(message)}`;
    // Per-message SDK protocol logs are debug; never promote them to production info on disk.
    if (level === "debug" || level === 0) input.logger?.debug?.(line);
    else if (level === "error" || level === 3) input.logger?.warn(line);
    else input.logger?.info?.(line);
  });
  // Warn on any frame load failure (with code and URL): when the plugin page blanks, this
  // distinguishes blocked/404/network causes.
  input.guest.on(
    "did-fail-load",
    (
      _event,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ) => {
      input.logger?.warn(
        `[plugin-sandbox] did-fail-load code=${errorCode} ${errorDescription} url=${validatedUrl} mainFrame=${String(isMainFrame)}`,
      );
    },
  );
  input.guest.on(
    "did-frame-navigate",
    (
      _event,
      url: string,
      httpResponseCode: number,
      httpStatusText: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame && url.startsWith(pluginOrigin + "/")) pluginLoaded = true;
      input.logger?.info?.(
        `[plugin-sandbox] did-frame-navigate ${url} ${httpResponseCode} ${httpStatusText} mainFrame=${String(isMainFrame)}`,
      );
    },
  );
  input.guest.on("input-event", (_event, inputEvent) => {
    if (
      inputEvent.type === "mouseDown" ||
      inputEvent.type === "keyDown" ||
      inputEvent.type === "rawKeyDown"
    ) {
      input.registry.markUserGesture(input.sandboxId);
    }
  });
  // A page-initiated reload must not inherit the previous document's grants or MessagePort.
  input.guest.on("did-start-navigation", (event) => {
    if (
      !event.isSameDocument &&
      ((initialized && event.isMainFrame) || (pluginLoaded && !event.isMainFrame))
    ) {
      input.registry.dispose(record.sandboxId, record.initId);
    }
  });
  input.guest.once("dom-ready", () => {
    const current = input.registry.get(input.sandboxId);
    if (!current || input.guest.isDestroyed() || input.hostWebContents.isDestroyed()) return;
    initialized = true;
    const channel = input.createMessageChannel();
    openPorts.push(channel.port1, channel.port2);
    const payload = { sandboxId: current.sandboxId, initId: current.initId };
    // Host renderer first, then guest: the renderer registers initId first so the shell's init
    // is not dropped while the host is not ready.
    input.hostWebContents.postMessage(InternalChannels.PluginSandboxPorts, payload, [
      channel.port2,
    ] as never);
    // Declared permissions → the plugin iframe's `allow` (the shell delegates Permissions Policy
    // to the cross-origin iframe based on it).
    input.guest.postMessage(
      PluginSandboxChannels.Init,
      { ...payload, allow: buildMcpAppsIframeAllow(current.permissions) },
      [channel.port1] as never,
    );
  });

  return () => {
    unpin();
    for (const port of openPorts) port.close();
    openPorts.length = 0;
  };
}

function isAllowedNavigation(url: string, allowedOrigins: Set<string>): boolean {
  try {
    const parsed = new URL(url);
    return allowedOrigins.has(`${parsed.protocol}//${parsed.host}`);
  } catch {
    return false;
  }
}
