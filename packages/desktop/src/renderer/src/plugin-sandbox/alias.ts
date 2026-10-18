import { App, LATEST_PROTOCOL_VERSION, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import { ZCODE_GLOBALS_EVENT, createPluginSandboxAliasRuntime } from "./aliasRuntime.js";
import { OPENAI_SET_GLOBALS_EVENT } from "./openaiAlias.js";

/**
 * `window.zcode` / `window.openai` aliases injected at the top of plugin HTML (IIFE-bundled as
 * out/plugin-sandbox/plugin-sandbox-alias.js). Thin wrapper over the official `App`: it talks only
 * to the parent window (trusted relay shell, origin shell-<id>) and connects lazily, so pages that
 * build their own official `App` never pay an extra ui/initialize because of the alias.
 */
// No `declare global` Window augmentation here: the alias script shares the host renderer's
// tsconfig, and `zcode?: unknown` would clobber the host's type for window.zcode (the preload
// bridge). Only defineProperty / `in` checks are used; no declarations needed.

const app = new App(
  { name: "zcode-alias", version: "1" },
  {},
  // Pages using the alias call notifyIntrinsicHeight themselves; an automatic ResizeObserver would double-report next to a page-owned App.
  { autoResize: false },
);

const runtime = createPluginSandboxAliasRuntime({
  app,
  // Accept messages from the relay shell (window.parent) only; the SDK transport posts to "*" and
  // the shell side validates origin.
  transport: new PostMessageTransport(window.parent, window.parent),
  protocolVersion: LATEST_PROTOCOL_VERSION,
  onChange: (globals) => {
    window.dispatchEvent(new CustomEvent(ZCODE_GLOBALS_EVENT));
    window.dispatchEvent(new CustomEvent(OPENAI_SET_GLOBALS_EVENT, { detail: { globals } }));
  },
});

// Host JSON-RPC (response/notification) before the alias handshake = a page-owned official App is already talking; the alias stands down (see markForeignApp).
window.addEventListener("message", (event) => {
  if (runtime.connecting || event.source !== window.parent) return;
  const data = event.data as { jsonrpc?: unknown } | null;
  if (data && typeof data === "object" && data.jsonrpc === "2.0") runtime.markForeignApp();
});

Object.defineProperty(window, "zcode", {
  value: runtime.zcode,
  writable: false,
  configurable: false,
  enumerable: true,
});
// Never overwrite a page-owned window.openai (e.g. the page's own polyfill).
if (!("openai" in window)) {
  Object.defineProperty(window, "openai", {
    value: runtime.openai,
    writable: false,
    configurable: false,
    enumerable: true,
  });
}
