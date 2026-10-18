/* eslint-disable max-lines -- autoUpdater must centralize Electron events, menu state, and IPC; splitting it further would obscure the update state flow */
import { app, BrowserWindow, ipcMain, Menu } from "electron";
import type { ISettingService } from "@zcode/services";
import pkg, { CancellationToken } from "electron-updater";
import semver from "semver";
const { autoUpdater } = pkg;
import {
  DEFAULT_LOCALE,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  PlatformChannels,
  ZCODE_VERSION,
  desktopMenuMessageIds,
  formatDesktopMenuMessage,
  getDesktopMenuMessage,
  resolveRuntimeZCodeEndpointOrigin,
  type ElectronReleaseChannel,
  type Locale,
  type PostUpdateReleaseNotesPayload,
  type UpdateCheckResultPayload,
  type UpdateStatePayload,
} from "@zcode/shared";
import { logger } from "./logger.js";
import { ManifestUpdateProvider, getElectronReleasePlatform } from "./manifestUpdateProvider.js";

export const CHECK_FOR_UPDATE_MENU_ID = "check-for-update";
const AUTO_UPDATE_POLL_INTERVAL_MS = 15 * 60 * 1000;
const AUTO_UPDATE_VISIBLE_POLL_INTERVAL_MS = 2 * 60 * 1000;
const UPDATE_FEED_URL_ENV = "ZCODE_UPDATE_FEED_URL";
const UPDATE_FEED_URL_SWITCH = "--zcode-update-feed-url";
const DEV_AUTO_UPDATE_ENV = "ZCODE_AUTO_UPDATE_DEV";
const DEV_AUTO_UPDATE_SWITCH = "--zcode-auto-update-dev";
const DEV_AUTO_UPDATE_VERSION_ENV = "ZCODE_AUTO_UPDATE_DEV_VERSION";
const DEV_AUTO_UPDATE_VERSION_SWITCH = "--zcode-auto-update-dev-version";
let readyUpdateVersion: string | null = null;
let readyUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
let readyUpdateRestoredFromPendingReleaseNotes = false;
let menuLocale: Locale = DEFAULT_LOCALE;
let manualCheckWebContentsId: number | null = null;
let pendingPostUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
let deliveredPostUpdateReleaseNotesWebContentsId: number | null = null;
let autoUpdatePollTimer: NodeJS.Timeout | null = null;
let autoUpdatePollIntervalMs: number | null = null;
let checkForUpdatesInFlight = false;
let autoUpdateCheckGeneration = 0;
let activeAutoUpdateCheckId: number | null = null;
let activeAutoUpdateCheckChannel: ElectronReleaseChannel | null = null;
let settlingAutoUpdateCheckId: number | null = null;
let availableUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
let availableUpdateChannel: ElectronReleaseChannel = "stable";
let downloadingUpdateVersion: string | null = null;
let downloadingUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
let downloadingUpdateChannel: ElectronReleaseChannel | null = null;
let downloadCancellationToken: CancellationToken | null = null;
let readyUpdateChannel: ElectronReleaseChannel | null = null;
let pendingManifestReleaseChannelRefresh: ElectronReleaseChannel | null = null;
let onBeforeQuitAndInstall: (() => void | Promise<void>) | undefined;
const acknowledgedPostUpdateReleaseNotesVersions = new Set<string>();
const cancelledDownloadTokens = new WeakSet<CancellationToken>();
let pendingCancelledDownloadErrorCount = 0;
let autoUpdaterSettingService: SettingServiceLike | undefined;
// initAutoUpdater({ enabled: false }) only clears polling and returns, leaving the electron-updater instance unconfigured
// (placeholder feed, autoDownload defaults). Any entry missed by the identity check that still triggers a manual check
// would hit the placeholder feed for real. Remember flavor-disabled state so manual checks fail closed inside the module.
let autoUpdaterDisabledForProductFlavor = false;

type SettingServiceLike = Pick<ISettingService, "get" | "update">;

type ReleaseNoteInfoLike = {
  note?: string | null;
  version?: string | null;
};

type UpdateDownloadedInfoLike = {
  version: string;
  path?: string | null;
  files?: Array<{ url?: string | null } | null> | null;
  packages?: Record<string, { path?: string | null } | null> | null;
  zcodeReleaseChannel?: ElectronReleaseChannel | null;
  releaseName?: string | null;
  releaseNotes?: string | ReleaseNoteInfoLike[] | null;
  releaseDate?: string | Date | null;
  releaseNotesByLocale?: Partial<
    Record<
      Locale,
      | string
      | {
          title?: string | null;
          markdown?: string | null;
          releaseNotes?: string | ReleaseNoteInfoLike[] | null;
        }
      | null
    >
  > | null;
};

type RuntimeUpdateFeedSource = { url: string };

type AutoUpdaterMenuState = UpdateStatePayload;
let menuState: AutoUpdaterMenuState = { kind: "idle", enabled: true };

export type ForceAutoUpdateState =
  | { kind: "checking" }
  | { kind: "downloading"; version?: string; progress?: string }
  | { kind: "ready"; version?: string }
  | { kind: "installing" }
  | { kind: "error"; message: string }
  | { kind: "dev-skipped"; message?: string };

let activeForceAutoUpdateListener: ((state: ForceAutoUpdateState) => void) | null = null;
const autoUpdaterStateListeners = new Set<(state: UpdateStatePayload) => void>();
let forceAutoUpdateLastLoggedProgressBucket: number | null = null;

interface InitAutoUpdaterOptions {
  enabled?: boolean;
  onBeforeQuitAndInstall?: () => void | Promise<void>;
  settingService?: SettingServiceLike;
  locale?: Locale;
  updateFeedSource?: RuntimeUpdateFeedSource;
  deviceMid?: string;
  resolveEndpointOrigin?: () => string | Promise<string>;
}

let quitAndInstallInFlight = false;
let devAutoUpdateVersionOverride: string | null = null;
let recheckAfterDownload: ((reason: string) => void) | null = null;
let pendingFailedDownloadRecheck = false;

type MutableAutoUpdaterForDev = typeof autoUpdater & {
  currentVersion?: semver.SemVer;
  forceDevUpdateConfig?: boolean;
};

function isTruthyRuntimeFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function readCommandLineSwitchValue(name: string): string | null {
  const prefix = `${name}=`;
  for (const arg of process.argv) {
    if (arg === name) {
      return "";
    }
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return null;
}

function isDevAutoUpdateEnabled(): boolean {
  return (
    isTruthyRuntimeFlag(process.env[DEV_AUTO_UPDATE_ENV]) ||
    readCommandLineSwitchValue(DEV_AUTO_UPDATE_SWITCH) !== null
  );
}

function canUseAutoUpdaterInCurrentRuntime(): boolean {
  return app.isPackaged || isDevAutoUpdateEnabled();
}

function shouldRelaunchForDevAutoUpdateInstall(): boolean {
  return !app.isPackaged && isDevAutoUpdateEnabled();
}

function getCurrentAppVersionForUpdate(): string {
  return devAutoUpdateVersionOverride ?? app.getVersion();
}

function resolveDevAutoUpdateVersion(): string | null {
  const configuredVersion =
    process.env[DEV_AUTO_UPDATE_VERSION_ENV]?.trim() ||
    readCommandLineSwitchValue(DEV_AUTO_UPDATE_VERSION_SWITCH)?.trim() ||
    ZCODE_VERSION;
  const parsed = semver.parse(configuredVersion);
  if (!parsed) {
    logger.warn(`[auto-update] ignore invalid dev update version=${configuredVersion}`);
    return null;
  }
  return parsed.format();
}

function applyDevAutoUpdateRuntimeOverrides(): void {
  devAutoUpdateVersionOverride = null;
  if (app.isPackaged || !isDevAutoUpdateEnabled()) {
    return;
  }

  const devVersion = resolveDevAutoUpdateVersion();
  const parsedVersion = devVersion ? semver.parse(devVersion) : null;
  const mutableAutoUpdater = autoUpdater as MutableAutoUpdaterForDev;
  mutableAutoUpdater.forceDevUpdateConfig = true;
  if (parsedVersion) {
    devAutoUpdateVersionOverride = parsedVersion.format();
    // In dev, Electron app.getVersion() reports the desktop shell version,
    // not necessarily the product version. To test auto-update, electron-updater's
    // currentVersion must be overridden to the product version, or flows like 3.3.1 -> 3.3.2 cannot be reproduced.
    mutableAutoUpdater.currentVersion = parsedVersion;
  }

  logger.info(
    `[auto-update] dev update enabled version=${devAutoUpdateVersionOverride ?? app.getVersion()}`,
  );
}

function normalizeVersionForCompare(version: string): string | null {
  return semver.valid(semver.coerce(version.trim()));
}

function isVersionGreaterThan(candidateVersion: string, baselineVersion: string): boolean {
  const candidate = normalizeVersionForCompare(candidateVersion);
  const baseline = normalizeVersionForCompare(baselineVersion);
  if (candidate && baseline) {
    return semver.gt(candidate, baseline);
  }

  return candidateVersion.trim() !== baselineVersion.trim();
}

function shouldDownloadAvailableUpdate(version: string): boolean {
  if (readyUpdateRestoredFromPendingReleaseNotes) {
    return true;
  }

  return !readyUpdateVersion || isVersionGreaterThan(version, readyUpdateVersion);
}

function canPollForUpdatesFromState(state: AutoUpdaterMenuState): boolean {
  return (
    state.kind === "idle" || state.kind === "update-available" || state.kind === "update-downloaded"
  );
}

function hasVisibleUpdateTarget(state: AutoUpdaterMenuState): boolean {
  return state.kind === "update-available" || state.kind === "update-downloaded";
}

function resolveAutoUpdatePollInterval(state: AutoUpdaterMenuState): number {
  return hasVisibleUpdateTarget(state)
    ? AUTO_UPDATE_VISIBLE_POLL_INTERVAL_MS
    : AUTO_UPDATE_POLL_INTERVAL_MS;
}

function getAutoUpdaterReleaseChannelForCurrentState(): ElectronReleaseChannel {
  switch (menuState.kind) {
    case "update-available":
      return menuState.channel ?? availableUpdateChannel;
    case "download-progress":
      return menuState.channel ?? downloadingUpdateChannel ?? availableUpdateChannel;
    case "update-downloaded":
      return menuState.channel ?? readyUpdateChannel ?? availableUpdateChannel;
    default:
      return availableUpdateChannel;
  }
}

function readUpdateInfoReleaseChannel(
  info: UpdateDownloadedInfoLike,
): ElectronReleaseChannel | null {
  return info.zcodeReleaseChannel === "preview" || info.zcodeReleaseChannel === "stable"
    ? info.zcodeReleaseChannel
    : null;
}

function beginAutoUpdateCheck(): number {
  checkForUpdatesInFlight = true;
  autoUpdateCheckGeneration += 1;
  activeAutoUpdateCheckId = autoUpdateCheckGeneration;
  activeAutoUpdateCheckChannel = availableUpdateChannel;
  settlingAutoUpdateCheckId = null;
  return activeAutoUpdateCheckId;
}

function completeAutoUpdateCheck(reason: string, checkId: number | null): void {
  if (checkId !== null && activeAutoUpdateCheckId !== checkId) {
    return;
  }

  checkForUpdatesInFlight = false;
  activeAutoUpdateCheckId = null;
  activeAutoUpdateCheckChannel = null;
  settlingAutoUpdateCheckId = null;

  const pendingChannel = pendingManifestReleaseChannelRefresh;
  const shouldRecheckFailedDownload = pendingFailedDownloadRecheck;
  pendingFailedDownloadRecheck = false;
  if (shouldRecheckFailedDownload && !pendingChannel && !activeForceAutoUpdateListener) {
    // The download failed before this check settled. Re-check after the flag clears so the
    // follow-up is not dropped by the in-flight check.
    queueMicrotask(() => recheckAfterDownload?.("download-failed"));
  }
  if (!pendingChannel) {
    return;
  }

  pendingManifestReleaseChannelRefresh = null;
  refreshAutoUpdaterReleaseChannel(
    pendingChannel === "preview",
    `${reason} pending release channel refresh`,
  );
}

function finishAutoUpdateCheck(reason: string, checkId: number | null): void {
  if (
    checkId !== null &&
    activeAutoUpdateCheckId === checkId &&
    settlingAutoUpdateCheckId === checkId
  ) {
    return;
  }

  completeAutoUpdateCheck(reason, checkId);
}

function settleAutoUpdateCheckResult(
  reason: string,
  work: () => Promise<void> | void,
): Promise<void> {
  const checkId = activeAutoUpdateCheckId;
  if (!checkForUpdatesInFlight || checkId === null) {
    return Promise.resolve(work());
  }

  settlingAutoUpdateCheckId = checkId;
  try {
    return Promise.resolve(work()).finally(() => {
      // electron-updater's checkForUpdates() promise resolves on request return only;
      // it does not await the async state handling inside update-available (settings read, skip version, auto-download).
      // Make one check's mutex span request plus result handling so a channel refresh or manual check cannot start before the old result writes state.
      completeAutoUpdateCheck(reason, checkId);
    });
  } catch (error) {
    completeAutoUpdateCheck(reason, checkId);
    return Promise.reject(error);
  }
}

function shouldIgnoreStaleAvailableUpdate(infoChannel: ElectronReleaseChannel | null): boolean {
  const expectedChannel = activeAutoUpdateCheckChannel ?? availableUpdateChannel;
  return Boolean(infoChannel && infoChannel !== expectedChannel);
}

function isReadyUpdateCurrentTarget(): boolean {
  return Boolean(
    readyUpdateVersion &&
    menuState.kind === "update-downloaded" &&
    menuState.version === readyUpdateVersion,
  );
}

function buildUpdateDownloadedState(version: string): AutoUpdaterMenuState {
  return {
    kind: "update-downloaded",
    enabled: true,
    version,
    ...(readyUpdateChannel ? { channel: readyUpdateChannel } : {}),
    ...(readyUpdateReleaseNotes ? { releaseNotes: readyUpdateReleaseNotes } : {}),
  };
}

function buildUpdateAvailableState(
  version: string,
  releaseNotes: PostUpdateReleaseNotesPayload | null,
  channel: ElectronReleaseChannel,
): AutoUpdaterMenuState {
  return {
    kind: "update-available",
    enabled: true,
    version,
    channel,
    ...(releaseNotes ? { releaseNotes } : {}),
  };
}

function notifyForceAutoUpdate(state: ForceAutoUpdateState) {
  activeForceAutoUpdateListener?.(state);
}

function getForceAutoUpdateNoUpdateMessage(): string {
  return menuLocale === "zh-CN"
    ? "未找到可安装更新，请使用手动升级。"
    : "No installable update was found. Use manual update instead.";
}

function normalizeProgressPercent(progress: unknown): string | undefined {
  if (typeof progress !== "object" || progress === null || !("percent" in progress)) {
    return undefined;
  }

  const percent = Number((progress as { percent?: unknown }).percent);
  if (!Number.isFinite(percent)) {
    return undefined;
  }

  return Math.max(0, Math.min(100, percent)).toFixed(0);
}

function logForceAutoUpdateProgress(progress: string | undefined) {
  if (!progress) {
    return;
  }

  const bucket = Math.floor(Number(progress) / 10) * 10;
  if (bucket === forceAutoUpdateLastLoggedProgressBucket) {
    return;
  }
  forceAutoUpdateLastLoggedProgressBucket = bucket;
  logger.info(`[force-update] auto-update download progress ${progress}%`);
}

function buildDownloadProgressState(
  progress: string,
  byteProgress?: { transferredBytes: number; totalBytes: number },
): AutoUpdaterMenuState {
  return {
    kind: "download-progress",
    enabled: false,
    progress,
    ...(byteProgress ? byteProgress : {}),
    ...(downloadingUpdateVersion ? { version: downloadingUpdateVersion } : {}),
    ...(downloadingUpdateChannel ? { channel: downloadingUpdateChannel } : {}),
    ...(downloadingUpdateReleaseNotes ? { releaseNotes: downloadingUpdateReleaseNotes } : {}),
  };
}

async function quitAndInstallUpdate(rejectUnavailable = false) {
  if (
    menuState.kind === "update-downloaded" &&
    readyUpdateVersion &&
    readyUpdateRestoredFromPendingReleaseNotes
  ) {
    const restoredVersion = readyUpdateVersion;
    const restoredReleaseNotes = readyUpdateReleaseNotes;
    const restoredChannel = readyUpdateChannel ?? availableUpdateChannel;
    logger.warn(
      `[auto-update] restage restored pending update before install version=${restoredVersion}`,
    );
    clearReadyUpdateState();
    availableUpdateReleaseNotes = restoredReleaseNotes;
    setAutoUpdaterMenuState(
      buildUpdateAvailableState(restoredVersion, restoredReleaseNotes, restoredChannel),
    );
    if (await shouldAutoDownloadAndInstallUpdates(autoUpdaterSettingService)) {
      downloadAvailableUpdate("restored-pending-install");
    }
    return;
  }

  if (
    menuState.kind !== "update-downloaded" ||
    !readyUpdateVersion ||
    !isReadyUpdateCurrentTarget()
  ) {
    // Fix: the renderer may still show "restart to update" from a stale UpdateReady cache after
    // main cleared ready on a staging error. Even then, never install a package below the current
    // target version.
    logger.warn(`[auto-update] ignore quitAndInstall request: state=${menuState.kind}`);
    if (rejectUnavailable) {
      throw new Error(`Update is not ready to install: state=${menuState.kind}`);
    }
    return;
  }

  if (quitAndInstallInFlight) {
    logger.info("[auto-update] quitAndInstall already in flight");
    return;
  }
  quitAndInstallInFlight = true;
  logger.info("[auto-update] user requested quit and install");
  // On macOS, quitAndInstall() closes windows without running app.before-quit first.
  // Relying on before-quit alone to allow window close lets the traffic-light-close-hides-window logic block the quit,
  // leaving UI gone, process alive, and the install stalled.
  // Tell main to enter allow-real-close first, then hand control to the updater.
  try {
    // Windows updates replace packaged resources such as resources/glm;
    // if quitAndInstall runs before host/agent children exit, the installer may start overwriting while files are locked,
    // leaving a half-updated state where the app starts but the bundled agent is missing.
    // Wait explicitly for main to finish shutdown prep before the installer, straightening resource-swap vs child-reap ordering.
    await onBeforeQuitAndInstall?.();
  } catch (error) {
    // Shutdown prep is a hard precondition for releasing host/agent and resources/glm file locks.
    // Launching the installer after a failure here can overwrite a locked install dir on Windows, half-updating.
    quitAndInstallInFlight = false;
    handleAutoUpdateFailure(error, "prepare quit and install failed");
    if (rejectUnavailable) {
      throw error;
    }
    return;
  }

  try {
    if (shouldRelaunchForDevAutoUpdateInstall()) {
      // Dev mode only verifies server manifest, download progress, and the install entry UI loop;
      // an unpackaged app has no real release package for the installer to take over. Restart the dev app instead,
      // avoiding a hung state after restart-to-update runs shutdown prep.
      logger.info("[auto-update] dev update install fallback: relaunch app");
      app.relaunch();
      app.exit(0);
      return;
    }

    // The 3.3.0 Windows custom PowerShell delayed launcher in detached/hidden mode could
    // spawn powershell.exe without reliably reaching the installer; the app closes but the version never changes.
    // Restore electron-updater's native install path; a spawned launcher process must not count as the update taking over.
    autoUpdater.quitAndInstall();
  } finally {
    quitAndInstallInFlight = false;
  }
}

function updateMenuItemLabel(label: string, enabled: boolean) {
  const menu = Menu.getApplicationMenu();
  const item = menu?.getMenuItemById(CHECK_FOR_UPDATE_MENU_ID);
  if (item) {
    item.label = label;
    item.enabled = enabled;
  }
}

function getMenuItemLabel(state: AutoUpdaterMenuState): string {
  switch (state.kind) {
    case "checking":
      return getDesktopMenuMessage(menuLocale, desktopMenuMessageIds.helpCheckingForUpdates);
    case "update-available":
      return formatDesktopMenuMessage(
        menuLocale,
        desktopMenuMessageIds.helpUpdateAvailableVersion,
        { version: state.version },
      );
    case "download-progress":
      return formatDesktopMenuMessage(
        menuLocale,
        desktopMenuMessageIds.helpDownloadingUpdateProgress,
        { progress: state.progress },
      );
    case "update-downloaded":
      return formatDesktopMenuMessage(menuLocale, desktopMenuMessageIds.helpRestartToUpdate, {
        version: state.version,
      });
    case "idle":
    default:
      return getDesktopMenuMessage(menuLocale, desktopMenuMessageIds.helpCheckForUpdates);
  }
}

function syncMenuItemState() {
  updateMenuItemLabel(getMenuItemLabel(menuState), menuState.enabled);
}

function isSameAutoUpdaterMenuState(left: AutoUpdaterMenuState, right: AutoUpdaterMenuState) {
  if (left.kind !== right.kind || left.enabled !== right.enabled) {
    return false;
  }

  switch (left.kind) {
    case "update-available":
      return (
        right.kind === left.kind &&
        right.version === left.version &&
        right.channel === left.channel &&
        JSON.stringify(right.releaseNotes ?? null) === JSON.stringify(left.releaseNotes ?? null)
      );
    case "update-downloaded":
      return (
        right.kind === left.kind &&
        right.version === left.version &&
        right.channel === left.channel &&
        JSON.stringify(right.releaseNotes ?? null) === JSON.stringify(left.releaseNotes ?? null)
      );
    case "download-progress":
      return (
        right.kind === left.kind &&
        right.progress === left.progress &&
        right.version === left.version &&
        right.channel === left.channel &&
        JSON.stringify(right.releaseNotes ?? null) === JSON.stringify(left.releaseNotes ?? null)
      );
    case "idle":
    case "checking":
    default:
      return true;
  }
}

function broadcastAutoUpdaterState() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(PlatformChannels.UpdateStateChanged, menuState);
    }
  }
}

