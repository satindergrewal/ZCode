import type { RemoteAssetInstallMode } from "./remoteAssetInstallMode.js";
import type { RemoteResourcePackageSelection } from "./remoteResourcePackages.js";
import type { ProviderFamilyDomain } from "./model-provider-family.js";
import type { ProviderFamilyConnectionSelectionSettings } from "./provider-family-connection-selection.js";
import type { ZCodeProvider } from "./zcode-task-types-core.js";
import type { WorkspacePurpose } from "./workspacePurpose.js";
import type { DynamicWorkflowMode } from "./dynamic-workflow-feature.js";
import type { EmbeddedBrowserViewportPreference } from "./browser-use/command-metadata.js";

// ── Domain types ──

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  /** Legacy remote servers may omit it; callers must treat absent as false. */
  isSymbolicLink?: boolean;
}

export interface FileStat {
  path: string;
  type: "file" | "directory";
  /** File size in bytes; legacy remote servers may omit it, so callers must handle undefined. */
  size?: number;
  /** File last-modified time; shared chunked reads use it to detect concurrent rewrites mid-read. */
  mtimeMs?: number;
}

/** File system change event (directory granularity) */
export interface FileWatchEvent {
  /** Directory path where the change happened */
  dirPath: string;
  /**
   * Full changed path, when the underlying watcher can confirm it.
   * Omitted by legacy Hosts, platforms without filename, or when one debounce window spans several paths; refresh conservatively.
   */
  changedPath?: string;
}

export interface FileTextSlice {
  path: string;
  content: string;
  offset: number;
  bytesRead: number;
  totalBytes: number;
  truncated: boolean;
  isBinary: boolean;
}

export interface FileMediaPreview {
  path: string;
  mediaType: string;
  dataBase64: string;
  totalBytes: number;
}

export interface FileBinaryPreview {
  path: string;
  dataBase64: string;
  totalBytes: number;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
}

export interface SystemInfo {
  homedir: string;
  platform: string;
}

/** Supported locales */
export type Locale = "zh-CN" | "en-US";

/** UI language preference; system follows the running device's OS language. */
export type LocalePreference = "system" | Locale;

/** Interaction behavior for input while ZCode is running */
export type ZCodeInteractionBehavior = "queue" | "guide";

/** Desktop Electron auto-update release channel. */
export type ElectronReleaseChannel = "stable" | "preview";

/** Integrated-terminal shell dialects usable by the Windows Bash tool. */
export type IntegratedTerminalShellDialect = "cmd" | "git-bash";

/** The Windows Bash shell chosen in settings. */
export type IntegratedTerminalShellSelection =
  | { mode: "auto" }
  | {
      mode: "shell";
      dialect: IntegratedTerminalShellDialect;
      id: string;
      label: string;
      path: string;
    };

/** Windows shell options the current host recognizes. */
export interface IntegratedTerminalShellOption {
  dialect: IntegratedTerminalShellDialect;
  id: string;
  label: string;
  path: string;
  source: "system" | "path";
}

/** Default locale */
export const DEFAULT_LOCALE: Locale = "zh-CN";

// ── Workspace / Tab ──

//** Unique tab identifier */
export type TabId = string;

/** State of a single tab */
export interface TabState {
  id: TabId;
  /** Absolute workspace path */
  workspacePath: string;
  /** Display label, usually the last path segment */
  label: string;
}

export interface SSHRemoteTargetSnapshot {
  kind: "ssh";
  host: string;
  port?: number;
  username: string;
  /** SSH config Host alias picked at connect time; UI display only. */
  sshConfigAlias?: string;
  privateKeyPath?: string;
  assetInstallMode?: RemoteAssetInstallMode;
  resourcePackages?: RemoteResourcePackageSelection;
  /**
   * SSH passwords are never written into settings.json.
   * Only the credentialService key is stored; the real password is read from secure storage on restore.
   */
  passwordCredentialKey?: string;
  /**
   * Private-key passphrases are never written into settings.json.
   * Only the credentialService key is stored; the real passphrase is read on restore.
   */
  privateKeyPassphraseCredentialKey?: string;
}

export interface WSLRemoteTargetSnapshot {
  kind: "wsl";
  distro?: string;
  user?: string;
}

