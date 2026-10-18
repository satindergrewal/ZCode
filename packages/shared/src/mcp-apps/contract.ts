/**
 * The MCP Apps protocol contract: constants, tool-UI metadata types, sandbox handles, and registration payloads shared by agent, host, renderer, and main.
 * The page<->host wire protocol (`ui/*` methods, handshake, version negotiation, JSON-RPC) is defined by the official `@modelcontextprotocol/ext-apps` SDK;
 * only ZCode's own extension keys and limits live here. Types and constants only; normalization and schemas sit in siblings, exported via index.ts.
 */

/** MCP extension identifier (spec Extension Identifier); matches the official SDK `EXTENSION_ID`. */
export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";
/** UI resource mimeType (spec MUST); matches the official SDK `RESOURCE_MIME_TYPE`. */
export const MCP_APPS_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
/** Deprecated flat key `_meta["ui/resourceUri"]`; the spec requires hosts to stay compat; matches SDK `RESOURCE_URI_META_KEY`. */
export const MCP_APPS_LEGACY_RESOURCE_URI_META_KEY = "ui/resourceUri";

/**
 * The ui extension capability declaration inside MCP client `initialize` (spec Client (Host) Capabilities).
 * A type, not an interface: the MCP SDK's `ClientCapabilities.extensions` requires a string index signature.
 */
export type McpAppsClientCapability = { mimeTypes: string[] };
/** Per-MCP-server capability fragment the agent declares; goes into `Client` constructor `capabilities.extensions`. */
export function buildMcpAppsClientCapabilities(): {
  extensions: { [extensionId: string]: McpAppsClientCapability };
} {
  return { extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APPS_RESOURCE_MIME_TYPE] } } };
}

/** The host's hostInfo.name; hostInfo.version serves page feature detection only, not the app version. */
export const MCP_APPS_HOST_NAME = "zcode";
export const MCP_APPS_HOST_VERSION = "1";
/** `ui/initialize` handshake timeout (from port arrival) and the pre-unload wait for `ui/resource-teardown`. */
export const MCP_APPS_HANDSHAKE_TIMEOUT_MS = 15_000;
export const MCP_APPS_TEARDOWN_TIMEOUT_MS = 500;

export type McpAppsDisplayMode = "inline" | "fullscreen" | "pip";
export type McpAppsToolVisibility = "model" | "app";
export const MCP_APPS_DEFAULT_TOOL_VISIBILITY: readonly McpAppsToolVisibility[] = ["model", "app"];

/** MCP Apps resource-level CSP (`McpUiResourceCsp`): four domain classes. Resource `_meta` is primary; tool-level `_meta.ui.csp` only backfills. */
export interface McpToolUiCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

/**
 * Resource-level `_meta["zcode/csp"]`: hosts default to the spec set ('self' 'unsafe-inline') and grant no 'unsafe-eval' /
 * 'wasm-unsafe-eval'; resources needing eval / WebAssembly declare here. The host announces supported keys via
 * `hostCapabilities.experimental["zcode/csp"].flags`.
 */
export const MCP_APPS_CSP_RELAXATION_META_KEY = "zcode/csp";
export const MCP_APPS_CSP_RELAXATION_FLAGS = ["unsafeEval", "wasmUnsafeEval"] as const;
export type McpAppCspRelaxationFlag = (typeof MCP_APPS_CSP_RELAXATION_FLAGS)[number];
export type McpAppCspRelaxations = Partial<Record<McpAppCspRelaxationFlag, boolean>>;
export function buildMcpAppsCspExperimentalCapability(): {
  [MCP_APPS_CSP_RELAXATION_META_KEY]: { flags: McpAppCspRelaxationFlag[] };
} {
  return { [MCP_APPS_CSP_RELAXATION_META_KEY]: { flags: [...MCP_APPS_CSP_RELAXATION_FLAGS] } };
}

/**
 * Browser permissions a resource may declare (the four keys of spec-draft `UIResourceMeta.permissions`); order = normalization order.
 * Host: undeclared always denies; camera / microphone / geolocation prompt natively on first use, clipboardWrite passes as declared.
 */
export const MCP_APPS_RESOURCE_PERMISSIONS = [
  "camera",
  "microphone",
  "geolocation",
  "clipboardWrite",
] as const;
export type McpAppsResourcePermission = (typeof MCP_APPS_RESOURCE_PERMISSIONS)[number];
/** Spec permission key -> Permissions Policy feature name for the plugin iframe `allow`. */
export const MCP_APPS_IFRAME_ALLOW_TOKENS: Record<McpAppsResourcePermission, string> = {
  camera: "camera",
  microphone: "microphone",
  geolocation: "geolocation",
  clipboardWrite: "clipboard-write",
};
/** Same shape as the SDK's `buildAllowAttribute`: `"camera; clipboard-write"`; empty string when nothing is declared. */
export function buildMcpAppsIframeAllow(
  permissions: readonly McpAppsResourcePermission[] | undefined,
): string {
  if (!permissions?.length) return "";
  return MCP_APPS_RESOURCE_PERMISSIONS.filter((key) => permissions.includes(key))
    .map((key) => MCP_APPS_IFRAME_ALLOW_TOKENS[key])
    .join("; ");
}

