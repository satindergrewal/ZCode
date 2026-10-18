import {
  BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS,
  type BrowserViewportSize,
  type BrowserViewScreenshotSurfacePreparePayload,
  type BrowserViewScreenshotSurfaceReadyPayload,
  type BrowserViewScreenshotSurfaceReleasePayload,
} from "@zcode/shared";
import {
  releaseBrowserScreenshotResourceOnce,
  sameBrowserScreenshotViewport,
  toBrowserScreenshotSurfacePreparePayload,
  toBrowserScreenshotSurfaceReleasePayload,
  type BrowserScreenshotActivityLease,
  type BrowserScreenshotPendingRequest as PendingRequest,
  type BrowserScreenshotPreparationGroup as PreparationGroup,
  type BrowserScreenshotSurfaceCoordinator,
  type BrowserScreenshotSurfaceLease,
  type BrowserScreenshotSurfacePrepareInput,
} from "./browserScreenshotSurfaceContracts.js";

const DEFAULT_SCREENSHOT_ACTIVITY_TIMEOUT_MS = 35_000;
const UNSCALED_SURFACE_EPSILON = 0.001;
export type {
  BrowserScreenshotSurfaceCoordinator,
  BrowserScreenshotSurfaceLease,
} from "./browserScreenshotSurfaceContracts.js";

/**
 * * Transient screenshot-surface handshake between desktop main and the owner renderer.
 *
 * Concurrent captures of one guest reuse a single renderer surface; different guests serialize,
 * # or one background capture layer would point at two webviews, making ready attribution ambiguous.
 */
export class DesktopBrowserScreenshotSurfaceCoordinator implements BrowserScreenshotSurfaceCoordinator {
  private readonly timeoutMs: number;
  private readonly activityTimeoutMs: number;
  private readonly groupsByGuestKey = new Map<string, PreparationGroup>();
  private readonly groupsByReadyRequestId = new Map<string, PreparationGroup>();
  private readonly queuedGroups: PreparationGroup[] = [];
  private activeGroup: PreparationGroup | undefined;
  private schedulingSuspended = false;
  private disposed = false;

  constructor(
    private readonly options: {
      timeoutMs?: number;
      activityTimeoutMs?: number;
      acquireActivity?(
        windowId: number,
        payload: BrowserViewScreenshotSurfacePreparePayload,
      ): BrowserScreenshotActivityLease | undefined;
      sendPrepare(windowId: number, payload: BrowserViewScreenshotSurfacePreparePayload): boolean;
      sendRelease(windowId: number, payload: BrowserViewScreenshotSurfaceReleasePayload): void;
      log?(message: string): void;
      warn?(message: string): void;
    },
  ) {
    this.timeoutMs = options.timeoutMs ?? BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS;
    this.activityTimeoutMs = options.activityTimeoutMs ?? DEFAULT_SCREENSHOT_ACTIVITY_TIMEOUT_MS;
  }

  prepare(input: BrowserScreenshotSurfacePrepareInput): Promise<BrowserScreenshotSurfaceLease> {
    if (this.disposed) {
      return Promise.reject(new Error("browser screenshot surface coordinator disposed"));
    }

    if (input.signal.aborted) {
      return Promise.reject(new Error("browser screenshot surface preparation cancelled"));
    }

    if (input.viewport.width <= 0 || input.viewport.height <= 0) {
      return Promise.reject(
        new Error("browser screenshot surface preparation requires a non-zero viewport"),
      );
    }

    const key = this.getGuestKey(input);
    let group = this.groupsByGuestKey.get(key);
    if (group?.ready) {
      return Promise.resolve(this.createLease(group, input.signal));
    }

    if (!group) {
      group = {
        key,
        payload: toBrowserScreenshotSurfacePreparePayload(input, this.timeoutMs),
        windowId: input.windowId,
        requests: new Set(),
        prepareSent: false,
        ready: false,
        released: false,
        leaseReleases: new Set(),
        activityTimeoutMs: input.activityTimeoutMs,
        invalidationController: new AbortController(),
      };
      this.groupsByGuestKey.set(key, group);
      this.queuedGroups.push(group);
    }

    return new Promise<BrowserScreenshotSurfaceLease>((resolve, reject) => {
      const request = {} as PendingRequest;
      const failForAbort = () =>
        this.finishRequestError(
          request,
          new Error("browser screenshot surface preparation cancelled"),
        );
      request.input = input;
      request.group = group;
      request.resolve = resolve;
      request.reject = reject;
      request.timer = setTimeout(() => {
        this.finishRequestError(
          request,
          new Error(`browser screenshot surface preparation timed out after ${this.timeoutMs}ms`),
        );
      }, this.timeoutMs);
      request.abortListener = failForAbort;

      // Register before sending: doubles and real IPC may answer ready during sendPrepare itself.
      group.requests.add(request);
      input.signal.addEventListener("abort", failForAbort, { once: true });

      if (input.signal.aborted) {
        failForAbort();
        return;
      }

      this.activateNextGroup();
    });
  }