export function onAutoUpdaterStateChanged(listener: (state: UpdateStatePayload) => void) {
  autoUpdaterStateListeners.add(listener);
  return () => {
    autoUpdaterStateListeners.delete(listener);
  };
}

function setAutoUpdaterMenuState(nextState: AutoUpdaterMenuState) {
  if (isSameAutoUpdaterMenuState(menuState, nextState)) {
    return;
  }

  menuState = nextState;
  syncMenuItemState();
  broadcastAutoUpdaterState();
  ensureAutoUpdatePollInterval();
  for (const listener of autoUpdaterStateListeners) {
    listener(menuState);
  }
}

function findLiveWindowByWebContentsId(webContentsId: number | null) {
  if (webContentsId == null) {
    return null;
  }

  return (
    BrowserWindow.getAllWindows().find(
      (win) => !win.isDestroyed() && win.webContents.id === webContentsId,
    ) ?? null
  );
}

function deriveReleaseNotesTitle(markdown: string, version: string) {
  const firstHeading = markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("# ") && line.length > 2);

  return firstHeading ? firstHeading.slice(2).trim() : `Release v${version}`;
}

function normalizeReleaseNotesMarkdown(
  releaseNotes: UpdateDownloadedInfoLike["releaseNotes"],
): string | null {
  if (typeof releaseNotes === "string") {
    const markdown = releaseNotes.trim();
    return markdown === "" ? null : markdown;
  }

  if (!Array.isArray(releaseNotes)) {
    return null;
  }

  const markdown = releaseNotes
    .map((item) => (typeof item?.note === "string" ? item.note.trim() : ""))
    .filter((item) => item.length > 0)
    .join("\n\n")
    .trim();

  return markdown === "" ? null : markdown;
}

