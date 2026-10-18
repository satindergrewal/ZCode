import type {
  McpAppCspRelaxations,
  McpAppResourceMeta,
  McpAppsDisplayMode,
  McpAppsResourcePermission,
  McpAppsToolVisibility,
  McpToolUiCsp,
  McpToolUiDescriptor,
} from "./contract.js";
import {
  MCP_APPS_CSP_RELAXATION_FLAGS,
  MCP_APPS_CSP_RELAXATION_META_KEY,
  MCP_APPS_DEFAULT_TOOL_VISIBILITY,
  MCP_APPS_RESOURCE_PERMISSIONS,
  MCP_APPS_LEGACY_RESOURCE_URI_META_KEY,
  MCP_APPS_RESOURCE_URI_MAX_CHARS,
  MCP_APPS_SURFACE_ID_MAX_CHARS,
  MCP_APPS_SURFACE_ID_PATTERN,
  MCP_APPS_UI_RESOURCE_SCHEME,
} from "./contract.js";

/**
 * Tool visibility, decoupled from UI presentation. Reads only `_meta.ui.visibility`, default `["model", "app"]`,
 * and pure-data tools without a `ui://` resource decide model-table entry by it too -- no more losing whole tools to a missing resourceUri.
 */
export function readMcpToolVisibility(meta: unknown): McpAppsToolVisibility[] {
  return readVisibility(asRecord(asRecord(meta)?.ui)?.visibility);
}

/**
 * Tool `_meta` -> UI descriptor normalization. Pure. resourceUri precedence: `_meta.ui.resourceUri` ->
 * deprecated flat key `_meta["ui/resourceUri"]` (spec MUST compat) -> compat-interface `openai/outputTemplate`.
 * `openai/*` aliases compat; an invalid item drops only itself -- except resourceUri, where invalid means the whole null
 * (visibility then comes solely from readMcpToolVisibility).
 */
export function normalizeMcpToolUiMeta(meta: unknown): McpToolUiDescriptor | null {
  const root = asRecord(meta);
  if (!root) return null;
  const ui = asRecord(root.ui);
  const resourceUri =
    readResourceUri(ui?.resourceUri) ??
    readResourceUri(root[MCP_APPS_LEGACY_RESOURCE_URI_META_KEY]) ??
    readResourceUri(root["openai/outputTemplate"]);
  if (!resourceUri) return null;

  const descriptor: McpToolUiDescriptor = {
    resourceUri,
    visibility: readVisibility(ui?.visibility),
  };
  const preferredDisplayMode = readDisplayMode(
    asRecord(root["openai/ui"])?.preferredModelDisplayMode,
  );
  if (preferredDisplayMode) descriptor.preferredDisplayMode = preferredDisplayMode;
  const csp = readCsp(asRecord(ui?.csp), asRecord(root["openai/widgetCSP"]));
  if (csp) descriptor.csp = csp;
  const prefersBorder =
    readBoolean(ui?.prefersBorder) ?? readBoolean(root["openai/widgetPrefersBorder"]);
  if (prefersBorder !== undefined) descriptor.prefersBorder = prefersBorder;
  const surface = readSurfaceId(ui?.surface);
  if (surface) descriptor.surface = surface;
  const showInline =
    readBoolean(ui?.showInline) ?? readBoolean(root["openai/widgetShowCodexWidgetInline"]);
  if (showInline !== undefined) descriptor.showInline = showInline;
  return descriptor;
}

/**
 * The `ui://` HTML resource item's own `_meta` (the selected content item's `_meta.ui` wins).
 * csp and prefersBorder compat `openai/widgetCSP` / `openai/widgetPrefersBorder`;
 * size hints only `openai/widgetHeightHint` / `openai/widgetMinFrameHeight`; `openai/widgetShowCodexWidgetInline` => showInline;
 * nothing declared returns null.
 */
export function normalizeMcpAppResourceMeta(meta: unknown): McpAppResourceMeta | null {
  const root = asRecord(meta);
  if (!root) return null;
  const ui = asRecord(root.ui);
  const result: McpAppResourceMeta = {};
  const csp = readCsp(asRecord(ui?.csp), asRecord(root["openai/widgetCSP"]));
  if (csp) result.csp = csp;
  const prefersBorder =
    readBoolean(ui?.prefersBorder) ?? readBoolean(root["openai/widgetPrefersBorder"]);
  if (prefersBorder !== undefined) result.prefersBorder = prefersBorder;
  const heightHint = readPositiveInt(root["openai/widgetHeightHint"]);
  if (heightHint !== undefined) result.heightHint = heightHint;
  const minFrameHeight = readPositiveInt(root["openai/widgetMinFrameHeight"]);
  if (minFrameHeight !== undefined) result.minFrameHeight = minFrameHeight;
  const showInline =
    readBoolean(ui?.showInline) ?? readBoolean(root["openai/widgetShowCodexWidgetInline"]);
  if (showInline !== undefined) result.showInline = showInline;
  const cspRelaxations = normalizeMcpAppCspRelaxations(meta);
  if (cspRelaxations) result.cspRelaxations = cspRelaxations;
  const permissions = normalizeMcpAppResourcePermissions(ui?.permissions);
  if (permissions.length > 0) result.permissions = permissions;
  return Object.keys(result).length > 0 ? result : null;
}

