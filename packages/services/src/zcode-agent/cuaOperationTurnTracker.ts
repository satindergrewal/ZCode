import { resolveWorkspaceKey, type ZCodeComputerUseOperationEvent } from "@zcode/shared";
import type { PipSessionEvent } from "@zcode/zcode-cua/pip-session";

export interface CuaOperationWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface CuaOperationState {
  active: boolean;
  sessionId: string;
  turnId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface CuaOperationStateReporter {
  onStateChanged(event: CuaOperationState): void;
}

interface CuaOperationTurnTracker {
  accept(workspace: CuaOperationWorkspaceTarget, event: ZCodeComputerUseOperationEvent): void;
  /** Whether a turn with a running Computer Use tool exists. */
  hasActiveTurn(): boolean;
  clearWorkspaceKey(workspaceKey: string): void;
  clearAll(): void;
}

interface TrackerLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

interface ActiveTurnRecord extends CuaOperationState {
  workspaceKey: string;
  sessionKey: string;
  turnKey: string;
}

const MAX_RETIRED_TURN_KEYS = 2_048;
const MAX_SEEN_OPERATION_EVENT_IDS = 8_192;

function toReportedState(record: ActiveTurnRecord, active: boolean): CuaOperationState {
  return {
    active,
    sessionId: record.sessionId,
    turnId: record.turnId,
    workspacePath: record.workspacePath,
    ...(record.workspaceIdentity ? { workspaceIdentity: record.workspaceIdentity } : {}),
  };
}

export function createCuaOperationTurnTracker(options: {
  /** Desktop projection for the Windows top banner; not injected off-win32. */
  reporter?: CuaOperationStateReporter;
  /** Aggregation boundary for the Windows operation indicator; PiP no longer consumes it. */
  onTurnsActive?: () => void;
  onTurnsIdle?: () => void;
  /** macOS desktop-local PiP consumes exactly these product facts; panel policy stays producer-side. */
  onPipSessionLifecycle?: (
    workspace: CuaOperationWorkspaceTarget,
    event: Exclude<PipSessionEvent, { kind: "focus-changed" }>,
  ) => void;
  logger?: TrackerLogger;
}): CuaOperationTurnTracker {
  const currentTurnBySession = new Map<string, string>();
  const lastSeqBySession = new Map<string, number>();
  /**
   * Scheduled, confirmed-CUA tool calls (keyed turnKey\0toolCallId).
   *
   * Only tool-scheduled carries model source (ToolCallStartedPayload has no input), so CUA-ness
   // is decided at schedule time; the overlay lights up on real start - approval may sit in
   // between. Persist the scheduled fact here and redeem it on tool-started.
   */
  const computerUseScheduledCalls = new Set<string>();
  const activeTurns = new Map<string, ActiveTurnRecord>();
  const retiredTurnKeys = new Set<string>();
  const retiredTurnKeyOrder: string[] = [];
  const seenEventIds = new Set<string>();
  const seenEventIdOrder: string[] = [];

  const sessionKeyFor = (workspaceKey: string, sessionId: string) =>
    `${workspaceKey}\0${sessionId}`;
  const turnKeyFor = (sessionKey: string, turnId: string) => `${sessionKey}\0${turnId}`;
  const toolKeyFor = (turnKey: string, toolCallId: string) => `${turnKey}\0${toolCallId}`;

  function notifyBoundary(kind: "active" | "idle"): void {
    const callback = kind === "active" ? options.onTurnsActive : options.onTurnsIdle;
    if (!callback) return;
    options.logger?.info(
      `CUA operation turns ${kind === "active" ? "became active" : "went idle"} (activeTurns=${activeTurns.size})`,
    );
    try {
      callback();
    } catch (error) {
      // Boundary callbacks are a display side channel (PiP); never break the main event chain.
      options.logger?.warn(`CUA operation turn boundary callback failed error=${String(error)}`);
    }
  }

  function publishPipLifecycle(
    workspace: CuaOperationWorkspaceTarget,
    event: Exclude<PipSessionEvent, { kind: "focus-changed" }>,
  ): void {
    try {
      options.onPipSessionLifecycle?.(workspace, event);
    } catch (error) {
      options.logger?.warn(
        `CUA PiP lifecycle publisher failed session=${event.sessionId} event=${event.kind} error=${String(error)}`,
      );
    }
  }

  function report(record: ActiveTurnRecord, active: boolean, refresh = false): void {
    if (options.reporter) {
      try {
        options.reporter.onStateChanged(toReportedState(record, active));
      } catch (error) {
        // The reporter is a desktop projection side channel; MessagePort close races must not
        // break the main session event chain.
        options.logger?.warn(
          `CUA operation reporter failed workspace=${record.workspaceKey} session=${record.sessionId} turn=${record.turnId} error=${String(error)}`,
        );
      }
    }
    const message = `CUA operation turn ${active ? "activated" : "cleared"} workspace=${record.workspaceKey} session=${record.sessionId} turn=${record.turnId}`;
    if (refresh) {
      options.logger?.debug(message);
    } else {
      options.logger?.info(message);
    }
  }

  function retireTurn(turnKey: string): void {
    if (retiredTurnKeys.has(turnKey)) return;
    retiredTurnKeys.add(turnKey);
    retiredTurnKeyOrder.push(turnKey);
    while (retiredTurnKeyOrder.length > MAX_RETIRED_TURN_KEYS) {
      const removed = retiredTurnKeyOrder.shift();
      if (removed) retiredTurnKeys.delete(removed);
    }
  }

  function clearTurn(turnKey: string): void {
    const record = activeTurns.get(turnKey);
    if (record) {
      activeTurns.delete(turnKey);
      report(record, false);
    }
    const toolPrefix = `${turnKey}\0`;
    for (const key of computerUseScheduledCalls) {
      if (key.startsWith(toolPrefix)) computerUseScheduledCalls.delete(key);
    }
    // Only a truly removed operation turn can reach zero; never-active turns emit no boundary.
    if (record && activeTurns.size === 0) notifyBoundary("idle");
  }

  function clearSession(sessionKey: string): void {
    for (const record of activeTurns.values()) {
      if (record.sessionKey === sessionKey) clearTurn(record.turnKey);
    }
    const sessionPrefix = `${sessionKey}\0`;
    for (const key of computerUseScheduledCalls) {
      if (key.startsWith(sessionPrefix)) computerUseScheduledCalls.delete(key);
    }
  }

  function accept(
    workspace: CuaOperationWorkspaceTarget,
    event: ZCodeComputerUseOperationEvent,
  ): void {
    const workspaceKey = resolveWorkspaceKey(workspace);
    const sessionKey = sessionKeyFor(workspaceKey, event.sessionId);
    const eventKey = `${workspaceKey}\0${event.eventId}`;
    if (seenEventIds.has(eventKey)) return;
    seenEventIds.add(eventKey);
    seenEventIdOrder.push(eventKey);
    while (seenEventIdOrder.length > MAX_SEEN_OPERATION_EVENT_IDS) {
      const removed = seenEventIdOrder.shift();
      if (removed) seenEventIds.delete(removed);
    }

    const lastSeq = lastSeqBySession.get(sessionKey) ?? 0;
    if (event.sequenceNumber < lastSeq) {
      options.logger?.debug(
        `ignored stale CUA operation event sequenceNumber=${event.sequenceNumber} lastSeq=${lastSeq} session=${event.sessionId}`,
      );
      return;
    }
    // The sideband uses raw runtime sequenceNumbers; mixing them with legacy session/event seq
    // makes larger raw numbers flag later legacy terminals as late, leaking a permanent overlay.
    lastSeqBySession.set(sessionKey, Math.max(lastSeq, event.sequenceNumber));

    if (event.kind === "turn-started") {
      if (!event.turnId) return;
      const nextTurnKey = turnKeyFor(sessionKey, event.turnId);
      if (retiredTurnKeys.has(nextTurnKey)) return;
      publishPipLifecycle(workspace, {
        kind: "turn-started",
        sessionId: event.sessionId,
        turnId: event.turnId,
        sequenceNumber: event.sequenceNumber,
        eventId: event.eventId,
      });
      const previousTurnId = currentTurnBySession.get(sessionKey);
      if (previousTurnId && previousTurnId !== event.turnId) {
        retireTurn(turnKeyFor(sessionKey, previousTurnId));
        clearSession(sessionKey);
      }
      currentTurnBySession.set(sessionKey, event.turnId);
      return;
    }

    if (event.kind === "session-closed") {
      publishPipLifecycle(workspace, {
        kind: "session-closed",
        sessionId: event.sessionId,
        sequenceNumber: event.sequenceNumber,
        eventId: event.eventId,
      });
      const currentTurnId = currentTurnBySession.get(sessionKey);
      if (currentTurnId) retireTurn(turnKeyFor(sessionKey, currentTurnId));
      clearSession(sessionKey);
      currentTurnBySession.delete(sessionKey);
      return;
    }

    if (event.kind === "turn-completed" || event.kind === "turn-failed") {
      const turnId = event.turnId;
      if (!turnId) return;
      publishPipLifecycle(workspace, {
        kind: "turn-ended",
        sessionId: event.sessionId,
        turnId,
        sequenceNumber: event.sequenceNumber,
        eventId: event.eventId,
        outcome: event.kind === "turn-completed" ? "completed" : "failed",
      });
      const turnKey = turnKeyFor(sessionKey, turnId);
      retireTurn(turnKey);
      clearTurn(turnKey);
      if (currentTurnBySession.get(sessionKey) === turnId) {
        currentTurnBySession.delete(sessionKey);
      }
      return;
    }

    if (event.kind !== "tool-scheduled" && event.kind !== "tool-started") return;
    const toolCallId = event.toolCallId;
    const currentTurnId = currentTurnBySession.get(sessionKey);
    const turnId = event.turnId ?? currentTurnId;
    if (!toolCallId || !turnId) return;
    // Root cause: once a new turn replaces the old, late old-turn tool events must not revive
    // the terminated top banner.
    if (!currentTurnId) currentTurnBySession.set(sessionKey, turnId);

    const turnKey = turnKeyFor(sessionKey, turnId);
    if (retiredTurnKeys.has(turnKey)) return;
    const toolKey = toolKeyFor(turnKey, toolCallId);
    if (event.kind === "tool-scheduled") {
      if (event.computerUse) computerUseScheduledCalls.add(toolKey);
      return;
    }

    // Trust only the single boolean fact this tool call uses Computer Use; do not parse action names
    // (extracted from model source against a verb list - any SDK change breaks the chain).
    // The decision happens once in bootstrap (usesComputerUse).
    if (!computerUseScheduledCalls.delete(toolKey)) return;

    const existingRecord = activeTurns.get(turnKey);
    if (existingRecord) {
      // Every new CUA cell in a turn refreshes the overlay's safety deadline; the reporter resets
      // the fallback timer on the Main side without recreating the native window.
      report(existingRecord, true, true);
      return;
    }

    const record: ActiveTurnRecord = {
      active: true,
      workspaceKey,
      sessionKey,
      turnKey,
      sessionId: event.sessionId,
      turnId,
      workspacePath: workspace.workspacePath,
      ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
    };
    activeTurns.set(turnKey, record);
    report(record, true);
    if (activeTurns.size === 1) notifyBoundary("active");
  }

  function clearWorkspaceKey(workspaceKey: string): void {
    for (const record of activeTurns.values()) {
      if (record.workspaceKey === workspaceKey) clearTurn(record.turnKey);
    }
    const workspacePrefix = `${workspaceKey}\0`;
    for (const key of currentTurnBySession.keys()) {
      if (key.startsWith(workspacePrefix)) currentTurnBySession.delete(key);
    }
    for (const key of lastSeqBySession.keys()) {
      if (key.startsWith(workspacePrefix)) lastSeqBySession.delete(key);
    }
    for (const key of computerUseScheduledCalls) {
      if (key.startsWith(workspacePrefix)) computerUseScheduledCalls.delete(key);
    }
    for (let index = retiredTurnKeyOrder.length - 1; index >= 0; index -= 1) {
      const key = retiredTurnKeyOrder[index];
      if (!key?.startsWith(workspacePrefix)) continue;
      retiredTurnKeyOrder.splice(index, 1);
      retiredTurnKeys.delete(key);
    }
    for (let index = seenEventIdOrder.length - 1; index >= 0; index -= 1) {
      const key = seenEventIdOrder[index];
      if (!key?.startsWith(workspacePrefix)) continue;
      seenEventIdOrder.splice(index, 1);
      seenEventIds.delete(key);
    }
  }

  function clearAll(): void {
    for (const record of activeTurns.values()) clearTurn(record.turnKey);
    currentTurnBySession.clear();
    lastSeqBySession.clear();
    computerUseScheduledCalls.clear();
    retiredTurnKeys.clear();
    retiredTurnKeyOrder.length = 0;
    seenEventIds.clear();
    seenEventIdOrder.length = 0;
  }

  return {
    accept,
    hasActiveTurn: () => activeTurns.size > 0,
    clearWorkspaceKey,
    clearAll,
  };
}