function normalizeLocalizedReleaseNotes(
  version: string,
  releaseNotesByLocale: UpdateDownloadedInfoLike["releaseNotesByLocale"],
): PostUpdateReleaseNotesPayload["releaseNotesByLocale"] | undefined {
  const localized: PostUpdateReleaseNotesPayload["releaseNotesByLocale"] = {};
  if (!releaseNotesByLocale || typeof releaseNotesByLocale !== "object") {
    return undefined;
  }

  for (const locale of ["zh-CN", "en-US"] as const) {
    const entry = releaseNotesByLocale[locale];
    if (!entry) {
      continue;
    }

    const markdown =
      typeof entry === "string"
        ? normalizeReleaseNotesMarkdown(entry)
        : normalizeReleaseNotesMarkdown(entry.markdown ?? entry.releaseNotes);
    if (!markdown) {
      continue;
    }

    localized[locale] = {
      title:
        typeof entry === "object" && entry.title?.trim()
          ? entry.title.trim()
          : deriveReleaseNotesTitle(markdown, version),
      markdown,
    };
  }

  return Object.keys(localized).length > 0 ? localized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function redactUpdateFeedUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    if (url.search) {
      url.search = "?<redacted>";
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

function readSwitchValue(argv: readonly string[], switchName: string): string | undefined {
  const equalsPrefix = `${switchName}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg.startsWith(equalsPrefix)) {
      return arg.slice(equalsPrefix.length).trim() || undefined;
    }
    if (arg === switchName) {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        return next.trim() || undefined;
      }
      return undefined;
    }
  }
  return undefined;
}

export function resolveUpdateFeedSourceFromStartupConfig(
  options: {
    argv?: readonly string[];
    env?: Record<string, string | undefined>;
  } = {},
): RuntimeUpdateFeedSource | undefined {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const feedUrl = readSwitchValue(argv, UPDATE_FEED_URL_SWITCH) ?? env[UPDATE_FEED_URL_ENV]?.trim();
  return feedUrl
    ? {
        url: feedUrl,
      }
    : undefined;
}

async function resolveUpdateReleaseChannel(
  settingService: SettingServiceLike | undefined,
): Promise<ElectronReleaseChannel> {
  if (!settingService) {
    return "stable";
  }

  try {
    const settings = await settingService.get();
    return settings.receivePreviewUpdates === true ? "preview" : "stable";
  } catch (error) {
    logger.warn("[auto-update] read preview update setting failed:", error);
    return "stable";
  }
}

async function syncAutoUpdateCheckChannelFromSettings(
  checkId: number,
  settingService: SettingServiceLike | undefined,
  reason: string,
): Promise<void> {
  const nextChannel = await resolveUpdateReleaseChannel(settingService);
  if (activeAutoUpdateCheckId !== checkId) {
    return;
  }

  if (availableUpdateChannel !== nextChannel) {
    logger.info(
      `[auto-update] ${reason}: check channel ${availableUpdateChannel} -> ${nextChannel}`,
    );
  }
  // The server-side manifest provider reads preview settings inside checkForUpdates.
  // If begin still assumes the default stable channel, a cold-start preview result is misjudged as stale.
  availableUpdateChannel = nextChannel;
  activeAutoUpdateCheckChannel = nextChannel;
}

function applyManifestUpdateProvider(options: InitAutoUpdaterOptions): void {
  const manifestUrl = options.updateFeedSource?.url.trim();
  autoUpdater.setFeedURL({
    provider: "custom",
    updateProvider: ManifestUpdateProvider,
    endpointOrigin: DEFAULT_ZCODE_ENDPOINT_ORIGIN,
    ...(manifestUrl ? { manifestUrl } : {}),
    releasePlatform: getElectronReleasePlatform(),
    deviceMid: options.deviceMid,
    resolveEndpointOrigin:
      options.resolveEndpointOrigin ?? (() => resolveRuntimeZCodeEndpointOrigin(process.env)),
    resolveReleaseChannel: async () => {
      availableUpdateChannel = await resolveUpdateReleaseChannel(options.settingService);
      return availableUpdateChannel;
    },
  });
  logger.info(
    manifestUrl
      ? `[auto-update] service manifest provider applied platform=${getElectronReleasePlatform()} manifestUrl=${redactUpdateFeedUrlForLog(manifestUrl)}`
      : `[auto-update] service manifest provider applied platform=${getElectronReleasePlatform()}`,
  );
}

function pickFallbackReleaseNotesMarkdown(
  localized: PostUpdateReleaseNotesPayload["releaseNotesByLocale"] | undefined,
): string | null {
  return (
    localized?.[menuLocale]?.markdown ??
    localized?.["zh-CN"]?.markdown ??
    localized?.["en-US"]?.markdown ??
    null
  );
}

function normalizeReleaseDate(
  releaseDate: UpdateDownloadedInfoLike["releaseDate"],
): string | undefined {
  if (releaseDate instanceof Date && !Number.isNaN(releaseDate.getTime())) {
    return releaseDate.toISOString();
  }
  if (typeof releaseDate !== "string") {
    return undefined;
  }
  const trimmed = releaseDate.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toPostUpdateReleaseNotesPayload(
  info: UpdateDownloadedInfoLike,
): PostUpdateReleaseNotesPayload | null {
  const releaseNotesByLocale = normalizeLocalizedReleaseNotes(
    info.version,
    info.releaseNotesByLocale,
  );
  const markdown =
    normalizeReleaseNotesMarkdown(info.releaseNotes) ??
    pickFallbackReleaseNotesMarkdown(releaseNotesByLocale);
  if (!markdown) {
    return null;
  }

  const title = info.releaseName?.trim() || deriveReleaseNotesTitle(markdown, info.version);
  const releaseDate = normalizeReleaseDate(info.releaseDate);
  return {
    version: info.version,
    title,
    markdown,
    ...(releaseDate ? { releaseDate } : {}),
    ...(releaseNotesByLocale ? { releaseNotesByLocale } : {}),
  };
}

async function persistPendingPostUpdateReleaseNotes(
  settingService: SettingServiceLike,
  payload: PostUpdateReleaseNotesPayload,
  reason: string,
) {
  if (acknowledgedPostUpdateReleaseNotesVersions.has(payload.version)) {
    logger.info(
      `[auto-update] skip persisting acknowledged post-update release notes (${reason}) version=${payload.version}`,
    );
    return;
  }

  await settingService.update({ pendingPostUpdateReleaseNotes: payload });
  pendingPostUpdateReleaseNotes = payload;
  deliveredPostUpdateReleaseNotesWebContentsId = null;
  logger.info(
    `[auto-update] persisted post-update release notes (${reason}) version=${payload.version}`,
  );
}

/**
 * The pending release notes' version comes from the downloaded installer; the running version stays old until install completes,
 * so pending-newer-than-running is a normal intermediate state and must not be dropped.
 * If the user upgrades via a skipped channel (website installer), an older pending download may linger on disk;
 * pending-older-than-installed must be dropped at startup or a stale release-notes popup appears.
 */
function shouldDiscardStalePendingReleaseNotes(
  pendingVersion: string,
  appVersion: string,
): boolean {
  const pending = pendingVersion.trim();
  const current = appVersion.trim();
  if (pending === current) {
    return false;
  }

  const pendingCoerced = semver.valid(semver.coerce(pending));
  const appCoerced = semver.valid(semver.coerce(current));
  if (!pendingCoerced || !appCoerced) {
    return false;
  }

  return semver.lt(pendingCoerced, appCoerced);
}

function isPendingReleaseNotesForFutureVersion(payload: PostUpdateReleaseNotesPayload): boolean {
  return isVersionGreaterThan(payload.version, getCurrentAppVersionForUpdate());
}

function isDevSquirrelReadyError(error: unknown): boolean {
  if (
    app.isPackaged ||
    !isDevAutoUpdateEnabled() ||
    process.platform !== "darwin" ||
    !isRecord(error)
  ) {
    return false;
  }

  return error.domain === "SQRLUpdaterErrorDomain" && error.code === 2;
}

async function clearPendingPostUpdateReleaseNotes(
  settingService: SettingServiceLike,
  reason: string,
) {
  if (!pendingPostUpdateReleaseNotes) {
    return;
  }

  const version = pendingPostUpdateReleaseNotes.version;
  await settingService.update({ pendingPostUpdateReleaseNotes: undefined });
  pendingPostUpdateReleaseNotes = null;
  deliveredPostUpdateReleaseNotesWebContentsId = null;
  logger.info(`[auto-update] cleared post-update release notes (${reason}) version=${version}`);
}

function sendManualCheckResult(payload: UpdateCheckResultPayload) {
  const webContentsId = manualCheckWebContentsId;
  if (webContentsId == null) return;
  manualCheckWebContentsId = null;

  const win = findLiveWindowByWebContentsId(webContentsId);
  if (!win) {
    logger.info(
      `[auto-update] manual check result dropped, target webContents ${webContentsId} gone`,
    );
    return;
  }
  logger.info(`[auto-update] manual check result → wc=${webContentsId}: ${payload.kind}`);
  win.webContents.send(PlatformChannels.UpdateCheckResult, payload);
}

function clearAvailableUpdateState() {
  availableUpdateReleaseNotes = null;
}

function clearDownloadingUpdateState() {
  downloadingUpdateVersion = null;
  downloadingUpdateReleaseNotes = null;
  downloadingUpdateChannel = null;
}

function clearReadyUpdateState() {
  readyUpdateVersion = null;
  readyUpdateReleaseNotes = null;
  readyUpdateChannel = null;
  readyUpdateRestoredFromPendingReleaseNotes = false;
}

function clearPersistedPostUpdateReleaseNotesForVersion(version: string, reason: string) {
  if (pendingPostUpdateReleaseNotes?.version === version) {
    pendingPostUpdateReleaseNotes = null;
    deliveredPostUpdateReleaseNotesWebContentsId = null;
  }

  const settingService = autoUpdaterSettingService;
  if (!settingService) {
    return;
  }

  void (async () => {
    try {
      const settings = await settingService.get();
      if (settings.pendingPostUpdateReleaseNotes?.version !== version) {
        return;
      }

      await settingService.update({ pendingPostUpdateReleaseNotes: undefined });
      logger.info(`[auto-update] cleared post-update release notes (${reason}) version=${version}`);
    } catch (error) {
      logger.warn(`[auto-update] clear post-update release notes (${reason}) failed:`, error);
    }
  })();
}

function isCancelledDownload(cancellationToken: CancellationToken, error: unknown): boolean {
  return (
    cancelledDownloadTokens.has(cancellationToken) ||
    (cancellationToken.cancelled && isDownloadCancellationError(error))
  );
}

function isDownloadCancellationError(error: unknown): boolean {
  return error instanceof Error && error.message === "cancelled";
}

function markCancelledDownload(cancellationToken: CancellationToken) {
  cancelledDownloadTokens.add(cancellationToken);
  pendingCancelledDownloadErrorCount += 1;
}

function shouldIgnoreCancelledDownloadError(error: unknown): boolean {
  if (pendingCancelledDownloadErrorCount <= 0 || !isDownloadCancellationError(error)) {
    return false;
  }

  pendingCancelledDownloadErrorCount -= 1;
  return true;
}

function handleAutoUpdateFailure(error: unknown, source: string) {
  const message = error instanceof Error ? error.message : String(error);
  const failedDownload =
    menuState.kind === "download-progress"
      ? {
          version: downloadingUpdateVersion ?? menuState.version,
          releaseNotes: downloadingUpdateReleaseNotes ?? menuState.releaseNotes ?? null,
          channel: downloadingUpdateChannel ?? menuState.channel ?? availableUpdateChannel,
        }
      : downloadCancellationToken && downloadingUpdateVersion
        ? {
            version: downloadingUpdateVersion,
            releaseNotes: downloadingUpdateReleaseNotes ?? null,
            channel: downloadingUpdateChannel ?? availableUpdateChannel,
          }
        : null;
  if (
    menuState.kind === "update-downloaded" &&
    readyUpdateVersion &&
    isDevSquirrelReadyError(error)
  ) {
    // Even in dev verification against the real test-env manifest, macOS Squirrel can still emit
    // a code=2 staging error after update-downloaded. Production must clear the failed ready,
    // but dev keeps ready to exercise the restart-to-update flow end to end.
    logger.warn(
      `[auto-update] ignore dev Squirrel ready error after ${source} version=${readyUpdateVersion}: ${message}`,
    );
    setAutoUpdaterMenuState(buildUpdateDownloadedState(readyUpdateVersion));
    return;
  }

  logger.error(`[auto-update] ${source}:`, error);
  if (
    source.endsWith("check failed") &&
    hasVisibleUpdateTarget(menuState) &&
    !activeForceAutoUpdateListener
  ) {
    notifyForceAutoUpdate({ kind: "error", message });
    sendManualCheckResult({ kind: "error", message });
    return;
  }
  if (menuState.kind === "update-downloaded" && readyUpdateVersion) {
    const failedReadyVersion = readyUpdateVersion;
    // macOS Squirrel can discover a stage failure only after update-downloaded.
    // Keeping the ready cache would leave restart-to-update shown forever, with retries hitting a dead install context.
    clearReadyUpdateState();
    clearPersistedPostUpdateReleaseNotesForVersion(
      failedReadyVersion,
      `${source}-after-ready-error`,
    );
    logger.info(`[auto-update] cleared ready update after ${source} version=${failedReadyVersion}`);
  }
  clearAvailableUpdateState();
  clearDownloadingUpdateState();
  if (failedDownload?.version && !readyUpdateVersion && !activeForceAutoUpdateListener) {
    // Fix: when download start or staging fails right after the user clicks "download update",
    // the old logic cleared available/downloading and broadcast idle, making the renderer entry
    // and dialog vanish together.
    // A failure is not a version skip; fall back to update-available so the user can see and retry.
    availableUpdateReleaseNotes = failedDownload.releaseNotes;
    availableUpdateChannel = failedDownload.channel;
    setAutoUpdaterMenuState(
      buildUpdateAvailableState(
        failedDownload.version,
        failedDownload.releaseNotes,
        failedDownload.channel,
      ),
    );
  } else {
    setAutoUpdaterMenuState(
      readyUpdateVersion
        ? buildUpdateDownloadedState(readyUpdateVersion)
        : { kind: "idle", enabled: true },
    );
  }
  notifyForceAutoUpdate({ kind: "error", message });
  sendManualCheckResult({ kind: "error", message });
  // A download failure is also a download end, via Promise reject or error event alike.
  // Re-check immediately when no forced update is in flight so a weak-network failure cannot
  // hide a newer version. The failure may land inside startup-check result handling: record the
  // reason and re-check once that check settles.
  if (failedDownload && !activeForceAutoUpdateListener) {
    recheckAfterDownload?.("download-failed");
  }
}

async function isSkippedUpdateVersion(
  version: string,
  channel: ElectronReleaseChannel,
  settingService: SettingServiceLike | undefined,
): Promise<boolean> {
  if (!settingService || activeForceAutoUpdateListener) {
    return false;
  }

  // A manual check means the user cares about a skipped version again.
  // Even before the persisted cleanup lands, this pass must not keep hiding the same-version update as up-to-date.
  if (manualCheckWebContentsId != null) {
    return false;
  }

  try {
    const settings = await settingService.get();
    return settings.skippedElectronUpdateVersions?.[channel]?.trim() === version.trim();
  } catch (error) {
    logger.warn("[auto-update] read skipped update version failed:", error);
    return false;
  }
}

async function shouldAutoDownloadAndInstallUpdates(
  settingService: SettingServiceLike | undefined,
): Promise<boolean> {
  if (!settingService) {
    return false;
  }

  try {
    return (await settingService.get()).autoDownloadAndInstallUpdates === true;
  } catch (error) {
    logger.warn("[auto-update] read auto download preference failed:", error);
    return false;
  }
}

export async function skipAvailableUpdateVersion(
  version: string,
  settingService: SettingServiceLike | undefined,
): Promise<void> {
  if (activeForceAutoUpdateListener) {
    logger.info(`[auto-update] ignore skip version=${version}: force update active`);
    return;
  }

  if (
    (menuState.kind !== "update-available" && menuState.kind !== "download-progress") ||
    menuState.version !== version
  ) {
    logger.info(`[auto-update] ignore skip version=${version}: state=${menuState.kind}`);
    return;
  }

  const channel =
    menuState.channel ??
    (menuState.kind === "download-progress" ? downloadingUpdateChannel : availableUpdateChannel) ??
    availableUpdateChannel;
  if (downloadCancellationToken) {
    markCancelledDownload(downloadCancellationToken);
    downloadCancellationToken.cancel();
    logger.info(
      `[auto-update] skipped downloading version; cancel active download channel=${channel} version=${version}`,
    );
  }

  // The downloading dialog must still allow skipping the current version.
  // If main accepted only update-available, skip-this-version clicks in that state would no-op;
  // cancel the active download and clear downloading state before persisting the skip.
  clearAvailableUpdateState();
  clearDownloadingUpdateState();
  setAutoUpdaterMenuState(
    readyUpdateVersion
      ? buildUpdateDownloadedState(readyUpdateVersion)
      : { kind: "idle", enabled: true },
  );

  if (!settingService) {
    logger.warn(
      `[auto-update] skipped version not persisted because setting service is missing version=${version}`,
    );
    return;
  }

  try {
    const settings = await settingService.get();
    await settingService.update({
      skippedElectronUpdateVersions: {
        ...settings.skippedElectronUpdateVersions,
        [channel]: version,
      },
    });
    logger.info(`[auto-update] skipped version persisted channel=${channel} version=${version}`);
  } catch (error) {
    logger.error("[auto-update] persist skipped update version failed:", error);
  }
}

async function clearSkippedUpdateVersionForManualCheck(
  channel: ElectronReleaseChannel,
  settingService: SettingServiceLike | undefined,
): Promise<void> {
  if (!settingService) {
    return;
  }

  try {
    const settings = await settingService.get();
    const skippedVersions = settings.skippedElectronUpdateVersions;
    const skippedVersion = skippedVersions?.[channel]?.trim();
    if (!skippedVersion) {
      return;
    }

    const nextSkippedVersions = { ...skippedVersions };
    delete nextSkippedVersions[channel];
    await settingService.update({
      skippedElectronUpdateVersions: nextSkippedVersions,
    });
    logger.info(
      `[auto-update] manual check cleared skipped update channel=${channel} version=${skippedVersion}`,
    );
  } catch (error) {
    logger.warn("[auto-update] clear skipped update version failed:", error);
  }
}

export function downloadAvailableUpdate(reason = "renderer") {
  if (!canUseAutoUpdaterInCurrentRuntime()) {
    logger.info(`[auto-update] skip ${reason} download: not packaged`);
    return;
  }

  if (menuState.kind === "update-downloaded") {
    logger.info(`[auto-update] skip ${reason} download: update already ready`);
    return;
  }

  if (menuState.kind === "download-progress") {
    logger.info(`[auto-update] skip ${reason} download: download already in progress`);
    return;
  }

  if (downloadCancellationToken) {
    logger.info(`[auto-update] skip ${reason} download: download already requested`);
    return;
  }

  if (menuState.kind !== "update-available") {
    logger.info(`[auto-update] skip ${reason} download: state=${menuState.kind}`);
    return;
  }

  downloadingUpdateVersion = menuState.version;
  downloadingUpdateReleaseNotes = menuState.releaseNotes ?? availableUpdateReleaseNotes;
  downloadingUpdateChannel = menuState.channel ?? availableUpdateChannel;
  // On a local cached package, electron-updater fires update-downloaded inside downloadUpdate() directly.
  // Do not broadcast a 0% downloading state first, or the UI shows downloading then jumps to downloaded;
  // the real downloading state is driven by the first download-progress event.
  notifyForceAutoUpdate({
    kind: "downloading",
    version: downloadingUpdateVersion,
    progress: "0",
  });

  const cancellationToken = new CancellationToken();
  downloadCancellationToken = cancellationToken;
  void autoUpdater
    .downloadUpdate(cancellationToken)
    .catch((error) => {
      if (isCancelledDownload(cancellationToken, error)) {
        logger.info(`[auto-update] ${reason} download cancelled`);
        return;
      }
      // Downloads start via explicit user click or force-update gate; a rejected promise must feed back immediately.
      // Never rely on a later error event from electron-updater, or the UI sticks in downloading.
      handleAutoUpdateFailure(error, "download update failed");
    })
    .finally(() => {
      if (downloadCancellationToken === cancellationToken) {
        downloadCancellationToken = null;
      }
      cancellationToken.dispose();
    });
}

export function cancelDownloadingUpdate(reason = "renderer") {
  if (activeForceAutoUpdateListener) {
    logger.info(`[auto-update] skip ${reason} cancel download: force update active`);
    return;
  }

  if (menuState.kind !== "download-progress" || !downloadCancellationToken) {
    logger.info(`[auto-update] skip ${reason} cancel download: state=${menuState.kind}`);
    return;
  }

  const version = downloadingUpdateVersion;
  const releaseNotes = downloadingUpdateReleaseNotes;
  const channel = downloadingUpdateChannel ?? availableUpdateChannel;
  const cancellationToken = downloadCancellationToken;
  markCancelledDownload(cancellationToken);
  cancellationToken.cancel();
  logger.info(
    `[auto-update] ${reason}: cancel download channel=${channel} version=${version ?? "unknown"}`,
  );

  // Cancelling is not skipping: fall back to update-available, keeping the manifest so the user can retry later.
  clearDownloadingUpdateState();
  if (version) {
    availableUpdateReleaseNotes = releaseNotes;
    availableUpdateChannel = channel;
    setAutoUpdaterMenuState(buildUpdateAvailableState(version, releaseNotes, channel));
    recheckAfterDownload?.("download-finished");
    return;
  }

  setAutoUpdaterMenuState(
    readyUpdateVersion
      ? buildUpdateDownloadedState(readyUpdateVersion)
      : { kind: "idle", enabled: true },
  );
}

export function setAutoUpdaterMenuLocale(locale: Locale) {
  menuLocale = locale;

  // The check-for-updates menu item is rewritten repeatedly by the updater's async state flow.
  // Translating once at menu build time would regress to English during checking/downloading.
  // Persist locale plus updater state so every menu rebuild or language switch rerenders from the latest state.
  syncMenuItemState();
}

export async function hydratePendingPostUpdateReleaseNotes(settingService: SettingServiceLike) {
  const settings = await settingService.get();
  pendingPostUpdateReleaseNotes = settings.pendingPostUpdateReleaseNotes ?? null;
  deliveredPostUpdateReleaseNotesWebContentsId = null;

  if (pendingPostUpdateReleaseNotes) {
    logger.info(
      `[auto-update] hydrated pending post-update release notes version=${pendingPostUpdateReleaseNotes.version}`,
    );
  }

  if (
    pendingPostUpdateReleaseNotes &&
    shouldDiscardStalePendingReleaseNotes(
      pendingPostUpdateReleaseNotes.version,
      getCurrentAppVersionForUpdate(),
    )
  ) {
    logger.info(
      `[auto-update] discard stale post-update release notes pending=${pendingPostUpdateReleaseNotes.version} app=${getCurrentAppVersionForUpdate()}`,
    );
    await clearPendingPostUpdateReleaseNotes(
      settingService,
      "hydrate-pending-older-than-installed-app",
    );
  }

  if (
    pendingPostUpdateReleaseNotes &&
    isPendingReleaseNotesForFutureVersion(pendingPostUpdateReleaseNotes)
  ) {
    // Restarting after download-but-before-install loses electron-updater's in-memory ready state;
    // the pending package and release notes remain. Restore pending-install when pending version outranks current,
    // so a cached package no longer prompts download only to fall back to idle on a dev staging error.
    readyUpdateVersion = pendingPostUpdateReleaseNotes.version;
    readyUpdateReleaseNotes = pendingPostUpdateReleaseNotes;
    readyUpdateRestoredFromPendingReleaseNotes = true;
    setAutoUpdaterMenuState(buildUpdateDownloadedState(readyUpdateVersion));
    logger.info(
      `[auto-update] restored ready update from pending release notes version=${readyUpdateVersion}`,
    );
  }
}

export function syncReadyUpdateToWindow(win: BrowserWindow) {
  if (!readyUpdateVersion || win.isDestroyed()) {
    return;
  }

  // update-downloaded can fire before the renderer's React effects mount,
  // or even before a window reload or a new window. Treat already-installable-update as persistent state and
  // re-emit once the window is ready, so the button never depends on that one transient event.
  logger.info(
    `[auto-update] sync ready update to window ${win.webContents.id}: ${readyUpdateVersion}`,
  );
  win.webContents.send(PlatformChannels.UpdateReady, readyUpdateVersion);
}

export function getAutoUpdaterState(): UpdateStatePayload {
  return menuState;
}

export function refreshAutoUpdaterReleaseChannel(
  receivePreviewUpdates: boolean,
  reason = "settings receivePreviewUpdates changed",
) {
  const nextChannel: ElectronReleaseChannel = receivePreviewUpdates ? "preview" : "stable";

  if (!canUseAutoUpdaterInCurrentRuntime()) {
    logger.info(`[auto-update] skip ${reason}: not packaged`);
    return;
  }

  if (menuState.kind === "download-progress" || menuState.kind === "update-downloaded") {
    logger.info(`[auto-update] skip ${reason}: state=${menuState.kind} channel=${nextChannel}`);
    return;
  }

  if (checkForUpdatesInFlight) {
    // The user may flip the preview switch while the startup check is still in flight.
    // Changing availableUpdateChannel immediately would let the old response label its versions with the new channel;
    // record the pending channel and refetch the manifest once the current check settles.
    pendingManifestReleaseChannelRefresh = nextChannel;
    logger.info(
      `[auto-update] defer ${reason}: check already in flight, next channel=${nextChannel}`,
    );
    return;
  }

  const currentChannel = getAutoUpdaterReleaseChannelForCurrentState();
  if (currentChannel === nextChannel) {
    logger.info(`[auto-update] skip ${reason}: channel unchanged (${nextChannel})`);
    return;
  }

  logger.info(
    `[auto-update] ${reason}: refresh manifest channel ${currentChannel} -> ${nextChannel}`,
  );
  availableUpdateChannel = nextChannel;
  clearAvailableUpdateState();
  setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  const checkId = beginAutoUpdateCheck();
  autoUpdater
    .checkForUpdates()
    .catch((err) => {
      logger.error(`[auto-update] ${reason} check failed:`, err);
      setAutoUpdaterMenuState(
        readyUpdateVersion
          ? buildUpdateDownloadedState(readyUpdateVersion)
          : { kind: "idle", enabled: true },
      );
    })
    .finally(() => {
      finishAutoUpdateCheck(reason, checkId);
    });
}

export function syncAutoUpdaterStateToWindow(win: BrowserWindow) {
  if (win.isDestroyed()) {
    return;
  }

  win.webContents.send(PlatformChannels.UpdateStateChanged, menuState);
}

export function syncPostUpdateReleaseNotesToWindow(win: BrowserWindow) {
  if (!pendingPostUpdateReleaseNotes || win.isDestroyed()) {
    return;
  }

  if (isPendingReleaseNotesForFutureVersion(pendingPostUpdateReleaseNotes)) {
    // Pending release notes are written at download-complete; while that version still outranks the app,
    // the update is not installed yet, so they must not be silently acked to the renderer as post-install notes.
    return;
  }

  const assignedWindow = findLiveWindowByWebContentsId(
    deliveredPostUpdateReleaseNotesWebContentsId,
  );
  if (assignedWindow && assignedWindow.webContents.id !== win.webContents.id) {
    return;
  }

  deliveredPostUpdateReleaseNotesWebContentsId = win.webContents.id;
  logger.info(
    `[auto-update] sync post-update release notes to window ${win.webContents.id}: ${pendingPostUpdateReleaseNotes.version}`,
  );
  win.webContents.send(PlatformChannels.PostUpdateReleaseNotes, pendingPostUpdateReleaseNotes);
}

export async function acknowledgePostUpdateReleaseNotes(
  version: string,
  settingService: SettingServiceLike,
) {
  if (!pendingPostUpdateReleaseNotes) {
    logger.info(
      `[auto-update] ignore release notes ack without pending payload version=${version}`,
    );
    return;
  }

  if (pendingPostUpdateReleaseNotes.version !== version) {
    logger.warn(
      `[auto-update] ignore release notes ack version mismatch expected=${pendingPostUpdateReleaseNotes.version} actual=${version}`,
    );
    return;
  }

  acknowledgedPostUpdateReleaseNotesVersions.add(version);
  await clearPendingPostUpdateReleaseNotes(settingService, "renderer-acknowledged");
}

export async function initAutoUpdater(options: InitAutoUpdaterOptions = {}): Promise<void> {
  if (options.enabled === false) {
    autoUpdaterDisabledForProductFlavor = true;
    if (autoUpdatePollTimer) {
      clearInterval(autoUpdatePollTimer);
      autoUpdatePollTimer = null;
    }
    logger.info("[auto-update] disabled for this desktop product flavor");
    return;
  }
  autoUpdaterDisabledForProductFlavor = false;
  if (!canUseAutoUpdaterInCurrentRuntime()) return;

  onBeforeQuitAndInstall = options.onBeforeQuitAndInstall;
  if (options.locale) {
    menuLocale = options.locale;
  }
  autoUpdaterSettingService = options.settingService;

  if (autoUpdatePollTimer) {
    clearInterval(autoUpdatePollTimer);
    autoUpdatePollTimer = null;
  }
  checkForUpdatesInFlight = false;
  activeAutoUpdateCheckId = null;
  activeAutoUpdateCheckChannel = null;
  settlingAutoUpdateCheckId = null;
  pendingManifestReleaseChannelRefresh = null;
  devAutoUpdateVersionOverride = null;
  availableUpdateChannel = "stable";
  clearAvailableUpdateState();
  clearDownloadingUpdateState();
  applyDevAutoUpdateRuntimeOverrides();

  logger.info(`[auto-update] initializing, current version: ${getCurrentAppVersionForUpdate()}`);

  // Once an older version is downloaded and the feed moves higher, main must compare the remote version against the ready version
  // before downloading. Left to itself, electron-updater judges only against the running app version,
  // so with 3.1.2 ready and 3.1.3 released, every poll could re-download 3.1.3.
  autoUpdater.autoDownload = false;
  // Bugfix: Windows/NSIS starts the installer asynchronously after window close; an immediate
  // shutdown can interrupt it, leaving a half-updated state that breaks the next start. macOS and
  // Linux also drop install-on-quit: before-quit installs only while the ready package still
  // equals the current target, so a raised target never gets the old package.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = logger;
  applyManifestUpdateProvider(options);

  const triggerCheckForUpdates = (reason: string) => {
    if (checkForUpdatesInFlight) {
      logger.info(`[auto-update] skip ${reason}: check already in flight`);
      return;
    }

    // A displayed target must not be overwritten to checking by a re-check; while downloading, wait for the download to end before checking again.
    if (reason === "poll" && !canPollForUpdatesFromState(menuState)) {
      logger.info(`[auto-update] skip ${reason}: state=${menuState.kind}`);
      return;
    }

    const checkId = beginAutoUpdateCheck();
    const checkForUpdatesPromise = options.settingService
      ? (async () => {
          await syncAutoUpdateCheckChannelFromSettings(checkId, options.settingService, reason);
          await autoUpdater.checkForUpdates();
        })()
      : autoUpdater.checkForUpdates();

    checkForUpdatesPromise
      .catch((err) => {
        // The force-update dialog may reuse the startup background check; if checkForUpdates rejects with no later error event,
        // log-only handling would stick the dialog at checking. Reuse the failure-convergence path to restore state and notify force-update listeners.
        handleAutoUpdateFailure(err, `${reason} check failed`);
      })
      .finally(() => {
        finishAutoUpdateCheck(reason, checkId);
        ensureAutoUpdatePollInterval();
      });
  };
  recheckAfterDownload = (recheckReason: string) => {
    // Download failures wait for the current check to settle; completed/cancelled results are already subsumed by this check and do not queue.
    if (checkForUpdatesInFlight) {
      if (recheckReason === "download-failed") {
        pendingFailedDownloadRecheck = true;
      }
      return;
    }
    triggerCheckForUpdates(recheckReason);
  };

  autoUpdater.on("checking-for-update", () => {
    logger.info("[auto-update] checking for update...");
    if (hasVisibleUpdateTarget(menuState) || menuState.kind === "download-progress") {
      return;
    }
    setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  });

  autoUpdater.on("update-available", (info: UpdateDownloadedInfoLike) => {
    logger.info(`[auto-update] new version available: ${info.version}`);
    const infoChannel = readUpdateInfoReleaseChannel(info);
    if (shouldIgnoreStaleAvailableUpdate(infoChannel)) {
      // When the user toggles preview releases, the old channel's manifest response may land after the new one.
      // Letting the stale result write menuState or end the generation early keeps the standalone dialog on the old version/notes.
      logger.info(
        `[auto-update] ignore stale update channel=${infoChannel} expected=${activeAutoUpdateCheckChannel ?? availableUpdateChannel} version=${info.version}`,
      );
      return;
    }

    void settleAutoUpdateCheckResult("update available", async () => {
      if (!shouldDownloadAvailableUpdate(info.version)) {
        const readyVersion = readyUpdateVersion ?? info.version;
        logger.info(
          `[auto-update] keep downloaded update version=${readyVersion}; remote=${info.version}`,
        );
        setAutoUpdaterMenuState(buildUpdateDownloadedState(readyVersion));
        sendManualCheckResult({ kind: "ready", version: readyVersion });
        return;
      }

      const channel = infoChannel ?? availableUpdateChannel;
      if (await isSkippedUpdateVersion(info.version, channel, options.settingService)) {
        logger.info(
          `[auto-update] ignore skipped update channel=${channel} version=${info.version}`,
        );
        clearAvailableUpdateState();
        setAutoUpdaterMenuState({ kind: "idle", enabled: true });
        sendManualCheckResult({
          kind: "up-to-date",
          currentVersion: getCurrentAppVersionForUpdate(),
        });
        return;
      }

      availableUpdateReleaseNotes = toPostUpdateReleaseNotesPayload(info);
      if (readyUpdateRestoredFromPendingReleaseNotes) {
        // pendingPostUpdateReleaseNotes only proves release notes were once downloaded and persisted; it cannot restore
        // this process's electron-updater downloadedUpdateHelper, the Squirrel.Mac proxy server, or a native staged update.
        // When the manifest re-confirms the same version, clear the pseudo-ready and
        // downloadUpdate again so a cache-hit/fresh download rebuilds a real install context via update-downloaded.
        clearReadyUpdateState();
      }
      setAutoUpdaterMenuState(
        buildUpdateAvailableState(info.version, availableUpdateReleaseNotes, channel),
      );

      if (activeForceAutoUpdateListener) {
        downloadAvailableUpdate("force-update");
        return;
      }

      if (await shouldAutoDownloadAndInstallUpdates(options.settingService)) {
        // By design the auto-download preference lives in main's update state machine, independent of any renderer dialog.
        // Reuse the manual download path on update-found so cancel/cache-hit/failure-recovery behave identically.
        downloadAvailableUpdate("auto-download");
        return;
      }

      sendManualCheckResult({
        kind: "available",
        version: info.version,
        channel,
        ...(availableUpdateReleaseNotes ? { releaseNotes: availableUpdateReleaseNotes } : {}),
      });
    }).catch((error) => {
      handleAutoUpdateFailure(error, "update available failed");
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    void settleAutoUpdateCheckResult("update not available", () => {
      logger.info(
        `[auto-update] already up to date (local=${getCurrentAppVersionForUpdate()}, remote=${info.version})`,
      );
      if (readyUpdateVersion && isReadyUpdateCurrentTarget()) {
        setAutoUpdaterMenuState(buildUpdateDownloadedState(readyUpdateVersion));
        sendManualCheckResult({ kind: "ready", version: readyUpdateVersion });
        return;
      }
      if (hasVisibleUpdateTarget(menuState)) {
        sendManualCheckResult({
          kind: "available",
          version:
            menuState.kind === "update-available" ? menuState.version : (readyUpdateVersion ?? ""),
          ...(menuState.kind !== "checking" && menuState.channel
            ? { channel: menuState.channel }
            : {}),
        });
        return;
      }

      clearAvailableUpdateState();
      clearDownloadingUpdateState();
      setAutoUpdaterMenuState({ kind: "idle", enabled: true });
      // When the force-update dialog reuses the startup check, no-update must still close the loop instead of sticking at checking.
      notifyForceAutoUpdate({
        kind: "error",
        message: getForceAutoUpdateNoUpdateMessage(),
      });
      sendManualCheckResult({
        kind: "up-to-date",
        currentVersion: getCurrentAppVersionForUpdate(),
      });
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    // After a quick cancel, electron-updater may still emit progress from the old download stream.
    // Accepting those stale events pushes the UI from update-available back to downloading, looking stuck after cancel.
    if (!downloadCancellationToken || downloadCancellationToken.cancelled) {
      return;
    }

    if (menuState.kind !== "download-progress" && menuState.kind !== "update-available") {
      return;
    }

    const normalizedProgress = normalizeProgressPercent(progress) ?? progress.percent.toFixed(0);
    logger.info(
      `[auto-update] download progress: ${progress.percent.toFixed(1)}% (${(progress.bytesPerSecond / 1024).toFixed(0)} KB/s, ${(progress.transferred / 1024 / 1024).toFixed(1)}/${(progress.total / 1024 / 1024).toFixed(1)} MB)`,
    );
    if (menuState.kind === "update-available") {
      clearAvailableUpdateState();
    }
    setAutoUpdaterMenuState(
      buildDownloadProgressState(normalizedProgress, {
        transferredBytes: progress.transferred,
        totalBytes: progress.total,
      }),
    );
    logForceAutoUpdateProgress(normalizedProgress);
    notifyForceAutoUpdate({
      kind: "downloading",
      ...(downloadingUpdateVersion ? { version: downloadingUpdateVersion } : {}),
      progress: normalizedProgress,
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateDownloadedInfoLike) => {
    readyUpdateVersion = info.version;
    readyUpdateRestoredFromPendingReleaseNotes = false;
    readyUpdateChannel = downloadingUpdateChannel ?? availableUpdateChannel;
    readyUpdateReleaseNotes =
      toPostUpdateReleaseNotesPayload(info) ?? downloadingUpdateReleaseNotes;
    clearAvailableUpdateState();
    clearDownloadingUpdateState();
    logger.info(
      `[auto-update] downloaded: ${info.version}, ${process.platform === "win32" ? "waiting for explicit install" : "ready to install on quit or explicit install"}`,
    );
    setAutoUpdaterMenuState(buildUpdateDownloadedState(info.version));
    notifyForceAutoUpdate({ kind: "ready", version: info.version });
    if (!activeForceAutoUpdateListener) {
      recheckAfterDownload?.("download-finished");
    }

    if (activeForceAutoUpdateListener) {
      notifyForceAutoUpdate({ kind: "installing" });
      void quitAndInstallUpdate();
    }

    if (options.settingService) {
      const releaseNotesPayload = readyUpdateReleaseNotes;
      const persistTask = releaseNotesPayload
        ? persistPendingPostUpdateReleaseNotes(
            options.settingService,
            releaseNotesPayload,
            "update-downloaded",
          )
        : clearPendingPostUpdateReleaseNotes(
            options.settingService,
            "update-downloaded-without-release-notes",
          );

      void persistTask.catch((error) => {
        logger.error("[auto-update] persist post-update release notes failed:", error);
      });
    }

    for (const win of BrowserWindow.getAllWindows()) {
      syncReadyUpdateToWindow(win);
    }
  });

  autoUpdater.on("error", (err) => {
    if (shouldIgnoreCancelledDownloadError(err)) {
      // electron-updater may emit error("cancelled") asynchronously after the cancel.
      // The cancel already restored retryable update-available; a late cancelled event must not clear the entry again.
      logger.info("[auto-update] ignore delayed error from cancelled download");
      return;
    }

    void settleAutoUpdateCheckResult("error", () => {
      handleAutoUpdateFailure(err, "error");
    });
  });

  ipcMain.handle(PlatformChannels.QuitAndInstallUpdate, () =>
    // The renderer learns the installer did not take over only via IPC rejection. A stale ready or
    // failed shutdown prep must not ACK success, or restart-to-update pends forever.
    quitAndInstallUpdate(true),
  );
  ipcMain.on(PlatformChannels.QuitAndInstallUpdate, () => {
    void quitAndInstallUpdate();
  });
  ipcMain.handle(PlatformChannels.DownloadUpdate, () => {
    downloadAvailableUpdate("renderer");
  });
  ipcMain.handle(PlatformChannels.CancelUpdateDownload, () => {
    cancelDownloadingUpdate("renderer");
  });
  ipcMain.handle(PlatformChannels.SkipUpdateVersion, async (_event, version: unknown) => {
    const validatedVersion = typeof version === "string" ? version.trim() : "";
    if (!validatedVersion) {
      logger.warn("[auto-update] ignore empty skipped update version");
      return;
    }
    await skipAvailableUpdateVersion(validatedVersion, options.settingService);
  });

  triggerCheckForUpdates("startup");
  ensureAutoUpdatePollInterval();
  app.on("before-quit", (event) => {
    if (process.platform === "win32" || quitAndInstallInFlight || !isReadyUpdateCurrentTarget()) {
      return;
    }
    event.preventDefault();
    void quitAndInstallUpdate();
  });
}

function ensureAutoUpdatePollInterval() {
  if (menuState.kind === "download-progress") {
    if (autoUpdatePollTimer) {
      clearInterval(autoUpdatePollTimer);
      autoUpdatePollTimer = null;
      autoUpdatePollIntervalMs = null;
    }
    return;
  }
  const nextInterval = resolveAutoUpdatePollInterval(menuState);
  if (autoUpdatePollTimer && autoUpdatePollIntervalMs === nextInterval) {
    return;
  }
  if (autoUpdatePollTimer) {
    clearInterval(autoUpdatePollTimer);
  }
  autoUpdatePollIntervalMs = nextInterval;
  autoUpdatePollTimer = setInterval(() => {
    recheckAfterDownload?.("poll");
  }, nextInterval);
  autoUpdatePollTimer.unref?.();
}

export function requestForceAutoUpdate(
  onStateChange: (state: ForceAutoUpdateState) => void,
  reason = "force-update",
  _minimumVersion?: string,
) {
  const dispose = () => {
    if (activeForceAutoUpdateListener === onStateChange) {
      activeForceAutoUpdateListener = null;
    }
  };

  activeForceAutoUpdateListener = onStateChange;
  forceAutoUpdateLastLoggedProgressBucket = null;
  logger.info(`[force-update] auto-update starting reason=${reason}`);
  onStateChange({ kind: "checking" });

  if (!canUseAutoUpdaterInCurrentRuntime()) {
    const message = "not packaged";
    logger.info(`[force-update] auto-update skipped: ${message}`);
    onStateChange({ kind: "dev-skipped", message });
    return dispose;
  }

  if (menuState.kind === "update-downloaded") {
    onStateChange({ kind: "installing" });
    void quitAndInstallUpdate();
    return dispose;
  }

  if (menuState.kind === "update-available") {
    downloadAvailableUpdate("force-update");
    return dispose;
  }

  if (menuState.kind === "download-progress") {
    onStateChange({
      kind: "downloading",
      ...("version" in menuState && menuState.version ? { version: menuState.version } : {}),
      progress: menuState.progress,
    });
    return dispose;
  }

  if (checkForUpdatesInFlight) {
    logger.info(`[force-update] auto-update reusing in-flight update check`);
    return dispose;
  }

  const checkId = beginAutoUpdateCheck();
  setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  autoUpdater
    .checkForUpdates()
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[auto-update] ${reason} check failed:`, err);
      setAutoUpdaterMenuState(
        readyUpdateVersion
          ? buildUpdateDownloadedState(readyUpdateVersion)
          : { kind: "idle", enabled: true },
      );
      onStateChange({ kind: "error", message });
    })
    .finally(() => {
      finishAutoUpdateCheck(reason, checkId);
    });

  return () => {
    if (activeForceAutoUpdateListener === onStateChange) {
      activeForceAutoUpdateListener = null;
    }
  };
}