export interface DockerRemoteTargetSnapshot {
  kind: "docker";
  container: string;
}

export interface ServerRemoteTargetSnapshot {
  kind: "server";
  url: string;
  name?: string;
  workspacePath?: string;
  serverId?: string;
  /**
   * Server tokens are never written into settings.json.
   * Only the credentialService key is stored; the real token is read on restore.
   */
  tokenCredentialKey?: string;
}

export type RemoteTargetSnapshot =
  | SSHRemoteTargetSnapshot
  | WSLRemoteTargetSnapshot
  | DockerRemoteTargetSnapshot
  | ServerRemoteTargetSnapshot;

export interface RemoteWorkspaceSessionSnapshot {
  /** The remote workspace's true absolute path */
  workspacePath: string;
  /** Local workspace path captured at connect time; used only for MCP filesystem path rewriting. */
  localWorkspacePath?: string;
  /** Stable identity key of the remote workspace (authority + canonicalPath). */
  workspaceIdentity?: string;
  /** Resumable snapshot of the remote connection target */
  target: RemoteTargetSnapshot;
  /** Last time this workspace was opened successfully */
  lastOpenedAt: number;
  /** Outcome of the last restore/reconnect */
  lastConnectionStatus: "connected" | "failed";
  /** Last failure reason; cleared on success */
  lastConnectionError?: string;
}

export interface LocalWorkspaceSessionEntry {
  kind: "local";
  workspacePath: string;
  /** Display classification; legacy data defaults to project, while conversations keep the real workspacePath as cwd/key. */
  workspacePurpose?: WorkspacePurpose;
}

export interface RemoteWorkspaceSessionEntry extends RemoteWorkspaceSessionSnapshot {
  kind: "remote";
}

export type PersistedWorkspaceSessionEntry =
  | LocalWorkspaceSessionEntry
  | RemoteWorkspaceSessionEntry;

// ── Process Monitor ──

/** Resource monitor categories: base services / builtin plugins / community plugins */
export type ResourceUsageCategory = "base" | "builtin-plugin" | "community-plugin";

/** Group key for base services; plugin groups key by plugin name or MCP server name */
export type ResourceUsageBaseGroupKey = "main" | "gpu" | "renderer" | "host" | "cli" | "utility";

/** One process row in the resource monitor (CPU is machine-normalized percent, memory in bytes) */
export interface ResourceUsageProcess {
  pid: number;
  /** Display name, e.g. zcode-main / zcode-agent-zcode-demo / node_repl */
  name: string;
  category: ResourceUsageCategory;
  groupKey: string;
  groupLabel: string;
  cpuPercent: number;
  memoryBytes: number;
  /** false means topology only, metrics not yet sampled (rendered as an em dash) */
  sampled: boolean;
}

/** External process rows (Agent / MCP / terminals...) sampled host-side, merged into the snapshot by main */
export type HostResourceUsageProcess = Omit<ResourceUsageProcess, "sampled">;

/** One full resource-monitor snapshot; main merges Electron metrics, system totals, and host sampling */
export interface ResourceUsageSnapshot {
  sampledAt: number;
  logicalCpuCount: number;
  system: {
    cpuPercent: number;
    memoryTotalBytes: number;
    memoryUsedBytes: number;
  };
  app: {
    cpuPercent: number;
    memoryBytes: number;
  };
  processes: ResourceUsageProcess[];
}