/**
 * The `ui://` HTML resource's own `_meta` (`resources/read` content item wins). `heightHint` / `minFrameHeight` are initial and
 * minimum height (px); `showInline` true pins the card visible, out of the collapsed area.
 */
export interface McpAppResourceMeta {
  csp?: McpToolUiCsp;
  cspRelaxations?: McpAppCspRelaxations;
  /** Browser permissions declared via `_meta.ui.permissions` (the spec's four keys; fixed order, deduped). */
  permissions?: McpAppsResourcePermission[];
  prefersBorder?: boolean;
  heightHint?: number;
  minFrameHeight?: number;
  showInline?: boolean;
}
/** Resource-level presentation info returned to the renderer with the sandbox handle; CSP and relaxations stay in main, never returned. */
export type PluginSandboxResourceMeta = Omit<McpAppResourceMeta, "csp" | "cspRelaxations">;
/** The UI descriptor after tool `_meta` normalization; an invalid `resourceUri` means no descriptor at all. */
export interface McpToolUiDescriptor {
  resourceUri: string;
  visibility?: McpAppsToolVisibility[];
  preferredDisplayMode?: McpAppsDisplayMode;
  csp?: McpToolUiCsp;
  prefersBorder?: boolean;
  /** Panel id this tool result belongs to (manifest `ui.surfaces[].id`). */
  surface?: string;
  /** Tool-level `openai/widgetShowCodexWidgetInline`; pins the card visible. */
  showInline?: boolean;
}

/** Length/charset bounds for `_meta.ui.surface` / manifest surface ids (same source as sandboxId: must be CSP host-source safe). */
export const MCP_APPS_SURFACE_ID_MAX_CHARS = 128;
export const MCP_APPS_SURFACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export const MCP_APPS_UI_RESOURCE_SCHEME = "ui://";
export const MCP_APPS_RESOURCE_URI_MAX_CHARS = 2048;
/**
 * Persistence caps for `display.ui.structuredContent` / `widgetMeta` / `content` (UTF-8 bytes of the JSON text).
 * Over-limit strings are not truncated (half a JSON is meaningless): the field is omitted, `truncated: true` plus `truncatedBytes` record the dropped bytes;
 * the page sees `toolOutput` null and `toolResponseMetadata["zcode/truncated"] = { bytes }`, re-fetchable via tools/call.
 */
export const MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES = 64 * 1024;
export const MCP_APPS_WIDGET_META_MAX_BYTES = 16 * 1024;
export const MCP_APPS_CONTENT_MAX_BYTES = 32 * 1024;
export const MCP_APPS_TRUNCATED_META_KEY = "zcode/truncated";
/** Host-side caps for accepted `ui://` HTML plus the mimeType allowlist (the spec knows profiled types only; profileless text/html is a deliberate loose superset). */
// The official pdf-server sample's single-file page (inline pdf.js) is 4.3 MB; 4 MiB would reject it, hence 16 MiB.
export const MCP_APPS_HTML_MAX_BYTES = 16 * 1024 * 1024;
export const MCP_APPS_HTML_MIME_TYPES = [MCP_APPS_RESOURCE_MIME_TYPE, "text/html"] as const;
/**
 * Image blocks arriving via ui/update-model-context and ui/message: three whitelisted bitmap types, <= 4 MiB decoded each;
 * anything unlisted or oversized fails the whole request with -32602 `unsupported_content`.
 */
export const MCP_APPS_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MCP_APPS_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export {
  MCP_APPS_UI_READ_RESOURCE_MAX_BYTES,
  MCP_APPS_UI_READ_RESOURCE_MIME_ALLOWLIST,
  isMcpAppsUiReadResourceMimeAllowed,
} from "./resourceMime.js";

/**
 * ZCode extension keys inside `hostCapabilities.experimental`. The official zod strips unknown capability keys beyond the standard set,
 * so extensions always go under experimental (the spec's reserved slot); pages feature-detect per key.
 */
export const MCP_APPS_WIDGET_STATE_EXPERIMENTAL_KEY = "zcode/widgetState";
export const MCP_APPS_RESOURCE_SUBSCRIBE_EXPERIMENTAL_KEY = "zcode/resourceSubscribe";
export const MCP_APPS_SURFACE_EXPERIMENTAL_KEY = "zcode/surface";
/**
 * ZCode extension method `ui/set-widget-state { widgetState }` (MCP Apps has no widgetState): the page hands UI state to the host
 * renderer memory (not persisted; a session remount restores it); the initial value ships at handshake via hostContext `zcode/widgetState`.
 */
export const MCP_APPS_SET_WIDGET_STATE_METHOD = "ui/set-widget-state";
export const MCP_APPS_WIDGET_STATE_CONTEXT_KEY = "zcode/widgetState";

