/* eslint-disable max-lines -- IAB owner registry, ready/abort lifecycle and guest CDP state must live in one state machine; splitting them reintroduces cross-scope races. */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { webContents, type WebFrameMain } from "electron";
import {
  BROWSER_VIEWPORT_LIMITS,
  DEFAULT_AGENT_BROWSER_VIEWPORT,
  type BrowserClientMode,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserGuestAttachRejectReason,
  type BrowserGuestAttachResult,
  type BrowserDialog,
  type BrowserRecordingAction,
  type BrowserRecordingJob,
  type BrowserRecordingOptions,
  type BrowserResponseMeta,
  type BrowserTabSummary,
  type BrowserUserTabInfo,
  type BrowserViewCloseTabRequest,
  type BrowserViewResidencyReportPayload,
  type BrowserViewResidencyTransitionPayload,
  type BrowserViewRestoredTabShell,
  type BrowserViewportSize,
} from "@zcode/shared";
import { executeBrowserCommandOnView, type ControlledView } from "./browserCommandExecutor.js";
import { executeIabPlaywrightLocator } from "./browserPlaywrightLocatorExecutor.js";
import { recordBrowserVideo, type BrowserWebmRecorderFactory } from "./browserVideoRecorder.js";
import { normalizePlaywrightTimeout } from "./browserPlaywrightTimeout.js";
import type {
  BrowserScreenshotSurfaceCoordinator,
  BrowserScreenshotSurfaceLease,
} from "./browserScreenshotSurfaceCoordinator.js";
import {
  startBrowserScreenshotTransparentWindowBootstrap,
  TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS,
  type BrowserWindowForTransparentBootstrap,
  type TransparentWindowBootstrap,
} from "./browserTransparentWindowBootstrap.js";
import {
  BrowserTabResidencyCoordinator,
  type BrowserTabResidencyRecord,
} from "./browserTabResidencyCoordinator.js";
import type {
  BrowserTabPageStateRecord,
  BrowserTabRecoveryStore,
  BrowserTabShellRecord,
} from "./browserTabRecoveryStore.js";

interface GuestWebContents {
  readonly id: number;
  readonly hostWebContents?: { getZoomFactor(): number } | null;
  readonly mainFrame: WebFrameMain;
  getType(): string;
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  reload(): void;
  stop(): void;
  capturePage(): Promise<{ toPNG(): Buffer }>;
  executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>;
  navigationHistory: {
    canGoBack(): boolean;
    canGoForward(): boolean;
    goBack(): void;
    goForward(): void;
    getAllEntries(): Array<{ url: string; title?: string; pageState?: string }>;
    getActiveIndex(): number;
    restore(options: {
      entries: Array<{ url: string; title?: string; pageState?: string }>;
      index: number;
    }): Promise<void>;
  };
  close(options?: { waitForBeforeUnload?: boolean }): void;
  isCurrentlyAudible?(): boolean;
  isBeingCaptured?(): boolean;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  debugger: {
    isAttached(): boolean;
    attach(protocolVersion?: string): void;
    detach(): void;
    sendCommand(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
    on(event: "message", listener: (event: unknown, method: string, params: unknown) => void): void;
    removeListener(
      event: "message",
      listener: (event: unknown, method: string, params: unknown) => void,
    ): void;
  };
  once(event: "destroyed", listener: () => void): void;
  session?: {
    on(
      event: "will-download",
      listener: (event: unknown, item: GuestDownloadItem, contents: GuestWebContents) => void,
    ): void;
    removeListener(
      event: "will-download",
      listener: (event: unknown, item: GuestDownloadItem, contents: GuestWebContents) => void,
    ): void;
  };
}

interface GuestDownloadItem {
  getSavePath(): string;
  once(event: "done", listener: (event: unknown, state: string) => void): void;
}

export interface BrowserGuestExecutionContext {
  requestId: string;
  browserId: string;
  browserGeneration: number;
  windowId: number;
  workspaceKey: string;
  sessionId: string;
  turnId?: string;
  remoteSessionId?: string;
  clientMode: BrowserClientMode;
}

interface InternalExecutionContext extends BrowserGuestExecutionContext {
  legacy?: boolean;
}

type TabLifecycle = "active" | "deliverable" | "handoff" | "closed";
type GuestBindingLifecycle = "detached" | "attached" | "detaching" | "destroyed";
type GuestRecoveryReason = BrowserGuestAttachRejectReason | "guest-destroyed" | "attach-timeout";

const TAB_CONTEXT_RECOVERY_HINT =
  "This is pre-action stale-binding recovery, not post-action popup observation. " +
  "Keep the existing browser binding; call browser.tabs.list(), then browser.tabs.get(info.id). " +
  "If the controlled list is empty, inspect browser.user.openTabs() and use browser.user.claimTab(info) " +
  "before creating a new tab.";

interface ManagedTab {
  tabId: string;
  owner: InternalExecutionContext;
  guest?: GuestWebContents;
  /** Guest replacement generation; used to reject stale guests before command dispatch. */
  guestGeneration: number;
  /** Guest that bound successfully before; separates first-wait on a new tab from self-heal of an existing tab. */
  hasAttachedGuest: boolean;
  attachFailure?: GuestRecoveryReason;
  rebindRequested: boolean;
  cdpAttached: boolean;
  /** Native CDP lifecycle of the guest; must pass through detaching before the DOM is destroyed. */
  guestLifecycle: GuestBindingLifecycle;
  /** Count of unsettled debugger.sendCommand calls; teardown waits for zero or timeout. */
  pendingCdpCommands: number;
  /** Idle-release timer of the command stream; reset after each CDP command, cleared on detachGuest. */
  guestCdpIdleTimer?: ReturnType<typeof setTimeout>;
  /** Session-state restore flight for re-attach; business commands await it before dispatch (serial barrier). */
  guestCdpRestoreFlight?: Promise<void>;
  /** Viewport critical section currently held; CDP reconnect replays inline and must not re-queue on itself. */
  insideViewportMutation?: boolean;
  /** Only one replacement-teardown flight per guest; duplicate ACKs share the result. */
  guestTeardownFlight?: Promise<boolean>;
  lifecycle: TabLifecycle;
  origin: "agent" | "user";
  /** A human IAB tab is discoverable by any session until first use within the same window/workspace. */
  claimable: boolean;
  /** A claimed user tab reverts to user tab on finalize/closeSession; never closed like agent tabs. */
  userOwner?: InternalExecutionContext;
  active: boolean;
  /** Per-tab CSS viewport set by Agent/UI; undefined follows the host natural size. */
  viewportOverride?: BrowserViewportSize;
  /** Corrects guest native raster under Desktop page zoom; does not change the CSS viewport. */
  desktopZoomFactor?: number;
  /** Scale successfully applied to Chromium; input must not use a target scale still queued for the viewport. */
  appliedViewportScale?: number;
  /** For background execution only while the pane is hidden at 0x0; must be cleared once foregrounded. */
  backgroundViewportFallback?: BrowserViewportSize;
  /** Serializes transient clear against explicit set/reset so the last user/Agent setting wins. */
  viewportMutation?: Promise<void>;
  downloadCleanup?: () => void;
  activityCleanup?: () => void;
  /**
   * Unregister the debugger 'message' listener. After a guest generation change the old listener
   * must not linger: it looks up the map on every event just to drop via current.guest !== guest — a pure leak.
   * Note this is JS-side cleanup only; the native CDP channel closes for real only via debugger.detach().
   */
  cdpMessageCleanup?: () => void;
  /**
   * Unregister the render-process-gone listener. It proactively tears down CDP while the guest renderer is dead but
   * WebContents still lives — the only moment to avoid api::Debugger implicit destruction.
   */
  crashGuardCleanup?: () => void;
  loading: boolean;
  mediaActive: boolean;
  cachedUrl: string;
  cachedTitle: string;
  cachedFaviconUrl: string | null;
  openedAt: number;
  restoredFromStore?: boolean;
}

interface PendingWaiter {
  resolve: (guest: GuestWebContents | null) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface RunningRequest {
  context: InternalExecutionContext;
  controller: AbortController;
  dispatched: boolean;
  tabId?: string;
}

interface InFlightScreenshot {
  execution: Promise<BrowserCommandResult>;
  requestId: string;
  startedAt: number;
}

interface BrowserRecordingEntry {
  id: string;
  context: InternalExecutionContext;
  tabId: string;
  controller: AbortController;
  status: BrowserRecordingJob["status"];
  phase: BrowserRecordingJob["phase"];
  progress: number;
  startedAt: number;
  updatedAt: number;
  artifact?: BrowserRecordingJob["artifact"];
  error?: string;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

interface DownloadRecord {
  tabId: string;
  path: string | null;
  state: "pending" | "completed" | "cancelled" | "interrupted";
}

interface DownloadWaiter {
  resolve: (downloadId: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  onAbort: () => void;
}

const DEFAULT_ATTACH_TIMEOUT_MS = 10_000;
// Hard cap for full-page capture once the transparent presentation is up; normally settles within hundreds of ms.
const HIDDEN_WINDOW_CAPTURE_DEADLINE_MS = 5_000;
// Per-tab hard cap for 'wait abandoned but underlying CDP capture still unsettled'. CDP screenshots have no
// single-request cancel API; retries leave pending commands inside Chromium, and while the compositor stays broken
// the unbounded case stacks forever (they drain together on frame recovery, but pendingCdpCommands never
// zeroes and detach times out). Past the cap the tab's screenshots fail fast with a reopen hint; slots
// recycle once the old capture actually settles.
const MAX_ABANDONED_SCREENSHOT_CAPTURES = 3;
/** Cap on teardown waiting for in-flight CDP commands to converge; still attempts native detach on timeout. */
const DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS = 1_000;
// CDP command-stream idle release threshold: covers the measured crash window (0.4-9s intra-turn gaps)
// without interrupting dense agent command streams (typical gaps are far smaller).
const DEFAULT_GUEST_CDP_IDLE_RELEASE_MS = 1_500;
const RECORDING_RESULT_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_BACKGROUND_BROWSER_VIEWPORT: BrowserViewportSize = {
  width: 800,
  height: 600,
};

type BrowserTabRecoveryStorePort = Pick<
  BrowserTabRecoveryStore,
  "upsert" | "upsertPageState" | "getPageState" | "removePageState" | "remove" | "listShells"
> &
  Partial<Pick<BrowserTabRecoveryStore, "whenIdle">>;

interface BrowserGuestManagerResidencyOptions {
  tabLimit?: number;
  suspendAckTimeoutMs?: number;
  now?: () => number;
  recoveryStore?: BrowserTabRecoveryStorePort;
  onSuspendTabRequested?(payload: BrowserViewResidencyTransitionPayload): void;
  onRestoreTabRequested?(payload: BrowserViewResidencyTransitionPayload): void;
  onResidencyChanged?(payload: BrowserViewResidencyTransitionPayload): void;
  onRecoveryOrphanCloseRequested?(payload: { tabId: string; reason: "recovery-orphan" }): void;
  warn?(message: string): void;
  recording?: {
    tempRoot?: string;
    createRecorder?: BrowserWebmRecorderFactory;
    now?: () => number;
  };
}
function normalizeDesktopZoomMetricsScale(desktopZoomFactor: number | undefined): number {
  return Number.isFinite(desktopZoomFactor) && (desktopZoomFactor ?? 1) > 1
    ? (desktopZoomFactor ?? 1)
    : 1;
}

function buildViewportMetricsOverride(
  viewport: BrowserViewportSize,
  desktopZoomFactor?: number,
): Record<string, unknown> {
  const metricsScale = normalizeDesktopZoomMetricsScale(desktopZoomFactor);
  return {
    width: viewport.width,
    height: viewport.height,
    // By default CDP lets DPR=1 page metrics take over visible size as well, so on Retina only a
    // 1x native surface is allocated; DOM bounds are right but the page covers just the frame's top-left. The visible surface
    // stays owned by the Electron <webview> bounds; CDP owns only CSS viewport and screenshot DPR.
    deviceScaleFactor: 1,
    mobile: false,
    dontSetVisibleSize: true,
    // With Desktop page zoom > 1, the Electron guest-target screenshot already contains only
    // 1/zoom of the frame; the outer CSS transform cannot restore the missing native raster. CDP scale
    // corrects the visible surface only when zoomed in; keep 1 zoomed out to avoid shrinking content again.
    ...(metricsScale > 1 ? { scale: metricsScale } : {}),
  };
}

function scopeKey(context: InternalExecutionContext): string {
  if (context.legacy) return "legacy";
  return [
    context.browserId,
    String(context.browserGeneration),
    String(context.windowId),
    context.workspaceKey,
    context.remoteSessionId ?? "",
    context.sessionId,
    context.clientMode,
  ].join("\u0000");
}

function sameScope(left: InternalExecutionContext, right: InternalExecutionContext): boolean {
  return (left.legacy === true && right.legacy === true) || scopeKey(left) === scopeKey(right);
}

function normalizeLegacyContext(defaultKey: string): InternalExecutionContext {
  return {
    requestId: `legacy:${randomUUID()}`,
    browserId: "legacy-iab",
    browserGeneration: 0,
    windowId: 0,
    workspaceKey: defaultKey,
    sessionId: defaultKey,
    clientMode: "desktop-continuous",
    legacy: true,
  };
}

function suspendAckKey(tabId: string, generation: number): string {
  return `${tabId}\u0000${generation}`;
}

function toRestoredShell(
  record: BrowserTabShellRecord,
  owner: InternalExecutionContext,
): BrowserViewRestoredTabShell {
  return {
    tabId: record.tabId,
    workspaceKey: record.workspaceKey,
    ...(record.remoteSessionId ? { remoteSessionId: record.remoteSessionId } : {}),
    sessionId: record.sessionId,
    browserId: owner.browserId,
    browserGeneration: owner.browserGeneration,
    origin: record.origin,
    restoreUrl: record.restoreUrl,
    title: record.title,
    faviconUrl: record.faviconUrl,
    openedAt: record.openedAt,
    lastSelectedAt: record.lastSelectedAt,
  };
}

function isSideEffecting(command: BrowserCommand): boolean {
  if (command.method === "playwright" && command.action.name === "locator") {
    return [
      "click",
      "dblclick",
      "downloadMedia",
      "fill",
      "press",
      "selectOption",
      "setChecked",
    ].includes(command.action.operation);
  }
  if (command.method === "playwright" && command.action.name === "evaluate") return true;
  return [
    "navigate",
    "back",
    "forward",
    "reload",
    "click",
    "fill",
    "type",
    "press",
    "cuaKeypress",
    "scroll",
    "cuaScroll",
    "domCuaScroll",
    "hover",
    "select",
    "check",
    "drag",
    "cuaDrag",
    "recordingStart",
    "recordingCancel",
    "handleDialog",
    "close",
    "evaluate",
    "finalize",
    "finalizeTabs",
    "claimTab",
    "activateTab",
    "markDeliverable",
    "markHandoff",
    "newTab",
  ].includes(command.method);
}

/**
 * IAB guest registry. Production paths are strictly isolated by BrowserGuestExecutionContext; the string overload
 * survives only for legacy renderer/unit tests and must not be used by new callers.
 */
function safeNumber(read: () => number | undefined): number | undefined {
  try {
    const value = read();
    return typeof value === "number" ? value : undefined;
  } catch {
    // Reading id throws once the guest is destroyed; the janitor simply skips that tab.
    return undefined;
  }
}

export class BrowserGuestManager {
  private readonly tabs = new Map<string, ManagedTab>();

  /** Janitor: webContents ids of browser guests still alive, so their renderers count toward the built-in browser-use plugin. */
  listGuestWebContentsIds(): number[] {
    const ids: number[] = [];
    for (const tab of this.tabs.values()) {
      if (tab.lifecycle === "closed" || !tab.guest) continue;
      const id = safeNumber(() => tab.guest?.id);
      if (id !== undefined) ids.push(id);
    }
    return ids;
  }
  /** After close keep only the opaque id tombstone to reject late renderer attaches; no owner/guest retained. */
  private readonly closedTabIds = new Set<string>();
  private readonly activeTabByScope = new Map<string, string>();
  private readonly defaultTabByScope = new Map<string, string>();
  private readonly waiters = new Map<string, PendingWaiter[]>();
  private readonly pendingDialogs = new Map<string, BrowserDialog>();
  private readonly runningRequests = new Map<string, RunningRequest>();
  /**
   * CDP Page.captureScreenshot has no per-request cancel API. After an outer timeout/cancel the promise may still
   * be executing inside Chromium. Request abort/deadline
   * settles at once and releases the barrier, so the same tab can retry immediately — overlap is transient and self-draining: the next
   * screenshot's transparent presentation resumes frames and the old pending capture settles; results belong to their own
   * promise chains and never attach to the new request (clearTrackedScreenshot is idempotent by entry identity). The old
   * 'keep barrier until actual settle' turned never-settling pending requests into a permanent screenshot
   * deadlock for the tab (observed pendingMs 120s+); removed. Pile-up is bounded by the abandonedScreenshotCaptures cap.
   */
  private readonly inFlightScreenshots = new Map<string, InFlightScreenshot>();
  /** See MAX_ABANDONED_SCREENSHOT_CAPTURES; keyed by tabId. */
  private readonly abandonedScreenshotCaptures = new Map<string, number>();
  private readonly recordings = new Map<string, BrowserRecordingEntry>();
  private readonly downloads = new Map<string, DownloadRecord>();
  private readonly queuedDownloads = new Map<string, string[]>();
  private readonly downloadWaiters = new Map<string, DownloadWaiter[]>();
  private readonly sessionNames = new Map<string, string>();
  private readonly visibilityByScope = new Map<string, boolean>();
  private readonly naturalViewportByWindow = new Map<number, BrowserViewportSize>();
  private readonly residencyCoordinator: BrowserTabResidencyCoordinator;
  private readonly suspendAckWaiters = new Map<string, () => void>();
  private readonly suspendFlights = new Map<string, Promise<void>>();
  private readonly restoreFlights = new Map<string, Promise<GuestWebContents | null>>();
  /** On rebind after guest destruction, the replacement must finish original-page restore before new browser commands. */
  private readonly guestRecoveryFlights = new Map<string, Promise<GuestWebContents | null>>();
  /** At most one attach/rebind flight per tab, so concurrent commands cannot each rebuild the webview. */
  private readonly guestAttachFlights = new Map<string, Promise<GuestWebContents | null>>();
  private readonly restoredTabClaims = new Map<string, number>();

  constructor(
    private readonly log?: (msg: string) => void,
    private readonly attachTimeoutMs: number = DEFAULT_ATTACH_TIMEOUT_MS,
    private readonly onCloseTabRequested?: (
      tabId: string,
      owner?: BrowserGuestExecutionContext,
    ) => void,
    private readonly onOpenTabRequested?: (
      tabId: string,
      owner: BrowserGuestExecutionContext,
    ) => void,
    private readonly onVisibilityChanged?: (
      visible: boolean,
      owner: BrowserGuestExecutionContext,
      tabId?: string,
    ) => void,
    private readonly onViewportChanged?: (
      viewport: BrowserViewportSize | null,
      owner: BrowserGuestExecutionContext,
      tabId: string,
    ) => void,
    // Bit 7 is taken by screenshot CSS-pixel normalization; new gating flags append only, keeping existing main/test callers intact.
    private readonly resizeScreenshotToCssPixels?: ControlledView["resizeScreenshotToCssPixels"],
    private readonly screenshotSurfaceCoordinator?: BrowserScreenshotSurfaceCoordinator,
    private readonly residencyOptions: BrowserGuestManagerResidencyOptions = {},
    // Transparent presentation for hidden-window screenshots needs the owner BrowserWindow; tests inject a stub, production
    // wires it in index.ts via BrowserWindow.fromId. Uninjected, the whole capability stays off, matching legacy behavior.
    private readonly resolveOwnerWindow?: (
      windowId: number,
    ) => BrowserWindowForTransparentBootstrap | null,
    // How long the CDP command stream stays idle before proactive release (detach). Guest renderer killed by
    // Chromium with render-process-gone never reaching main plus destroyed-direct + CDP attached equals
    // main-process UAF; the measured crash window is 0.4-9s intra-turn gaps, narrowed by command-level idle release.
    private readonly cdpIdleReleaseMs: number = DEFAULT_GUEST_CDP_IDLE_RELEASE_MS,
  ) {
    this.residencyCoordinator = new BrowserTabResidencyCoordinator({
      tabLimit: residencyOptions.tabLimit,
      now: residencyOptions.now,
      onEvict: (record) => this.closeTabForLimit(record),
    });
  }