/** `_meta.ui.permissions`: the spec's four keys with object values (`{}`); unknown keys drop, fixed order out. */
export function normalizeMcpAppResourcePermissions(value: unknown): McpAppsResourcePermission[] {
  const root = asRecord(value);
  if (!root) return [];
  return MCP_APPS_RESOURCE_PERMISSIONS.filter((key) => asRecord(root[key]) !== null);
}

/**
 * Resource-level `_meta["zcode/csp"]`: boolean keys of `MCP_APPS_CSP_RELAXATION_FLAGS` only; unknown keys and non-booleans drop;
 * no true key returns null (false equals undeclared).
 */
export function normalizeMcpAppCspRelaxations(meta: unknown): McpAppCspRelaxations | null {
  const root = asRecord(asRecord(meta)?.[MCP_APPS_CSP_RELAXATION_META_KEY]);
  if (!root) return null;
  const result: McpAppCspRelaxations = {};
  for (const flag of MCP_APPS_CSP_RELAXATION_FLAGS) {
    if (root[flag] === true) result[flag] = true;
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** Panel id: length/charset bound, invalid dropped (the tool result falls back to the inline card, no error). */
export function readSurfaceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MCP_APPS_SURFACE_ID_MAX_CHARS) return undefined;
  return MCP_APPS_SURFACE_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * Validate one origin of the CSP allow list; returns the normalized origin (port kept), null when invalid.
 * - `https:` / `wss:`: any host.
 * - `http:` / `ws:`: only hostname exactly `127.0.0.1` (the openpencil H-B loopback), so plugin-local services
 *   (e.g. a WebSocket bridge inside the plugin MCP server process) stay reachable from the sandbox page. No `localhost` (hosts-file rewrites),
 *   no `[::1]` (differs from our MCP bridge's 127.0.0.1), no other IPs.
 * - Never credentials, query, hash, or path.
 */
export function normalizeCspOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const loopback =
    url.hostname === "127.0.0.1" && (url.protocol === "http:" || url.protocol === "ws:");
  if (url.protocol !== "https:" && url.protocol !== "wss:" && !loopback) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

function readResourceUri(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith(MCP_APPS_UI_RESOURCE_SCHEME)) return null;
  if (trimmed.length > MCP_APPS_RESOURCE_URI_MAX_CHARS) return null;
  return trimmed;
}

function readVisibility(value: unknown): McpAppsToolVisibility[] {
  if (!Array.isArray(value)) return [...MCP_APPS_DEFAULT_TOOL_VISIBILITY];
  const filtered = value.filter(
    (item): item is McpAppsToolVisibility => item === "model" || item === "app",
  );
  return filtered.length > 0 ? [...new Set(filtered)] : [...MCP_APPS_DEFAULT_TOOL_VISIBILITY];
}

function readDisplayMode(value: unknown): McpAppsDisplayMode | undefined {
  return value === "inline" || value === "fullscreen" || value === "pip" ? value : undefined;
}

/** The four domain classes read independently; `openai/widgetCSP` accepts camelCase and snake_case. */
function readCsp(
  modern: Record<string, unknown> | null,
  legacy: Record<string, unknown> | null,
): McpToolUiCsp | undefined {
  const pick = (camel: string, snake: string) =>
    readOriginList(modern?.[camel]) ??
    readOriginList(legacy?.[camel]) ??
    readOriginList(legacy?.[snake]);
  const connect = pick("connectDomains", "connect_domains");
  const resource = pick("resourceDomains", "resource_domains");
  const frame = pick("frameDomains", "frame_domains");
  const baseUri = pick("baseUriDomains", "base_uri_domains");
  if (!connect && !resource && !frame && !baseUri) return undefined;
  const csp: McpToolUiCsp = {};
  if (connect) csp.connectDomains = connect;
  if (resource) csp.resourceDomains = resource;
  if (frame) csp.frameDomains = frame;
  if (baseUri) csp.baseUriDomains = baseUri;
  return csp;
}

function readPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function readOriginList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const origins = value.map(normalizeCspOrigin).filter((item): item is string => item !== null);
  return [...new Set(origins)];
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
