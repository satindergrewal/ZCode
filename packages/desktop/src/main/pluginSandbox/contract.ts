import type {
  McpAppCspRelaxations,
  McpAppsResourcePermission,
  PluginSandboxHandle,
  PluginSandboxPlatformPort,
  PluginSandboxRegisterInput,
} from "@zcode/shared/mcp-apps";
import { createHash } from "node:crypto";

/** Privileged scheme and URL/partition derivation rules. */
export const PLUGIN_SANDBOX_SCHEME = "zcode-sandbox";
export const PLUGIN_SANDBOX_SHELL_HOST_PREFIX = "shell-";
export const PLUGIN_SANDBOX_PLUGIN_HOST_PREFIX = "plugin-";
/**
 * `persist:` keeps localStorage/IndexedDB across cards and restarts (the official
 * viewUUID + localStorage page-state pattern holds). `v2` stabilizes both the top-level shell and
 * plugin origins; v1 survives until clear-all-data, with no implicit migration.
 */
export const PLUGIN_SANDBOX_PARTITION_PREFIX = "persist:plugin-sandbox-v2-";

export function buildPluginSandboxShellUrl(sandboxId: string, appIdentity: string): string {
  return `${PLUGIN_SANDBOX_SCHEME}://${PLUGIN_SANDBOX_SHELL_HOST_PREFIX}${appIdentity}/instance/${sandboxId}/`;
}
export function buildPluginSandboxPluginOrigin(sandboxId: string): string {
  return `${PLUGIN_SANDBOX_SCHEME}://${PLUGIN_SANDBOX_PLUGIN_HOST_PREFIX}${sandboxId}`;
}
/** The trusted Agent app identity already encodes source, workspace, environment and known accounts; page-self-reported origins are not accepted. */
export function buildPluginSandboxPartition(input: { appIdentity: string }): string {
  const hash = createHash("sha256").update(input.appIdentity).digest("hex");
  return `${PLUGIN_SANDBOX_PARTITION_PREFIX}${hash}`;
}

export type { PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";

export interface PluginSandboxRecord extends PluginSandboxHandle {
  workspacePath?: string;
  workspaceIdentity?: string;
  ownerWebContentsId: number;
  sessionId: string;
  contentKind?: "gen-ui";
  pluginId?: string;
  serverName?: string;
  scopeId: string;
  html: string;
  /** Full Content-Security-Policy header derived from csp and cspRelaxations. */
  cspHeader: string;
  cspRelaxations?: McpAppCspRelaxations;
  /** Browser permissions declared by the resource; Permissions-Policy, iframe allow and the gate all defer to it. */
  permissions?: McpAppsResourcePermission[];
  prefersBorder: boolean;
}

/**
 * Sandbox registry: single owner of sandbox content and lifecycle in the main process.
 * `register` is idempotent on full ownership plus Agent token; content is immutable per
 * credential and repeated calls return the same sandboxId/initId.
 */
export interface PluginSandboxRegistryPort {
  /** Throws `PluginSandboxQuotaError` when full and every registration has a live guest; never evict live instances. */
  register(input: PluginSandboxRegisterInput): PluginSandboxHandle;
  get(sandboxId: string): PluginSandboxRecord | null;
  /** With initId given and mismatched, do not release (a stale controller's late dispose). */
  dispose(sandboxId: string, initId?: number): void;
  /** Release every registration owned by one host webContents (window closed/crash). */
  disposeOwner(ownerWebContentsId: number): void;
  /** +1 on guest attach, -1 on destroy; pinned > 0 exempts from TTL and capacity eviction. */
  pin(sandboxId: string): void;
  unpin(sandboxId: string): void;
  /** Called by the guest policy on input events; token TTL 5s. */
  markUserGesture(sandboxId: string): void;
  consumeUserGesture(sandboxId: string): boolean;
}

/** The renderer-side port mounts at `IPlatformService.pluginSandbox`; types live in shared, only the alias remains here. */
export type IPluginSandboxPlatform = PluginSandboxPlatformPort;

/** Registry full with all instances live; the renderer stops in an error state with a message, never evicting other cards. */
export class PluginSandboxQuotaError extends Error {
  readonly code = "sandbox_quota" as const;
  constructor(maxEntries: number) {
    super(`Plugin UI limit reached (${maxEntries}); close other plugin cards or panels first.`);
    this.name = "PluginSandboxQuotaError";
  }
}