/** The one MessageChannel between host renderer and relay shell; raw JSON-RPC runs over it (official AppBridge / App). */
export const PLUGIN_SANDBOX_PORT_NAME = "plugin-sandbox-rpc";

/** Minimal structural type of a MessagePort; host renderer Transport and relay shell depend only on these members. */
export interface PluginSandboxTransportPort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  start?(): void;
  close(): void;
}

/** main -> host renderer port events (transferred via preload `window.postMessage`). */
export interface PluginSandboxPortsEvent {
  sandboxId: string;
  initId: number;
  port: PluginSandboxTransportPort;
}
/**
 * Sandbox platform ports for the renderer, mounted as optional `IPlatformService.pluginSandbox`; undefined on web, UI falls back accordingly.
 * Sandbox registration is not here: the host does it via parentPort; the renderer only receives handles.
 */
export interface PluginSandboxPlatformPort {
  /** Atomic-move sandbox adaptation installed by preload. */
  supportsRetainedMove?: boolean;
  /** Host operations only; main copies current page content after checking owner/generation. */
  copyImage?(input: PluginSandboxCaptureRequest): Promise<void>;
  /** Host window webContents id; prepareSandbox uses it as owner, main validates on will-attach. */
  getOwnerWebContentsId(): Promise<number>;
  /**
   * Release the sandbox. With initId, only the captured registration: a new page gets new agent credentials and sandboxId,
   * the two IPC paths differ (host parentPort vs ipcMain), and a late old dispose must not kill the new registration.
   */
  disposeSandbox(sandboxId: string, initId?: number): Promise<void>;
  consumeUserGesture(sandboxId: string): Promise<boolean>;
  onPorts(handler: (event: PluginSandboxPortsEvent) => void): () => void;
}

export interface PluginSandboxCaptureRequest {
  sandboxId: string;
  initId: number;
  captureRect: { x: number; y: number; width: number; height: number };
  viewportSize: { width: number; height: number };
}

/**
 * Sandbox scope. Tool cards by toolCallId, panels (manifest `ui.surfaces[]`) by surfaceId;
 * both map to one string scopeId for registry idempotency keys and widgetState routing, so main/host never learn a panel concept.
 */
export type PluginUiScopeRef =
  | { kind: "toolCall"; toolCallId: string }
  | { kind: "surface"; surfaceId: string };
export function buildPluginSandboxScopeId(scope: PluginUiScopeRef): string {
  return scope.kind === "toolCall" ? `tool:${scope.toolCallId}` : `surface:${scope.surfaceId}`;
}

/** host -> main payload registering sandbox content (same pattern as LocalMediaPreviewPathAuthorize*). */
export interface PluginSandboxRegisterRequestPayload {
  instance: import("./instance.js").McpAppInstance;
  requestId: string;
  /** Workspace isolation; legacy callers may omit, new host registrations must thread the real workspace scope. */
  workspacePath?: string;
  workspaceIdentity?: string;
  ownerWebContentsId: number;
  sessionId: string;
  /** Gen UI has Host provenance and never impersonates an MCP plugin. */
  contentKind?: "gen-ui";
  pluginId?: string;
  /** Owning MCP server runtime name; the sandbox partition derives from it (that server's pages share one persistent store). */
  serverName?: string;
  /** The `buildPluginSandboxScopeId` result: `tool:<toolCallId>` or `surface:<surfaceId>`. */
  scopeId: string;
  html: string;
  /** Effective CSP: resource-level first, tool-level fallback (merged by the host plugin-ui-bridge). */
  csp?: McpToolUiCsp;
  /** Relaxations declared in resource-level `_meta["zcode/csp"]`. */
  cspRelaxations?: McpAppCspRelaxations;
  /** Resource-declared browser permissions; main relaxes Permissions-Policy and iframe allow, and routes requests to the gate. */
  permissions?: McpAppsResourcePermission[];
  prefersBorder?: boolean;
  /** Resource-level size hints, passed to the renderer via handle verbatim. */
  heightHint?: number;
  minFrameHeight?: number;
  /** Resource-level always-visible flag, returned to the renderer via handle resourceMeta. */
  showInline?: boolean;
}
/** host-internal registration input: the transport requestId removed. */
export type PluginSandboxRegisterInput = Omit<PluginSandboxRegisterRequestPayload, "requestId">;
export interface PluginSandboxHandle {
  instance: import("./instance.js").McpAppInstance;
  sandboxId: string;
  initId: number;
  shellUrl: string;
  partition: string;
  /** Resource-level presentation info (prefersBorder / heightHint / minFrameHeight / showInline); omitted when the resource declares none. */
  resourceMeta?: PluginSandboxResourceMeta;
}
export type PluginSandboxRegisterResultPayload =
  | ({ requestId: string; ok: true } & PluginSandboxHandle)
  | { requestId: string; ok: false; error: string };