  attachGuest(
    tabId: string,
    webContentsId: number,
    options?: {
      active?: boolean;
      windowId?: number;
      workspaceKey?: string;
      remoteSessionId?: string;
      sessionId?: string;
      residencyGeneration?: number;
    },
  ): BrowserGuestAttachResult {
    let tab = this.tabs.get(tabId);
    const guest = webContents.fromId(webContentsId) as GuestWebContents | undefined;
    if (!guest || guest.isDestroyed()) {
      const recoveryRequested =
        tab && tab.lifecycle !== "closed"
          ? this.requestGuestRebind(tab, guest ? "destroyed" : "not-found")
          : false;
      this.log?.(
        `[browser-use] attachGuest skip tabId=${tabId} id=${webContentsId} reason=${guest ? "destroyed" : "not-found"}`,
      );
      return {
        ok: false,
        reason: guest ? "destroyed" : "not-found",
        recoveryRequested,
      };
    }
    if (guest.getType() !== "webview") {
      // fromId accepts any in-process WebContents id; a renderer mistake passing the main window id would let later
      // CDP/Runtime input drive the ZCode composer. IAB accepts only real <webview> guests and fails closed.
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} id=${webContentsId} reason=not-webview type=${guest.getType()}`,
      );
      return { ok: false, reason: "not-webview", recoveryRequested: false };
    }

    if (this.closedTabIds.has(tabId)) {
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=closed`);
      return { ok: false, reason: "closed", recoveryRequested: false };
    }
    // Legacy renderer compat: keys that never went through a create request enter the legacy scope only.
    if (!tab) {
      const owner = options?.workspaceKey
        ? {
            requestId: `unclaimed:${randomUUID()}`,
            browserId: "unclaimed-iab",
            browserGeneration: 0,
            windowId: options.windowId ?? 0,
            workspaceKey: options.workspaceKey,
            // Human tabs used to be registered per workspace as globally unclaimed, letting any new conversation
            // enumerate and take over via user.openTabs(). ownerTaskId is now frozen at attach; with legacy
            // renderers omitting sessionId keep the unclaimable sentinel - hidden beats leaked across conversations.
            sessionId: options.sessionId?.trim() || "unscoped",
            ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
            clientMode: "desktop-continuous" as const,
          }
        : normalizeLegacyContext(tabId);
      if (options?.windowId !== undefined) owner.windowId = options.windowId;
      tab = {
        tabId,
        owner,
        cdpAttached: false,
        guestLifecycle: "detached",
        pendingCdpCommands: 0,
        guestGeneration: 0,
        hasAttachedGuest: false,
        rebindRequested: false,
        lifecycle: "active",
        origin: options?.workspaceKey ? "user" : "agent",
        claimable: Boolean(options?.workspaceKey && options.sessionId?.trim()),
        ...(options?.workspaceKey ? { userOwner: { ...owner } } : {}),
        active: false,
        loading: false,
        mediaActive: false,
        cachedUrl: "",
        cachedTitle: "",
        cachedFaviconUrl: null,
        openedAt: this.now(),
      };
      this.tabs.set(tabId, tab);
      this.registerTabResidency(tab, options?.active === true);
    }
    if (tab.lifecycle === "closed") {
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=closed`);
      return { ok: false, reason: "closed", recoveryRequested: false };
    }
    if (options?.windowId !== undefined && tab.owner.windowId !== options.windowId) {
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=window-mismatch expected=${tab.owner.windowId} actual=${options.windowId}`,
      );
      return { ok: false, reason: "window-mismatch", recoveryRequested: false };
    }
    if (options?.workspaceKey && tab.owner.workspaceKey !== options.workspaceKey) {
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=workspace-mismatch`);
      return this.rejectGuestAttach(tab, guest, "workspace-mismatch");
    }
    if (options?.sessionId && tab.owner.sessionId !== options.sessionId) {
      // A late renderer dom-ready must not reuse the tabId under another conversation's ownership.
      // Reject even at equal window/workspace so a cross-conversation-replaced guest cannot bypass openTabs isolation.
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=session-mismatch`);
      return this.rejectGuestAttach(tab, guest, "session-mismatch");
    }
    if ((tab.owner.remoteSessionId ?? "") !== (options?.remoteSessionId ?? "")) {
      // Remote owners were validated only when the renderer sent remoteSessionId; a missing value failed
      // open, so post-reconnect old tabs could attach to the new runtime.
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=remote-session-mismatch`,
      );
      return this.rejectGuestAttach(tab, guest, "remote-session-mismatch");
    }

    const residency = this.residencyCoordinator.get(tabId);
    const rejectsNewGuest =
      tab.guest !== guest &&
      (residency?.residency === "suspended" || residency?.residency === "suspend-pending");
    if (rejectsNewGuest) {
      // After the restore timeout rolled back, a late old-generation guest could still bypass restoring
      // checks and re-occupy the tab. suspended/pending accepts repeat reports only from the same old guest, not new attaches.
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=residency-${residency.residency}`,
      );
      this.closeGuestWebContents(tab, guest);
      return {
        ok: false,
        reason: "residency-suspended",
        recoveryRequested: false,
      };
    }
    if (
      residency?.residency === "restoring" &&
      !this.residencyCoordinator.markAttached(
        tabId,
        options?.active === true,
        options?.residencyGeneration,
      )
    ) {
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=residency-generation-mismatch expected=${residency.generation} actual=${options?.residencyGeneration ?? "missing"}`,
      );
      this.closeGuestWebContents(tab, guest);
      return {
        ok: false,
        reason: "residency-generation-mismatch",
        recoveryRequested: false,
      };
    }
    const isSameGuest = tab.guest === guest;
    if (residency?.residency === "restoring") {
      // The restoring src uses a deferred protocol that does not commit the document; once scope/generation checks
      // pass, stop the provisional request so restoreGuestState performs the single first valid navigation.
      try {
        guest.stop();
      } catch (error) {
        this.warn(`browser tab provisional navigation stop failed tabId=${tabId}`, error);
      }
    }
    if (tab.guest && !isSameGuest) this.detachGuest(tab);
    if (!isSameGuest) this.guestRecoveryFlights.delete(tab.tabId);

    // detachGuest reads the last URL from the still-living old guest; the restore decision must come after it, so a
    // just-occurred navigation is not misread as no-restorable-facts before the renderer reports residency.
    const rebindReason = tab.attachFailure;
    const shouldRestoreAfterRebind =
      tab.hasAttachedGuest &&
      !isSameGuest &&
      rebindReason !== undefined &&
      rebindReason !== "residency-suspended" &&
      rebindReason !== "residency-generation-mismatch" &&
      tab.cachedUrl.trim() !== "" &&
      tab.cachedUrl !== "about:blank";

    let cdpAttached = false;
    try {
      if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
      cdpAttached = guest.debugger.isAttached();
    } catch {
      cdpAttached = safeBool(() => guest.debugger.isAttached(), false);
    }
    tab.guest = guest;
    tab.cdpAttached = cdpAttached;
    tab.guestLifecycle = "attached";
    tab.guestTeardownFlight = undefined;
    if (!isSameGuest) tab.guestGeneration += 1;
    tab.hasAttachedGuest = true;
    tab.attachFailure = undefined;
    tab.rebindRequested = false;
    if (cdpAttached) this.scheduleGuestCdpIdleRelease(tab);
    // A new guest's initial URL during restore is about:blank. Overwriting the logical cache before
    // pageState/restoreUrl is consumed would degrade a corrupted snapshot to a blank page and hide fully-fact-missing orphans.
    if (residency?.residency !== "restoring" && !shouldRestoreAfterRebind) {
      tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
      tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
    }
    if (options?.active === true) {
      tab.active = true;
      if (!tab.claimable) this.selectTab(tab, false);
      this.restoreNaturalViewportAfterBackground(tab);
    } else if (options?.active === false) {
      tab.active = false;
      this.residencyCoordinator.report(tab.tabId, {
        selected: false,
        visible: false,
      });
      if (this.activeTabByScope.get(scopeKey(tab.owner)) === tabId) {
        this.activeTabByScope.delete(scopeKey(tab.owner));
      }
    }
    this.log?.(
      `[browser-use] attachGuest tabId=${tabId} windowId=${tab.owner.windowId} cdp=${cdpAttached}`,
    );

    guest.once("destroyed", () => {
      const current = this.tabs.get(tabId);
      if (current?.guest === guest) {
        this.detachGuest(current);
        this.requestGuestRebind(current, "guest-destroyed");
      }
    });
    // Place before the remaining wiring: later setup steps can throw synchronously on a destroyed guest and skip the rest,
    // and this is the only listener that closes the UAF window - it must not be taken down with them.
    if (!isSameGuest) this.setupCdpCrashGuard(tab, guest);
    if (!isSameGuest) this.setupDialogTracking(tab, guest);
    if (!isSameGuest) this.setupDownloadTracking(tab, guest);
    if (!isSameGuest) this.setupActivityTracking(tab, guest);
    if (!isSameGuest) this.applyViewportOverride(tab);
    if (tab.viewportOverride) {
      // The Agent may emit viewport events before the renderer finishes auto-open; replay once after guest attach so the
      // freshly mounted free-size UI misses no one-shot main -> renderer sync.
      this.onViewportChanged?.({ ...tab.viewportOverride }, tab.owner, tab.tabId);
    }
    if (options?.active !== false && this.visibilityByScope.get(scopeKey(tab.owner)) === true) {
      // visibilityByScope says the whole browser scope is visible, not that this attach's tab
      // is selected. Replaying inactive guests as visible=true re-activates an old tab after the user
      // moved away; late duplicates after close even revive the tab shell. Only non-inactive attaches inherit
      // scope visibility; explicit selection stays with selectTab/browserVisibilitySet.
      this.onVisibilityChanged?.(true, tab.owner, tab.tabId);
    }
    if (shouldRestoreAfterRebind) {
      // When guest-destroyed replays only Ready, the new guest's initial URL is about:blank; flagging it
      // available stops the renderer from re-consuming the applied initialUrl, leaving the side panel blank forever.
      // Reuse the existing pageState -> restoreUrl path and serialize follow-up commands with the per-tab flight.
      const recoveryFlight = this.restoreReboundGuest(tab, guest);
      this.guestRecoveryFlights.set(tab.tabId, recoveryFlight);
      const clearRecoveryFlight = () => {
        if (this.guestRecoveryFlights.get(tab.tabId) === recoveryFlight) {
          this.guestRecoveryFlights.delete(tab.tabId);
        }
      };
      void recoveryFlight.then(clearRecoveryFlight, clearRecoveryFlight);
    }
    this.resolveWaiters(tabId, guest);
    if (residency?.residency !== "restoring") {
      this.residencyCoordinator.markAttached(tabId, options?.active === true);
    }
    void this.persistShell(tab);
    return { ok: true, guestGeneration: tab.guestGeneration };
  }

  /** Renderer free-size interaction writeback; the sending window is bound by the IPC layer, never reach across windows. */
  async updateViewportFromRenderer(
    tabId: string,
    viewport: BrowserViewportSize | null,
    windowId: number,
    desktopZoomFactor = 1,
  ): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.lifecycle === "closed" || tab.owner.windowId !== windowId) {
      throw new Error(`browser tab '${tabId}' is unavailable for viewport update`);
    }
    if (viewport) {
      assertViewportOverride(viewport);
      tab.desktopZoomFactor = normalizeDesktopZoomMetricsScale(desktopZoomFactor);
      await this.setTabViewport(tab, viewport);
      return;
    }
    await this.resetTabViewport(tab);
  }

  getTabOwner(tabId: string): BrowserGuestExecutionContext | null {
    const owner = this.tabs.get(tabId)?.owner;
    return owner ? { ...owner } : null;
  }

  /** Resolve the controlled tab from the guest WebContents so webview popup events keep the original session scope. */
  getTabOwnerByWebContentsId(
    webContentsId: number,
  ): (BrowserGuestExecutionContext & { tabId: string }) | null {
    for (const tab of this.tabs.values()) {
      if (tab.guest?.id === webContentsId && tab.lifecycle !== "closed") {
        return { ...tab.owner, tabId: tab.tabId };
      }
    }
    return null;
  }

  async reportResidency(
    payload: BrowserViewResidencyReportPayload & { windowId: number },
  ): Promise<void> {
    const tab = this.requireRendererOwnedTab(payload);
    tab.cachedUrl = payload.restoreUrl?.trim() || tab.cachedUrl;
    if (payload.title !== undefined) tab.cachedTitle = payload.title ?? "";
    if (payload.faviconUrl !== undefined) tab.cachedFaviconUrl = payload.faviconUrl;
    tab.loading = payload.loading;
    this.residencyCoordinator.report(tab.tabId, {
      selected: payload.selected,
      visible: payload.visible,
      currentTask: payload.currentTask,
      loading: payload.loading,
      audible: safeBool(() => tab.guest?.isCurrentlyAudible?.() ?? false, false),
      mediaActive: tab.mediaActive,
      operationActive: this.hasRunningRequestForTab(tab.tabId),
      captureActive: this.isTabCaptureActive(tab),
      downloadActive: this.hasPendingDownloadForTab(tab.tabId),
    });
    if (payload.selected) {
      tab.active = true;
      if (!tab.claimable) this.selectTab(tab, false);
      // A foreground report is the signal the user is really watching (panel expand/tab switch), independent of claimability,
      // and must stay independent of selectTab-triggered restore.
      this.maybeRestoreBackgroundViewport(tab);
    } else {
      tab.active = false;
      const key = scopeKey(tab.owner);
      if (this.activeTabByScope.get(key) === tab.tabId) this.activeTabByScope.delete(key);
    }
    await this.persistShell(tab);
    await this.residencyCoordinator.whenIdle();
  }

  acknowledgeSuspend(payload: { tabId: string; generation: number; windowId: number }): void {
    const tab = this.tabs.get(payload.tabId);
    if (!tab || tab.owner.windowId !== payload.windowId) return;
    const key = suspendAckKey(payload.tabId, payload.generation);
    this.suspendAckWaiters.get(key)?.();
  }

  async closeTabFromRenderer(
    payload: BrowserViewCloseTabRequest & { windowId: number },
  ): Promise<void> {
    // Agent close already removed the logical tab in main, but the BrowserViewCloseTab notice may land in a
    // non-current workspace, dropped by the renderer, leaving a shell in the UI. The user's x click ends up here; throwing
    // 'unavailable for renderer scope' means no ack, so the renderer never removes the UI - the tab is unclosable.
    // main no longer has the logical tab, so letting the renderer converge its own shell is safe and required: pass
    // idempotently and add the tombstone so a late attach cannot revive it. Scope checks apply only to living tabs;
    // closing other scopes' tabs across window/workspace stays rejected.
    const existing = this.tabs.get(payload.tabId);
    if (!existing || existing.lifecycle === "closed") {
      this.closedTabIds.add(payload.tabId);
      return;
    }
    // Close is convergence intent: the reconnect-guard semantics of remoteSessionId belong to attach (see
    // remote-session-mismatch in attachGuest). Attach side has the workspaceRemoteSessionId fallback for it, close side
    // does not; strict equality would make remote human tabs unclosable. A renderer closing a tab it can see is not
    // unauthorized; window/workspace/session still match strictly and cross-scope closes stay rejected.
    const tab = this.requireRendererOwnedTab(payload, { skipRemoteSession: true });
    await this.closeTabDurably(tab, false);
  }

  async whenRecoveryIdle(): Promise<void> {
    await this.residencyOptions.recoveryStore?.whenIdle?.();
  }

  async ensureResidentFromRenderer(
    payload: BrowserViewCloseTabRequest & { windowId: number },
  ): Promise<void> {
    const tab = this.requireRendererOwnedTab(payload);
    const guest = await this.ensureGuest(tab, new AbortController().signal);
    if (!guest) throw new Error(`browser tab '${tab.tabId}' restore failed`);
  }

  async restoreTabs(payload: {
    windowId: number;
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId?: string;
  }): Promise<BrowserViewRestoredTabShell[]> {
    const records =
      (await this.residencyOptions.recoveryStore?.listShells({
        workspaceKey: payload.workspaceKey,
        ...(payload.remoteSessionId ? { remoteSessionId: payload.remoteSessionId } : {}),
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      })) ?? [];
    this.log?.(
      `[browser-use] restoreTabs windowId=${payload.windowId} workspaceKey=${payload.workspaceKey} remoteSessionId=${payload.remoteSessionId ?? "<local>"} sessionId=${payload.sessionId ?? "<all>"} records=${records.length}`,
    );
    const restored: BrowserViewRestoredTabShell[] = [];
    for (const record of records) {
      if (this.closedTabIds.has(record.tabId)) continue;
      const claimedWindowId = this.restoredTabClaims.get(record.tabId);
      if (claimedWindowId !== undefined && claimedWindowId !== payload.windowId) continue;
      this.restoredTabClaims.set(record.tabId, payload.windowId);

      let tab = this.tabs.get(record.tabId);
      if (!tab) {
        const owner: InternalExecutionContext = {
          requestId: `restore:${randomUUID()}`,
          browserId:
            record.browserId ?? (record.origin === "user" ? "unclaimed-iab" : "restored-iab"),
          browserGeneration: record.browserGeneration ?? 0,
          windowId: payload.windowId,
          workspaceKey: record.workspaceKey,
          ...(record.remoteSessionId ? { remoteSessionId: record.remoteSessionId } : {}),
          sessionId: record.sessionId,
          clientMode: "desktop-continuous",
        };
        tab = {
          tabId: record.tabId,
          owner,
          cdpAttached: false,
          guestLifecycle: "detached",
          pendingCdpCommands: 0,
          guestGeneration: 0,
          hasAttachedGuest: false,
          rebindRequested: false,
          lifecycle: record.lifecycle,
          origin: record.origin,
          claimable: record.origin === "user",
          ...(record.origin === "user" ? { userOwner: { ...owner } } : {}),
          active: false,
          ...(record.viewport ? { viewportOverride: { ...record.viewport } } : {}),
          loading: false,
          mediaActive: false,
          cachedUrl: record.restoreUrl ?? "",
          cachedTitle: record.title ?? "",
          cachedFaviconUrl: record.faviconUrl,
          openedAt: record.openedAt,
          restoredFromStore: true,
        };
        this.tabs.set(record.tabId, tab);
        this.registerTabResidency(tab, false, "suspended", record.lastSelectedAt);
      } else if (tab.owner.windowId !== payload.windowId) {
        continue;
      }
      restored.push(toRestoredShell(record, tab.owner));
    }
    return restored;
  }

  async execute(
    contextOrKey: BrowserGuestExecutionContext | string,
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<BrowserCommandResult> {
    const context =
      typeof contextOrKey === "string" ? normalizeLegacyContext(contextOrKey) : contextOrKey;
    this.log?.(
      `[browser-use] execute requestId=${context.requestId} browserId=${context.browserId} generation=${context.browserGeneration} windowId=${context.windowId} sessionId=${context.sessionId} method=${command.method}`,
    );

    if (this.runningRequests.has(context.requestId)) {
      // requestId is the correlation key for cancel and lifecycle cleanup. Same-key overwrite would
      // cancel into the wrong scope and the old finally would delete a still-running newer entry. Duplicates fail before dispatch.
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "duplicate_request_id",
            message: `browser requestId '${context.requestId}' is already running`,
            sideEffect: "none",
          },
          elapsedMs: 0,
        },
        context,
      );
    }

    if (command.method === "cancelRequest") {
      const cancelled = this.abortRequest(command.requestId, context);
      return this.withMeta({ ok: true, value: { cancelled }, elapsedMs: 0 }, context);
    }
    if (command.method === "turnEnded") {
      this.endTurn(context, command.turnId ?? context.turnId);
      return this.withMeta({ ok: true, elapsedMs: 0 }, context);
    }
    if (command.method === "closeSession") {
      this.closeSession(context);
      return this.withMeta({ ok: true, elapsedMs: 0 }, context);
    }

    const controller = new AbortController();
    const unlink = linkAbortSignal(signal, controller);
    const running: RunningRequest = { context, controller, dispatched: false };
    this.runningRequests.set(context.requestId, running);
    try {
      return await this.executeInScope(context, command, running);
    } finally {
      unlink();
      // Cleanup binds to entry identity; even if a future path misuses the same key, an old request never deletes newer state.
      if (this.runningRequests.get(context.requestId) === running) {
        this.runningRequests.delete(context.requestId);
      }
      if (running.tabId) this.refreshRuntimeProtection(running.tabId);
    }
  }

  private async executeInScope(
    context: InternalExecutionContext,
    command: BrowserCommand,
    running: RunningRequest,
  ): Promise<BrowserCommandResult> {
    const startedAt = Date.now();
    if (running.controller.signal.aborted) {
      return this.cancelledResult(context, false, startedAt);
    }

    if (command.method === "list") {
      const tabs = await Promise.all(this.ownedTabs(context).map((tab) => this.summary(tab)));
      return this.withMeta({ ok: true, tabs, elapsedMs: Date.now() - startedAt }, context);
    }

    if (command.method === "listUserTabs") {
      const userTabs = this.openUserTabs(context).map((tab) => this.userTabInfo(tab));
      return this.withMeta({ ok: true, userTabs, elapsedMs: Date.now() - startedAt }, context);
    }

    if (command.method === "nameSession") {
      this.sessionNames.set(scopeKey(context), command.name);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context);
    }

    if (command.method === "browserVisibilityGet") {
      return this.withMeta(
        {
          ok: true,
          value: this.visibilityByScope.get(scopeKey(context)) === true,
          elapsedMs: Date.now() - startedAt,
        },
        context,
      );
    }

    if (command.method === "browserVisibilitySet") {
      const key = scopeKey(context);
      this.visibilityByScope.set(key, command.visible);
      const active = this.activeTabByScope.get(key);
      const selected = active ? this.tabs.get(active) : this.ownedTabs(context).at(-1);
      this.onVisibilityChanged?.(command.visible, context, selected?.tabId);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, selected);
    }

    if (command.method === "browserViewportSet") {
      const tab = this.resolveTab(context, command.tabId);
      if (!tab) return this.unavailableTabResult(context, command.tabId, startedAt);
      const viewport = { width: command.width, height: command.height };
      await this.setTabViewport(tab, viewport);
      this.selectTab(tab, true);
      this.onViewportChanged?.(viewport, tab.owner, tab.tabId);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }

    if (command.method === "browserViewportReset") {
      const tab = this.resolveTab(context, command.tabId);
      if (!tab) return this.unavailableTabResult(context, command.tabId, startedAt);
      await this.resetTabViewport(tab);
      this.onViewportChanged?.(null, tab.owner, tab.tabId);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }

    if (command.method === "recordingStatus" || command.method === "recordingCancel") {
      const entry = this.recordings.get(command.recordingId);
      if (!entry || !sameScope(entry.context, context)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser recording '${command.recordingId}' is unavailable in this context`,
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      if ("tabId" in command && command.tabId && command.tabId !== entry.tabId) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser recording '${command.recordingId}' does not belong to tab '${command.tabId}'`,
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      if (command.method === "recordingCancel" && entry.status === "running") {
        entry.controller.abort(new DOMException("recording cancelled", "AbortError"));
        this.setRecordingTerminal(entry, "cancelled");
      }
      return this.withMeta(
        {
          ok: true,
          recording: this.snapshotRecording(entry),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        this.tabs.get(entry.tabId),
      );
    }

    if (command.method === "activateTab") {
      const tab = this.tabs.get(command.tabId);
      if (!tab || tab.lifecycle === "closed" || !sameScope(tab.owner, context)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser tab '${command.tabId}' is unavailable for activation. ${TAB_CONTEXT_RECOVERY_HINT}`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      running.tabId = tab.tabId;
      this.refreshRuntimeProtection(tab.tabId);
      const guest = await this.ensureGuest(tab, running.controller.signal);
      if (!guest || safeBool(() => guest.isDestroyed(), true)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser tab '${command.tabId}' could not be restored for activation`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      // Legacy tabs.get creates the Tab binding only inside the agent; the renderer may still show another page.
      // Activation must atomically update main's selected state before notifying the origin renderer; the renderer expands
      // the view only when that scope is foreground - background conversations record activation, never stealing focus.
      this.selectTab(tab, true);
      return this.withMeta(
        {
          ok: true,
          tab: await this.summary(tab),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    if (command.method === "claimTab") {
      const candidate = this.tabs.get(command.tabId);
      if (!candidate || !this.canClaimUserTab(candidate, context)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `user browser tab '${command.tabId}' is unavailable or already claimed`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      const tab = this.claimTab(candidate, context);
      return this.withMeta(
        {
          ok: true,
          tab: await this.summary(tab),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    if (command.method === "finalizeTabs") {
      const keep = new Map(command.keep.map((item) => [item.tabId, item.status]));
      const unknown = [...keep.keys()].filter(
        (tabId) => !this.ownedTabs(context).some((tab) => tab.tabId === tabId),
      );
      if (unknown.length > 0) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `cannot finalize unknown tab(s): ${unknown.join(", ")}`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      this.finalizeTabs(context, keep);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context);
    }

    if (command.method === "newTab") {
      const tab = this.createTab(context);
      running.tabId = tab.tabId;
      this.refreshRuntimeProtection(tab.tabId);
      const guest = await this.ensureGuest(tab, running.controller.signal);
      if (!guest) {
        const result = this.cancelledOrUnavailable(context, running, startedAt, tab);
        // A newTab failing before the ready ack must not leave a guestless provisional tab; later list/attach
        // would mistake a canceled creation for a live tab. close also asks the renderer to unload and leaves a tombstone.
        await this.closeTabDurably(tab);
        return this.withMeta(result, context, tab, "closed");
      }
      return this.withMeta(
        {
          ok: true,
          tab: await this.summary(tab),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    const tab = this.resolveTab(context, "tabId" in command ? command.tabId : undefined);
    if (!tab) {
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "backend_unavailable",
            message:
              "tabId" in command && command.tabId
                ? `browser tab '${command.tabId}' is not visible in the current context. ${TAB_CONTEXT_RECOVERY_HINT}`
                : "browser tab is unavailable",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
      );
    }
    running.tabId = tab.tabId;
    this.refreshRuntimeProtection(tab.tabId);

    if (command.method === "recordingStart") {
      const active = [...this.recordings.values()].find(
        (entry) => entry.tabId === tab.tabId && entry.status === "running",
      );
      if (active) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "execution_error",
              message: `browser tab '${tab.tabId}' already has active recording '${active.id}'`,
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      const entry = this.createRecordingEntry(context, tab);
      this.recordings.set(entry.id, entry);
      this.refreshRuntimeProtection(tab.tabId);
      void this.runRecording(entry, tab, command.options).catch((error: unknown) => {
        if (entry.status !== "running") return;
        if (
          entry.controller.signal.aborted &&
          entry.controller.signal.reason instanceof DOMException &&
          entry.controller.signal.reason.name === "TimeoutError"
        ) {
          this.setRecordingTerminal(entry, "failed", entry.controller.signal.reason.message);
        } else if (entry.controller.signal.aborted) {
          this.setRecordingTerminal(entry, "cancelled");
        } else {
          this.setRecordingTerminal(
            entry,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
      return this.withMeta(
        {
          ok: true,
          recording: this.snapshotRecording(entry),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    if (command.method === "getDialog") {
      return this.withMeta(
        {
          ok: true,
          dialog: this.pendingDialogs.get(tab.tabId) ?? null,
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    if (command.method === "close") {
      await this.closeTabDurably(tab);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab, "closed");
    }
    if (command.method === "finalize") {
      tab.lifecycle = command.deliverable === false ? "active" : "deliverable";
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    if (command.method === "markDeliverable") {
      tab.lifecycle = "deliverable";
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    if (command.method === "markHandoff") {
      tab.lifecycle = "handoff";
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    if (command.method === "playwrightWaitForTimeout") {
      // Validate the tab before the fixed wait; the wait touches no page and needs no guest/CDP attach.
      // turn/session/request aborts must end the timer early so a canceled sleep holds no lifecycle.
      const completed = await waitForDelay(command.timeoutMs, running.controller.signal);
      if (!completed) {
        return this.withMeta(this.cancelledResult(context, false, startedAt), context, tab);
      }
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    if (
      command.method === "playwright" &&
      (command.action.name === "fileChooserSetFiles" ||
        (command.action.name === "waitForEvent" && command.action.event === "filechooser"))
    ) {
      // The IAB backend has no filechooser; never fake success or treat it as a plain DOM fill.
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "capability_unsupported",
            message: "File uploads are not supported by iab",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    if (command.method === "playwright" && command.action.name === "downloadPath") {
      const record = this.downloads.get(command.action.downloadId);
      if (!record || record.tabId !== tab.tabId) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: "download is unavailable for this tab",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      const status = await waitForCondition(
        // Playwright's download.path() resolves only after the download completes; a savePath present at will-download
        // does not mean the file is safely readable, so do not resolve early.
        () => record.state !== "pending",
        command.action.timeoutMs ?? 30_000,
        running.controller.signal,
      );
      if (status === "cancelled") {
        return this.withMeta(this.cancelledResult(context, false, startedAt), context, tab);
      }
      if (status === "timeout") {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "timeout",
              message: "Timeout waiting for download path",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      if (record.state !== "completed") {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "execution_error",
              message: `download ${record.state}`,
              sideEffect: "uncertain",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      return this.withMeta(
        { ok: true, value: record.path, elapsedMs: Date.now() - startedAt },
        context,
        tab,
      );
    }

    const guest = await this.ensureGuest(tab, running.controller.signal);
    if (!guest) return this.cancelledOrUnavailable(context, running, startedAt, tab);
    if (safeBool(() => guest.isDestroyed(), false)) {
      this.detachGuest(tab);
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: "browser guest destroyed",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    if ((tab.viewportOverride || tab.backgroundViewportFallback) && guest.getZoomFactor() !== 1)
      guest.setZoomFactor(1);
    const guestGeneration = tab.guestGeneration;
    const assertCurrentGuest = (): void => {
      if (tab.guestLifecycle === "detaching") {
        throw new Error("browser guest is detaching");
      }
      if (
        tab.guest !== guest ||
        tab.guestGeneration !== guestGeneration ||
        safeBool(() => guest.isDestroyed(), true)
      ) {
        throw new Error("browser guest changed before command dispatch");
      }
    };
    const sendCdpCommand = (method: string, params?: unknown, sessionId?: string) =>
      this.sendGuestCdpCommand(tab, guest, method, params, sessionId, assertCurrentGuest);

    if (
      command.method === "playwright" &&
      command.action.name === "waitForEvent" &&
      command.action.event === "download"
    ) {
      const downloadId = await this.waitForDownload(
        tab.tabId,
        // Download events wait 3s by default; callers may extend to at most 120s for real downloads.
        normalizePlaywrightTimeout(command.action.timeoutMs, 120_000),
        running.controller.signal,
      );
      if (!downloadId) {
        const result = running.controller.signal.aborted
          ? this.cancelledResult(context, false, startedAt)
          : {
              ok: false as const,
              error: {
                code: "timeout" as const,
                message: "Timeout waiting for download",
              },
              elapsedMs: Date.now() - startedAt,
            };
        return this.withMeta(result, context, tab);
      }
      return this.withMeta(
        {
          ok: true,
          value: { id: downloadId },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    if (command.method === "handleDialog") {
      try {
        assertCurrentGuest();
      } catch {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: "browser guest changed before command dispatch",
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      running.dispatched = true;
      const execution = sendCdpCommand("Page.handleJavaScriptDialog", {
        accept: command.accept,
        ...(command.promptText !== undefined ? { promptText: command.promptText } : {}),
      })
        .then<BrowserCommandResult>(() => ({
          ok: true,
          elapsedMs: Date.now() - startedAt,
        }))
        .catch<BrowserCommandResult>((error: unknown) => ({
          ok: false,
          error: {
            code: "execution_error",
            message: error instanceof Error ? error.message : String(error),
          },
          elapsedMs: Date.now() - startedAt,
        }));
      const result = await raceBackendExecution(
        execution,
        running.controller.signal,
        command,
        startedAt,
      );
      if (result.ok) {
        this.pendingDialogs.delete(tab.tabId);
      }
      return this.withMeta(result, context, tab);
    }

    const screenshotCommand = isScreenshotCommand(command);
    const previousScreenshot = screenshotCommand
      ? this.inFlightScreenshots.get(tab.tabId)
      : undefined;
    if (previousScreenshot && this.isInFlightScreenshotAlive(previousScreenshot)) {
      const elapsedMs = Date.now() - previousScreenshot.startedAt;
      this.log?.(
        `[browser-use] screenshot rejected tabId=${tab.tabId} requestId=${context.requestId} pendingRequestId=${previousScreenshot.requestId} pendingMs=${elapsedMs}`,
      );
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "timeout",
            message:
              "A previous screenshot for this browser tab is still completing after timeout. " +
              "Wait before retrying, or reopen the tab if it does not recover.",
            sideEffect: "none",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    const abandonedCaptures = screenshotCommand
      ? (this.abandonedScreenshotCaptures.get(tab.tabId) ?? 0)
      : 0;
    if (screenshotCommand && abandonedCaptures >= MAX_ABANDONED_SCREENSHOT_CAPTURES) {
      // Unsettled underlying captures hit the hard cap: stop stacking pending CDP commands, fail fast
      // and hint to reopen the tab; slots recycle once old captures settle - recovery without manual action.
      this.log?.(
        `[browser-use] screenshot rejected tabId=${tab.tabId} requestId=${context.requestId} abandonedCaptures=${abandonedCaptures}`,
      );
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "timeout",
            message:
              `${abandonedCaptures} previous screenshot captures for this browser tab are still ` +
              "stuck in the backend after timeout. Reopen the tab to recover.",
            sideEffect: "none",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    if (previousScreenshot) {
      // While a full capture waits for frames in a hidden window, the 30s watchdog declares death but the underlying execution
      // never settles, the tracker cannot clean up, and every later screenshot on the tab is rejected at 0ms
      // until the tab closes (logs show pendingMs up to 120s). Pending screenshots whose command returned or
      // was aborted count as dead entries, replaced by the new request; cleanup is idempotent by entry identity, so a late settle never deletes the newer request.
      this.log?.(
        `[browser-use] screenshot superseded stale pending tabId=${tab.tabId} requestId=${context.requestId} pendingRequestId=${previousScreenshot.requestId} pendingMs=${Date.now() - previousScreenshot.startedAt}`,
      );
    }

    const execution = screenshotCommand
      ? this.executeScreenshotWithPreparedSurface(
          context,
          tab,
          guest,
          command,
          running,
          startedAt,
          assertCurrentGuest,
          sendCdpCommand,
        )
      : executeBrowserCommandOnView(
          this.toControlledView(
            guest,
            Boolean(tab.viewportOverride || tab.backgroundViewportFallback),
            undefined,
            assertCurrentGuest,
            sendCdpCommand,
          ),
          command,
          { signal: running.controller.signal },
        );
    if (!screenshotCommand) running.dispatched = true;
    if (screenshotCommand) {
      const tracked: InFlightScreenshot = {
        execution,
        requestId: context.requestId,
        startedAt: Date.now(),
      };
      this.inFlightScreenshots.set(tab.tabId, tracked);
      this.refreshRuntimeProtection(tab.tabId);
      const clearTrackedScreenshot = () => {
        if (this.inFlightScreenshots.get(tab.tabId) !== tracked) return;
        this.inFlightScreenshots.delete(tab.tabId);
        this.refreshRuntimeProtection(tab.tabId);
        this.log?.(
          `[browser-use] screenshot backend settled tabId=${tab.tabId} requestId=${context.requestId} elapsedMs=${Date.now() - tracked.startedAt}`,
        );
      };
      // Attach both fulfilled/rejected handlers; relying on finally alone creates an unhandled derived rejection.
      void execution.then(clearTrackedScreenshot, clearTrackedScreenshot);
    }
    const result = await raceBackendExecution(
      execution,
      running.controller.signal,
      command,
      startedAt,
    );
    return this.withMeta(result, context, tab);
  }

  /**
   * The renderer's logical viewport ready proves only the CSS coordinate space; under negative Windows scaling a
   * Fit preview can still be an 800x450 raster that CDP tiles into 1280x720. main reads the
   * composited guest surface and normalizes to the logical viewport; this bypasses the renderer
   * `<webview>.capturePage()` path that triggered V8 FATAL, changing no layout, DPR, or interaction metrics.
   */
  private async executeScreenshotWithPreparedSurface(
    context: InternalExecutionContext,
    tab: ManagedTab,
    guest: GuestWebContents,
    command: BrowserCommand,
    running: RunningRequest,
    startedAt: number,
    assertCurrentGuest: () => void,
    sendCdpCommand: ControlledView["cdp"]["send"],
  ): Promise<BrowserCommandResult> {
    let lease: BrowserScreenshotSurfaceLease | undefined;
    try {
      const screenshotSurfaceCoordinator = this.screenshotSurfaceCoordinator;
      if (!screenshotSurfaceCoordinator) {
        throw new Error("browser screenshot surface coordinator is unavailable");
      }
      const viewport = await this.readTabViewport(tab);
      let result: BrowserCommandResult | undefined;

      // Never acquire activity and then queue the viewport mutation: if an earlier resize/CDP hangs,
      // owner + guest capture back-to-back outside the queue for up to 35s. Surface preparation starts only
      // after this viewport critical section, so activity covers exactly prepare + raster lifetime.
      await this.enqueueViewportMutation(tab, async () => {
        lease = await screenshotSurfaceCoordinator.prepare({
          requestId: context.requestId,
          windowId: context.windowId,
          workspaceKey: context.workspaceKey,
          sessionId: context.sessionId,
          browserId: context.browserId,
          browserGeneration: context.browserGeneration,
          tabId: tab.tabId,
          webContentsId: guest.id,
          viewport,
          // The natural viewport has no metrics; a temporary Fit from the renderer must not expand guest layout or reflow the page.
          viewportMode:
            tab.viewportOverride || tab.backgroundViewportFallback ? "emulated" : "natural",
          signal: running.controller.signal,
        });
        if (
          running.controller.signal.aborted ||
          tab.guest !== guest ||
          guest.isDestroyed() ||
          lease.webContentsId !== guest.id
        ) {
          throw new Error("browser guest changed while preparing screenshot surface");
        }
        const invalidationError = readScreenshotSurfaceInvalidation(lease.invalidated);
        if (invalidationError) throw invalidationError;
        // The plain fallback also uses a temporary responsive surface; compensate the native raster after host upscaling.
        // Plain mode never writes the viewport back; on hot zoom change, sync within the same mutation, not at idle reconnect.
        if (tab.backgroundViewportFallback) {
          const desktopZoom = guest.hostWebContents?.getZoomFactor();
          if (
            !guest.debugger.isAttached() ||
            tab.guestCdpRestoreFlight ||
            (tab.appliedViewportScale ?? 1) !== normalizeDesktopZoomMetricsScale(desktopZoom)
          ) {
            await this.sendGuestCdpCommand(
              tab,
              guest,
              "Emulation.setDeviceMetricsOverride",
              buildViewportMetricsOverride(tab.backgroundViewportFallback, desktopZoom),
            );
          }
        }
        const normalizedScreenshot = Boolean(
          tab.viewportOverride || tab.backgroundViewportFallback,
        );
        // Windows 125% display scaling + Desktop 110%: even with the renderer reporting
        // surfaceScale=1, CDP periodically tiles the smaller native raster up to the target size.
        // Upscale-compensated viewport screenshots also read the actual surface, then normalize to CSS px.
        const captureViewportScreenshot =
          normalizedScreenshot &&
          (lease.surfaceScale < 0.999 ||
            (tab.appliedViewportScale ?? tab.desktopZoomFactor ?? 1) > 1)
            ? async (): Promise<string | undefined> => {
                if (!this.resizeScreenshotToCssPixels) {
                  throw new Error("browser screenshot CSS pixel normalizer is unavailable");
                }
                const surface = await guest.capturePage();
                const surfacePng = surface.toPNG();
                if (surfacePng.byteLength === 0) return undefined;
                return this.resizeScreenshotToCssPixels(surfacePng.toString("base64"), viewport);
              }
            : undefined;
        running.dispatched = true;
        // With the owner window hidden (closed to tray) the Windows compositor composites no
        // guest frames, and the prepare-phase transparent bootstrap released early on renderer ready, so a full capture
        // gets frames only after the user reopens the window (logs: ~140ms after tray-show,
        // everything else dies at the 30s watchdog). Hold a transparent presentation for the capture lifetime
        // (showInactive + opacity 0, invisible to the user) to request frames; also race the capture settle against
        // abort/bounded deadline - a dangling execution drags the viewport mutation queue and in-flight
        // slots down with it; a mutation must never outlive its request.
        const capturePresentation = this.startHiddenWindowCapturePresentation(context, guest);
        try {
          // Same constraint as the activity pump: a same-turn read after showInactive throws
          // UnknownVizError before the Viz surface exists. Wait for the shared bounded presentation grace, then capture -
          // the normalization path (background tab) via guest.capturePage() is equally sensitive.
          if (
            capturePresentation &&
            !(await waitForDelay(
              TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS,
              running.controller.signal,
            ))
          ) {
            throw new Error("browser screenshot capture cancelled during presentation grace");
          }
          // Native capture bypasses sendCdpCommand yet still waits for post-idle-detach metrics restore.
          if (!guest.debugger.isAttached() || tab.guestCdpRestoreFlight) {
            await this.ensureGuestCdpAttached(tab, guest);
          }
          const captureExecution = executeBrowserCommandOnView(
            this.toControlledView(
              guest,
              normalizedScreenshot,
              captureViewportScreenshot,
              assertCurrentGuest,
              sendCdpCommand,
            ),
            command,
            { signal: running.controller.signal },
          );
          result = await this.settleScreenshotCapture(
            captureExecution,
            running.controller.signal,
            context,
            startedAt,
            tab.tabId,
            capturePresentation ? HIDDEN_WINDOW_CAPTURE_DEADLINE_MS : undefined,
          );
        } finally {
          capturePresentation?.release();
        }
        const lateInvalidationError = readScreenshotSurfaceInvalidation(lease.invalidated);
        if (lateInvalidationError) throw lateInvalidationError;
      });
      if (!result) throw new Error("browser screenshot did not produce a result");
      return result;
    } catch (error) {
      const cancelled = running.controller.signal.aborted;
      return {
        ok: false,
        error: {
          code: cancelled ? "cancelled" : "backend_unavailable",
          message: cancelled
            ? "browser screenshot surface preparation cancelled"
            : error instanceof Error
              ? error.message
              : String(error),
          sideEffect: "none",
        },
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      lease?.release();
    }
  }

  /** One-shot transparent presentation for full capture while the window is hidden; no-op when visible or capability missing. */
  private startHiddenWindowCapturePresentation(
    context: InternalExecutionContext,
    guest: GuestWebContents,
  ): TransparentWindowBootstrap | undefined {
    if (!this.resolveOwnerWindow) return undefined;
    const win = this.resolveOwnerWindow(context.windowId);
    if (!win) return undefined;
    return (
      startBrowserScreenshotTransparentWindowBootstrap({
        win,
        enabled: true,
        windowId: context.windowId,
        webContentsId: guest.id,
        requestId: context.requestId,
        hideTaskbarDuringBootstrap: process.platform === "win32",
        log: this.log,
      }) || undefined
    );
  }

  /**
   * Single settlement exit for capture: execution, request abort, optional bounded deadline - first arrival settles.
   * When hidden-window frame waits or an upstream 30s cancelRequest leave execution unsettled forever, do not wait:
   * the viewport mutation queue and in-flight slots release with the request. If abort/deadline wins, the underlying
   * CDP command stays pending in Chromium and counts toward the abandonedScreenshotCaptures cap.
   */
  private async settleScreenshotCapture(
    execution: Promise<BrowserCommandResult>,
    signal: AbortSignal,
    context: InternalExecutionContext,
    startedAt: number,
    tabId: string,
    deadlineMs?: number,
  ): Promise<BrowserCommandResult> {
    return await new Promise<BrowserCommandResult>((resolve) => {
      let settled = false;
      const finish = (result: BrowserCommandResult): boolean => {
        if (settled) return false;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(result);
        return true;
      };
      const onAbort = () => {
        if (
          finish({
            ok: false,
            error: {
              code: "cancelled",
              message: "browser screenshot capture cancelled",
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          })
        ) {
          this.abandonBackendCapture(tabId, execution);
        }
      };
      const timer =
        deadlineMs !== undefined
          ? setTimeout(() => {
              this.log?.(
                `[browser-use] hidden window capture deadline exceeded requestId=${context.requestId} windowId=${context.windowId} deadlineMs=${deadlineMs}`,
              );
              if (
                finish({
                  ok: false,
                  error: {
                    code: "timeout",
                    message: `browser screenshot capture timed out after ${deadlineMs}ms while the window was hidden`,
                    sideEffect: "none",
                  },
                  elapsedMs: Date.now() - startedAt,
                })
              ) {
                this.abandonBackendCapture(tabId, execution);
              }
            }, deadlineMs)
          : undefined;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      execution.then(finish, (error: unknown) =>
        finish({
          ok: false,
          error: {
            code: "execution_error",
            message: error instanceof Error ? error.message : String(error),
          },
          elapsedMs: Date.now() - startedAt,
        }),
      );
    });
  }

  /** Record a capture abandoned while waiting but still executing; its slot recycles once it settles. */
  private abandonBackendCapture(tabId: string, execution: Promise<BrowserCommandResult>): void {
    this.abandonedScreenshotCaptures.set(
      tabId,
      (this.abandonedScreenshotCaptures.get(tabId) ?? 0) + 1,
    );
    execution.then(
      () => this.releaseAbandonedBackendCapture(tabId),
      () => this.releaseAbandonedBackendCapture(tabId),
    );
  }

  private releaseAbandonedBackendCapture(tabId: string): void {
    const count = this.abandonedScreenshotCaptures.get(tabId);
    if (count === undefined) return;
    if (count <= 1) this.abandonedScreenshotCaptures.delete(tabId);
    else this.abandonedScreenshotCaptures.set(tabId, count - 1);
  }

  private recordingNow(): number {
    return this.residencyOptions.recording?.now?.() ?? Date.now();
  }

  /**
   * Is the pending screenshot still alive: its command is still executing (an un-aborted runningRequests entry).
   * A missing entry means the command returned long ago (typically the 30s watchdog) while execution dangles - a dead slot.
   */
  private isInFlightScreenshotAlive(tracked: InFlightScreenshot): boolean {
    const running = this.runningRequests.get(tracked.requestId);
    return Boolean(running) && !running.controller.signal.aborted;
  }

  private createRecordingEntry(
    context: InternalExecutionContext,
    tab: ManagedTab,
  ): BrowserRecordingEntry {
    const now = this.recordingNow();
    return {
      id: `iab-recording:${randomUUID()}`,
      context: { ...context },
      tabId: tab.tabId,
      controller: new AbortController(),
      status: "running",
      phase: "preparing",
      progress: 0,
      startedAt: now,
      updatedAt: now,
    };
  }

  private snapshotRecording(entry: BrowserRecordingEntry): BrowserRecordingJob {
    return {
      id: entry.id,
      status: entry.status,
      phase: entry.phase,
      progress: entry.progress,
      startedAt: entry.startedAt,
      updatedAt: entry.updatedAt,
      ...(entry.artifact ? { artifact: { ...entry.artifact } } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    };
  }

  private setRecordingPhase(
    entry: BrowserRecordingEntry,
    phase: Extract<BrowserRecordingJob["phase"], "capturing" | "finalizing">,
  ): void {
    if (entry.status !== "running") return;
    entry.phase = phase;
    entry.progress = phase === "capturing" ? 0.1 : 0.9;
    entry.updatedAt = this.recordingNow();
    this.refreshRuntimeProtection(entry.tabId);
  }

  private setRecordingTerminal(
    entry: BrowserRecordingEntry,
    status: Extract<BrowserRecordingJob["status"], "completed" | "failed" | "cancelled">,
    error?: string,
  ): void {
    entry.status = status;
    entry.phase = status;
    entry.progress = status === "completed" ? 1 : entry.progress;
    entry.updatedAt = this.recordingNow();
    if (error) entry.error = error;
    else delete entry.error;
    if (!entry.cleanupTimer) {
      entry.cleanupTimer = setTimeout(() => {
        this.recordings.delete(entry.id);
        if (entry.artifact?.path) {
          void rm(entry.artifact.path, { force: true }).catch(() => undefined);
        }
      }, RECORDING_RESULT_TTL_MS);
      entry.cleanupTimer.unref?.();
    }
    this.refreshRuntimeProtection(entry.tabId);
  }

  private abortRecordings(
    predicate: (entry: BrowserRecordingEntry) => boolean,
    reason: string,
  ): void {
    for (const entry of this.recordings.values()) {
      if (entry.status !== "running" || !predicate(entry)) continue;
      entry.controller.abort(new DOMException(reason, "AbortError"));
      this.setRecordingTerminal(entry, "cancelled");
    }
  }

  private async runRecording(
    entry: BrowserRecordingEntry,
    tab: ManagedTab,
    rawOptions?: BrowserRecordingOptions,
  ): Promise<void> {
    const signal = entry.controller.signal;
    const options = rawOptions ?? {};
    const viewport = options.viewport ?? DEFAULT_AGENT_BROWSER_VIEWPORT;
    const fps = options.fps ?? 25;
    const maxDurationMs = options.maxDurationMs ?? 60_000;
    const settleMs = options.settleMs ?? 300;
    assertViewportOverride(viewport);

    const guest = await this.ensureGuest(tab, signal);
    if (!guest || guest.isDestroyed()) throw new Error("browser guest unavailable for recording");
    // Recording temporarily rewrites the tab viewport override for a 100% surface; remember the pre-recording value.
    const previousViewport = tab.viewportOverride ? { ...tab.viewportOverride } : undefined;
    let lease: BrowserScreenshotSurfaceLease | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.setTabViewport(tab, viewport);
      // Changing only CDP metrics does not resize the renderer's free-size frame hosting the WebView; a custom recording
      // viewport keeps the old DOM bounds and either times out in prepare or upscales a shrunk surface into blur.
      this.onViewportChanged?.(viewport, tab.owner, tab.tabId);
      const coordinator = this.screenshotSurfaceCoordinator;
      if (!coordinator) throw new Error("browser recording surface coordinator is unavailable");
      lease = await coordinator.prepare({
        requestId: `recording:${entry.id}`,
        windowId: entry.context.windowId,
        workspaceKey: entry.context.workspaceKey,
        sessionId: entry.context.sessionId,
        browserId: entry.context.browserId,
        browserGeneration: entry.context.browserGeneration,
        tabId: tab.tabId,
        webContentsId: guest.id,
        viewport,
        surfaceScaleMode: "unscaled",
        signal,
        activityTimeoutMs: maxDurationMs + 30_000,
      });
      if (!lease || lease.webContentsId !== guest.id) {
        throw new Error("browser guest changed while preparing recording surface");
      }
      const invalidationError = readScreenshotSurfaceInvalidation(lease.invalidated);
      if (invalidationError) throw invalidationError;
      const invalidateRecording = () =>
        entry.controller.abort(
          lease?.invalidated?.reason instanceof Error
            ? lease.invalidated.reason
            : new Error("browser recording surface invalidated"),
        );
      lease.invalidated?.addEventListener("abort", invalidateRecording, { once: true });
      timeout = setTimeout(
        () =>
          entry.controller.abort(new DOMException("browser recording timed out", "TimeoutError")),
        maxDurationMs,
      );
      const guestGeneration = tab.guestGeneration;
      const assertCurrentGuest = (): void => {
        if (tab.guestLifecycle === "detaching") {
          throw new Error("browser guest is detaching");
        }
        if (
          tab.guest !== guest ||
          tab.guestGeneration !== guestGeneration ||
          safeBool(() => guest.isDestroyed(), true)
        ) {
          throw new Error("browser guest changed before recording dispatch");
        }
      };
      const view = this.toControlledView(
        guest,
        true,
        undefined,
        assertCurrentGuest,
        (method, params, sessionId) =>
          this.sendGuestCdpCommand(tab, guest, method, params, sessionId, assertCurrentGuest),
      );
      if (options.showCursor !== false) await this.installRecordingCursorOverlay(guest);
      const createRecorder = this.residencyOptions.recording?.createRecorder;
      if (!createRecorder) throw new Error("browser WebM recorder is unavailable");
      entry.artifact = await recordBrowserVideo({
        targetFrame: guest.mainFrame,
        tempRoot: this.residencyOptions.recording?.tempRoot ?? tmpdir(),
        recordingId: entry.id.replace(/[^A-Za-z0-9._-]/gu, "-"),
        viewport,
        fps,
        signal,
        onPhase: (phase) => this.setRecordingPhase(entry, phase),
        onCaptureComplete: () => {
          // maxDurationMs bounds scene framing only; encoding is finalization - never kill an already fully captured video.
          if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
          }
          lease?.release();
        },
        executeScenario: async () => {
          if (settleMs > 0 && !(await waitForDelay(settleMs, signal))) throw abortError();
          await this.executeRecordingActions(view, options.actions ?? [], signal, viewport);
        },
        createRecorder,
      });
      this.setRecordingTerminal(entry, "completed");
    } finally {
      if (timeout) clearTimeout(timeout);
      if (options.showCursor !== false) await this.removeRecordingCursorOverlay(guest);
      // lease.release() returns only the transient surface ratio; the tab's own viewport override stays
      // at the recording size, so later previews and screenshots follow it. Recording is a temporary borrow; restore it.
      await this.restoreRecordingViewport(tab, previousViewport).catch(() => undefined);
      lease?.release();
    }
  }

  /** Hand a tab viewport rewritten for recording back to its pre-recording state. */
  private async restoreRecordingViewport(
    tab: ManagedTab,
    previous: BrowserViewportSize | undefined,
  ): Promise<void> {
    if (tab.lifecycle === "closed") return;
    if (previous) {
      await this.setTabViewport(tab, previous);
      this.onViewportChanged?.(previous, tab.owner, tab.tabId);
      return;
    }
    await this.resetTabViewport(tab);
    this.onViewportChanged?.(null, tab.owner, tab.tabId);
  }

  private async executeRecordingActions(
    view: ControlledView,
    actions: BrowserRecordingAction[],
    signal: AbortSignal,
    viewport: BrowserViewportSize,
  ): Promise<void> {
    const pointer = { x: viewport.width / 2, y: viewport.height / 2 };
    for (const action of actions) {
      if (signal.aborted) throw abortError();
      await this.executeRecordingAction(view, action, signal, pointer);
      const delayAfterMs = "delayAfterMs" in action ? action.delayAfterMs : undefined;
      if (delayAfterMs && !(await waitForDelay(delayAfterMs, signal))) throw abortError();
    }
  }

  private async executeRecordingAction(
    view: ControlledView,
    action: BrowserRecordingAction,
    signal: AbortSignal,
    pointer: { x: number; y: number },
  ): Promise<void> {
    if (action.type === "wait") {
      if (!(await waitForDelay(action.durationMs, signal))) throw abortError();
      return;
    }
    if (action.type === "click" || action.type === "type" || action.type === "waitFor") {
      const locatorAction =
        action.type === "click"
          ? action.selector
            ? {
                name: "locator" as const,
                selector: action.selector,
                operation: action.doubleClick ? ("dblclick" as const) : ("click" as const),
                ...(action.button ? { button: action.button } : {}),
              }
            : undefined
          : action.type === "type"
            ? {
                name: "locator" as const,
                selector: action.selector,
                operation: "fill" as const,
                value: action.text,
              }
            : {
                name: "locator" as const,
                selector: action.selector,
                operation: "waitFor" as const,
                state: action.state ?? "visible",
              };
      if (locatorAction) {
        const result = await executeIabPlaywrightLocator(
          view,
          locatorAction,
          action.type === "waitFor" ? (action.timeoutMs ?? 3_000) : 3_000,
          signal,
        );
        if (result.kind === "cancelled") throw abortError();
        if (result.kind === "timeout")
          throw new Error(`recording action timed out: ${result.reason}`);
        return;
      }
      if (typeof action.x !== "number" || typeof action.y !== "number") {
        throw new Error("recording click requires selector or (x,y)");
      }
      await this.executeRecordingBrowserCommand(view, {
        method: "click",
        x: action.x,
        y: action.y,
        ...(action.button ? { button: action.button } : {}),
        ...(action.doubleClick !== undefined ? { doubleClick: action.doubleClick } : {}),
      });
      pointer.x = action.x;
      pointer.y = action.y;
      return;
    }
    if (action.type === "hover") {
      if (action.selector) {
        const point = await this.resolveRecordingSelectorPoint(view, action.selector, signal);
        await this.moveRecordingPointer(
          view,
          point.x,
          point.y,
          action.durationMs ?? 0,
          signal,
          pointer,
        );
      } else if (typeof action.x === "number" && typeof action.y === "number") {
        await this.moveRecordingPointer(
          view,
          action.x,
          action.y,
          action.durationMs ?? 0,
          signal,
          pointer,
        );
      } else {
        throw new Error("recording hover requires selector or (x,y)");
      }
      return;
    }
    if (action.type === "move") {
      await this.moveRecordingPointer(
        view,
        action.x,
        action.y,
        action.durationMs ?? 0,
        signal,
        pointer,
      );
      return;
    }
    if (action.type === "scroll") {
      await this.animateRecordingScroll(
        view,
        action.deltaX ?? 0,
        action.deltaY,
        action.durationMs ?? 0,
        signal,
      );
      return;
    }
    if (action.type === "scrollTo") {
      const current = (await view.webContents.executeJavaScript(
        "({ x: window.scrollX, y: window.scrollY })",
      )) as { x?: unknown; y?: unknown };
      const target = action.selector
        ? await this.resolveRecordingSelectorScrollTarget(view, action.selector, signal)
        : { x: action.x ?? Number(current.x ?? 0), y: action.y ?? Number(current.y ?? 0) };
      await this.animateRecordingScroll(
        view,
        target.x - Number(current.x ?? 0),
        target.y - Number(current.y ?? 0),
        action.durationMs ?? 0,
        signal,
      );
      return;
    }
    if (action.type === "wheel") {
      const times = action.times ?? 1;
      for (let index = 0; index < times; index += 1) {
        await this.executeRecordingBrowserCommand(view, {
          method: "scroll",
          x: action.deltaX ?? 0,
          y: action.deltaY,
        });
        if (action.intervalMs && !(await waitForDelay(action.intervalMs, signal)))
          throw abortError();
      }
      return;
    }
    if (action.type === "drag") {
      const steps = Math.max(1, action.path.length - 1);
      const intervalMs = Math.floor((action.durationMs ?? 0) / steps);
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: action.path[0]!.x,
        y: action.path[0]!.y,
      });
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: action.path[0]!.x,
        y: action.path[0]!.y,
        button: "left",
        clickCount: 1,
      });
      for (const point of action.path.slice(1)) {
        await view.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: point.x,
          y: point.y,
          button: "left",
          buttons: 1,
        });
        if (intervalMs > 0 && !(await waitForDelay(intervalMs, signal))) throw abortError();
      }
      const last = action.path.at(-1)!;
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: last.x,
        y: last.y,
        button: "left",
        clickCount: 1,
      });
      pointer.x = last.x;
      pointer.y = last.y;
    }
  }

  private async executeRecordingBrowserCommand(
    view: ControlledView,
    command: BrowserCommand,
  ): Promise<void> {
    const result = await executeBrowserCommandOnView(view, command);
    if (!result.ok)
      throw new Error(result.error?.message ?? `recording action ${command.method} failed`);
  }

  private async resolveRecordingSelectorPoint(
    view: ControlledView,
    selector: string,
    signal: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const result = await executeIabPlaywrightLocator(
      view,
      {
        name: "locator",
        selector,
        operation: "evaluate",
        expressionKind: "function",
        expression:
          "(element) => { const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }",
      },
      3_000,
      signal,
    );
    if (result.kind !== "done" || !isBrowserPointValue(result.value)) {
      throw new Error(`recording selector '${selector}' has no visible point`);
    }
    return result.value;
  }

  private async resolveRecordingSelectorScrollTarget(
    view: ControlledView,
    selector: string,
    signal: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const result = await executeIabPlaywrightLocator(
      view,
      {
        name: "locator",
        selector,
        operation: "evaluate",
        expressionKind: "function",
        expression:
          "(element) => { const rect = element.getBoundingClientRect(); return { x: window.scrollX + rect.left, y: window.scrollY + rect.top }; }",
      },
      3_000,
      signal,
    );
    if (result.kind !== "done" || !isBrowserPointValue(result.value)) {
      throw new Error(`recording selector '${selector}' has no scroll target`);
    }
    return result.value;
  }

  private async moveRecordingPointer(
    view: ControlledView,
    x: number,
    y: number,
    durationMs: number,
    signal: AbortSignal,
    pointer: { x: number; y: number },
  ): Promise<void> {
    const steps = Math.max(1, Math.min(60, Math.round(durationMs / 16)));
    const startX = pointer.x;
    const startY = pointer.y;
    for (let index = 1; index <= steps; index += 1) {
      if (signal.aborted) throw abortError();
      const progress = index / steps;
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: startX + (x - startX) * progress,
        y: startY + (y - startY) * progress,
      });
      if (durationMs > 0 && index < steps && !(await waitForDelay(durationMs / steps, signal))) {
        throw abortError();
      }
    }
    pointer.x = x;
    pointer.y = y;
  }

  private async installRecordingCursorOverlay(guest: GuestWebContents): Promise<void> {
    await guest.executeJavaScript(`(() => {
      const id = "__zcode_browser_recording_cursor";
      document.getElementById(id)?.remove();
      const cursor = document.createElement("div");
      cursor.id = id;
      cursor.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;border-radius:50%;background:#ff4d4f;border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45);pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);opacity:0;transition:opacity 80ms linear";
      document.documentElement.appendChild(cursor);
      const move = (event) => {
        cursor.style.left = event.clientX + "px";
        cursor.style.top = event.clientY + "px";
        cursor.style.opacity = "1";
      };
      const down = () => {
        cursor.style.transform = "translate(-50%,-50%) scale(.72)";
      };
      const up = () => {
        cursor.style.transform = "translate(-50%,-50%) scale(1)";
      };
      window["__zcodeBrowserRecordingCursorCleanup"]?.();
      window.addEventListener("mousemove", move, true);
      window.addEventListener("mousedown", down, true);
      window.addEventListener("mouseup", up, true);
      window["__zcodeBrowserRecordingCursorCleanup"] = () => {
        window.removeEventListener("mousemove", move, true);
        window.removeEventListener("mousedown", down, true);
        window.removeEventListener("mouseup", up, true);
        cursor.remove();
        delete window["__zcodeBrowserRecordingCursorCleanup"];
      };
    })()`);
  }

  private async removeRecordingCursorOverlay(guest: GuestWebContents): Promise<void> {
    if (guest.isDestroyed()) return;
    await guest
      .executeJavaScript('window["__zcodeBrowserRecordingCursorCleanup"]?.()')
      .catch(() => undefined);
  }

  private async animateRecordingScroll(
    view: ControlledView,
    deltaX: number,
    deltaY: number,
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const steps = Math.max(1, Math.min(60, Math.round(durationMs / 16)));
    for (let index = 0; index < steps; index += 1) {
      await this.executeRecordingBrowserCommand(view, {
        method: "scroll",
        x: deltaX / steps,
        y: deltaY / steps,
      });
      if (
        durationMs > 0 &&
        index + 1 < steps &&
        !(await waitForDelay(durationMs / steps, signal))
      ) {
        throw abortError();
      }
    }
  }

  private resolveTab(
    context: InternalExecutionContext,
    explicitTabId?: string,
  ): ManagedTab | undefined {
    if (explicitTabId) {
      const explicit = this.tabs.get(explicitTabId);
      if (!explicit || explicit.lifecycle === "closed" || !sameScope(explicit.owner, context)) {
        return undefined;
      }
      return explicit;
    }
    const key = scopeKey(context);
    const activeId = this.activeTabByScope.get(key);
    const active = activeId ? this.tabs.get(activeId) : undefined;
    if (active && active.lifecycle !== "closed" && sameScope(active.owner, context)) return active;
    const defaultId = this.defaultTabByScope.get(key);
    const existingDefault = defaultId ? this.tabs.get(defaultId) : undefined;
    if (
      existingDefault &&
      existingDefault.lifecycle !== "closed" &&
      sameScope(existingDefault.owner, context)
    ) {
      return existingDefault;
    }
    // Background session (renderer reports active:false) with the tab created via explicit newTab: activeTabByScope and
    // defaultTabByScope are both empty. Reuse the scope's most recent living tab, or tabId-less commands
    // open a fresh empty tab and tabs.list()'s active diverges from the real target.
    const recent = this.ownedTabs(context).at(-1);
    if (recent) return recent;
    return this.createTab(context, context.legacy ? context.sessionId : undefined, true);
  }

  private createTab(
    context: InternalExecutionContext,
    preferredTabId?: string,
    makeDefault = false,
  ): ManagedTab {
    const tabId = preferredTabId ?? `iab-tab:${randomUUID()}`;
    const existing = this.tabs.get(tabId);
    if (existing && existing.lifecycle !== "closed" && sameScope(existing.owner, context)) {
      return existing;
    }
    const tab: ManagedTab = {
      tabId,
      owner: { ...context },
      cdpAttached: false,
      guestLifecycle: "detached",
      pendingCdpCommands: 0,
      guestGeneration: 0,
      hasAttachedGuest: false,
      rebindRequested: false,
      lifecycle: "active",
      origin: "agent",
      claimable: false,
      active: false,
      loading: false,
      mediaActive: false,
      cachedUrl: "",
      cachedTitle: "",
      cachedFaviconUrl: null,
      openedAt: this.now(),
      // Model-created tabs (explicit newTab, or implicit with none) default to desktop free-size.
      // Viewport is a creation-time fact; claim/activate/navigate reuse the tab and never re-apply defaults.
      viewportOverride: { ...DEFAULT_AGENT_BROWSER_VIEWPORT },
    };
    this.tabs.set(tabId, tab);
    this.registerTabResidency(tab, false);
    void this.persistShell(tab);
    if (makeDefault) this.defaultTabByScope.set(scopeKey(context), tabId);
    return tab;
  }

  private async ensureGuest(
    tab: ManagedTab,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    if (signal.aborted) return null;
    const suspendFlight = this.suspendFlights.get(tab.tabId);
    if (suspendFlight) {
      // The protecting state can only cancel the coordinator generation; it cannot yet prove the renderer stayed mounted.
      // Browser commands wait for snapshot/ack/required restore to converge, never reuse a guest about to die.
      const settled = await waitForPromiseWithSignal(suspendFlight, signal);
      if (!settled.completed) return null;
    }
    const residency = this.residencyCoordinator.get(tab.tabId);
    if (residency?.residency === "suspended" || residency?.residency === "restoring") {
      return await this.restoreSuspendedGuest(tab, signal);
    }
    if (tab.guest && !safeBool(() => tab.guest!.isDestroyed(), true)) {
      return await this.waitForGuestRecovery(tab, tab.guest, signal);
    }
    if (tab.guest) {
      this.detachGuest(tab);
    }

    const existingFlight = this.guestAttachFlights.get(tab.tabId);
    let flight = existingFlight;
    if (!flight) {
      flight = this.runGuestAttachFlight(tab);
      this.guestAttachFlights.set(tab.tabId, flight);
      const clearFlight = () => {
        if (this.guestAttachFlights.get(tab.tabId) === flight) {
          this.guestAttachFlights.delete(tab.tabId);
        }
      };
      void flight.then(clearFlight, clearFlight);
    }
    const settled = await waitForPromiseWithSignal(flight, signal);
    if (!settled.completed || !settled.value) return null;
    return await this.waitForGuestRecovery(tab, settled.value, signal);
  }

  private async waitForGuestRecovery(
    tab: ManagedTab,
    guest: GuestWebContents,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    const flight = this.guestRecoveryFlights.get(tab.tabId);
    if (!flight) return guest;
    const settled = await waitForPromiseWithSignal(flight, signal);
    return settled.completed && settled.value === guest ? guest : null;
  }

  private async runGuestAttachFlight(tab: ManagedTab): Promise<GuestWebContents | null> {
    // A new tab's first ready waits once; an existing guest or an explicit rejection allows one bounded replay.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (tab.lifecycle === "closed") return null;
      // create/ready is replayable; after a lost event or guest crash, issue one bounded replay.
      // If destroyed/mismatch already started a rebind, reuse that request - one webview per tab.
      if (!tab.rebindRequested) this.onOpenTabRequested?.(tab.tabId, tab.owner);
      // Some tests/legacy renderers attach synchronously inside Ready; never register a waiter after attach succeeded.
      if (tab.guest && !safeBool(() => tab.guest.isDestroyed(), true)) return tab.guest;
      const guest = await this.waitForGuest(tab.tabId);
      if (guest && !safeBool(() => guest.isDestroyed(), true)) return guest;
      if (attempt === 0 && !tab.hasAttachedGuest && !tab.attachFailure) return null;
      if (attempt === 1) return null;
      this.requestGuestRebind(tab, tab.attachFailure ?? "attach-timeout");
    }
    return null;
  }

  private ownedTabs(context: InternalExecutionContext): ManagedTab[] {
    return [...this.tabs.values()].filter(
      (tab) => tab.lifecycle !== "closed" && sameScope(tab.owner, context),
    );
  }

  private canClaimUserTab(tab: ManagedTab, context: InternalExecutionContext): boolean {
    return (
      tab.origin === "user" &&
      tab.claimable &&
      tab.lifecycle !== "closed" &&
      tab.owner.windowId === context.windowId &&
      tab.owner.workspaceKey === context.workspaceKey &&
      (tab.owner.remoteSessionId ?? "") === (context.remoteSessionId ?? "") &&
      tab.owner.sessionId === context.sessionId
    );
  }

  private openUserTabs(context: InternalExecutionContext): ManagedTab[] {
    return [...this.tabs.values()]
      .filter((tab) => this.canClaimUserTab(tab, context) && this.hasDiscoverableUserPage(tab))
      .sort((left, right) => Number(right.active) - Number(left.active));
  }

  private hasDiscoverableUserPage(tab: ManagedTab): boolean {
    const url = tab.guest
      ? safeStr(() => tab.guest!.getURL(), tab.cachedUrl).trim()
      : tab.cachedUrl.trim();
    // A mounted human webview readies with about:blank/empty URL before the first navigation.
    // That is a UI placeholder, not a user page claimable by agents; controlled tabs.list() ignores this filter.
    return url.length > 0 && url !== "about:blank";
  }

  private claimTab(tab: ManagedTab, context: InternalExecutionContext): ManagedTab {
    if (!this.canClaimUserTab(tab, context)) return tab;
    tab.owner = { ...context };
    tab.claimable = false;
    // Claim takes ownership only, not activation; an inactive
    // human tab webview frames nothing, so post-claim screenshot prepare handshake times out at 3s (renderer ready
    // never arrives). Claim implies activation: selectTab(tab, true), same as activateTab - the foreground
    // scope expands the view; background scopes record activation without stealing user focus.
    this.selectTab(tab, true);
    this.log?.(
      `[browser-use] claim human tab tabId=${tab.tabId} windowId=${context.windowId} sessionId=${context.sessionId}`,
    );
    return tab;
  }

  private selectTab(tab: ManagedTab, notifyRenderer: boolean): void {
    const key = scopeKey(tab.owner);
    // A browser scope holds at most one active tab; legacy attach marked only the new tab active
    // without clearing the old tab.active, so tabs.list() could return several active=true.
    for (const candidate of this.tabs.values()) {
      if (!sameScope(candidate.owner, tab.owner)) continue;
      candidate.active = candidate.tabId === tab.tabId;
      this.residencyCoordinator.report(candidate.tabId, {
        selected: candidate.tabId === tab.tabId,
      });
    }
    this.activeTabByScope.set(key, tab.tabId);
    if (!notifyRenderer) return;
    this.visibilityByScope.set(key, true);
    this.onVisibilityChanged?.(true, tab.owner, tab.tabId);
    // activateTab / claim both end at selectTab(tab, true); the attach path uses notifyRenderer=false
    // and restores on its own - no duplication.
    this.maybeRestoreBackgroundViewport(tab);
  }

  private releaseToUser(tab: ManagedTab): void {
    if (tab.claimable) return;
    if (!tab.userOwner) {
      tab.userOwner = {
        ...tab.owner,
        requestId: `unclaimed:${randomUUID()}`,
        // On release the tab must leave its controlled browser scope, or the same session's tabs.list() keeps
        // treating the user tab as controlled; keep sessionId/workspaceKey for an explicit owner re-claim.
        browserId: "unclaimed-iab",
        browserGeneration: 0,
        turnId: undefined,
      };
    }
    const claimedScope = scopeKey(tab.owner);
    if (this.activeTabByScope.get(claimedScope) === tab.tabId) {
      this.activeTabByScope.delete(claimedScope);
    }
    if (this.defaultTabByScope.get(claimedScope) === tab.tabId) {
      this.defaultTabByScope.delete(claimedScope);
    }
    tab.owner = { ...tab.userOwner };
    tab.origin = "user";
    tab.claimable = true;
    tab.lifecycle = "active";
  }

  private finalizeTabs(
    context: InternalExecutionContext,
    keep: Map<string, "handoff" | "deliverable">,
  ): void {
    // Product semantic: an IAB tab is persistent within this ZCode process. keep is a state-flag set, not a
    // cleanup whitelist; a missed tab must not be closed as transient - user pages would vanish at turn end unless the model closes them.
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      const status = keep.get(tab.tabId);
      if (status === "handoff") tab.lifecycle = status;
      else if (status === "deliverable") {
        tab.lifecycle = status;
        this.releaseToUser(tab);
      }
    }
  }

  /**
   * Sole arbiter of active in tabs.list(): which tab tabId-less commands land on, aligned with resolveTab,
   * not 'is the UI showing it' - visibility has its own browserVisibilitySet/Get channel.
   *
   * The fallback is required: in background the renderer isVisible is false, reporting only
   * attachGuest({active:false}); no tab in the scope self-reports active and activeTabByScope is empty.
   * The CLI turn-end auto screenshot addresses via tabs.find(t => t.active === true) with no fallback and silently skips,
   * so background sessions end with no screenshot. Falling back to the scope's most recent living tab (matching
   * browserVisibilitySet and the CLI tabs.selected() at(-1) fallback) re-aligns reported active with the command target.
   */
  private effectiveActiveTabId(owner: InternalExecutionContext): string | undefined {
    const key = scopeKey(owner);
    const activeId = this.activeTabByScope.get(key);
    const activeTab = activeId ? this.tabs.get(activeId) : undefined;
    if (activeTab && activeTab.lifecycle !== "closed") return activeId;
    // A pre-claim human tab only sets tab.active, not activeTabByScope; such self-reported active wins over the fallback,
    // and stops the scan, keeping one active=true per scope.
    for (const tab of this.tabs.values()) {
      if (tab.active && tab.lifecycle !== "closed" && sameScope(tab.owner, owner)) return tab.tabId;
    }
    return this.ownedTabs(owner).at(-1)?.tabId;
  }

  private async summary(tab: ManagedTab): Promise<BrowserTabSummary> {
    // Until guest-rebind restore completes the replacement may still report about:blank; every state reader
    // keeps the logical cache - a temporary guest URL never clobbers later restore facts.
    if (tab.guest && !this.guestRecoveryFlights.has(tab.tabId)) {
      tab.cachedUrl = safeStr(() => tab.guest!.getURL(), tab.cachedUrl);
      tab.cachedTitle = safeStr(() => tab.guest!.getTitle(), tab.cachedTitle);
    }
    return {
      tabId: tab.tabId,
      url: tab.cachedUrl,
      title: tab.cachedTitle,
      viewport: await this.readTabViewport(tab),
      ...(this.effectiveActiveTabId(tab.owner) === tab.tabId ? { active: true } : {}),
      ...(tab.lifecycle !== "active" ? { lifecycle: tab.lifecycle } : {}),
    };
  }

  private async readTabViewport(tab: ManagedTab): Promise<BrowserViewportSize> {
    if (tab.viewportOverride) return { ...tab.viewportOverride };
    if (tab.backgroundViewportFallback) {
      // A foreground tab must not rest at the foreign fallback size: readTabViewport's 'fallback exists, short-circuit'
      // lets the residue self-reinforce (page pinned to the background size; window resize/fullscreen
      // stops following). Even with both foreground signals (selectTab / reportResidency) lost, the foreground
      // tab's next viewport read must self-heal; this call still returns fallback, recovery follows in the mutation queue.
      if (tab.active) {
        this.maybeRestoreBackgroundViewport(tab);
      }
      return { ...tab.backgroundViewportFallback };
    }
    if (!tab.guest || safeBool(() => tab.guest!.isDestroyed(), true)) {
      return { ...DEFAULT_BACKGROUND_BROWSER_VIEWPORT };
    }
    const value = await tab.guest.executeJavaScript(
      "({ width: window.innerWidth, height: window.innerHeight })",
    );
    if (isBrowserViewportSize(value)) {
      this.naturalViewportByWindow.set(tab.owner.windowId, { ...value });
      return value;
    }

    // A background session's Browser pane keeps the guest but hides via display:none; a first
    // tabs.new() still dom-readies/attaches yet gets a 0x0 viewport. Hidden is presentation, not a blocker for
    // background execution; borrow the same window's last natural size, clear the CDP override once foregrounded.
    const fallback = normalizeBackgroundViewport(
      this.naturalViewportByWindow.get(tab.owner.windowId) ?? DEFAULT_BACKGROUND_BROWSER_VIEWPORT,
    );
    await this.applyBackgroundViewportFallback(tab, fallback);
    this.log?.(
      `[browser-use] applied background viewport fallback tabId=${tab.tabId} width=${fallback.width} height=${fallback.height}`,
    );
    return { ...fallback };
  }

  private userTabInfo(tab: ManagedTab): BrowserUserTabInfo {
    if (tab.guest && !this.guestRecoveryFlights.has(tab.tabId)) {
      tab.cachedUrl = safeStr(() => tab.guest!.getURL(), tab.cachedUrl);
      tab.cachedTitle = safeStr(() => tab.guest!.getTitle(), tab.cachedTitle);
    }
    return {
      id: tab.tabId,
      ...(tab.cachedUrl ? { url: tab.cachedUrl } : {}),
      ...(tab.cachedTitle ? { title: tab.cachedTitle } : {}),
    };
  }

  private withMeta(
    result: BrowserCommandResult,
    context: InternalExecutionContext,
    tab?: ManagedTab,
    lifecycleOverride?: BrowserResponseMeta["lifecycle"],
  ): BrowserCommandResult {
    const openTabs = this.ownedTabs(context);
    const currentUrl = tab
      ? sanitizeBrowserMetaUrl(
          tab.guest ? safeStr(() => tab.guest!.getURL(), tab.cachedUrl) : tab.cachedUrl,
        )
      : undefined;
    const meta: BrowserResponseMeta = {
      browserUse: true,
      backendType: "iab",
      browserId: context.browserId,
      browserGeneration: context.browserGeneration,
      openTabIds: openTabs.map((candidate) => candidate.tabId),
      ...(tab ? { tabId: tab.tabId } : {}),
      ...(currentUrl ? { currentUrl } : {}),
      ...(lifecycleOverride
        ? { lifecycle: lifecycleOverride }
        : tab
          ? { lifecycle: tab.lifecycle }
          : {}),
    };
    return { ...result, meta };
  }

  private cancelledOrUnavailable(
    context: InternalExecutionContext,
    running: RunningRequest,
    startedAt: number,
    tab: ManagedTab,
  ): BrowserCommandResult {
    if (running.controller.signal.aborted) {
      return this.withMeta(
        this.cancelledResult(context, running.dispatched, startedAt),
        context,
        tab,
      );
    }
    return this.withMeta(
      {
        ok: false,
        error: {
          code: "backend_unavailable",
          message: "browser guest not attached (webview not ready)",
        },
        elapsedMs: Date.now() - startedAt,
      },
      context,
      tab,
    );
  }

  private unavailableTabResult(
    context: InternalExecutionContext,
    tabId: string | undefined,
    startedAt: number,
  ): BrowserCommandResult {
    return this.withMeta(
      {
        ok: false,
        error: {
          code: "backend_unavailable",
          message: tabId
            ? `browser tab '${tabId}' is not visible in the current context. ${TAB_CONTEXT_RECOVERY_HINT}`
            : "browser tab is unavailable",
        },
        elapsedMs: Date.now() - startedAt,
      },
      context,
    );
  }

  private cancelledResult(
    _context: InternalExecutionContext,
    dispatched: boolean,
    startedAt: number,
  ): BrowserCommandResult {
    return {
      ok: false,
      error: {
        code: "cancelled",
        message: dispatched
          ? "browser request cancelled after backend dispatch; side effects may have occurred"
          : "browser request cancelled before backend dispatch",
        sideEffect: dispatched ? "uncertain" : "none",
      },
      elapsedMs: Date.now() - startedAt,
    };
  }

  private abortRequest(requestId: string, context: InternalExecutionContext): boolean {
    const request = this.runningRequests.get(requestId);
    // requestId is a correlation id, not an credential; cancel obeys the full IAB scope.
    if (!request || !sameScope(request.context, context)) return false;
    request.controller.abort(new DOMException("aborted", "AbortError"));
    return true;
  }

  endTurn(context: InternalExecutionContext, turnId?: string): void {
    this.abortRecordings(
      (entry) =>
        sameScope(entry.context, context) &&
        (turnId === undefined || entry.context.turnId === turnId),
      "turn ended",
    );
    for (const request of this.runningRequests.values()) {
      if (
        sameScope(request.context, context) &&
        (turnId === undefined || request.context.turnId === turnId)
      ) {
        request.controller.abort(new DOMException("turn ended", "AbortError"));
      }
    }
    // Turn end ends requests, not tabs. The legacy 'keep only the final active page' fallback auto-closed later tabs
    // once a handoff existed, making page survival depend on the model remembering finalize JS. active/handoff tabs now persist;
    // deliverables and claimed user tabs still release control per the explicit lifecycle, but the view stays open.
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      if (tab.lifecycle === "handoff") continue;
      if (tab.lifecycle === "deliverable" || tab.origin === "user") this.releaseToUser(tab);
    }
    // The guest WebContents died while CDP stayed attached (destroyed direct,
    // triggers not enumerable: React unmount of webview / system behavior), letting DevToolsSession's implicit teardown
    // UAF the main process on in-flight notifications. Past turn end the agent idles; detaching now narrows the CDP
    // window from 'whole tab lifetime' to 'in-flight commands of a turn'; later commands lazy re-attach via sendGuestCdpCommand.
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      this.releaseGuestCdpAfterIdle(tab, "turn ended");
    }
  }

  private releaseGuestCdpAfterIdle(tab: ManagedTab, reason: string): void {
    const guest = tab.guest;
    if (!guest || tab.guestLifecycle !== "attached") return;
    void (async () => {
      // Disconnect only after in-flight CDP commands (playwright cdp.send / viewport override / dialog handling) finish;
      // never dismantle a pipeline in use. The timeout fallback shares one budget with runGuestTeardown.
      const settled = await this.waitForGuestCdpIdle(tab, DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS);
      if (!settled) {
        this.warn(
          `browser guest cdp release pending timeout tabId=${tab.tabId} ` +
            `pending=${tab.pendingCdpCommands} reason=${reason}`,
        );
      }
      // The tab may have been replaced/closed/re-entered command phase while waiting; abandon this release round.
      if (this.tabs.get(tab.tabId) !== tab || tab.guest !== guest) return;
      if (tab.guestLifecycle !== "attached") return;
      if (tab.pendingCdpCommands > 0) return;
      if (safeBool(() => guest.isDestroyed(), true)) return;
      try {
        if (!guest.debugger.isAttached()) {
          tab.cdpAttached = false;
          return;
        }
        guest.debugger.detach();
        tab.cdpAttached = false;
        this.log?.(`[browser-use] cdp released after ${reason} tabId=${tab.tabId}`);
      } catch (error) {
        this.warn(`browser guest cdp release failed tabId=${tab.tabId} reason=${reason}`, error);
      }
    })();
  }

  /**
   * Command-level idle release: reset the timer after each CDP command; no new command within cdpIdleReleaseMs detaches.
   * Guest renderer killed by Chromium with render-process-gone lost (known Electron gap;
   * measured destroyed-direct + CDP attached -> main-process UAF) crashes cluster in intra-turn command gaps,
   * which turnEnded-level release misses; dense command gaps sit far below the threshold, so nothing is interrupted.
   */
  private scheduleGuestCdpIdleRelease(tab: ManagedTab): void {
    if (tab.guestCdpIdleTimer) clearTimeout(tab.guestCdpIdleTimer);
    tab.guestCdpIdleTimer = setTimeout(() => {
      tab.guestCdpIdleTimer = undefined;
      this.releaseGuestCdpAfterIdle(tab, "cdp idle");
    }, this.cdpIdleReleaseMs);
  }

  private clearGuestCdpIdleRelease(tab: ManagedTab): void {
    if (tab.guestCdpIdleTimer) {
      clearTimeout(tab.guestCdpIdleTimer);
      tab.guestCdpIdleTimer = undefined;
    }
  }

  closeSession(context: InternalExecutionContext): void {
    this.abortRecordings((entry) => sameScope(entry.context, context), "session closed");
    for (const request of this.runningRequests.values()) {
      if (sameScope(request.context, context)) {
        request.controller.abort(new DOMException("session closed", "AbortError"));
      }
    }
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      // A session is the control boundary, not the visible-tab lifetime. The view survives release but stays bound
      // to its session; never rewrite it as globally unclaimed, or other conversations take over via user.openTabs().
      this.releaseToUser(tab);
      // As in endTurn: release CDP at session end, closing the main-process UAF window on any later guest destruction path.
      this.releaseGuestCdpAfterIdle(tab, "session closed");
    }
    this.activeTabByScope.delete(scopeKey(context));
    this.defaultTabByScope.delete(scopeKey(context));
    this.sessionNames.delete(scopeKey(context));
    this.visibilityByScope.delete(scopeKey(context));
  }

  closeWindow(windowId: number): void {
    this.abortRecordings((entry) => entry.context.windowId === windowId, "window closed");
    for (const request of this.runningRequests.values()) {
      if (request.context.windowId === windowId) {
        request.controller.abort(new DOMException("window closed", "AbortError"));
      }
    }
    for (const tab of this.tabs.values()) {
      if (tab.owner.windowId !== windowId) continue;
      this.detachAndCloseGuest(tab);
      this.residencyCoordinator.remove(tab.tabId);
      this.restoredTabClaims.delete(tab.tabId);
      // closeWindow takes the fast path, bypassing closeTab; without cleanup here, late-settling
      // callbacks pollute by tabId the new-tab counters recovery may reuse. decrement is
      // a no-op for removed keys, provided entries are deleted here first.
      this.inFlightScreenshots.delete(tab.tabId);
      this.abandonedScreenshotCaptures.delete(tab.tabId);
      this.tabs.delete(tab.tabId);
    }
    this.naturalViewportByWindow.delete(windowId);
  }

  private async removeTabRecovery(tab: ManagedTab): Promise<void> {
    await this.residencyOptions.recoveryStore?.remove(tab.tabId);
  }

  private async closeTabDurably(tab: ManagedTab, notifyRenderer = true): Promise<void> {
    if (tab.lifecycle === "closed") return;
    // Legacy close replied to commands/notified the renderer, then fire-and-forget deleted the restore repo; on quick exit
    // closed tabs revived from the old shell. Persist the deletion first; on failure keep the logical tab for a caller retry.
    await this.removeTabRecovery(tab);
    this.closeTab(tab, notifyRenderer);
  }

  private closeTab(tab: ManagedTab, notifyRenderer = true): void {
    if (tab.lifecycle === "closed") return;
    this.abortRecordings((entry) => entry.tabId === tab.tabId, "tab closed");
    tab.lifecycle = "closed";
    this.closedTabIds.add(tab.tabId);
    // The tab runs no more commands; keep no manager reference for an old CDP capture that may never return.
    this.inFlightScreenshots.delete(tab.tabId);
    this.abandonedScreenshotCaptures.delete(tab.tabId);
    this.resolveWaiters(tab.tabId, null);
    this.detachAndCloseGuest(tab);
    for (const [downloadId, record] of this.downloads) {
      if (record.tabId === tab.tabId) this.downloads.delete(downloadId);
    }
    this.queuedDownloads.delete(tab.tabId);
    let waiter = this.downloadWaiters.get(tab.tabId)?.[0];
    while (waiter) {
      this.finishDownloadWaiter(tab.tabId, waiter, null);
      waiter = this.downloadWaiters.get(tab.tabId)?.[0];
    }
    const key = scopeKey(tab.owner);
    if (this.activeTabByScope.get(key) === tab.tabId) this.activeTabByScope.delete(key);
    if (this.defaultTabByScope.get(key) === tab.tabId) this.defaultTabByScope.delete(key);
    if (notifyRenderer) this.onCloseTabRequested?.(tab.tabId, tab.owner);
    this.residencyCoordinator.remove(tab.tabId);
    this.restoredTabClaims.delete(tab.tabId);
    this.tabs.delete(tab.tabId);
  }

  /**
   * Disconnect CDP as soon as the guest renderer crashes or is killed.
   *
   * Crash chain (main-process UAF, minidump in DevToolsSession::DispatchProtocolNotification,
   * client_ vptr = 0):
   * Chromium kills the guest renderer under memory pressure
   * -> render-process-gone: WebContents alive, CDP attached
   * -> renderer bumps webviewGeneration, React unmounts the old <webview>
   * -> only now is the old WebContents destroyed; api::Debugger takes the implicit-destructor path
   * -> DevToolsSession still holds client_ and dispatches an in-flight notification -> UAF -> main crash -> app exit
   *
   * Measured (Electron 41.0.3 / forcefullyCrashRenderer, timestamped A/B):
   * - at render-process-gone: isDestroyed()=false, isCrashed()=true, isAttached()=true;
   * detach() succeeds and isAttached() then reads false;
   * - at destroyed: isCrashed()/isAttached() both throw 'Object has been destroyed',
   * so detaching there is impossible - a destroyed-fallback cannot fix this UAF;
   * - with <webview> still mounted, WebContents stays crashed indefinitely (10s, no destroyed);
   * once the renderer unmounts <webview>, destroyed arrives within ~5ms. Destruction timing is the renderer's;
   * the safe window for native detach exists only before WebContents destruction.
   * main's render-process-gone is guard one; the explicit detach ACK before the renderer rebuilds is guard two,
   * covering lost main events. Neither changes destruction timing; both only ensure CDP is detached in time.
   */
  private setupCdpCrashGuard(tab: ManagedTab, guest: GuestWebContents): void {
    tab.crashGuardCleanup?.();
    if (!guest.on || !guest.removeListener) return;
    const tabId = tab.tabId;
    const onRenderProcessGone = (...args: unknown[]): void => {
      const reason = safeStr(
        () => String((args[1] as { reason?: string } | undefined)?.reason ?? "unknown"),
        "unknown",
      );
      const guestId = safeStr(() => String(guest.id), "?");
      // No tab.guest === guest check: disconnecting CDP of an already-replaced guest is equally correct and required;
      // skipping it leaves the UAF window open.
      try {
        if (this.tabs.get(tabId)?.guest === guest) tab.guestLifecycle = "detaching";
        if (!guest.debugger.isAttached()) return;
        guest.debugger.detach();
        this.log?.(
          `[browser-use] cdp detached on render-process-gone tabId=${tabId} ` +
            `guestId=${guestId} reason=${reason}`,
        );
      } catch (error) {
        // Failure here means the UAF window stayed open; log it for correlation with the later crash.
        this.warn(
          `browser guest cdp detach on render-process-gone failed tabId=${tabId} ` +
            `guestId=${guestId} reason=${reason}`,
          error,
        );
      } finally {
        if (this.tabs.get(tabId)?.guest === guest) tab.cdpAttached = false;
      }
    };
    guest.on("render-process-gone", onRenderProcessGone);
    tab.crashGuardCleanup = () => {
      guest.removeListener?.("render-process-gone", onRenderProcessGone);
    };
  }

  private setupDialogTracking(tab: ManagedTab, guest: GuestWebContents): void {
    const tabId = tab.tabId;
    void this.sendGuestCdpCommand(tab, guest, "Page.enable").catch((error: unknown) => {
      this.log?.(`[browser-use] Page.enable failed tabId=${tabId}: ${String(error)}`);
    });
    const onMessage = (_event: unknown, method: string, params: unknown): void => {
      const current = this.tabs.get(tabId);
      if (!current || current.guest !== guest || current.lifecycle === "closed") return;
      if (method === "Page.javascriptDialogOpening") {
        // Instrument: the moment a dialog event reaches main, to tell 'event black hole' from
        // 'dialog cleaned up by detach' as getDialog=null causes.
        this.log?.(`[browser-use] dialog opening event received tabId=${tabId}`);
        const data = (params ?? {}) as {
          type?: string;
          message?: string;
          defaultPrompt?: string;
        };
        const dialog: BrowserDialog = {
          type: normalizeDialogType(data.type),
          message: typeof data.message === "string" ? data.message : "",
          ...(typeof data.defaultPrompt === "string" ? { defaultPrompt: data.defaultPrompt } : {}),
        };
        this.pendingDialogs.set(tabId, dialog);
      } else if (method === "Page.javascriptDialogClosed") {
        this.pendingDialogs.delete(tabId);
      }
    };
    guest.debugger.on("message", onMessage);
    tab.cdpMessageCleanup = () => {
      guest.debugger.removeListener("message", onMessage);
    };
  }

  private applyViewportOverride(tab: ManagedTab): void {
    const viewport = tab.viewportOverride;
    if (!viewport) return;
    void this.setTabViewport(tab, viewport).catch((error: unknown) => {
      this.log?.(`[browser-use] viewport apply failed tabId=${tab.tabId}: ${String(error)}`);
    });
  }

  private async setTabViewport(tab: ManagedTab, viewport: BrowserViewportSize): Promise<void> {
    assertViewportOverride(viewport);
    if (tab.lifecycle === "closed") return;
    tab.backgroundViewportFallback = undefined;
    tab.viewportOverride = { ...viewport };
    if (!tab.guest) return;
    const guest = tab.guest;
    await this.enqueueViewportMutation(tab, async () => {
      if (tab.guest !== guest || tab.lifecycle === "closed") return;
      await this.sendGuestCdpCommand(
        tab,
        guest,
        "Emulation.setDeviceMetricsOverride",
        buildViewportMetricsOverride(viewport, tab.desktopZoomFactor),
      );
    });
  }

  private async resetTabViewport(tab: ManagedTab): Promise<void> {
    if (tab.lifecycle === "closed") return;
    tab.viewportOverride = undefined;
    tab.desktopZoomFactor = undefined;
    tab.backgroundViewportFallback = undefined;
    if (!tab.guest) return;
    const guest = tab.guest;
    await this.enqueueViewportMutation(tab, async () => {
      if (tab.guest !== guest || tab.lifecycle === "closed") return;
      await this.sendGuestCdpCommand(tab, guest, "Emulation.clearDeviceMetricsOverride");
    });
  }

  private async applyBackgroundViewportFallback(
    tab: ManagedTab,
    viewport: BrowserViewportSize,
  ): Promise<void> {
    const guest = tab.guest;
    if (!guest || tab.lifecycle === "closed") {
      throw new Error(`browser tab '${tab.tabId}' has no readable viewport`);
    }
    const fallback = { ...viewport };
    tab.backgroundViewportFallback = fallback;
    try {
      await this.enqueueViewportMutation(tab, async () => {
        if (
          tab.guest !== guest ||
          tab.lifecycle === "closed" ||
          tab.backgroundViewportFallback !== fallback ||
          tab.viewportOverride
        ) {
          return;
        }
        await this.sendGuestCdpCommand(
          tab,
          guest,
          "Emulation.setDeviceMetricsOverride",
          buildViewportMetricsOverride(fallback, guest.hostWebContents?.getZoomFactor()),
        );
      });
    } catch (error) {
      if (tab.backgroundViewportFallback === fallback) {
        tab.backgroundViewportFallback = undefined;
      }
      throw error;
    }
  }

  /**
   * Single funnel for foreground activation: background fallback viewports must not survive the tab's return to front.
   * Clearing on attachGuest({active:true}) alone is not enough: foreground switches while the guest lives
   * (activateTab / claim / renderer residency) never re-attach, pinning the page to the background size.
   * restoreNaturalViewportAfterBackground carries an idempotence guard and the serial mutation queue,
   * so repeated triggers from any foreground signal are safe.
   */
  private maybeRestoreBackgroundViewport(tab: ManagedTab): void {
    if (tab.lifecycle === "closed" || !tab.backgroundViewportFallback) return;
    this.restoreNaturalViewportAfterBackground(tab);
  }

  private restoreNaturalViewportAfterBackground(tab: ManagedTab): void {
    const fallback = tab.backgroundViewportFallback;
    const guest = tab.guest;
    if (!fallback || tab.viewportOverride || !guest) return;
    void this.enqueueViewportMutation(tab, async () => {
      if (
        tab.guest !== guest ||
        tab.lifecycle === "closed" ||
        tab.backgroundViewportFallback !== fallback ||
        tab.viewportOverride
      ) {
        return;
      }
      await this.sendGuestCdpCommand(tab, guest, "Emulation.clearDeviceMetricsOverride");
      if (tab.backgroundViewportFallback !== fallback || tab.viewportOverride) return;
      const value = await guest.executeJavaScript(
        "({ width: window.innerWidth, height: window.innerHeight })",
      );
      if (tab.backgroundViewportFallback !== fallback || tab.viewportOverride) return;
      if (isBrowserViewportSize(value)) {
        this.naturalViewportByWindow.set(tab.owner.windowId, { ...value });
        tab.backgroundViewportFallback = undefined;
        return;
      }
      // active=true arrived but Chromium has not finished visible layout: keep transient; the next
      // visible renderer attach or viewport read still recovers - never briefly fall back to 0x0.
      await this.sendGuestCdpCommand(
        tab,
        guest,
        "Emulation.setDeviceMetricsOverride",
        buildViewportMetricsOverride(fallback, guest.hostWebContents?.getZoomFactor()),
      );
    }).catch((error: unknown) => {
      this.log?.(
        `[browser-use] background viewport restore failed tabId=${tab.tabId}: ${String(error)}`,
      );
    });
  }

  private enqueueViewportMutation(tab: ManagedTab, mutation: () => Promise<void>): Promise<void> {
    const previous = tab.viewportMutation ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        // CDP restore replays inline in the current critical section, instead of re-queueing and waiting on itself.
        tab.insideViewportMutation = true;
        try {
          await mutation();
        } finally {
          tab.insideViewportMutation = false;
        }
      });
    tab.viewportMutation = current;
    current.then(
      () => {
        if (tab.viewportMutation === current) tab.viewportMutation = undefined;
      },
      () => {
        if (tab.viewportMutation === current) tab.viewportMutation = undefined;
      },
    );
    return current;
  }

  private setupDownloadTracking(tab: ManagedTab, guest: GuestWebContents): void {
    tab.downloadCleanup?.();
    if (!guest.session) return;
    const listener = (_event: unknown, item: GuestDownloadItem, contents: GuestWebContents) => {
      if (contents !== guest || tab.guest !== guest || tab.lifecycle === "closed") return;
      const downloadId = `iab-download:${randomUUID()}`;
      const record: DownloadRecord = {
        tabId: tab.tabId,
        path: safeStr(() => item.getSavePath(), "") || null,
        state: "pending",
      };
      this.downloads.set(downloadId, record);
      this.refreshRuntimeProtection(tab.tabId);
      item.once("done", (_event, state) => {
        record.path = safeStr(() => item.getSavePath(), "") || record.path;
        record.state =
          state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
        this.refreshRuntimeProtection(tab.tabId);
      });
      const waiters = this.downloadWaiters.get(tab.tabId);
      const waiter = waiters?.shift();
      if (waiter) {
        this.finishDownloadWaiter(tab.tabId, waiter, downloadId);
      } else {
        const queued = this.queuedDownloads.get(tab.tabId) ?? [];
        queued.push(downloadId);
        this.queuedDownloads.set(tab.tabId, queued);
      }
    };
    guest.session.on("will-download", listener);
    tab.downloadCleanup = () => guest.session?.removeListener("will-download", listener);
  }

  private waitForDownload(
    tabId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<string | null> {
    const queued = this.queuedDownloads.get(tabId);
    const existing = queued?.shift();
    if (existing) return Promise.resolve(existing);
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = {} as DownloadWaiter;
      waiter.resolve = resolve;
      waiter.signal = signal;
      waiter.timer = setTimeout(() => this.finishDownloadWaiter(tabId, waiter, null), timeoutMs);
      waiter.onAbort = () => this.finishDownloadWaiter(tabId, waiter, null);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      const waiters = this.downloadWaiters.get(tabId) ?? [];
      waiters.push(waiter);
      this.downloadWaiters.set(tabId, waiters);
    });
  }

  private finishDownloadWaiter(
    tabId: string,
    waiter: DownloadWaiter,
    downloadId: string | null,
  ): void {
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    const waiters = this.downloadWaiters.get(tabId);
    if (waiters) {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      if (waiters.length === 0) this.downloadWaiters.delete(tabId);
    }
    waiter.resolve(downloadId);
  }

  /**
   * Restore-style attach of CDP session state: runs when the command phase resumes after idle/turn-end release;
   * returns an awaitable flight - business commands dispatch only after Page.enable and viewport override replay.
   *
   * Page-domain enable and Emulation.setDeviceMetricsOverride are per-session and already cleared by Chromium on
   * detach;
   * a bare attach('1.3') yields a pristine session - dialog event black hole (getDialog stays null; evaluate
   * hangs on JS dialogs, measured 62s), diverged viewport emulation and manager cache. And fire-and-forget
   * replay has no await barrier: business commands (screenshot/evaluate) run before restore completes, defeating replay
   * in the first-command case. Restore commands go via raw (no ensure, no self-await); viewport replay reuses the
   * serial queue, replaying inline when already inside it - no double-enqueue deadlock with the current flight.
   */
  private async ensureGuestCdpAttached(tab: ManagedTab, guest: GuestWebContents): Promise<void> {
    if (!tab.guestCdpRestoreFlight) {
      const flight = this.runGuestCdpSessionRestore(tab, guest).finally(() => {
        if (tab.guestCdpRestoreFlight === flight) tab.guestCdpRestoreFlight = undefined;
      });
      tab.guestCdpRestoreFlight = flight;
    }
    await tab.guestCdpRestoreFlight;
  }

  private async runGuestCdpSessionRestore(tab: ManagedTab, guest: GuestWebContents): Promise<void> {
    if (!safeBool(() => guest.debugger.isAttached(), false)) {
      guest.debugger.attach("1.3");
      tab.cdpAttached = safeBool(() => guest.debugger.isAttached(), false);
      if (!tab.cdpAttached) {
        throw new Error(`browser guest cdp restore attach failed tabId=${tab.tabId}`);
      }
    }
    // Restore failure must propagate: the barrier contract is 'business commands only after
    // Page.enable and viewport state are ready'. Swallowing it lets later commands skip restore once attached - losing
    // Page.extend... no; losing Page.enable stretches the dialog black hole across the attach, and the misleading 'replayed' log hurts debugging.
    // Before propagating, roll back to detached: a half-built session is unusable; restoring the released state lets the next
    // command rebuild the restore flight (otherwise attached=true pins the failure by skipping restore forever).
    try {
      await this.sendGuestCdpCommandRaw(tab, guest, "Page.enable");
    } catch (error) {
      this.warn(`browser guest Page.enable replay failed tabId=${tab.tabId}`, error);
      this.rollbackGuestCdpRestore(tab, guest);
      throw error;
    }
    const viewport = tab.viewportOverride ?? tab.backgroundViewportFallback;
    if (viewport) {
      try {
        const replayViewport = async () => {
          if (tab.guest !== guest || tab.lifecycle === "closed") return;
          await this.sendGuestCdpCommandRaw(
            tab,
            guest,
            "Emulation.setDeviceMetricsOverride",
            buildViewportMetricsOverride(
              viewport,
              tab.viewportOverride ? tab.desktopZoomFactor : guest.hostWebContents?.getZoomFactor(),
            ),
          );
        };
        // Screenshots occupy the viewport queue too, without resetting metrics. Treating an in-queue
        // re-attach as equivalent restore and skipping it makes the first screenshot read host-scaled natural size.
        // Already inside the critical section: replay inline; re-queueing and waiting on ourselves deadlocks.
        if (tab.insideViewportMutation) await replayViewport();
        else await this.enqueueViewportMutation(tab, replayViewport);
      } catch (error) {
        this.warn(`browser guest viewport replay failed tabId=${tab.tabId}`, error);
        this.rollbackGuestCdpRestore(tab, guest);
        throw error;
      }
    }
    this.log?.(`[browser-use] cdp session state replayed tabId=${tab.tabId} pageEnable=1`);
  }

  /** On restore failure return the half-built session to the released state; rollback failure masks nothing. */
  private rollbackGuestCdpRestore(tab: ManagedTab, guest: GuestWebContents): void {
    try {
      if (guest.debugger.isAttached()) guest.debugger.detach();
    } catch {
      // The session may already be destroyed; the cdpAttached reset must still happen.
    }
    tab.cdpAttached = false;
  }

  /** Restore-only send: pending count and dispatch, never ensure (no self-await deadlock). */
  private async sendGuestCdpCommandRaw(
    tab: ManagedTab,
    guest: GuestWebContents,
    method: string,
    params?: unknown,
    sessionId?: string,
  ): Promise<unknown> {
    tab.pendingCdpCommands += 1;
    try {
      const result = await guest.debugger.sendCommand(method, params, sessionId);
      if (!sessionId && tab.guest === guest) {
        if (method === "Emulation.setDeviceMetricsOverride") {
          tab.appliedViewportScale = normalizeDesktopZoomMetricsScale(
            (params as { scale?: number }).scale,
          );
          // The renderer's normalization callback can be overwritten by a later Electron page-zoom propagation.
          // Fixed-viewport setup and CDP reconnect restore guest zoom within one execution boundary.
          if (guest.getZoomFactor() !== 1) guest.setZoomFactor(1);
        } else if (method === "Emulation.clearDeviceMetricsOverride") {
          tab.appliedViewportScale = undefined;
        }
      }
      return result;
    } finally {
      tab.pendingCdpCommands = Math.max(0, tab.pendingCdpCommands - 1);
      this.scheduleGuestCdpIdleRelease(tab);
    }
  }

  private async sendGuestCdpCommand(
    tab: ManagedTab,
    guest: GuestWebContents,
    method: string,
    params?: unknown,
    sessionId?: string,
    assertCurrentGuest?: () => void,
  ): Promise<unknown> {
    assertCurrentGuest?.();
    if (tab.guest !== guest || tab.guestLifecycle !== "attached") {
      throw new Error("browser guest is detaching");
    }
    // After turnEnded/closeSession/command idle, CDP is proactively released (against main-process
    // UAF on guest destruction); the command path restore-attaches here and awaits session-state replay (explicit
    // serial barrier: Page.enable / viewport override handled by Chromium before this command).
    if (!safeBool(() => guest.debugger.isAttached(), false) || tab.guestCdpRestoreFlight) {
      await this.ensureGuestCdpAttached(tab, guest);
    }
    // The native-raster metrics scale also hits CDP mouse input. Tools, locators
    // and screenshots stay in CSS px; compensate position and wheel delta at the single guest send boundary, not per API.
    const scale = tab.appliedViewportScale ?? 1;
    if (!sessionId && method === "Input.dispatchMouseEvent" && scale !== 1 && params) {
      const event = { ...(params as Record<string, unknown>) };
      for (const key of ["x", "y", "deltaX", "deltaY"]) {
        if (typeof event[key] === "number") event[key] *= scale;
      }
      params = event;
    }
    return this.sendGuestCdpCommandRaw(tab, guest, method, params, sessionId);
  }

  private toControlledView(
    guest: GuestWebContents,
    normalizeScreenshotToCssPixels = false,
    captureViewportScreenshot: ControlledView["captureViewportScreenshot"] | undefined,
    assertCurrentGuest: () => void,
    sendCdpCommand: ControlledView["cdp"]["send"],
  ): ControlledView {
    const assertCurrent = () => assertCurrentGuest();
    return {
      webContents: {
        loadURL: (url) => {
          assertCurrent();
          return guest.loadURL(url);
        },
        getURL: () => {
          assertCurrent();
          return guest.getURL();
        },
        getTitle: () => {
          assertCurrent();
          return guest.getTitle();
        },
        canGoBack: () => {
          assertCurrent();
          return guest.navigationHistory.canGoBack();
        },
        canGoForward: () => {
          assertCurrent();
          return guest.navigationHistory.canGoForward();
        },
        goBack: () => {
          assertCurrent();
          return guest.navigationHistory.goBack();
        },
        goForward: () => {
          assertCurrent();
          return guest.navigationHistory.goForward();
        },
        reload: () => {
          assertCurrent();
          return guest.reload();
        },
        executeJavaScript: (script) => {
          assertCurrent();
          return guest.executeJavaScript(script, true);
        },
      },
      cdp: {
        send: (method, params, sessionId) => {
          try {
            assertCurrent();
            return sendCdpCommand(method, params, sessionId);
          } catch (error) {
            // CDP consumers call .catch directly on abort/terminate paths; the lifecycle guard must
            // return a rejected Promise, never throw synchronously and break that cleanup chain.
            return Promise.reject(error);
          }
        },
      },
      captureViewportScreenshot,
      normalizeScreenshotToCssPixels,
      resizeScreenshotToCssPixels: this.resizeScreenshotToCssPixels,
    };
  }

  private registerTabResidency(
    tab: ManagedTab,
    visible: boolean,
    residency: BrowserTabResidencyRecord["residency"] = visible
      ? "live-visible"
      : "live-background",
    lastSelectedAt: number | null = null,
  ): void {
    this.residencyCoordinator.upsert({
      tabId: tab.tabId,
      windowId: tab.owner.windowId,
      sessionId: tab.owner.sessionId,
      residency,
      guestAttached: Boolean(tab.guest && !safeBool(() => tab.guest!.isDestroyed(), true)),
      openedAt: tab.openedAt,
      lastActivityAt: tab.openedAt,
      lastSelectedAt,
      preferred: visible,
      currentTask: false,
      selected: visible,
      visible,
      operationActive: false,
      captureActive: false,
      audible: false,
      mediaActive: false,
      loading: false,
      downloadActive: false,
    });
  }

  private async closeTabForLimit(record: BrowserTabResidencyRecord): Promise<boolean> {
    const tab = this.tabs.get(record.tabId);
    if (!tab || tab.lifecycle === "closed") return true;
    try {
      // The legacy count guard destroyed only the WebContents, keeping the suspended logical tab,
      // so the tab strip grew past 32. Reuse the durable close and shut down fully in order
      // restore data -> guest -> renderer tab shell, so closed tabs never revive in this UI or the next launch.
      await this.closeTabDurably(tab);
      this.log?.(
        `[browser-use] closed tabId=${tab.tabId} reason=tab-limit windowId=${tab.owner.windowId}`,
      );
      return true;
    } catch (error) {
      this.warn(`browser tab limit close failed tabId=${tab.tabId}`, error);
      return false;
    }
  }

  private async restoreSuspendedGuest(
    tab: ManagedTab,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    if (signal.aborted) return null;
    let flight = this.restoreFlights.get(tab.tabId);
    if (!flight) {
      // The legacy single-flight adopted the first caller's AbortSignal; one canceled command
      // poisoned every concurrent caller and left the coordinator restoring. The flight is owned by the tab lifecycle now.
      flight = this.runRestoreSuspendedGuest(tab, new AbortController().signal).finally(() => {
        if (this.restoreFlights.get(tab.tabId) === flight) this.restoreFlights.delete(tab.tabId);
      });
      this.restoreFlights.set(tab.tabId, flight);
    }
    const result = await waitForPromiseWithSignal(flight, signal);
    return result.completed ? result.value : null;
  }

  private async runRestoreSuspendedGuest(
    tab: ManagedTab,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    const before = this.residencyCoordinator.get(tab.tabId);
    const transition = this.residencyCoordinator.markRestoring(tab.tabId);
    if (!transition) return null;
    if (before?.residency === "suspended") {
      const payload: BrowserViewResidencyTransitionPayload = {
        tabId: tab.tabId,
        workspaceKey: tab.owner.workspaceKey,
        remoteSessionId: tab.owner.remoteSessionId,
        sessionId: tab.owner.sessionId,
        browserId: tab.owner.browserId,
        browserGeneration: tab.owner.browserGeneration,
        generation: transition.generation,
        residency: "restoring",
      };
      if (this.residencyOptions.onRestoreTabRequested) {
        this.residencyOptions.onRestoreTabRequested(payload);
      } else {
        this.onOpenTabRequested?.(tab.tabId, tab.owner);
      }
    }

    const guest = await this.waitForGuest(tab.tabId, signal);
    if (!guest) {
      const failed = this.residencyCoordinator.failRestore(tab.tabId, transition.generation);
      if (failed) {
        // Tell the renderer to fall back to the lightweight shell; the new generation also fail-closes this round's late attaches.
        this.residencyOptions.onSuspendTabRequested?.({
          tabId: tab.tabId,
          workspaceKey: tab.owner.workspaceKey,
          remoteSessionId: tab.owner.remoteSessionId,
          sessionId: tab.owner.sessionId,
          browserId: tab.owner.browserId,
          browserGeneration: tab.owner.browserGeneration,
          generation: failed.generation,
          residency: "suspended",
        });
      }
      return null;
    }
    const restored = await this.restoreGuestState(tab, guest);
    if (!restored && tab.restoredFromStore && !tab.cachedUrl) {
      // Clean the orphan only when all three restore facts are missing after a forced restore mount; normal page-state eviction
      // keeps restoreUrl and must not enter this branch, forming a restore/close loop.
      await this.removeTabRecovery(tab);
      this.residencyOptions.onRecoveryOrphanCloseRequested?.({
        tabId: tab.tabId,
        reason: "recovery-orphan",
      });
      this.closeTab(tab, false);
      return null;
    }
    if (!restored) {
      // Do not handle only 'all restore facts missing': committing live when history and URL both fail
      // permanently treats bootstrap/about:blank as a success page. On failure destroy this round's guest, return to a retryable shell.
      const failed = this.residencyCoordinator.failRestore(tab.tabId, transition.generation);
      this.detachAndCloseGuest(tab);
      if (failed) {
        this.residencyOptions.onSuspendTabRequested?.({
          tabId: tab.tabId,
          workspaceKey: tab.owner.workspaceKey,
          remoteSessionId: tab.owner.remoteSessionId,
          sessionId: tab.owner.sessionId,
          browserId: tab.owner.browserId,
          browserGeneration: tab.owner.browserGeneration,
          generation: failed.generation,
          residency: "suspended",
        });
      }
      return null;
    }
    if (!this.residencyCoordinator.completeRestore(tab.tabId, transition.generation)) return null;
    const completed = this.residencyCoordinator.get(tab.tabId);
    if (completed) {
      // The renderer got only the restoring start, no terminal state on success - the restoring shell would persist forever.
      this.residencyOptions.onResidencyChanged?.({
        tabId: tab.tabId,
        workspaceKey: tab.owner.workspaceKey,
        remoteSessionId: tab.owner.remoteSessionId,
        sessionId: tab.owner.sessionId,
        browserId: tab.owner.browserId,
        browserGeneration: tab.owner.browserGeneration,
        generation: completed.generation,
        residency: completed.residency === "live-visible" ? "live-visible" : "live-background",
      });
    }
    tab.restoredFromStore = false;
    await this.persistShell(tab);
    return guest;
  }

  private async restoreGuestState(tab: ManagedTab, guest: GuestWebContents): Promise<boolean> {
    const pageState = await this.residencyOptions.recoveryStore?.getPageState(tab.tabId);
    if (pageState && pageState.entries.length > 0) {
      const activePageState = pageState.entries[pageState.activeIndex];
      if (tab.cachedUrl && activePageState?.url !== tab.cachedUrl) {
        // pageState refreshes only while the budget is pending; a post-restore navigation updates the shell but keeps the old snapshot.
        // Cold start trusts the logical shell's current URL; never roll B back to snapshot A.
        this.warn(
          `browser tab stale page-state ignored tabId=${tab.tabId} shellUrl=${tab.cachedUrl} pageStateUrl=${activePageState?.url ?? "missing"}`,
        );
        await this.residencyOptions.recoveryStore?.removePageState(tab.tabId);
      } else {
        const acceptRestoredPageState = () => {
          const active = pageState.entries[pageState.activeIndex];
          tab.cachedUrl = active?.url ?? tab.cachedUrl;
          tab.cachedTitle = active?.title ?? tab.cachedTitle;
          return true;
        };
        try {
          this.log?.(
            `[browser-use] restore page-state start tabId=${tab.tabId} index=${pageState.activeIndex} entries=${JSON.stringify(pageState.entries.map((entry) => entry.url))}`,
          );
          await guest.navigationHistory.restore({
            entries: pageState.entries.map((entry) => ({ ...entry })),
            index: pageState.activeIndex,
          });
          this.log?.(
            `[browser-use] restore page-state complete tabId=${tab.tabId} url=${safeStr(() => guest.getURL(), "")} index=${safeStr(() => String(guest.navigationHistory.getActiveIndex()), "unknown")} entries=${safeStr(() => JSON.stringify(guest.navigationHistory.getAllEntries().map((entry) => entry.url)), "unknown")}`,
          );
          return acceptRestoredPageState();
        } catch (error) {
          const restoreAppliedDespiteAbort =
            String(error).includes("ERR_ABORTED") &&
            safeBool(() => {
              const actualEntries = guest.navigationHistory.getAllEntries();
              return (
                guest.navigationHistory.getActiveIndex() === pageState.activeIndex &&
                actualEntries.length === pageState.entries.length &&
                actualEntries.every((entry, index) => entry.url === pageState.entries[index]?.url)
              );
            }, false);
          if (restoreAppliedDespiteAbort) {
            // Electron 41 reports the default about:blank canceled with ERR_ABORTED even after the full history lands.
            // Trust the actual navigationHistory; do not drop valid pageState or start a second URL navigation.
            return acceptRestoredPageState();
          }
          this.warn(`browser tab page-state restore failed tabId=${tab.tabId}`, error);
          await this.residencyOptions.recoveryStore?.removePageState(tab.tabId);
        }
      }
    }
    if (!tab.cachedUrl) return false;
    try {
      await guest.loadURL(tab.cachedUrl);
      return true;
    } catch (error) {
      this.warn(`browser tab URL restore failed tabId=${tab.tabId}`, error);
      return false;
    }
  }

  private async restoreReboundGuest(
    tab: ManagedTab,
    guest: GuestWebContents,
  ): Promise<GuestWebContents | null> {
    if (tab.lifecycle === "closed" || tab.guest !== guest) return null;
    const restored = await this.restoreGuestState(tab, guest);
    if (!restored || tab.lifecycle === "closed" || tab.guest !== guest) {
      if (tab.lifecycle !== "closed" && tab.guest === guest) {
        this.warn(`browser tab guest rebind restore failed tabId=${tab.tabId}`);
      }
      return null;
    }
    this.log?.(
      `[browser-use] guest rebind restore complete tabId=${tab.tabId} url=${tab.cachedUrl}`,
    );
    await this.persistShell(tab);
    return guest;
  }

  private async persistRecoverySnapshot(tab: ManagedTab, guest: GuestWebContents): Promise<void> {
    tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
    tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
    await this.persistShell(tab);
    try {
      const entries = guest.navigationHistory.getAllEntries().map((entry) => ({ ...entry }));
      if (entries.length === 0) return;
      const pageState: BrowserTabPageStateRecord = {
        schemaVersion: 1,
        tabId: tab.tabId,
        entries,
        activeIndex: guest.navigationHistory.getActiveIndex(),
        updatedAt: this.now(),
      };
      await this.residencyOptions.recoveryStore?.upsertPageState(pageState);
    } catch (error) {
      // A snapshot failure must not exceed resource budgets forever; the shell's restoreUrl is already saved.
      this.warn(`browser tab page-state snapshot failed tabId=${tab.tabId}`, error);
    }
  }

  private async persistShell(tab: ManagedTab): Promise<void> {
    const store = this.residencyOptions.recoveryStore;
    if (!store || tab.lifecycle === "closed") return;
    const residency = this.residencyCoordinator.get(tab.tabId);
    const record: BrowserTabShellRecord = {
      schemaVersion: 1,
      tabId: tab.tabId,
      windowBindingId: null,
      workspaceKey: tab.owner.workspaceKey,
      ...(tab.owner.remoteSessionId ? { remoteSessionId: tab.owner.remoteSessionId } : {}),
      sessionId: tab.owner.sessionId,
      browserId: tab.owner.browserId,
      browserGeneration: tab.owner.browserGeneration,
      origin: tab.origin,
      lifecycle: tab.lifecycle,
      restoreUrl: tab.cachedUrl || null,
      title: tab.cachedTitle || null,
      faviconUrl: tab.cachedFaviconUrl,
      viewport: tab.viewportOverride ? { ...tab.viewportOverride } : null,
      openedAt: tab.openedAt,
      lastSelectedAt: residency?.lastSelectedAt ?? null,
      updatedAt: this.now(),
    };
    try {
      await store.upsert(record);
    } catch (error) {
      this.warn(`browser tab shell persist failed tabId=${tab.tabId}`, error);
    }
  }

  private requireRendererOwnedTab(
    payload: BrowserViewCloseTabRequest & { windowId: number },
    options?: { skipRemoteSession?: boolean },
  ): ManagedTab;
  private requireRendererOwnedTab(
    payload: BrowserViewResidencyReportPayload & { windowId: number },
    options?: { skipRemoteSession?: boolean },
  ): ManagedTab;
  private requireRendererOwnedTab(
    payload:
      | (BrowserViewCloseTabRequest & { windowId: number })
      | (BrowserViewResidencyReportPayload & { windowId: number }),
    options?: { skipRemoteSession?: boolean },
  ): ManagedTab {
    const tab = this.tabs.get(payload.tabId);
    if (
      !tab ||
      tab.lifecycle === "closed" ||
      tab.owner.windowId !== payload.windowId ||
      tab.owner.workspaceKey !== payload.workspaceKey ||
      tab.owner.sessionId !== payload.sessionId ||
      (!options?.skipRemoteSession &&
        (tab.owner.remoteSessionId ?? "") !== (payload.remoteSessionId ?? ""))
    ) {
      throw new Error(`browser tab '${payload.tabId}' is unavailable for renderer scope`);
    }
    return tab;
  }

  private setupActivityTracking(tab: ManagedTab, guest: GuestWebContents): void {
    tab.activityCleanup?.();
    if (!guest.on || !guest.removeListener) return;
    const onLoadingStarted = () => {
      if (tab.guest !== guest) return;
      tab.loading = true;
      this.refreshRuntimeProtection(tab.tabId);
    };
    const onLoadingStopped = () => {
      if (tab.guest !== guest) return;
      tab.loading = false;
      if (!this.guestRecoveryFlights.has(tab.tabId)) {
        tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
        tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
      }
      this.refreshRuntimeProtection(tab.tabId);
      void this.persistShell(tab);
    };
    const onAudioChanged = () => this.refreshRuntimeProtection(tab.tabId);
    const onMediaStarted = () => {
      if (tab.guest !== guest) return;
      tab.mediaActive = true;
      this.refreshRuntimeProtection(tab.tabId);
    };
    const onMediaPaused = () => {
      if (tab.guest !== guest) return;
      tab.mediaActive = false;
      this.refreshRuntimeProtection(tab.tabId);
    };
    guest.on("did-start-loading", onLoadingStarted);
    guest.on("did-stop-loading", onLoadingStopped);
    guest.on("audio-state-changed", onAudioChanged);
    guest.on("media-started-playing", onMediaStarted);
    guest.on("media-paused", onMediaPaused);
    tab.activityCleanup = () => {
      guest.removeListener?.("did-start-loading", onLoadingStarted);
      guest.removeListener?.("did-stop-loading", onLoadingStopped);
      guest.removeListener?.("audio-state-changed", onAudioChanged);
      guest.removeListener?.("media-started-playing", onMediaStarted);
      guest.removeListener?.("media-paused", onMediaPaused);
    };
  }

  private refreshRuntimeProtection(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.residencyCoordinator.report(tabId, {
      loading: tab.loading,
      operationActive: this.hasRunningRequestForTab(tabId),
      captureActive: this.isTabCaptureActive(tab),
      audible: safeBool(() => tab.guest?.isCurrentlyAudible?.() ?? false, false),
      mediaActive: tab.mediaActive,
      downloadActive: this.hasPendingDownloadForTab(tabId),
    });
  }

  private hasRunningRequestForTab(tabId: string): boolean {
    return [...this.runningRequests.values()].some((request) => request.tabId === tabId);
  }

  private isTabCaptureActive(tab: ManagedTab): boolean {
    return (
      this.inFlightScreenshots.has(tab.tabId) ||
      [...this.recordings.values()].some(
        (entry) => entry.tabId === tab.tabId && entry.status === "running",
      ) ||
      safeBool(() => tab.guest?.isBeingCaptured?.() ?? false, false)
    );
  }

  private hasPendingDownloadForTab(tabId: string): boolean {
    return [...this.downloads.values()].some(
      (record) => record.tabId === tabId && record.state === "pending",
    );
  }

  private detachAndCloseGuest(tab: ManagedTab): void {
    const guest = tab.guest;
    // Closing first lands destroyed and later listener cleanup on a destroyed object;
    // Electron then prints 'Object has been destroyed' forever. Tear down CDP/session/listeners, then drop the saved
    // WebContents reference: frees the real renderer, keeps the logical tab lifetime unchanged.
    this.detachGuest(tab);
    this.closeGuestWebContents(tab, guest);
  }

  private rejectGuestAttach(
    tab: ManagedTab,
    guest: GuestWebContents,
    reason: BrowserGuestAttachRejectReason,
  ): BrowserGuestAttachResult {
    // Scope/session mismatch used to just return: the renderer never learns the reason, waitForGuest
    // waits out the timeout, and the rejected incoming guest had no unified cleanup, possibly orphaning a WebContents.
    const recoveryRequested = this.requestGuestRebind(tab, reason);
    if (tab.guest !== guest) this.closeGuestWebContents(tab, guest);
    return { ok: false, reason, recoveryRequested };
  }

  private requestGuestRebind(tab: ManagedTab, reason: GuestRecoveryReason): boolean {
    tab.attachFailure = reason;
    if (tab.lifecycle === "closed" || tab.rebindRequested || !this.onOpenTabRequested) return false;
    tab.rebindRequested = true;
    this.log?.(`[browser-use] request guest rebind tabId=${tab.tabId} reason=${reason}`);
    this.onOpenTabRequested?.(tab.tabId, tab.owner);
    return true;
  }

  private closeGuestWebContents(tab: ManagedTab, guest = tab.guest): void {
    if (!guest || safeBool(() => guest.isDestroyed(), true)) return;
    try {
      guest.close({ waitForBeforeUnload: false });
    } catch (error) {
      this.warn(`browser guest close failed tabId=${tab.tabId}`, error);
    }
  }

  private now(): number {
    return this.residencyOptions.now?.() ?? Date.now();
  }

  private warn(message: string, error?: unknown): void {
    const suffix =
      error === undefined ? "" : ` error=${error instanceof Error ? error.message : String(error)}`;
    this.residencyOptions.warn?.(`${message}${suffix}`);
    this.log?.(`[browser-use] ${message}${suffix}`);
  }

  detach(key: string): void {
    const tab = this.tabs.get(key);
    if (tab) this.detachGuest(tab);
  }

  /**
   * When the renderer is about to replace <webview> via React key, close the old guest's native CDP channel first.
   *
   * Electron's render-process-gone does not always reach the main WebContents
   * listener; if the renderer unmounts the node directly, once destroyed arrives debugger.detach() is impossible and
   * DevToolsSession may still dispatch in-flight notifications into the freed client - main-process UAF. This makes DOM
   * teardown phase two, after the main ACK, with sender-window + current-guest-id validation so a late
   * old-generation event cannot disconnect the new guest that just took the tab.
   */
  async detachGuestBeforeReplacement(
    tabId: string,
    webContentsId: number,
    windowId: number,
  ): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) return true;
    if (tab.owner.windowId !== windowId) {
      this.log?.(
        `[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} ` +
          `guestId=${webContentsId} reason=window-mismatch`,
      );
      return false;
    }

    const guest = tab.guest;
    if (!guest) return true;
    const guestIdMatches = safeBool(() => guest.id === webContentsId, false);
    if (!guestIdMatches) {
      this.log?.(
        `[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} ` +
          `guestId=${webContentsId} reason=guest-mismatch`,
      );
      return false;
    }
    if (safeBool(() => guest.isDestroyed(), true)) {
      // Past destroyed there is no safe native-detach window; only a prior confirmed CDP disconnect allows the swap.
      if (tab.cdpAttached) {
        this.log?.(
          `[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} ` +
            `guestId=${webContentsId} reason=destroyed-with-cdp`,
        );
        return false;
      }
      this.detachGuest(tab);
      return true;
    }

    return this.beginGuestTeardown(tab, guest, "renderer replacement");
  }

  private beginGuestTeardown(
    tab: ManagedTab,
    guest: GuestWebContents,
    reason: string,
  ): Promise<boolean> {
    const existing = tab.guestTeardownFlight;
    if (existing) return existing;
    const flight = this.runGuestTeardown(tab, guest, reason);
    tab.guestTeardownFlight = flight;
    const clearFlight = () => {
      if (tab.guestTeardownFlight === flight) tab.guestTeardownFlight = undefined;
    };
    void flight.then(clearFlight, clearFlight);
    return flight;
  }

  private async runGuestTeardown(
    tab: ManagedTab,
    guest: GuestWebContents,
    reason: string,
  ): Promise<boolean> {
    if (tab.guest !== guest) return !tab.cdpAttached;
    tab.guestLifecycle = "detaching";

    // Stop new requests/recordings entering CDP first; dispatched ones stay counted by pendingCdpCommands
    // until their promises settle, so an outer cancel never reads a native command as finished.
    for (const request of this.runningRequests.values()) {
      if (request.tabId !== tab.tabId) continue;
      request.controller.abort(new DOMException(`browser guest ${reason}`, "AbortError"));
    }
    this.abortRecordings((entry) => entry.tabId === tab.tabId, `browser guest ${reason}`);

    const pendingAtStart = tab.pendingCdpCommands;
    const settled = await this.waitForGuestCdpIdle(tab, DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS);
    if (!settled) {
      this.warn(
        `browser guest teardown cdp pending timeout tabId=${tab.tabId} ` +
          `pending=${tab.pendingCdpCommands} started=${pendingAtStart} reason=${reason}`,
      );
    }

    // destroyed may arrive first while waiting; detachGuest has finished the JS side, but native
    // detach counts as safe only once cdpAttached=false.
    if (tab.guest !== guest) return !tab.cdpAttached;
    if (safeBool(() => guest.isDestroyed(), true)) {
      if (tab.cdpAttached) {
        this.log?.(
          `[browser-use] guest teardown rejected on destroyed guest tabId=${tab.tabId} ` +
            `guestId=${safeStr(() => String(guest.id), "?")}`,
        );
        return false;
      }
      this.detachGuest(tab);
      return true;
    }

    try {
      if (guest.debugger.isAttached()) guest.debugger.detach();
      if (guest.debugger.isAttached()) {
        this.warn(
          `browser guest replacement cdp detach not confirmed tabId=${tab.tabId} ` +
            `guestId=${safeStr(() => String(guest.id), "?")}`,
        );
        return false;
      }
    } catch (error) {
      // Fail closed: on detach failure keep the old node; do not reopen the known native-UAF window by rebuilding.
      this.warn(
        `browser guest replacement cdp detach failed tabId=${tab.tabId} ` +
          `guestId=${safeStr(() => String(guest.id), "?")}`,
        error,
      );
      if (tab.guest === guest && !safeBool(() => guest.isDestroyed(), true)) {
        tab.guestLifecycle = "attached";
      }
      return false;
    }

    this.log?.(
      `[browser-use] cdp detached before guest replacement tabId=${tab.tabId} ` +
        `guestId=${safeStr(() => String(guest.id), "?")}`,
    );
    tab.cdpAttached = false;
    tab.guestLifecycle = "detached";
    this.detachGuest(tab);
    return true;
  }

  private async waitForGuestCdpIdle(tab: ManagedTab, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (tab.pendingCdpCommands > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(10, deadline - Date.now())),
      );
    }
    return tab.pendingCdpCommands === 0;
  }

  /** Memory diagnostics counter; reads size only. */
  collectMemoryDiagnostics(): Record<string, number> {
    return { tabs: this.tabs.size, closedTabIds: this.closedTabIds.size };
  }

  private detachGuest(tab: ManagedTab): void {
    const guest = tab.guest;
    const guestDestroyed = guest ? safeBool(() => guest.isDestroyed(), true) : true;
    if (guest && !this.guestRecoveryFlights.has(tab.tabId)) {
      tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
      tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
    }
    this.pendingDialogs.delete(tab.tabId);
    try {
      // Electron destroys the guest as the renderer unmounts <webview>; the listener died with the object,
      // and a later session.removeListener only logs a pointless 'Object has been destroyed'.
      if (!guestDestroyed) tab.downloadCleanup?.();
    } catch (error) {
      // After the guest renderer is killed, the old session's removeListener throws
      // 'Object has been destroyed' too; cleanup failure never blocks the replacement's CDP rebind.
      this.log?.(
        `[browser-use] detachGuest download cleanup failed tabId=${tab.tabId} error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      tab.downloadCleanup = undefined;
    }
    try {
      if (!guestDestroyed) tab.activityCleanup?.();
    } catch {
      // Listener cleanup can fail once the guest is gone; residency convergence continues regardless.
    } finally {
      tab.activityCleanup = undefined;
      tab.loading = false;
      tab.mediaActive = false;
    }
    // Unregistering the crash guard is not gated on guestDestroyed: removeListener is pure JS,
    // and in replacement scenarios the guest reference often lives on; missing it accumulates listeners per generation.
    try {
      tab.crashGuardCleanup?.();
    } catch {
      // removeListener may throw 'Object has been destroyed' once the guest is gone; convergence is unaffected.
    } finally {
      tab.crashGuardCleanup = undefined;
    }
    // JS-side listener cleanup: after replacement/destruction the old message listener must not linger. Unrelated to
    // native CDP teardown (DevToolsSession dispatch ignores JS listeners); it just stops per-generation accumulation.
    const cdpWasAttached = tab.cdpAttached;
    try {
      tab.cdpMessageCleanup?.();
    } catch (error) {
      this.log?.(
        `[browser-use] detachGuest cdp message cleanup failed tabId=${tab.tabId} error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      tab.cdpMessageCleanup = undefined;
    }
    if (guest) {
      const guestId = safeStr(() => String(guest.id), "?");
      if (guestDestroyed) {
        // Guest destroyed before detach (destroyed callback / renderer unmount). detach()
        // then must throw, pointlessly: the native DevToolsAgentHost closed with the WebContents and main can
        // only accept the outcome. The crash site (client_
        // vptr=0 in DevToolsSession::DispatchProtocolNotification) follows 'CDP closed by implicit destruction, no explicit
        // detach', so this path must be logged - no other trace ties the crash to a tab lifetime.
        if (cdpWasAttached) {
          this.log?.(
            `[browser-use] detachGuest cdp still attached on destroyed guest ` +
              `tabId=${tab.tabId} guestId=${guestId}`,
          );
        }
      } else {
        try {
          if (guest.debugger.isAttached()) guest.debugger.detach();
        } catch (error) {
          // Never swallow silently: success and failure are indistinguishable in logs - and 'could have
          // detached but failed' is exactly the signal to correlate with the crash.
          this.warn(`browser guest cdp detach failed tabId=${tab.tabId} guestId=${guestId}`, error);
        }
      }
    }
    this.clearGuestCdpIdleRelease(tab);
    tab.guest = undefined;
    tab.cdpAttached = false;
    tab.guestLifecycle = guestDestroyed ? "destroyed" : "detached";
    tab.backgroundViewportFallback = undefined;
    // The scale belongs to the old guest's CDP session; the successor's natural viewport replays no metrics.
    tab.appliedViewportScale = undefined;
    tab.viewportMutation = undefined;
    this.residencyCoordinator.markDetached(tab.tabId);
    this.refreshRuntimeProtection(tab.tabId);
  }

  hasGuest(key: string): boolean {
    const tab = this.tabs.get(key);
    return Boolean(tab?.guest && tab.lifecycle !== "closed");
  }

  disposeAll(): void {
    for (const request of this.runningRequests.values()) {
      request.controller.abort(new DOMException("browser manager disposed", "AbortError"));
    }
    for (const tab of this.tabs.values()) this.closeTab(tab, false);
    for (const key of this.waiters.keys()) this.resolveWaiters(key, null);
    this.tabs.clear();
    this.closedTabIds.clear();
    this.activeTabByScope.clear();
    this.defaultTabByScope.clear();
    this.sessionNames.clear();
    this.naturalViewportByWindow.clear();
    for (const [tabId, waiters] of this.downloadWaiters) {
      let waiter = waiters[0];
      while (waiter) {
        this.finishDownloadWaiter(tabId, waiter, null);
        waiter = waiters[0];
      }
    }
    this.downloads.clear();
    this.queuedDownloads.clear();
    this.inFlightScreenshots.clear();
    this.abandonedScreenshotCaptures.clear();
    for (const entry of this.recordings.values()) {
      entry.controller.abort(new DOMException("browser manager disposed", "AbortError"));
      if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
      if (entry.artifact?.path)
        void rm(entry.artifact.path, { force: true }).catch(() => undefined);
    }
    this.recordings.clear();
    this.residencyCoordinator.dispose();
    this.restoredTabClaims.clear();
    for (const resolve of this.suspendAckWaiters.values()) resolve();
    this.suspendAckWaiters.clear();
    this.suspendFlights.clear();
    this.restoreFlights.clear();
    this.guestRecoveryFlights.clear();
    this.guestAttachFlights.clear();
  }

  private waitForGuest(tabId: string, signal?: AbortSignal): Promise<GuestWebContents | null> {
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise<GuestWebContents | null>((resolve) => {
      const waiter: PendingWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.removeWaiter(tabId, waiter);
          this.log?.(`[browser-use] waitForGuest timeout tabId=${tabId}`);
          resolve(null);
        }, this.attachTimeoutMs),
        signal,
      };
      waiter.onAbort = () => {
        this.removeWaiter(tabId, waiter);
        resolve(null);
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      const list = this.waiters.get(tabId) ?? [];
      list.push(waiter);
      this.waiters.set(tabId, list);
    });
  }

  private removeWaiter(tabId: string, waiter: PendingWaiter): void {
    clearTimeout(waiter.timer);
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
    const list = this.waiters.get(tabId);
    if (!list) return;
    const index = list.indexOf(waiter);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this.waiters.delete(tabId);
  }

  private resolveWaiters(tabId: string, guest: GuestWebContents | null): void {
    const list = this.waiters.get(tabId);
    if (!list) return;
    this.waiters.delete(tabId);
    for (const waiter of list) {
      clearTimeout(waiter.timer);
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(guest);
    }
  }
}

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function waitForPromiseWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<{ completed: true; value: T } | { completed: false }> {
  if (signal.aborted) return Promise.resolve({ completed: false });
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ completed: false });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ completed: true, value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function waitForDelay(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<"matched" | "timeout" | "cancelled"> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) return "cancelled";
    if (predicate()) return "matched";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "timeout";
    if (!(await waitForDelay(Math.min(50, remaining), signal))) return "cancelled";
  }
}

function readScreenshotSurfaceInvalidation(signal: AbortSignal | undefined): Error | undefined {
  if (!signal?.aborted) return undefined;
  if (signal.reason instanceof Error) return signal.reason;
  return new Error("browser screenshot activity was invalidated");
}

async function raceBackendExecution(
  execution: Promise<BrowserCommandResult>,
  signal: AbortSignal,
  command: BrowserCommand,
  startedAt: number,
): Promise<BrowserCommandResult> {
  if (signal.aborted) {
    return {
      ok: false,
      error: {
        code: "cancelled",
        message: "browser request cancelled after backend dispatch; side effects may have occurred",
        sideEffect: isSideEffecting(command) ? "uncertain" : "none",
      },
      elapsedMs: Date.now() - startedAt,
    };
  }
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: BrowserCommandResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () =>
      finish({
        ok: false,
        error: {
          code: "cancelled",
          message: isSideEffecting(command)
            ? "browser request cancelled after backend dispatch; side effects may have occurred"
            : "browser request cancelled",
          sideEffect: isSideEffecting(command) ? "uncertain" : "none",
        },
        elapsedMs: Date.now() - startedAt,
      });
    signal.addEventListener("abort", onAbort, { once: true });
    execution.then(finish, (error: unknown) =>
      finish({
        ok: false,
        error: {
          code: "execution_error",
          message: error instanceof Error ? error.message : String(error),
        },
        elapsedMs: Date.now() - startedAt,
      }),
    );
  });
}

function isBrowserViewportSize(value: unknown): value is BrowserViewportSize {
  if (!value || typeof value !== "object") return false;
  const viewport = value as Record<string, unknown>;
  return (
    Number.isInteger(viewport.width) &&
    Number(viewport.width) > 0 &&
    Number.isInteger(viewport.height) &&
    Number(viewport.height) > 0
  );
}

function isBrowserPointValue(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return typeof point.x === "number" && typeof point.y === "number";
}

function abortError(): DOMException {
  return new DOMException("Browser recording cancelled", "AbortError");
}

function normalizeBackgroundViewport(viewport: BrowserViewportSize): BrowserViewportSize {
  return {
    width: Math.min(
      BROWSER_VIEWPORT_LIMITS.maxWidth,
      Math.max(BROWSER_VIEWPORT_LIMITS.minWidth, viewport.width),
    ),
    height: Math.min(
      BROWSER_VIEWPORT_LIMITS.maxHeight,
      Math.max(BROWSER_VIEWPORT_LIMITS.minHeight, viewport.height),
    ),
  };
}

function isScreenshotCommand(command: BrowserCommand): boolean {
  return (
    command.method === "screenshot" ||
    (command.method === "playwright" && command.action.name === "elementScreenshot")
  );
}

function assertViewportOverride(viewport: BrowserViewportSize): void {
  if (
    !Number.isInteger(viewport.width) ||
    viewport.width < BROWSER_VIEWPORT_LIMITS.minWidth ||
    viewport.width > BROWSER_VIEWPORT_LIMITS.maxWidth ||
    !Number.isInteger(viewport.height) ||
    viewport.height < BROWSER_VIEWPORT_LIMITS.minHeight ||
    viewport.height > BROWSER_VIEWPORT_LIMITS.maxHeight
  ) {
    throw new Error("browser viewport is outside the supported free-size range");
  }
}

function safeStr(fn: () => string, fallback: string): string {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function safeBool(fn: () => boolean, fallback: boolean): boolean {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function normalizeDialogType(type: string | undefined): BrowserDialog["type"] {
  switch (type) {
    case "alert":
    case "confirm":
    case "prompt":
    case "beforeunload":
      return type;
    default:
      return "alert";
  }
}

/** Browser response meta enters model traces and debug logs; keep origin/path only, never credentials/query/hash. */
function sanitizeBrowserMetaUrl(value: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const sanitized = url.toString();
    return url.pathname === "/" ? sanitized.slice(0, -1) : sanitized;
  } catch {
    // Legal opaque URLs like about:blank still parse; unparseable internal page strings never enter meta.
    return undefined;
  }
}
