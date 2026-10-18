/* eslint-disable max-lines -- permission channel registration, the drag panel, and foreground-return waits share one main-process session state */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, BrowserWindow, ipcMain, nativeImage, screen } from "electron";
import { PlatformChannels, type CuaPermissionKind, type Locale } from "@zcode/shared";
import {
  cuaHelperBundleFingerprintUnchanged,
  openCuaPermissionOnboarding,
  prepareCuaHelperPermissionDrag,
} from "./cuaAccessibilitySettings.js";
import {
  createCuaPermissionDragPanel,
  createRealCuaPermissionPanelWindow,
  type CuaPermissionDragPanel,
} from "./cuaPermissionDragPanel.js";
import { createSystemSettingsWindowWatcher } from "./cuaSystemSettingsWindowWatcher.js";

const execFileAsync = promisify(execFile);
const MACOS_SYSTEM_SETTINGS_BUNDLE_ID = "com.apple.systempreferences";
// 1x1 transparent PNG. startDrag requires a non-empty icon on macOS (electron.d.ts: "The image must be non-empty
// on macOS"). Last-resort when even the packaged ZCode icon is unreadable, or startDrag throws and dragging dies.
const CUA_HELPER_DRAG_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
/** Drag cursor and panel tile both use 64pt to avoid a huge cursor bitmap. */
const CUA_DRAG_ICON_SIZE = 64;

/**
 * ZCode icon shared by the drag cursor and panel tile (module-level cache; no disk read per drag).
 *
 * Do not use `nativeImage.createFromNamedImage("NSApplicationIcon")`: that returns the **current host app** icon.
 * In dev the host is Electron.app, so drags would show the default Electron icon.
 * Read the packaged ZCode icon explicitly instead (electron-builder ships build/icon.png as resources/icon.png).
 */
let cachedZCodeIcon: Electron.NativeImage | null = null;

function resolveZCodeIcon(): Electron.NativeImage {
  if (cachedZCodeIcon && !cachedZCodeIcon.isEmpty()) return cachedZCodeIcon;
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(import.meta.dirname, "..", "..", "build", "icon.png");
  const image = nativeImage.createFromPath(iconPath);
  cachedZCodeIcon = image.isEmpty()
    ? nativeImage.createFromDataURL(CUA_HELPER_DRAG_ICON_DATA_URL)
    : image;
  return cachedZCodeIcon;
}

interface CuaApplicationReturnOptions {
  openSettings: () => Promise<void>;
  timeoutMs: number;
  signal: AbortSignal;
  resolveFrontmostBundleId?: () => Promise<string | null>;
}

async function resolveFrontmostBundleId(): Promise<string | null> {
  const { stdout: front } = await execFileAsync("/usr/bin/lsappinfo", ["front"], {
    encoding: "utf8",
    timeout: 2_000,
  });
  const asn = front.trim();
  if (!asn) return null;
  const { stdout: info } = await execFileAsync(
    "/usr/bin/lsappinfo",
    ["info", "-only", "bundleid", asn],
    { encoding: "utf8", timeout: 2_000 },
  );
  return info.match(/"CFBundleIdentifier"="([^"]+)"/)?.[1] ?? null;
}

/**
 * Listen to app-level window signals from Electron main, not the origin renderer's DOM focus. A drag started in window A
 * and resumed in window B must still advance A's original IPC. Listeners attach before openExternal, closing every race window.
 */