export function requestAutoUpdateCheckWithoutWindow(reason = "force-update") {
  logger.info(`[auto-update] ${reason}: user requested update check without renderer window`);

  if (!canUseAutoUpdaterInCurrentRuntime()) {
    logger.info(`[auto-update] skip ${reason}: not packaged`);
    return;
  }

  if (menuState.kind === "update-downloaded") {
    void quitAndInstallUpdate();
    return;
  }
  if (menuState.kind === "update-available") {
    downloadAvailableUpdate(reason);
    return;
  }
  if (menuState.kind === "download-progress") {
    logger.info(`[auto-update] skip ${reason}: update already ${menuState.kind}`);
    return;
  }
  if (checkForUpdatesInFlight) {
    logger.info(`[auto-update] skip ${reason}: check already in flight`);
    return;
  }

  const checkId = beginAutoUpdateCheck();
  setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  autoUpdater
    .checkForUpdates()
    .catch((err) => {
      logger.error(`[auto-update] ${reason} check failed:`, err);
      setAutoUpdaterMenuState(
        readyUpdateVersion
          ? buildUpdateDownloadedState(readyUpdateVersion)
          : { kind: "idle", enabled: true },
      );
    })
    .finally(() => {
      finishAutoUpdateCheck(reason, checkId);
    });
}

