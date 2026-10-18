import type { RemoteAssetInstallMode } from "./remoteAssetInstallMode.js";
import type { RemoteResourcePackageSelection } from "./remoteResourcePackages.js";
import type { ProviderFamilyDomain } from "./model-provider-family.js";
import type { ProviderFamilyConnectionSelectionSettings } from "./provider-family-connection-selection.js";
import type { ZCodeProvider } from "./zcode-task-types-core.js";
import type { WorkspacePurpose } from "./workspacePurpose.js";
import type { EmbeddedBrowserViewportPreference } from "./browser-use/command-metadata.js";

// ── Domain types ──

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  /** Legacy remote servers may not return it; callers must treat as false. */
  isSymbolicLink?: boolean;
}

export interface FileStat {
  path: string;
  type: "file" | "directory";
  /** File size in bytes; legacy remote servers may not return it, callers must handle undefined. */
  size?: number;
  /** File mtime; chunked share reads use it to detect concurrent rewrites mid-read. */
  mtimeMs?: number;
}

/** Filesystem change event (directory granularity) */
export interface FileWatchEvent {
  /// Changed directory path
  dirPath: string;
  /**
   * Full changed paths when the underlying watcher can confirm them.
   * Omitted on legacy hosts, platforms without filename, or debounce windows covering several paths; callers should refresh conservatively.
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

/** Supported languages */
export type Locale = "zh-CN" | "en-US";

/// UI locale preference; system means following the running platform's system language.
export type LocalePreference = "system" | Locale;

/// Interaction behavior for typing while a ZCode run is active
export type ZCodeInteractionBehavior = "queue" | "guide";

/// Desktop Electron auto-update release channel.
export type ElectronReleaseChannel = "stable" | "preview";

/// Integrated-terminal shell dialect usable by the Windows Bash tool.
export type IntegratedTerminalShellDialect = "cmd" | "git-bash";

/// The settings-page user choice of Windows Bash shell.
export type IntegratedTerminalShellSelection =
  | { mode: "auto" }
  | {
      mode: "shell";
      dialect: IntegratedTerminalShellDialect;
      id: string;
      label: string;
      path: string;
    };

/// Windows shell options recognizable by the current host.
export interface IntegratedTerminalShellOption {
  dialect: IntegratedTerminalShellDialect;
  id: string;
  label: string;
  path: string;
  source: "system" | "path";
}

/// Default language
export const DEFAULT_LOCALE: Locale = "zh-CN";

// ── Workspace / Tab ──

/// Unique tab id
export type TabId = string;

/// State of a single tab
export interface TabState {
  id: TabId;
  /// Absolute workspace path
  workspacePath: string;
  /// Display name, usually the path's last segment
  label: string;
}

export interface SSHRemoteTargetSnapshot {
  kind: "ssh";
  host: string;
  port?: number;
  username: string;
  /// SSH config Host alias chosen at connect time, for UI display only.
  sshConfigAlias?: string;
  privateKeyPath?: string;
  assetInstallMode?: RemoteAssetInstallMode;
  resourcePackages?: RemoteResourcePackageSelection;
  /**
   * SSH passwords never land in setting.json.
   * Only the credentialService key is stored; the real password is read from secure storage on restore.
   */
  passwordCredentialKey?: string;
  /**
   * Private-key passphrases never land in setting.json.
   * Only the credentialService key is stored; the real passphrase is read from secure storage on restore.
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

export type RemoteTargetSnapshot =
  | SSHRemoteTargetSnapshot
  | WSLRemoteTargetSnapshot
  | DockerRemoteTargetSnapshot;

export interface RemoteWorkspaceSessionSnapshot {
  /// The remote workspace's real absolute path
  workspacePath: string;
  /// Local workspace path at connect time, used only for MCP filesystem path rewriting.
  localWorkspacePath?: string;
  /// Stable identity key of the remote workspace (authority + canonicalPath).
  workspaceIdentity?: string;
  /// Resumable snapshot of the remote connection target
  target: RemoteTargetSnapshot;
  /// Timestamp of the last successful open of this workspace
  lastOpenedAt: number;
  /// Last restore/reconnect result
  lastConnectionStatus: "connected" | "failed";
  /// Last failure reason; cleared on success
  lastConnectionError?: string;
}

export interface LocalWorkspaceSessionEntry {
  kind: "local";
  workspacePath: string;
  /// Project display kind; legacy data defaults to project, conversation still uses the real workspacePath as cwd/key.
  workspacePurpose?: WorkspacePurpose;
}

export interface RemoteWorkspaceSessionEntry extends RemoteWorkspaceSessionSnapshot {
  kind: "remote";
}

export type PersistedWorkspaceSessionEntry =
  | LocalWorkspaceSessionEntry
  | RemoteWorkspaceSessionEntry;

// ── Process Monitor ──

/// Resource manager categories: core services / built-in plugins / community plugins
export type ResourceUsageCategory = "base" | "builtin-plugin" | "community-plugin";

/// Core-services group key; plugin groups key by plugin name or MCP server name
export type ResourceUsageBaseGroupKey = "main" | "gpu" | "renderer" | "host" | "cli" | "utility";

/// One process row in the resource manager (CPU is machine-normalized percent, memory in bytes)
export interface ResourceUsageProcess {
  pid: number;
  /// Process display name, e.g. zcode-main / zcode-agent-zcode-demo / node_repl
  name: string;
  category: ResourceUsageCategory;
  groupKey: string;
  groupLabel: string;
  cpuPercent: number;
  memoryBytes: number;
  /// false = topology known, metrics not yet sampled (rendered as -)
  sampled: boolean;
}

/// Host-side sampled external process rows (agent / MCP / terminal etc.), merged into the snapshot by main
export type HostResourceUsageProcess = Omit<ResourceUsageProcess, "sampled">;

/// One full resource-manager snapshot; main merges Electron metrics, system totals, and Host sampling
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
  /// The app/host no longer shows the pre-submit experience plan upsell; no entry's model choice changes.
  startPlanRecommendationDismissed?: boolean;
  recentProjects: string[]; // recent projects, at most 10 kept
  locale: Locale; // UI language
  /**
   * User-overridden shortcut bindings (command id -> array of binding strings, format in shortcutCommands.ts).
   * Only overrides persist: unoverridden commands are not written, merged with SHORTCUT_COMMANDS defaults on read;
   * override semantics are whole-group replacement (e.g. both defaults of openCommandCenter lapse together when overridden).
   */
  shortcutBindings?: Record<string, string[]>;
  /// UI locale preference; resolved locale is the actual language, for non-browser contexts like main/menu/remote control.
  localePreference?: LocalePreference;
  /// Best-effort inherit system terminal profile, shell env, and font
  terminalInheritSystemProfile?: boolean;
  /// User-overridden terminal font; auto-detected from the system terminal config when empty
  terminalFontFamily?: string;
  /// Native shell used by the Bash tool on Windows; auto-selected when unset.
  integratedTerminalShell?: IntegratedTerminalShellSelection;
  /// HTTP/HTTPS egress proxy, e.g. http://127.0.0.1:7890; direct when empty. Takes effect on next app/agent start.
  httpProxy?: string;
  /// Proxy bypass rules, e.g. localhost,127.0.0.1,.example.com; only affects the renderer while httpProxy is set, agent/tools keep explicit env.
  httpProxyNoProxy?: string;
  /// Custom PEM root CA path; used at next start for renderer validation and agent NODE_EXTRA_CA_CERTS.
  httpProxyCaCertPath?: string;
  /**
   * In-app browser ignores HTTPS certificate errors (self-signed, expired, mismatched host, ...) for intranet test sites.
   * Affects only the in-app browser egress, not ZCode's own requests to backends and model APIs. Off by default, effective after restart.
   */
  embeddedBrowserAllowInsecureCertificates?: boolean;
  /// One-shot display preference when a human opens a Browser tab; Agent Browser Never reads or writes it.
  embeddedBrowserViewportPreference?: EmbeddedBrowserViewportPreference;
  /**
   * The user turned off the composer's Computer-Use button in settings (internal hidden state).
   // hidden semantics, not visible: undefined = shown by default, no data migration for existing users.
   // Once off, the button stops rendering and does not self-heal across restarts/updates; only settings can re-enable.
   */
  computerUseComposerEntryHidden?: boolean;
  /// Master switch for auto-archiving finished old tasks
  taskAutoArchiveEnabled?: boolean;
  /// Auto-archive threshold; tasks whose last update predays this many days become archivable
  taskAutoArchiveOlderThanDays?: number;
  /// Windows desktop hides to tray on window close; other platforms ignore
  closeToTrayOnWindows?: boolean;
  /// Prevent system idle sleep while off-peak tasks run (manual toggle; cannot cover lid close).
  keepAwakeWhileRunning?: boolean;
  /// Whether the Windows close-to-tray default one-time migration ran; migration bookkeeping only, no business decisions.
  closeToTrayOnWindowsMigrationInitialized?: boolean;
  /// Desktop global page-zoom level; restores UI zoom after restart, web/phone ignore.
  desktopZoomLevel?: number;
  /// Desktop main window's last non-maximized size and maximized state; web/phone ignore.
  desktopWindowSize?: {
    width: number;
    height: number;
    maximized: boolean;
  };
  /// Desktop Chromium hardware-acceleration toggle; applies early in the next main-process start only, web/phone ignore.
  desktopChromiumHardwareAccelerationEnabled?: boolean;
  /// Show the model's thinking in the message stream
  messageStreamShowReasoning?: boolean;
  // TODO(settings-schema-version): once every supported upgrade path is proven migrated, move to a unified settings schema version and delete this marker, migration, and persistence check.
  /// Whether the show-thinking default's one-time migration ran; migration bookkeeping only, not a rendering decision.
  messageStreamShowReasoningMigrationInitialized?: boolean;
  /// Show todo tool rendering in the message stream; does not affect the summary panel's todos
  messageStreamShowTodos?: boolean;
  /// Aggregate consecutive read-only tool calls into Explore.
  toolGroupingExploreEnabled?: boolean;
  /// Aggregate consecutive non-readonly Shell tool calls into Terminal.
  toolGroupingTerminalEnabled?: boolean;
  /// Aggregate consecutive Write/Edit/ApplyPatch tool calls into Changes.
  toolGroupingChangesEnabled?: boolean;
  /// While a ZCode run is active: queue for the next round or guide to run after the next tool call
  zcodeInteractionBehavior?: ZCodeInteractionBehavior;
  /// Allow auto-continue when an agent question sits unanswered for five minutes; absent = on for legacy-config compat.
  askUserQuestionAutoResolutionEnabled?: boolean;
  /// Keep full Model I/O; when on: no rotation, no quota reset, no compaction or trimming; auth info still redacted.
  modelIoFullRetentionEnabled?: boolean;
  /// The per-Provider-Family structured connection choice in settings.
  providerFamilyConnectionSelections?: ProviderFamilyConnectionSelectionSettings;
  /// ZAI / BigModel provider-family runtime domain confirmed after a successful WelcomeScreen connect.
  providerFamilyDomain?: ProviderFamilyDomain;
  /// Last time providerFamilyDomain was set or cleared.
  providerFamilyDomainUpdatedAt?: number;
  /// Whether legacy oauth/provider state has been migrated to providerFamilyDomain.
  providerFamilyDomainMigrated?: boolean;
  /// Inject bfs/ugrep enhancements for Bash in new or cold-restored sessions; on by default.
  nativeSearchEnhancementsEnabled?: boolean;
  /** Whether new/cold-resumed sessions enable task-list-driven autonomous continuation (mission mode); default off. */
  missionContinuationEnabled?: boolean;
  /// Enable Memory for new or cold-restored sessions; off by default.
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
  /// Full workspace session at last close (local and remote workspaces)
  lastWorkspaceSession?: PersistedWorkspaceSessionEntry[];
  /// Active tab index at last close
  lastActiveTabIndex?: number;
  /// Per-workspace last active taskId, restored on next open
  lastActiveTaskByWorkspace?: Record<string, string>;
  /// Data root (replaces homedir), defaults to os.homedir(); the .zcode/v2 suffix is unchanged
  dataBaseDir?: string;
  /// Release notes staged for display on first start after an update installs
  pendingPostUpdateReleaseNotes?: {
    version: string;
    title: string;
    markdown: string;
    releaseDate?: string;
    releaseNotesByLocale?: Partial<Record<Locale, { title: string; markdown: string }>>;
  };
  /// Settings preference for receiving preview auto-updates; read by desktop auto-update only.
  receivePreviewUpdates?: boolean;
  /// Settings/dialog preference to auto-download and install updates; read by desktop auto-update only.
  autoDownloadAndInstallUpdates?: boolean;
  /// Electron auto-update versions skipped by the user; per-channel so stable/preview do not shadow each other.
  skippedElectronUpdateVersions?: Partial<Record<ElectronReleaseChannel, string>>;
  /// Whether the first-run settings-sync hint was consumed; means the dialog will not reappear, not that import succeeded.
  settingsSyncFirstRunPromptHandled?: boolean;
  /// Ad-hoc endpoint override from settings; production/test default base URLs are governed by ZCODE_BASE_URL.
  zcodeEndpointOrigin?: string;
}