  handleReady(input: {
    windowId: number;
    senderWebContentsId: number;
    payload: BrowserViewScreenshotSurfaceReadyPayload;
  }): void {
    const group = this.groupsByReadyRequestId.get(input.payload.requestId);
    if (!group || group !== this.activeGroup || group.released || group.ready) {
      return;
    }

    const expected = group.payload;
    if (
      group.windowId !== input.windowId ||
      expected.requestId !== input.payload.requestId ||
      expected.workspaceKey !== input.payload.workspaceKey ||
      expected.sessionId !== input.payload.sessionId ||
      expected.browserId !== input.payload.browserId ||
      expected.browserGeneration !== input.payload.browserGeneration ||
      expected.tabId !== input.payload.tabId ||
      expected.webContentsId !== input.payload.webContentsId ||
      (expected.viewportMode ?? "emulated") !== (input.payload.viewportMode ?? "emulated")
    ) {
      this.options.log?.("[browser-screenshot-surface] ignored ready with mismatched identity");
      return;
    }

    if (
      group.senderWebContentsId !== undefined &&
      group.senderWebContentsId !== input.senderWebContentsId
    ) {
      this.options.log?.("[browser-screenshot-surface] ignored ready from a different renderer");
      return;
    }

    // Freeze the first complete scope's trusted renderer so a late reply from another window cannot take over.
    group.senderWebContentsId ??= input.senderWebContentsId;
    if (!sameBrowserScreenshotViewport(expected.viewport, input.payload.viewport)) {
      this.options.log?.("[browser-screenshot-surface] ignored ready with unstable viewport");
      return;
    }
    if (!Number.isFinite(input.payload.surfaceScale) || input.payload.surfaceScale <= 0) {
      this.options.log?.("[browser-screenshot-surface] ignored ready with invalid surface scale");
      return;
    }
    if (
      expected.surfaceScaleMode === "unscaled" &&
      Math.abs(input.payload.surfaceScale - 1) > UNSCALED_SURFACE_EPSILON
    ) {
      // The recorder upscales the fitted surface; resolution looks right but the frame is soft.
      // Main rejects non-100% factors at handshake, preventing silent fake-HD recordings after renderer regressions.
      this.options.log?.(
        "[browser-screenshot-surface] ignored ready with scaled recording surface",
      );
      return;
    }

    this.finishGroupReady(group, input.payload.viewport, input.payload.surfaceScale);
  }

