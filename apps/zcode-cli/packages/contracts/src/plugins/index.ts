import type { CustomCommandRoot } from "../commands/index.js";
import type { HookEventName, HookMatcherConfig } from "../hooks/index.js";
import type { McpServerConfig } from "../interfaces/mcp.port.js";
import type { SkillRoot } from "../skills/index.js";
import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

export const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE = "zcode-plugins-official";
export const CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE = "claude-plugins-official";
export const ZCODE_INLINE_PLUGIN_MARKETPLACE = "inline";
export const ZCODE_PLUGIN_HOST_COMMAND = "__zcode-plugin-host";
/**
  * Hidden subcommand: the dynamic-workflow sandbox child entry (zcode-dwf-child <entry path>; the last argv item is
  * the entry file path written by the harness; the payload never touches the command line).
 *
  * Same family and mechanism as {@link ZCODE_PLUGIN_HOST_COMMAND}: a SEA single-file binary does not interpret Node CLI flags,
  * so the harness default of node --max-old-space-size=... <entry> would hand the flags to strict
  * parseArgs under SEA and fail inevitably. Under SEA it re-execs this binary instead, dispatched by run.ts before parseArgs.
  * The constant lives in contracts, not dynamic-workflow-runtime: the latter deliberately avoids depending on contracts (app-free proof),
  * and bootstrap hands it to the harness as argsPrefix after the SEA check.
 */
export const ZCODE_DWF_CHILD_COMMAND = "__zcode-dwf-child";

export function isOfficialMarketplaceId(id: string): boolean {
  return id === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE || id === CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE;
}

export type PluginSource = "official" | "inline" | "cache";
export type PluginDiagnosticSeverity = "warning" | "error";

export type PluginDiagnosticCode =
  | "plugin_root_not_found"
  | "plugin_manifest_not_found"
  | "plugin_manifest_invalid"
  | "plugin_component_path_invalid"
  | "plugin_unsupported_component"
  | "plugin_skill_root_empty"
  | "plugin_mcp_read_failed"
  | "plugin_mcp_invalid"
  | "plugin_mcp_server_disabled"
  | "plugin_hook_read_failed"
  | "plugin_hook_invalid"
  | "plugin_hook_unsupported_event"
  | "plugin_dependency_invalid"
  | "plugin_dependency_missing"
  | "plugin_dependency_cycle"
  | "plugin_dependency_cross_marketplace"
  | "plugin_marketplace_invalid"
  | "plugin_marketplace_declaration_reserved"
  | "plugin_git_unavailable"
  | "plugin_archive_fetch_failed"
  | "plugin_marketplace_source_unsupported"
  | "plugin_validation_deferred"
  | "plugin_variable_missing"
  | "plugin_duplicate_id"
  | "plugin_not_found"
  | "plugin_ambiguous_name";

export interface PluginUserConfigOption {
  default?: string | number | boolean;
  description?: string;
  title?: string;
  required?: boolean;
  sensitive?: boolean;
  type?: "string" | "number" | "boolean" | "directory" | "file";
}

export type PluginOptionValue = string | number | boolean;
export type PluginOptionValues = Record<string, PluginOptionValue>;

export type PluginMarketplaceSourceConfig =
  | { source: "url"; headers?: Record<string, string>; url: string }
  | { path?: string; ref?: string; repo: string; source: "github"; sparsePaths?: string[] }
  | { path?: string; ref?: string; source: "git"; sparsePaths?: string[]; url: string }
  | { package: string; source: "npm" }
  | { source: "file"; path: string }
  | { source: "directory"; path: string };

export interface PluginMarketplaceConfig {
  source: PluginMarketplaceSourceConfig;
}

export interface PluginHookDetail {
  args?: string[];
  async?: boolean;
  command: string;
  event: HookEventName;
  matcher?: string;
  runnable: boolean;
  shell?: true | string;
  sourcePath: string;
  statusMessage?: string;
  timeout?: number;
  timeoutMs?: number;
  type: "command" | "process";
}

