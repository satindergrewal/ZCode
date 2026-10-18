/**
 * Pure logic for the trusted relay shell: no parsing, no buffering - JSON-RPC is forwarded
 * verbatim between the host MessagePort and the plugin iframe. All protocol state (handshake,
 * timeouts, teardown) lives in the host renderer's official AppBridge; DOM wiring is in main.ts.
 */
export interface PluginSandboxRelayFrame {
  postMessage(message: unknown, targetOrigin: string): void;
  remove(): void;
}

export interface PluginSandboxRelayPort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  start?(): void;
  close(): void;
}

export interface PluginSandboxRelay {
  /** Init frame handed over by preload: `{ type: "init", sandboxId, initId }` plus one port. */
  handleInit(data: unknown, ports: readonly PluginSandboxRelayPort[]): void;
  /** Messages from the plugin iframe (source/origin already validated in main.ts). */
  handleFrameMessage(data: unknown): void;
  readonly initId: number | null;
  dispose(): void;
}

/** The plugin iframe `allow` accepts only these four Permissions Policy features (the same set the main permission gate enforces). */
export const PLUGIN_SANDBOX_IFRAME_ALLOW_TOKENS: readonly string[] = [
  "camera",
  "microphone",
  "geolocation",
  "clipboard-write",
];

/** Filter the init frame's allow list: drop unknown tokens, dedup, keep order. */
export function sanitizePluginSandboxIframeAllow(value: unknown): string {
  if (typeof value !== "string") return "";
  const tokens = value
    .split(";")
    .map((token) => token.trim())
    .filter((token) => PLUGIN_SANDBOX_IFRAME_ALLOW_TOKENS.includes(token));
  return [...new Set(tokens)].join("; ");
}

export const PLUGIN_SANDBOX_SHELL_HOST_PREFIX = "shell-";
export const PLUGIN_SANDBOX_PLUGIN_HOST_PREFIX = "plugin-";

//** Derive the sandboxId and plugin iframe origin/URL from the shell's own origin (zcode-sandbox://shell-<id>). */
export function resolvePluginSandboxShellIdentity(origin: string): {
  sandboxId: string;
  pluginOrigin: string;
  pluginUrl: string;
} | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (!url.hostname.startsWith(PLUGIN_SANDBOX_SHELL_HOST_PREFIX)) return null;
  const sandboxId = url.pathname.split("/")[2];
  if (!sandboxId) return null;
  const appIdentity = url.hostname.slice(PLUGIN_SANDBOX_SHELL_HOST_PREFIX.length);
  if (!appIdentity || !/^[a-f0-9]{64}$/.test(appIdentity)) return null;
  const pluginOrigin = `${url.protocol}//${PLUGIN_SANDBOX_PLUGIN_HOST_PREFIX}${appIdentity}`;
  return { sandboxId, pluginOrigin, pluginUrl: `${pluginOrigin}/instance/${sandboxId}/index.html` };
}

export function createPluginSandboxRelay(deps: {
  sandboxId: string;
  pluginOrigin: string;
  pluginUrl: string;
  /** Omit the attribute when `allow` is empty. */
  createPluginFrame(src: string, allow: string): PluginSandboxRelayFrame;
  showError(message: string): void;
  log(message: string): void;
}): PluginSandboxRelay {
  let port: PluginSandboxRelayPort | null = null;
  let frame: PluginSandboxRelayFrame | null = null;
  let initId: number | null = null;
  let disposed = false;

  return {
    get initId() {
      return initId;
    },
    handleInit(data, ports) {
      if (disposed) return;
      const init = data as {
        type?: unknown;
        sandboxId?: unknown;
        initId?: unknown;
        allow?: unknown;
      } | null;
      if (
        typeof init !== "object" ||
        init === null ||
        init.type !== "init" ||
        typeof init.sandboxId !== "string" ||
        typeof init.initId !== "number"
      ) {
        return;
      }
      if (init.sandboxId !== deps.sandboxId) {
        deps.log(
          `[plugin-sandbox-shell] init for another sandbox ${init.sandboxId}, expected ${deps.sandboxId}`,
        );
        return;
      }
      const incoming = ports[0];
      if (!incoming || ports.length !== 1) {
        deps.showError("Plugin sandbox: init without a port.");
        return;
      }
      if (port) {
        // main sends init once per guest dom-ready; a duplicate can only be a crossed line - keep the first.
        deps.log(
          `[plugin-sandbox-shell] duplicate init ignored (initId=${init.initId}, current=${initId})`,
        );
        incoming.close();
        return;
      }
      port = incoming;
      initId = init.initId;
      frame = deps.createPluginFrame(deps.pluginUrl, sanitizePluginSandboxIframeAllow(init.allow));
      port.onmessage = (event) => {
        frame?.postMessage(event.data, deps.pluginOrigin);
      };
      port.start?.();
    },
    handleFrameMessage(data) {
      if (disposed || !port) return;
      if (typeof data !== "object" || data === null) return;
      port.postMessage(data);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      port?.close();
      port = null;
      frame?.remove();
      frame = null;
    },
  };
}