function waitForCuaApplicationReturn({
  openSettings,
  timeoutMs,
  signal,
  resolveFrontmostBundleId: readFrontmostBundleId = resolveFrontmostBundleId,
}: CuaApplicationReturnOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let settingsOpened = false;
    // A LaunchServices query is two subprocess round-trips; it can read Settings' ASN yet return the bundle id
    // after ZCode's focus edge. Monotonic sequence numbers pair probe-start/during blur with the
    // subsequent focus, keeping real returns while never reviving stale BrowserWindow.isFocused() snapshots.
    let applicationEventSequence = 0;
    let latestBlurSequence = 0;
    let latestZCodeReturnSequence = 0;
    let observedSystemSettingsAfterSequence: number | null = null;
    let activeInspections = 0;
    let inspectionTimer: ReturnType<typeof setTimeout> | undefined;
    let observationTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (observationTimer) clearTimeout(observationTimer);
      if (inspectionTimer) clearTimeout(inspectionTimer);
      app.removeListener("browser-window-blur", onBlur);
      app.removeListener("browser-window-focus", onFocus);
      app.removeListener("activate", onFocus);
      app.removeListener("before-quit", onQuit);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const maybeFinishReturn = () => {
      if (
        settingsOpened &&
        observedSystemSettingsAfterSequence !== null &&
        latestZCodeReturnSequence > observedSystemSettingsAfterSequence
      )
        finish();
    };
    const scheduleInspection = () => {
      if (settled || activeInspections > 0 || observedSystemSettingsAfterSequence !== null) return;
      if (inspectionTimer) clearTimeout(inspectionTimer);
      inspectionTimer = setTimeout(inspectFrontmost, 150);
    };
    const inspectFrontmost = (forceAtEventBoundary = false) => {
      if (
        settled ||
        observedSystemSettingsAfterSequence !== null ||
        (!forceAtEventBoundary && activeInspections > 0)
      )
        return;
      if (inspectionTimer) {
        clearTimeout(inspectionTimer);
        inspectionTimer = undefined;
      }
      const inspectionStartedAtSequence = applicationEventSequence;
      // Only sampling started while the last app event is blur and no return focus is seen yet,
      // counts as evidence for this System Settings round-trip. A query triggered by the return focus itself, even if it later
      // reads a stale Settings value from LaunchServices, must not pair with that same focus or clear the timeout.
      const inspectionStartedWhileAway = latestBlurSequence > latestZCodeReturnSequence;
      activeInspections += 1;
      void readFrontmostBundleId().then(
        (bundleId) => {
          activeInspections -= 1;
          if (settled) return;
          if (
            bundleId === MACOS_SYSTEM_SETTINGS_BUNDLE_ID &&
            inspectionStartedWhileAway &&
            inspectionStartedAtSequence >= latestBlurSequence
          ) {
            // A blur received during this query must also precede the acceptable ZCode
            // return edge; this excludes an older focus from switching windows inside ZCode before Settings opened.
            // LaunchServices results can land before Electron delivers blur. If a pre-open probe reads
            // Settings while a ZCode focus/activate just preceded the probe, treating that old focus as the return misfires.
            // Probes must start after the latest blur and before the return focus: checking ever-blurred alone still borrows
            // an older internal-switch blur, and a probe started after focus can read stale LaunchServices data and clear
            // the timeout forever. Ignore both; the blur-bound/away-interval probes decide.
            observedSystemSettingsAfterSequence = Math.max(
              inspectionStartedAtSequence,
              latestBlurSequence,
            );
            // The old timer mistook the machine-level is-Settings-open SLA for a user deadline. Once Settings is
            // is confirmed foreground, clear it immediately; however long the user stays, return/restart survives, ended only by explicit lifecycle signals.
            if (observationTimer) {
              clearTimeout(observationTimer);
              observationTimer = undefined;
            }
            maybeFinishReturn();
            return;
          }
          scheduleInspection();
        },
        () => {
          activeInspections -= 1;
          scheduleInspection();
        },
      );
    };
    const onBlur = () => {
      latestBlurSequence = ++applicationEventSequence;
      // A pre-open lsappinfo query may already have sampled ZCode but stall on the second info subprocess.
      // Reusing the global single-flight blinds us to a fast Settings open/return round-trip. The blur edge
      // must force a time-bound parallel sample; the regular 150ms poll stays single-flight, so concurrency stays bounded.
      inspectFrontmost(true);
    };
    const onFocus = () => {
      // After System Settings fronts, BrowserWindow.isFocused() can briefly keep a stale true.
      // Reading that snapshot at probe completion misreads just-opened-Settings as user-returned.
      // focus/activate records the sequence first; if the matching Settings probe is still in flight, its late return
      // still proves the later edge via the inspection-start snapshot. Edges may also precede openExternal resolution.
      latestZCodeReturnSequence = ++applicationEventSequence;
      inspectFrontmost();
      maybeFinishReturn();
    };
    const onQuit = () => finish(new Error("ZCode quit during CUA permission onboarding"));
    const onAbort = () =>
      finish(signal.reason ?? new Error("CUA permission onboarding origin window closed"));
    observationTimer = setTimeout(
      () =>
        finish(
          new Error(`System Settings did not return to ZCode within ${Math.max(1, timeoutMs)}ms`),
        ),
      Math.max(1, timeoutMs),
    );

    app.on("browser-window-blur", onBlur);
    app.on("browser-window-focus", onFocus);
    app.on("activate", onFocus);
    app.on("before-quit", onQuit);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    // All listeners attach before openExternal; from here on, poll LaunchServices for the real frontmost app.
    // Only an observed System Settings lets a later ZCode focus advance, keeping internal window switches unmisjudged.
    inspectFrontmost();
    void openSettings().then(
      () => {
        settingsOpened = true;
        maybeFinishReturn();
      },
      (error) => finish(error),
    );
  });
}