export interface AppSettings {
  /** The pre-subscription plan promo has been dismissed; does not touch model selection on any entry. */
  startPlanRecommendationDismissed?: boolean;
  recentProjects: string[]; // Recent projects, at most 10 kept
  locale: Locale; // UI language
  /**
   * User-overridden shortcut bindings (command id -> binding arrays, format in shortcutCommands.ts).
   * Only overrides are stored: unbound commands stay off disk and merge with the SHORTCUT_COMMANDS defaults at read time;
   * override semantics are whole-group replacement (override openCommandCenter and both of its defaults die together).
   */
  shortcutBindings?: Record<string, string[]>;
  /** UI language preference; locale holds the resolved language for non-browser contexts (main/menu/remote control). */
  localePreference?: LocalePreference;
  /** Inherit the system terminal's profile, shell env, and font when possible */
  terminalInheritSystemProfile?: boolean;
  /** User-forced terminal font; auto-detected from the system terminal configuration when empty */
  terminalFontFamily?: string;
  /** Local shell for the Windows Bash tool; auto-selected when unset. */
  integratedTerminalShell?: IntegratedTerminalShellSelection;
  /** HTTP/HTTPS egress proxy, e.g. http://127.0.0.1:7890; direct when empty. Applies on next app/agent start. */
  httpProxy?: string;
  /** Proxy bypass list, e.g. localhost,127.0.0.1,.example.com; affects the renderer only while httpProxy is set -- agent/tools keep explicit env. */
  httpProxyNoProxy?: string;
  /** Custom PEM root CA path; on next app/agent start feeds renderer validation and agent NODE_EXTRA_CA_CERTS. */
  httpProxyCaCertPath?: string;
  /**
   * Embedded browser ignores HTTPS certificate errors (self-signed, expired, host mismatch) for intranet test sites.
   * Affects only embedded-browser egress, never ZCode's own backend/model API calls. Off by default; needs a restart.
   */
  embeddedBrowserAllowInsecureCertificates?: boolean;
  /** One-shot display preference when a human opens the Browser tab; Agent Browser Use never reads or writes it. */
  embeddedBrowserViewportPreference?: EmbeddedBrowserViewportPreference;
  /**
   * The user hid the composer's Computer Use button in settings (internal hidden state).
   * Stored as hidden, not visible: undefined means shown, so existing users need no data migration.
   * Once hidden the button stays unrendered, does not self-heal across restarts or upgrades; only settings re-enables it.
   */
  computerUseComposerEntryHidden?: boolean;
  /** Master switch for auto-archiving finished old tasks */
  taskAutoArchiveEnabled?: boolean;
  /** Auto-archive threshold; tasks whose last update predates this many days become eligible */
  taskAutoArchiveOlderThanDays?: number;
  /** Desktop hides to tray on window close (Windows/Linux; spec: docs/desktop/linux-close-to-tray.md) */
  closeToTrayOnWindows?: boolean;
  /** Block system idle sleep while an off-peak task runs (manual switch; lid close is out of scope). */
  keepAwakeWhileRunning?: boolean;
  /** Whether the Windows close-to-tray default migration has run; migration bookkeeping only, never business logic. */
  closeToTrayOnWindowsMigrationInitialized?: boolean;
  /**
   * Whether the Linux close-to-tray default (off) one-time migration has run.
   * The shared migration is platform-blind and once marked existing Linux users true, yet Linux had no settings entry;
   * main's bootstrap uses this flag to settle first-run Linux users to the default off.
   */
  closeToTrayLinuxMigrationInitialized?: boolean;
  /** Desktop global page zoom level; restores zoom after restart. Ignored on web/mobile. */
  desktopZoomLevel?: number;
  /** Desktop main window's last non-maximized size plus maximized state; ignored on web/mobile. */
  desktopWindowSize?: {
    width: number;
    height: number;
    maximized: boolean;
  };
  /** Desktop Chromium hardware acceleration; takes effect early in the next main-process start only. Ignored on web/mobile. */
  desktopChromiumHardwareAccelerationEnabled?: boolean;
  /** Show model thinking in the message stream */
  messageStreamShowReasoning?: boolean;
  // TODO(settings-schema-version): once every supported upgrade path has run this migration, switch to a unified settings schema version and delete this marker, the migrator, and the persisted check.
  /** Whether the show-reasoning default migration has run; migration bookkeeping only, never a rendering decision. */
  messageStreamShowReasoningMigrationInitialized?: boolean;
  /** Show todo tool renders in the message stream; does not affect the summary panel's todos */
  messageStreamShowTodos?: boolean;
  /** Collapse consecutive read-only tool calls into Explore. */
  toolGroupingExploreEnabled?: boolean;
  /** Collapse consecutive non-readonly Shell tool calls into Terminal. */
  toolGroupingTerminalEnabled?: boolean;
  /** Collapse consecutive Write/Edit/ApplyPatch tool calls into Changes. */
  toolGroupingChangesEnabled?: boolean;
  /** Input while ZCode runs: queue for the next round, or guide to run after the next tool call */
  zcodeInteractionBehavior?: ZCodeInteractionBehavior;
  /** Allow auto-continue when an agent question sits unanswered for five minutes; absent means on, for legacy configs. */
  askUserQuestionAutoResolutionEnabled?: boolean;
  /** Retain Model I/O in full: no rotation, no quota-reset trimming, no compression or pruning; auth fields still redacted. */
  modelIoFullRetentionEnabled?: boolean;
  /**
   * The user's dynamic workflow mode (docs/dynamic-workflow/launch.md, "The user's choice"). Absent = follow the
   * server-offered mode; only applies while the feature is offered. Re-choosing the offered mode deletes the field, so untouched installs keep following server flips.
   */
  dynamicWorkflowMode?: DynamicWorkflowMode;
  /** Enabled built-in agent CLIs; the UI still says "Install", the underlying semantic stays enable-builtin-capability. */
  enabledBuiltinAgentCliProviders?: ZCodeProvider[];
  /** The single structured connection choice per provider family in settings. */
  providerFamilyConnectionSelections?: ProviderFamilyConnectionSelectionSettings;
  /** ZAI / BigModel provider family realm confirmed after a successful WelcomeScreen connect. */
  providerFamilyDomain?: ProviderFamilyDomain;
  /** Last time providerFamilyDomain was set or cleared. */
  providerFamilyDomainUpdatedAt?: number;
  /** Whether legacy oauth/provider state has been migrated into providerFamilyDomain. */
  providerFamilyDomainMigrated?: boolean;
  /** Whether new/cold-resumed sessions inject the bfs/ugrep enhancements for Bash; default on. */
  nativeSearchEnhancementsEnabled?: boolean;
  /** Whether new/cold-resumed sessions enable task-list-driven autonomous continuation (mission mode); default off. */
  missionContinuationEnabled?: boolean;
  /** Whether new/cold-resumed sessions enable Memory; default off. */
  memoryEnabled?: boolean;
  onboardingOccupation?:
    | "office"
    | "developer"
    | "independent"
    | "infrastructure"
    | "product"
    | "design"
    | "student"
    | "creator"
    | "operations"
    | "marketing"
    | "finance"
    | "accounting"
    | "legal"
    | "other"
    | null;
  proactiveSuggestionsEnabled?: boolean;
  /** The full workspace session at last close (local and remote workspaces) */
  lastWorkspaceSession?: PersistedWorkspaceSessionEntry[];
  /** Active tab index at last close */
  lastActiveTabIndex?: number;
  /** Last active taskId per workspace, restored on next open */
  lastActiveTaskByWorkspace?: Record<string, string>;
  /** Data-dir root (replaces homedir), default os.homedir(); the .zcode/v2 suffix is unchanged */
  dataBaseDir?: string;
  /** Release notes held for first launch after an update installs */
  pendingPostUpdateReleaseNotes?: {
    version: string;
    title: string;
    markdown: string;
    releaseDate?: string;
    releaseNotesByLocale?: Partial<Record<Locale, { title: string; markdown: string }>>;
  };
  /** The receive-preview-updates preference in settings; read by desktop auto-update only. */
  receivePreviewUpdates?: boolean;
  /** The auto-download-and-install-updates preference in settings/update dialog; desktop auto-update only. */
  autoDownloadAndInstallUpdates?: boolean;
  /** Electron update versions the user skipped; per channel, so stable and preview never mask each other. */
  skippedElectronUpdateVersions?: Partial<Record<ElectronReleaseChannel, string>>;
  /** Whether the first-run settings-sync prompt was consumed; means the dialog stays gone, not that import succeeded. */
  settingsSyncFirstRunPromptHandled?: boolean;
  /** Non-sensitive device identity for the external web-remote-control relay; passHash belongs in credentialService. */
  webRemoteControlExternalRelayDevice?: {
    deviceSid: string;
  };
  /** Target of the last successful web-remote-control enable; absent means the user turned it off, never auto-restored. */
  webRemoteControlLastEnabledContext?: {
    workspacePath: string;
    workspaceIdentity?: string;
    initialTaskId?: string;
  };
  /** Temporary endpoint override from settings; prod/test default base URLs are governed by the ZCODE_BASE_URL env. */
  zcodeEndpointOrigin?: string;
}
