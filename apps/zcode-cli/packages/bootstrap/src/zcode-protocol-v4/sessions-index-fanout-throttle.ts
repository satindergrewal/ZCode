// Throttling high-frequency events in the sessions-index fan-out (docs/v4-refactor/14-sessions-index.md, event fan-out cadence).
// Scheduling only: window state and timers live here; publish is injected by the caller, gateways keep only call sites.
//
// Root-cause memo: one workflow run's engine events come back as DynamicWorkflowRunProgress on the parent session — 4000 in 8s measured.
// Each bumps record.updatedAt, so every summary changes -> the old implementation flushed a sessions-index delta per event
// -> host recomputes the task row -> renderer re-pulls the task list at event frequency. ModelStreaming was excluded for the same reason long ago.

/** Fan-out window for workflow progress events: in-window updates collapse into one publish at window end (sidebar running rows <=4Hz). */
export const WORKFLOW_PROGRESS_INDEX_FANOUT_MS = 250;

/** The timer handle is opaque to scheduling: production uses setTimeout, tests inject any implementation. */
export type FanoutTimerHandle = unknown;

export interface SessionsIndexFanoutThrottleOptions {
  /** Publishes the session's current summary to sessions-index (the gateway's publishCurrentSummaryToIndex). */
  publish: (sessionId: string) => void;
  windowMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => FanoutTimerHandle;
  clearTimer?: (handle: FanoutTimerHandle) => void;
}

interface WindowState {
  /** Whether unsent progress remains in the window; falls back to false once any immediate publish satisfies it. */
  pending: boolean;
  handle: FanoutTimerHandle;
}

function defaultSetTimer(callback: () => void, delayMs: number): FanoutTimerHandle {
  const timer = setTimeout(callback, delayMs);
  // CLI process exit must not be trapped by a throttle window (same posture as scheduleFlush).
  timer.unref?.();
  return timer;
}

function defaultClearTimer(handle: FanoutTimerHandle): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

/**
 * leading + trailing window throttle with per-session windows:
 * the first request after silence publishes immediately and opens a window; later in-window requests only set pending, collapsing into one publish at window end.
 * Pending at window end -> publish and re-open; at most one frame per window during bursts. No pending -> close the window,
 * and the next request takes the leading edge again.
 */
export class SessionsIndexFanoutThrottle {
  private readonly windows = new Map<string, WindowState>();
  private readonly publish: (sessionId: string) => void;
  private readonly windowMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => FanoutTimerHandle;
  private readonly clearTimer: (handle: FanoutTimerHandle) => void;

  constructor(options: SessionsIndexFanoutThrottleOptions) {
    this.publish = options.publish;
    this.windowMs = options.windowMs ?? WORKFLOW_PROGRESS_INDEX_FANOUT_MS;
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
  }

  /** High-frequency publish request: publish immediately (leading) or fold into the window-end publish (trailing). */
  request(sessionId: string): void {
    const open = this.windows.get(sessionId);
    if (open) {
      open.pending = true;
      return;
    }
    this.openWindow(sessionId);
    this.publish(sessionId);
  }

  /**
   * Any immediate publish (non-progress events, hydration catch-up, ...) already carries the window's merged progress,
   * The pending trailing is satisfied by it: clear pending only, keep window throttling, never emit an empty delta.
   */
  notePublished(sessionId: string): void {
    const open = this.windows.get(sessionId);
    if (open) open.pending = false;
  }

  /** Session runtime cleanup: the window timer must disappear with it (cleanupSessionRuntime). */
  clearSession(sessionId: string): void {
    const open = this.windows.get(sessionId);
    if (!open) return;
    this.clearTimer(open.handle);
    this.windows.delete(sessionId);
  }

  /** Gateway dispose: clear every window timer. */
  clear(): void {
    for (const open of this.windows.values()) this.clearTimer(open.handle);
    this.windows.clear();
  }

  private openWindow(sessionId: string): void {
    this.windows.set(sessionId, {
      pending: false,
      handle: this.setTimer(() => this.onWindowElapsed(sessionId), this.windowMs),
    });
  }

  private onWindowElapsed(sessionId: string): void {
    const open = this.windows.get(sessionId);
    if (!open) return;
    if (!open.pending) {
      // No new progress in the window -> close it; the next progress publishes immediately again.
      this.windows.delete(sessionId);
      return;
    }
    // Extend the window before publishing: publish calls back into notePublished, so state must already be the new window's.
    open.pending = false;
    open.handle = this.setTimer(() => this.onWindowElapsed(sessionId), this.windowMs);
    this.publish(sessionId);
  }
}