function normalizePermissionList(value: unknown): CuaPermissionKind[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const set = new Set<CuaPermissionKind>();
  for (const permission of value) {
    if (permission === "accessibility" || permission === "screen_recording") {
      set.add(permission);
    }
  }
  return [...set];
}

function normalizeOnboardingOperationId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128 ? normalized : null;
}

/**
 * Creates the panel for one onboarding session (snap data source included).
 *
 * When the watcher has no bounds (binary missing, no-swiftc build, Settings closed, process crash)
 * `getSettingsBounds` returns null and the positioner fail-opens, centering the panel at the screen bottom.
 * Snapping is cosmetic and must never be a usability precondition of onboarding.
 */
function createDragPanelForSession(
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
  getLocale: () => Locale,
): CuaPermissionDragPanel {
  const watcher = createSystemSettingsWindowWatcher({
    binaryPath: resolveWindowBoundsBinaryPath(),
    logger,
  });
  watcher.start();

  return createCuaPermissionDragPanel({
    createWindow: createRealCuaPermissionPanelWindow({
      BrowserWindow,
      app,
      preloadPath: join(import.meta.dirname, "../preload/cuaPermissionPanel.cjs"),
      rendererDir: join(import.meta.dirname, "../renderer"),
      rendererDevUrl: process.env["ELECTRON_RENDERER_URL"],
    }),
    getDisplayWorkArea: () => screen.getPrimaryDisplay().workArea,
    getSettingsBounds: () => watcher.latest(),
    stopSettingsBounds: () => watcher.stop(),
    getLocale,
    // The tile uses the real ZCode icon to match the row in System Settings' permission list, letting users
    // the dragged thing with the listed entry.
    getIconDataUrl: () =>
      resolveZCodeIcon()
        .resize({ width: CUA_DRAG_ICON_SIZE, height: CUA_DRAG_ICON_SIZE })
        .toDataURL(),
    logger,
  });
}

/** Production uses extraResources inside the signed package; dev uses the checkout build output. */
function resolveWindowBoundsBinaryPath(): string {
  const relative = join("macos-window-bounds", "zcode-window-bounds");
  return app.isPackaged
    ? join(process.resourcesPath, relative)
    : join(import.meta.dirname, "..", "..", "resources", relative);
}