  handleWindowDestroyed(windowId: number): void {
    const groups = Array.from(this.groupsByGuestKey.values());
    const schedulingWasSuspended = this.schedulingSuspended;
    this.schedulingSuspended = true;
    try {
      for (const group of groups) {
        if (group.windowId === windowId) {
          this.finishGroupError(
            group,
            new Error("browser screenshot surface preparation window destroyed"),
          );
        }
      }
    } finally {
      this.schedulingSuspended = schedulingWasSuspended;
      if (!schedulingWasSuspended) this.activateNextGroup();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const groups = Array.from(this.groupsByGuestKey.values());
    for (const group of groups) {
      this.finishGroupError(group, new Error("browser screenshot surface coordinator disposed"));
    }
  }

  private getGuestKey(input: BrowserScreenshotSurfacePrepareInput): string {
    return JSON.stringify([
      input.windowId,
      input.workspaceKey,
      input.sessionId,
      input.browserId,
      input.browserGeneration,
      input.tabId,
      input.webContentsId,
      input.viewport.width,
      input.viewport.height,
      input.surfaceScaleMode ?? "current",
      input.viewportMode ?? "emulated",
    ]);
  }

  private activateNextGroup(): void {
    if (this.activeGroup || this.disposed) return;

    const group = this.queuedGroups.shift();
    if (!group) return;
    if (group.released || group.requests.size === 0) {
      this.activateNextGroup();
      return;
    }

    this.activeGroup = group;
    this.groupsByReadyRequestId.set(group.payload.requestId, group);
    if (this.options.acquireActivity) {
      group.activityLease = this.options.acquireActivity(group.windowId, group.payload);
      if (!group.activityLease) {
        this.finishGroupError(
          group,
          new Error("browser screenshot activity could not be acquired"),
        );
        return;
      }
      const invalidated = group.activityLease.invalidated;
      if (invalidated) {
        const failForInvalidActivity = () => {
          const reason =
            invalidated.reason instanceof Error
              ? invalidated.reason
              : new Error("browser screenshot activity was invalidated");
          this.finishGroupError(group, reason);
        };
        group.activityAbortListener = failForInvalidActivity;
        invalidated.addEventListener("abort", failForInvalidActivity, { once: true });
        if (invalidated.aborted) {
          failForInvalidActivity();
          return;
        }
      }
      const activityTimeoutMs = group.activityTimeoutMs ?? this.activityTimeoutMs;
      group.activityTimer = setTimeout(() => {
        this.options.warn?.(
          `[browser-screenshot-surface] activity watchdog released requestId=${group.payload.requestId} windowId=${group.windowId}`,
        );
        this.finishGroupError(
          group,
          new Error(`browser screenshot activity timed out after ${activityTimeoutMs}ms`),
        );
      }, activityTimeoutMs);
    }
    // Release even when sendPrepare lies false: the renderer may have handled it despite the sender seeing failure.
    group.prepareSent = true;
    let sent = false;
    try {
      sent = this.options.sendPrepare(group.windowId, group.payload);
    } catch {
      // Doubles may ready synchronously inside sendPrepare; the lease is live and later send errors must not release early.
      if (!group.ready && !group.released) {
        this.finishGroupError(
          group,
          new Error("browser screenshot surface preparation could not be sent"),
        );
      }
      return;
    }

    if (!sent && !group.ready && !group.released) {
      this.finishGroupError(
        group,
        new Error("browser screenshot surface preparation could not be sent"),
      );
    }
  }

  private finishGroupReady(
    group: PreparationGroup,
    viewport: BrowserViewportSize,
    surfaceScale: number,
  ): void {
    if (group.ready || group.released) return;
    group.activityLease?.markPrepared?.();
    if (group.released) return;
    group.ready = true;
    group.readySurfaceScale = surfaceScale;
    group.readyViewport = viewport;
    this.groupsByReadyRequestId.delete(group.payload.requestId);

    const requests = [...group.requests];
    group.requests.clear();
    for (const request of requests) {
      this.clearRequest(request);
      request.resolve(this.createLease(group, request.input.signal));
    }
  }

  private finishRequestError(request: PendingRequest, error: Error): void {
    const { group } = request;
    if (!group.requests.delete(request)) return;
    this.clearRequest(request);
    request.reject(error);
    if (!group.ready && group.requests.size === 0) {
      this.settleGroup(group);
    }
  }

  private finishGroupError(group: PreparationGroup, error: Error): void {
    if (group.released) return;
    if (!group.invalidationController.signal.aborted) {
      group.invalidationController.abort(error);
    }
    const requests = [...group.requests];
    group.requests.clear();
    for (const request of requests) {
      this.clearRequest(request);
      request.reject(error);
    }
    this.settleGroup(group);
  }

  private clearRequest(request: PendingRequest): void {
    clearTimeout(request.timer);
    request.input.signal.removeEventListener("abort", request.abortListener);
  }

  private createLease(group: PreparationGroup, signal: AbortSignal): BrowserScreenshotSurfaceLease {
    let release!: () => void;
    const onAbort = () => release();
    release = releaseBrowserScreenshotResourceOnce(() => {
      signal.removeEventListener("abort", onAbort);
      group.leaseReleases.delete(release);
      if (group.released) return;
      if (group.leaseReleases.size === 0) {
        this.settleGroup(group);
      }
    });
    group.leaseReleases.add(release);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) release();

    return {
      invalidated: group.invalidationController.signal,
      surfaceScale: group.readySurfaceScale ?? 1,
      webContentsId: group.payload.webContentsId,
      viewport: group.readyViewport ?? group.payload.viewport,
      release,
    };
  }

  private settleGroup(group: PreparationGroup): void {
    if (group.released) return;
    group.released = true;
    if (group.activityTimer) {
      clearTimeout(group.activityTimer);
      group.activityTimer = undefined;
    }
    this.groupsByGuestKey.delete(group.key);
    this.groupsByReadyRequestId.delete(group.payload.requestId);

    const queuedIndex = this.queuedGroups.indexOf(group);
    if (queuedIndex >= 0) {
      this.queuedGroups.splice(queuedIndex, 1);
    }

    try {
      if (group.prepareSent) {
        this.options.sendRelease(
          group.windowId,
          toBrowserScreenshotSurfaceReleasePayload(group.payload),
        );
      }
    } catch {
      // release runs in timeout/abort/backend finally; a sync transport throw must not leave
      // activeGroup occupied forever, nor block the activity lease from restoring throttling.
      this.options.log?.("[browser-screenshot-surface] release send failed");
    } finally {
      for (const release of group.leaseReleases) release();
      group.leaseReleases.clear();
      const activityInvalidated = group.activityLease?.invalidated;
      if (activityInvalidated && group.activityAbortListener) {
        activityInvalidated.removeEventListener("abort", group.activityAbortListener);
      }
      group.activityAbortListener = undefined;
      group.activityLease?.release();
      group.activityLease = undefined;
    }

    if (this.activeGroup === group) {
      this.activeGroup = undefined;
      if (!this.schedulingSuspended) this.activateNextGroup();
    }
  }
}
