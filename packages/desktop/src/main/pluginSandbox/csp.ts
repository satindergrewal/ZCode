import type {
  McpAppCspRelaxations,
  McpAppsResourcePermission,
  McpToolUiCsp,
} from "@zcode/shared/mcp-apps";
import { normalizeCspOrigin } from "@zcode/shared/mcp-apps";
import { buildPluginSandboxShellUrl } from "./contract.js";

/**
 * App iframe CSP: default strictly per the MCP Apps spec block
 * (`default-src 'none'; script-src 'self' 'unsafe-inline'; ...`); the four directives allow only
 * origins declared in the resource's `_meta.ui.csp` (spec MUST NOT allow undeclared ones).
 * inline script/style must be allowed — MCP Apps HTML resources inline scripts routinely; the
 * isolation boundary is dedicated partition + dedicated origin + iframe sandbox, not inline bans.
 *
 * The only deviations from the spec default are non-host sources: `script-src` adds `blob: data:`
 * (single-file bundlers inline worker/dynamic-import chunks as data: URLs — the official pdf-server
 * example's pdf.js worker does exactly this; with 'unsafe-inline' present it adds no capability,
 * and the official reference host basic-host allows it too), `blob:` (canvas export/worker), and
 * `font-src 'self' data:` (the spec default has no font-src, so default-src 'none' would block
 * even inline fonts). `'unsafe-eval'`/`'wasm-unsafe-eval'` are not default-allowed: resources
 * needing eval/WebAssembly (e.g. OpenPencil's kiwi schema compile and CanvasKit) declare them in
 * the resource's `_meta["zcode/csp"]`.
 */
export function buildPluginSandboxCsp(input: {
  csp?: McpToolUiCsp;
  cspRelaxations?: McpAppCspRelaxations;
  sandboxId: string;
  appIdentity: string;
}): string {
  const resource = normalizeOrigins(input.csp?.resourceDomains);
  const connect = normalizeOrigins(input.csp?.connectDomains);
  const frame = normalizeOrigins(input.csp?.frameDomains);
  const baseUri = normalizeOrigins(input.csp?.baseUriDomains);
  if (!PLUGIN_SANDBOX_CSP_HOST_SAFE_ID.test(input.sandboxId)) {
    // See the registry createId comment: illegal chars silently turn frame-ancestors into 'none';
    // reject here instead of emitting a broken header.
    throw new Error(`plugin sandbox id is not CSP host-safe: ${input.sandboxId}`);
  }
  const shellUrl = new URL(buildPluginSandboxShellUrl(input.sandboxId, input.appIdentity));
  const shellOrigin = `${shellUrl.protocol}//${shellUrl.host}`;
  const scriptSources = [
    "'self'",
    "'unsafe-inline'",
    "blob:",
    "data:",
    ...(input.cspRelaxations?.unsafeEval ? ["'unsafe-eval'"] : []),
    ...(input.cspRelaxations?.wasmUnsafeEval ? ["'wasm-unsafe-eval'"] : []),
    ...resource,
  ];
  return [
    "default-src 'none'",
    `script-src ${scriptSources.join(" ")}`,
    `style-src ${["'self'", "'unsafe-inline'", ...resource].join(" ")}`,
    `img-src ${["'self'", "data:", "blob:", ...resource].join(" ")}`,
    `media-src ${["'self'", "data:", "blob:", ...resource].join(" ")}`,
    `font-src ${["'self'", "data:", ...resource].join(" ")}`,
    `connect-src ${connect.length > 0 ? connect.join(" ") : "'none'"}`,
    `frame-src ${frame.length > 0 ? frame.join(" ") : "'none'"}`,
    `base-uri ${["'self'", ...baseUri].join(" ")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    `frame-ancestors ${shellOrigin}`,
    "form-action 'none'",
  ].join("; ");
}

/** CSP host-source charset (ALPHA / DIGIT / "-"). */
export const PLUGIN_SANDBOX_CSP_HOST_SAFE_ID = /^[A-Za-z0-9-]+$/;

/** The trusted shell loads bundled resources only; no network. */
export const PLUGIN_SANDBOX_SHELL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "frame-src zcode-sandbox:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'self'",
].join("; ");

export const PLUGIN_SANDBOX_PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "display-capture=()",
  "payment=()",
  "usb=()",
  "clipboard-read=()",
].join(", ");

/**
 * Relax Permissions-Policy per resource declaration: the shell document uses `*` for declared
 * features (it embeds only this sandbox's plugin iframe, and Chromium may not accept custom-scheme
 * origin strings); the plugin document uses `(self)`; undeclared features get `()`.
 */
export function buildPluginSandboxPermissionsPolicy(
  permissions: readonly McpAppsResourcePermission[] | undefined,
  document: "shell" | "plugin",
): string {
  const granted = new Set(permissions ?? []);
  const allow = document === "shell" ? "*" : "(self)";
  return [
    `camera=${granted.has("camera") ? allow : "()"}`,
    `microphone=${granted.has("microphone") ? allow : "()"}`,
    `geolocation=${granted.has("geolocation") ? allow : "()"}`,
    "display-capture=()",
    "payment=()",
    "usb=()",
    "clipboard-read=()",
  ].join(", ");
}

function normalizeOrigins(list: string[] | undefined): string[] {
  if (!list) return [];
  const origins = list
    .map(normalizeCspOrigin)
    .filter((origin): origin is string => origin !== null);
  return [...new Set(origins)];
}