export function registerCuaPermissionIpcHandlers(options: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  currentApplicationLocale: () => Locale;
}) {
  // operationId is valid only within one webContents id namespace, so another renderer cannot guess an id and cancel
  // a participant that is not theirs. invoke always deletes on terminal state; destroyed still falls back to the signal path.
  const onboardingControllers = new Map<string, AbortController>();
  const operationKey = (senderId: number, operationId: string) => `${senderId}\0${operationId}`;

  // Verified Helper.app path plus byte-fingerprint cache. Native file drags must call event.sender.startDrag()
  // synchronously inside the dragstart chain; async install/verify would miss the OS gesture window and the user
  // could drag nothing out. So prepare warms up at panel mount; dragstart only reads cache and compares fingerprints, synchronously.
  let verifiedHelperAppPath: string | null = null;
  let verifiedHelperFingerprint: string | null = null;
  // The Helper's bundle display name. The panel tile shows it instead of a hardcoded string: the macOS permission list
  // shows exactly this value (Dev-suffixed in dev); matching both sides confirms dragged-thing equals listed entry.
  let verifiedHelperDisplayName: string | null = null;
  // The current session's panel. A landed drag must tell it to freeze position; StartDrag and onboarding are separate
  // handlers, so it is shared here and nulled on session end.
  let activeDragPanel: CuaPermissionDragPanel | null = null;

  function cacheVerifiedHelper(
    helperAppPath: string,
    verifiedFingerprint: string,
    displayName: string | null,
  ): void {
    verifiedHelperAppPath = helperAppPath;
    verifiedHelperFingerprint = verifiedFingerprint;
    verifiedHelperDisplayName = displayName;
  }

  function clearVerifiedHelper(): void {
    verifiedHelperAppPath = null;
    verifiedHelperFingerprint = null;
    verifiedHelperDisplayName = null;
  }

  async function refreshVerifiedHelperAppPath(): Promise<void> {
    const result = await prepareCuaHelperPermissionDrag({ logger: options.logger });
    if (result.success && result.helperAppPath && result.helperBundleFingerprint) {
      cacheVerifiedHelper(
        result.helperAppPath,
        result.helperBundleFingerprint,
        result.helperDisplayName ?? null,
      );
    } else {
      clearVerifiedHelper();
      options.logger.warn("[cua-permission-onboarding] prepare helper drag failed", result.error);
    }
  }

  // Called at panel mount: async install+verify caches the verified path plus fingerprint for later synchronous drags.
  ipcMain.handle(PlatformChannels.PrepareCuaHelperPermissionDrag, async () => {
    await refreshVerifiedHelperAppPath();
    // The fingerprint is main-side synchronous TOCTOU evidence and never crosses IPC to the renderer.
    return {
      success: verifiedHelperAppPath !== null,
      ...(verifiedHelperAppPath !== null ? { helperAppPath: verifiedHelperAppPath } : {}),
      ...(verifiedHelperDisplayName !== null
        ? { helperDisplayName: verifiedHelperDisplayName }
        : {}),
      ...(verifiedHelperAppPath === null ? { error: "helper drag preparation failed" } : {}),
    };
  });

  ipcMain.on(PlatformChannels.StartCuaHelperPermissionDrag, (event) => {
    const helperAppPath = verifiedHelperAppPath;
    const fingerprint = verifiedHelperFingerprint;
    if (!helperAppPath || !fingerprint) {
      // Not warmed up yet: never run async install/verify here (misses the gesture). Kick one off in the background for next time,
      // and skip this drag (mount already triggered prepare, so this path is unexpected).
      options.logger.warn(
        "[cua-permission-onboarding] helper drag not prepared yet; verifying in background for next drag",
      );
      void refreshVerifiedHelperAppPath();
      return;
    }
    // TOCTOU gate: between prepare (verification) and now, a same-UID attacker could overwrite Helper.app, and TCC grants bind to exactly
    // the dragged bundle identity. Compare byte fingerprints synchronously (ino/ctime/size; ctime cannot be rewound in userland); on mismatch,
    // reject the drag, clear the cache, re-prepare; never drag a possibly swapped bundle into Accessibility/Screen Recording.
    // The comparison is synchronous (microseconds) and cannot miss the gesture.
    if (!cuaHelperBundleFingerprintUnchanged(helperAppPath, fingerprint)) {
      options.logger.warn(
        "[cua-permission-onboarding] cached helper changed since verification; refusing to drag a possibly-tampered bundle",
      );
      clearVerifiedHelper();
      void refreshVerifiedHelperAppPath();
      return;
    }
    const icon = resolveZCodeIcon().resize({
      width: CUA_DRAG_ICON_SIZE,
      height: CUA_DRAG_ICON_SIZE,
    });
    try {
      // Start the native file drag synchronously; only then does the OS actually drag Helper.app into System Settings.
      event.sender.startDrag({ file: helperAppPath, icon });
    } catch (error) {
      options.logger.warn(
        "[cua-permission-onboarding] helper drag failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    // Drag landed: System Settings next shows a modal; further tracking would chase the dialog and get buried under it.
    activeDragPanel?.freezePosition();
    // A later dragend/mouseup hides the panel (handler below); freeze is the fallback
    // when that signal never arrives, so the panel at least stops chasing the dialog.
    // Refresh the cache in the background (Helper may be reinstalled/upgraded) so the next drag uses fresh verified path + fingerprint.
    void refreshVerifiedHelperAppPath();
  });

  // Gesture finished; grant landed and the panel yields to Settings and the restart prompt. hide, not destroy:
  // the next permission stage reuses the window. hide is idempotent, so duplicate dragend/mouseup is harmless.
  ipcMain.on(PlatformChannels.NotifyCuaHelperPermissionDragEnded, () => {
    activeDragPanel?.hide();
  });

  ipcMain.on(PlatformChannels.CancelCuaPermissionOnboarding, (event, payload) => {
    const senderId = event.sender?.id;
    const operationId = normalizeOnboardingOperationId(
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).operationId
        : undefined,
    );
    if (!Number.isInteger(senderId) || !operationId) return;
    onboardingControllers
      .get(operationKey(senderId, operationId))
      ?.abort(new Error("CUA permission onboarding surface closed"));
  });

  ipcMain.handle(PlatformChannels.OpenCuaPermissionOnboarding, async (event, payload) => {
    // Opens the matching System Settings pane directly (no confirm dialog, no Finder tile/animation for the Helper).
    const payloadRecord =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
    const operationId = normalizeOnboardingOperationId(payloadRecord?.operationId);
    const requiredPermissions = normalizePermissionList(payloadRecord?.requiredPermissions);
    const originController = new AbortController();
    const sender = event.sender as {
      id?: number;
      isDestroyed?: () => boolean;
      once?: (event: "destroyed", listener: () => void) => void;
      removeListener?: (event: "destroyed", listener: () => void) => void;
    };
    const senderId =
      typeof sender.id === "number" && Number.isInteger(sender.id) ? sender.id : null;
    const participantOperationKey =
      senderId !== null && operationId ? operationKey(senderId, operationId) : null;
    if (participantOperationKey && onboardingControllers.has(participantOperationKey)) {
      return {
        success: false,
        canceled: true,
        error: "duplicate CUA permission onboarding operation id",
      };
    }
    if (participantOperationKey) {
      onboardingControllers.set(participantOperationKey, originController);
    }
    const abortForDestroyedOrigin = () =>
      originController.abort(new Error("CUA permission onboarding origin window closed"));
    if (sender.isDestroyed?.()) abortForDestroyedOrigin();
    else sender.once?.("destroyed", abortForDestroyedOrigin);

    // Lazy creation: the panel only matters in the macOS onboarding flow and must be created/destroyed per session (no singleton),
    // so a stale window never leaks into the next session. null off-darwin; every call site uses ?..
    //
    // Wrap in try/catch: creation resolves the binary path, spawns the watcher, and builds a BrowserWindow;
    // any throw must not break onboarding itself, or the user could not even open Settings; without the panel
    // Settings still works (users can drag the .app from Finder). Degraded beats total failure.
    let dragPanel: CuaPermissionDragPanel | null = null;
    if (process.platform === "darwin") {
      try {
        dragPanel = createDragPanelForSession(options.logger, options.currentApplicationLocale);
      } catch (error) {
        options.logger.warn(
          "[cua-permission-onboarding] drag panel unavailable; continuing with settings pane only",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    activeDragPanel = dragPanel;

    let result: Awaited<ReturnType<typeof openCuaPermissionOnboarding>>;
    try {
      result = await openCuaPermissionOnboarding({
        initialPermission:
          payloadRecord?.initialPermission === "screen_recording"
            ? "screen_recording"
            : "accessibility",
        ...(requiredPermissions !== undefined ? { requiredPermissions } : {}),
        ...(typeof sender.id === "number" && Number.isInteger(sender.id)
          ? { participantKey: `webContents:${sender.id}` }
          : {}),
        signal: originController.signal,
        // Each stage: show the drag panel alongside Settings (the only way Helper enters the TCC list) and
        // retire it when the stage's wait ends. Terminal cleanup for the whole session lives in the finally below.
        openSettingsAndWaitForReturn: async (stage) => {
          try {
            await waitForCuaApplicationReturn({
              ...stage,
              openSettings: async () => {
                await stage.openSettings();
                dragPanel?.show(stage.permission);
              },
            });
          } finally {
            dragPanel?.hide();
          }
        },
        logger: options.logger,
      });
    } finally {
      // On any terminal state (success/cancel/timeout/origin destroyed) destroy the panel. PiP panels once lingered forever
      // for lack of unconditional cleanup; it lives in finally and depends on no success path.
      dragPanel?.destroy();
      if (activeDragPanel === dragPanel) activeDragPanel = null;
      sender.removeListener?.("destroyed", abortForDestroyedOrigin);
      if (
        participantOperationKey &&
        onboardingControllers.get(participantOperationKey) === originController
      ) {
        onboardingControllers.delete(participantOperationKey);
      }
    }
    // Users may linger in Settings; stale stage-start verification must not be treated as a validated
    // fingerprint on return. On success, run a fresh verify+fingerprint-bound prepare for the next drag.
    if (result.success) void refreshVerifiedHelperAppPath();
    return result;
  });

  // A 2026-08 audit removed Prepare/StartCuaHelperPermissionDrag as dead paths (no renderer callers then;
  // onboarding used a native dialog to auto-add Helper to TCC). Once the dialog went away, dragging became
  // the only way into the permission list, so both channels are restored above.
}