/** Detail-UI component group type, ordered as displayed: agent / command / skill / hook / mcp. */
export type PluginComponentKind = "agent" | "command" | "skill" | "hook" | "mcp";

export interface PluginComponentItem {
  name: string;
    /** Description from component frontmatter / manifest; omitted when missing, never fabricated. */
  description?: string;
}

export interface PluginComponentGroup {
  kind: PluginComponentKind;
  items: PluginComponentItem[];
}

/**
  * Store-listing metadata carried by marketplace catalog entries: describes how the plugin is presented in a store,
  * with no effect on behavior. All fields optional; the UI degrades when missing (letter avatar / hidden block / omitted row).
 */
export interface PluginStoreListing {
    /** Card/detail display name; falls back to the plugin name slug. */
  displayName?: string;
  displayNameI18n?: Record<string, string>;
    /** Localized variants of the catalog description (the description itself has its own field). */
  descriptionI18n?: Record<string, string>;
    /** Icon image: an https URL, or a local asset path for bundled plugins. */
  icon?: string;
  category?: string;
  author?: string;
  authorUrl?: string;
  homepage?: string;
  privacyPolicy?: string;
  termsOfService?: string;
    /** Detail-page hero banner image. */
  heroImage?: string;
    /** Detail-page example-prompt chips; clicking starts a prefilled new session. */
  examplePrompts?: string[];
  examplePromptsI18n?: Record<string, string[]>;
  /**
      * Needs a paid plan to be useful: the entry declares requiresPaidPlan: true and store card/detail titles show a hint icon beside them.
      * It expresses a usage precondition, not that the plugin itself is a paid product,
      * so it takes no part in install gating or billing; the name is not tied to a plan product and survives plan renames.
   */
  requiresPaidPlan?: boolean;
}

export interface PluginManifest {
  agents?: unknown;
  author?: unknown;
  channels?: unknown;
  commands?: unknown;
  dependencies?: unknown;
  description?: string;
  homepage?: string;
  hooks?: unknown;
  keywords?: unknown;
  license?: string;
  lspServers?: unknown;
  mcpServers?: unknown;
  name: string;
  outputStyles?: unknown;
  repository?: string;
  settings?: unknown;
  skills?: unknown;
  /** 插件 UI：`ui.surfaces[]` 面板入口声明，adapters 解析。 */
  ui?: unknown;
  userConfig?: Record<string, PluginUserConfigOption>;
  version?: string;
}

/** 面板生命周期：第一版只接受会话级；`draft` 留待需要时放开。 */
export type PluginUiSurfaceAvailability = "session";
/** 标题：单一字符串或按 locale 键的映射（`{ "zh-CN": "...", "en-US": "..." }`）。 */
export type PluginUiSurfaceTitle = string | Record<string, string>;
export interface PluginUiSurfaceDefinition {
  id: string;
  title: PluginUiSurfaceTitle;
  icon?: string;
  /** 运行时 namespaced MCP server 名（`plugin:${name}:${server}`），UI 直接用它调 mcp/uiReadResource。 */
  server: string;
  /** 清单里声明的原始 server 键，仅供诊断与展示。 */
  declaredServer: string;
  /** 必须以 `ui://` 开头。 */
  resourceUri: string;
  availability: PluginUiSurfaceAvailability;
}

export interface PluginConfig {
  dirs: string[];
  enabled: boolean;
  enabledPlugins: Record<string, boolean>;
  extraKnownMarketplaces: Record<string, PluginMarketplaceConfig>;
  options: Record<string, PluginOptionValues>;
  suppressedBuiltins: string[];
}