export function checkForUpdateMenuClick(originWindow?: BrowserWindow | null) {
  logger.info("[auto-update] user clicked Check for Updates");

  const targetWindow =
    originWindow && !originWindow.isDestroyed()
      ? originWindow
      : (BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ??
        null);

  if (!targetWindow) {
    logger.warn("[auto-update] manual check: no target window to report to");
    return;
  }

  if (!canUseAutoUpdaterInCurrentRuntime()) {
    logger.info("[auto-update] skip manual check: not packaged");
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "dev-skipped",
    } satisfies UpdateCheckResultPayload);
    return;
  }

  if (autoUpdaterDisabledForProductFlavor) {
    // The entry should already be hidden by product identity; this is the last gate keeping an uninitialized updater off the placeholder feed.
    logger.info("[auto-update] skip manual check: updater disabled for this product flavor");
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "dev-skipped",
    } satisfies UpdateCheckResultPayload);
    return;
  }

  if (menuState.kind === "update-downloaded" && isReadyUpdateCurrentTarget()) {
    // Menu copy already says "restart to update". Install only while the ready package still
    // equals the current target; a raised target falls through to the re-check below, never
    // installing a stale package.
    void quitAndInstallUpdate();
    return;
  }
  if (menuState.kind === "download-progress") {
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "already-downloading",
      version: downloadingUpdateVersion ?? readyUpdateVersion ?? "",
      progress: menuState.progress,
    } satisfies UpdateCheckResultPayload);
    return;
  }
  if (checkForUpdatesInFlight) {
    logger.info("[auto-update] skip manual check: check already in flight");
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "error",
      message: "Update check already in progress.",
    } satisfies UpdateCheckResultPayload);
    return;
  }

  manualCheckWebContentsId = targetWindow.webContents.id;
  const manualCheckChannel = getAutoUpdaterReleaseChannelForCurrentState();
  // Keep showing the discovered version until the check result replaces it, so the menu does not
  // flash "checking" first.
  if (!hasVisibleUpdateTarget(menuState)) {
    setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  }
  const checkId = beginAutoUpdateCheck();
  void (async () => {
    await clearSkippedUpdateVersionForManualCheck(manualCheckChannel, autoUpdaterSettingService);
    await autoUpdater.checkForUpdates();
  })()
    .catch((err) => {
      logger.error("[auto-update] manual check failed:", err);
      sendManualCheckResult({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      finishAutoUpdateCheck("manual check", checkId);
    });
}