export interface PluginMetadata {
    /** Author name from the manifest (plugin.json), normalized to a string; detail-page fallback when store info is missing. */
  author?: string;
  authorUrl?: string;
  commandRootCount: number;
  /**
      * Authoritative component inventory (name + optional description), enumerated by the loader from the plugin root at parse time,
      * enablement aside. The detail UI renders it directly, with no UI-side join against Skills/Commands/Agents.
   */
  components: PluginComponentGroup[];
  configuredOptions?: PluginOptionValues;
  dataPath: string;
  declaredMcpServerNames: string[];
  description?: string;
  enabled: boolean;
    /** homepage from the manifest (plugin.json); detail-page fallback when store info is missing. */
  homepage?: string;
  id: string;
  manifestPath: string;
  marketplace: string;
  mcpServerNames: string[];
  name: string;
  hookDetails: PluginHookDetail[];
  rootPath: string;
  skillCount: number;
  skillRootCount: number;
  source: PluginSource;
  /** 清单 `ui.surfaces[]` 解析结果（已校验）；未声明或全部非法时缺省。 */
  uiSurfaces?: PluginUiSurfaceDefinition[];
  userConfig?: Record<string, PluginUserConfigOption>;
  version?: string;
}

export interface PluginDiagnostic {
  code: PluginDiagnosticCode;
  message: string;
  path?: string;
  pluginId?: string;
  severity: PluginDiagnosticSeverity;
}

// ============================================================
// Identity-catalog contract for plugin conversation references (the @ Plugin capability hint).
// Semantics: the catalog freezes at Session (App) creation and carries identity/capability
// declarations only; actually injected abilities intersect the live inventory every turn.
// ============================================================

export interface PluginReferenceCatalogEntry {
    /** Stable plugin ID: manifest name at marketplace; the sole identity behind canonical plugin:// links. */
  pluginId: string;
    /** manifest name (base of the Skill/MCP/Subagent runtime namespaces); for display and provenance matching, not authoritative. */
  name: string;
  marketplace: string;
    /** Enablement at catalog freeze; disabled entries are kept for disabled_in_session diagnostics and are not referenceable. */
  enabled: boolean;
  /**
      * Other enabled plugin stable IDs sharing this entry's manifest name.
      * Non-empty means a V1 fail-closed conflict: the picker disables selection, the runtime skips as ambiguous,
      * and last-write-wins or display-name guessing is forbidden.
   */
  conflictingPluginIds: string[];
    /** Identity-declared Skill qualified names (name:skill); from component enumeration, decoupled from live discovery. */
  skillQualifiedNames: string[];
    /** Identity-declared namespaced MCP server names (plugin:name:server). */
  mcpServerNames: string[];
    /** Identity-declared canonical subagent names (name:agent); from component enumeration. */
  subagentNames: string[];
  /**
      * Plugin root dir, for runtime provenance tracing of live Skills/Subagents only (rootPath prefix check).
      * Never enters provider reminders or protocol projections -- paths are outside the identifiers-only contract.
   */
  rootPath: string;
  /** 面板入口声明（A5）；供 host 在 session 冻结 catalog 里查面板定义。 */
  uiSurfaces?: PluginUiSurfaceDefinition[];
}

export interface PluginReferenceCatalog {
  plugins: PluginReferenceCatalogEntry[];
}

export interface PluginLoadOutcome {
  commandRoots: CustomCommandRoot[];
  diagnostics: PluginDiagnostic[];
  hooks: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  mcpServers: Record<string, McpServerConfig>;
    /** Store listing keyed by the full plugin ID, for CLI/TUI display; takes no part in runtime identity. */
  pluginListingsById?: Record<string, PluginStoreListing>;
  plugins: PluginMetadata[];
  skillRoots: SkillRoot[];
}

export interface PluginDiscoverRequest {
  config: PluginConfig;
  env?: Record<string, string | undefined>;
    // bootstrap may pass the ids of official plugins safe to enable by default,
    // so they work without a prior zcode plugins enable (e.g. content-only skill-creator).
    // Defaults to empty; existing plugins (heavy ones like ios-simulator/android-emulator) behave unchanged.
  officialPluginsEnabledByDefault?: ReadonlySet<string>;
  officialPluginRoots?: string[];
  storageRoot: string;
  trace?: TraceContext;
  workingDirectory: string;
}

export interface PluginOperationOptions {
  context?: ExecutionContext;
  signal?: AbortSignal;
}

export interface PluginPort {
  discoverPlugins(
    request: PluginDiscoverRequest,
    options?: PluginOperationOptions,
  ): Promise<PluginLoadOutcome>;
}
