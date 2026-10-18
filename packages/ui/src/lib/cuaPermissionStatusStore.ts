/**
 * In-process shared cache for Computer Use Helper permission status.
 *
  * Why this exists: permission state has two consumers -- the settings Computer-Use section and the composer entry button.
  * Each used to hold its own useCuaPermissionStatus instance with its own polling and sticky probe snapshot,
 ~ * so one machine's TCC grant could show two different states and requests doubled.
  * This store converges last-result + in-flight dedup + sticky probes into one truth, slotted per workspace.
 *
  * Refresh is event-driven, not timed polling (page enter / app focus / explicit refresh), triggered by
  * useCuaPermissionStatus. The cache survives unmount: re-entering settings renders the last grant first
  * instead of flashing unknown->granted from null.
 */
import { isCuaPermissionStatusAvailable } from "@zcode/services";
import type {
  CuaPermissionStatus,
  CuaPermissionStatusQueryOptions,
  CuaPermissionStatusResult,
  ICuaPermissionService,
} from "@zcode/services";

import {
  persistCuaPermissionStatus,
  readCachedCuaPermissionStatus,
} from "./cuaPermissionStatusCache.js";

export interface CuaPermissionStatusSnapshot {
  /** Result of the last successful query; null = no status observed for this workspace yet. */
  status: CuaPermissionStatusResult | null;
  /**
   * Whether status is decision-safe. False while a query is in flight or the last one failed --
   * display may keep lastKnown, but actions like Open System Settings must wait for a fresh result.
   */
  fresh: boolean;
  /**
   * Whether presentable, confirmed content exists. True on cold-cache hit; once a real result lands it never downgrades.
   *
   * Division of labor with fresh: fresh means just-confirmed and resets to false per query;
   * if display followed it, the button would flip between Open System Settings and Verifying...
   * and jump width. settled is display-only, killing that jitter.
   */
  settled: boolean;
}

/**
 * Snapshot returned on slot miss. useSyncExternalStore needs a referentially stable getSnapshot;
 * a fresh object per call would loop renders, so construct once lazily and reuse.
 *
 * Seeded from the cross-process cache: in-memory slots empty on restart, and a null first frame would render the two
 * settings rows with buttons that vanish on the first query result (row-height collapse). The TCC grant belongs to the
 * Helper bundle, not a workspace, so it is the best guess for any workspace; not-yet-confirmed is fresh=false.
 */
let initialSnapshotCache: CuaPermissionStatusSnapshot | null = null;

function initialSnapshot(): CuaPermissionStatusSnapshot {
  if (!initialSnapshotCache) {
    const cached = readCachedCuaPermissionStatus();
    initialSnapshotCache = { status: cached, fresh: false, settled: cached !== null };
  }
  return initialSnapshotCache;
}

interface Slot {
  snapshot: CuaPermissionStatusSnapshot;
  inFlight: boolean;
  /** A refresh arrived while a query was in flight: coalesce into one follow-up instead of running concurrently. */
  rerunRequested: boolean;
  /** Explicit screenshot intent; OR-merged, reset right after consumption, at most once per round. */
  pendingFunctionalProbe: boolean;
  /** Backoff retry timer for transient unavailability; always undefined in the steady state. */
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Retry budget consumed so far; indexes TRANSIENT_RETRY_DELAYS_MS. */
  retryAttempt: number;
  /**
   * Ready snapshot: once fully-ready is observed (both TCC grants + both functional probes ok),
   * later read-only refreshes keep the confirmed-ok probe results while both TCC grants hold.
   * Read-only queries never run the screenshot probe anyway (upstream shouldRunCuaScreenCaptureProbe demands explicit
   * includeFunctionalProbes); propagating false would erase the measured-ready conclusion.
   * Real degradation (TCC revoked / Helper down) clears sticky in the else branch and publishes honestly.
   */
  stickyReady: CuaPermissionStatus | null;
}

const slots = new Map<string, Slot>();
const listeners = new Set<() => void>();

/**
 * Isomorphic with the settings helperContextKey: permission binds to (workspace path, workspace identity).
 * NUL-separated so spaces in paths cannot collide two workspaces into one slot.
 */
export function cuaPermissionStatusKey(workspacePath: string, workspaceIdentity?: string): string {
  return [workspacePath, workspaceIdentity?.trim() ?? ""].join("\u0000");
}

export function subscribeCuaPermissionStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCuaPermissionStatusSnapshot(key: string | null): CuaPermissionStatusSnapshot {
  if (!key) return initialSnapshot();
  return slots.get(key)?.snapshot ?? initialSnapshot();
}

/** Test reset: the module-level cache survives across cases. */
export function resetCuaPermissionStatusStoreForTest(): void {
  for (const slot of slots.values()) clearTransientRetry(slot);
  slots.clear();
  listeners.clear();
  initialSnapshotCache = null;
}

function ensureSlot(key: string): Slot {
  const existing = slots.get(key);
  if (existing) return existing;
  const created: Slot = {
    snapshot: initialSnapshot(),
    inFlight: false,
    rerunRequested: false,
    pendingFunctionalProbe: false,
    retryTimer: undefined,
    retryAttempt: 0,
    stickyReady: null,
  };
  slots.set(key, created);
  return created;
}

function clearTransientRetry(slot: Slot): void {
  if (slot.retryTimer) clearTimeout(slot.retryTimer);
  slot.retryTimer = undefined;
}

function publish(slot: Slot, snapshot: CuaPermissionStatusSnapshot): void {
  if (
    slot.snapshot.status === snapshot.status &&
    slot.snapshot.fresh === snapshot.fresh &&
    slot.snapshot.settled === snapshot.settled
  )
    return;
  slot.snapshot = snapshot;
  for (const listener of listeners) listener();
}

/**
 * Display readiness: both TCC grants present. The settings permission rows and the composer
 * entry button share this definition so the same grant renders identically in both places.
 *
 * Why display ignores functional probes: read-only refreshes never run the screenshot probe by upstream contract
 * (shouldRunCuaScreenCaptureProbe demands explicit includeFunctionalProbes -- active capture is always
 * user intent), so screenCaptureProbeOk is constant false; gating display on it would mark granted users
 * as pending forever. Real unavailability (TCC granted but WindowServer withholds pixels etc.) surfaces via the tool call's plain
 * MCP error to the model; the renderer never guesses permissions via resident polling or error text.
 */
export function isCuaPermissionTccGranted(result: CuaPermissionStatusResult | null): boolean {
  return (
    !!result &&
    "accessibility" in result &&
    result.accessibility === "granted" &&
    result.screenRecording === "granted"
  );
}

/**
 * Runtime end-to-end ready: both TCC granted **and** both functional probes measured ok.
 * Only a fresh explicit probe (post-grant, or post-Helper-restart verify) can set it,
 * so it only gates the sticky-snapshot record below, never the display.
 */
function isFunctionallyReady(result: CuaPermissionStatusResult | null): boolean {
  return (
    !!result &&
    "accessibility" in result &&
    result.accessibility === "granted" &&
    result.accessibilityProbeOk === true &&
    result.screenRecording === "granted" &&
    result.screenCaptureProbeOk === true
  );
}

/** Apply sticky probes and return the result that is actually published. */
function withStickyProbes(
  slot: Slot,
  result: CuaPermissionStatusResult,
): CuaPermissionStatusResult {
  if (!("accessibility" in result)) {
    slot.stickyReady = null;
    return result;
  }
  if (isFunctionallyReady(result)) {
    slot.stickyReady = result;
    return result;
  }
  if (
    slot.stickyReady &&
    result.accessibility === "granted" &&
    result.screenRecording === "granted"
  ) {
    return {
      ...result,
      accessibilityProbeOk: slot.stickyReady.accessibilityProbeOk,
      screenCaptureProbeOk: slot.stickyReady.screenCaptureProbeOk,
    };
  }
  slot.stickyReady = null;
  return result;
}

/**
 * Backoff delays (ms) for transient unavailability.
 *
 * Why: main getStatus honestly returns unavailable while the Helper host is not running yet
 * (packages/services/src/node.ts). Helper cold start and post-enable recreation both land in that window --
 * measured ~3s installed->ready locally. Event-driven refresh samples only on mount/focus/
 * explicit refresh; treating such a sample as final leaves the composer entry red+error and unclickable,
 * with no in-app recovery. Polling used to catch it next round; bounded backoff replaces that:
 * ~7s total covers the cold-start window, then it errors honestly; steady state runs no timers.
 */
const TRANSIENT_RETRY_DELAYS_MS = [1000, 2000, 4000];

/**
 * Schedule one backoff retry; returns false when the budget is spent, and the caller publishes the result as-is.
 * Retries carry no options: the active screenshot probe is explicit user intent, not to be amplified by auto-retry.
 */
function scheduleTransientRetry(slot: Slot, params: FetchCuaPermissionStatusParams): boolean {
  const delay = TRANSIENT_RETRY_DELAYS_MS[slot.retryAttempt];
  if (delay === undefined) {
    // Reset so the next real event (focus / refresh / remount) gets a full retry budget.
    slot.retryAttempt = 0;
    return false;
  }
  slot.retryAttempt += 1;
  clearTransientRetry(slot);
  slot.retryTimer = setTimeout(() => {
    slot.retryTimer = undefined;
    const { service, workspacePath, workspaceIdentity } = params;
    fetchCuaPermissionStatus({ service, workspacePath, workspaceIdentity, mode: "retry" });
  }, delay);
  return true;
}

export interface FetchCuaPermissionStatusParams {
  service: ICuaPermissionService;
  workspacePath: string;
  workspaceIdentity?: string;
  options?: CuaPermissionStatusQueryOptions;
  /**
   * "refresh" (default) = external state may have just changed (focus, Helper restart, plugin toggle); an in-flight query
   * may reflect the old world -- run one more;
   * "ensure" = only need one fresh result (mount); rides an in-flight query,
   * else settings and the composer entry queue separately and waste a host RPC;
   * "retry" = the store's own backoff, **not resetting the count** -- else every retry restores the full budget and
   * bounded backoff degrades into fixed-interval polling forever.
   */
  mode?: "refresh" | "ensure" | "retry";
}

/**
 * Fetch permission state once into the shared cache. Concurrent calls per workspace coalesce: at most one queued follow-up while in flight,
 * so ping-ponging between the OS prompt and System Settings cannot stack AX+screenshot probes.
 */
export function fetchCuaPermissionStatus(params: FetchCuaPermissionStatusParams): void {
  const { service, workspacePath, workspaceIdentity, options, mode = "refresh" } = params;
  const key = cuaPermissionStatusKey(workspacePath, workspaceIdentity);
  const slot = ensureSlot(key);
  slot.pendingFunctionalProbe ||= options?.includeFunctionalProbes === true;
  if (slot.inFlight) {
    if (mode === "refresh") slot.rerunRequested = true;
    return;
  }
  // Real events (mount/focus/explicit refresh) own sampling: cancel queued backoffs and reset the budget.
  // retry never passes here, or every retry restores the budget and backoff becomes endless polling.
  if (mode !== "retry") {
    clearTransientRetry(slot);
    slot.retryAttempt = 0;
  }
  slot.inFlight = true;
  const includeFunctionalProbes = slot.pendingFunctionalProbe;
  slot.pendingFunctionalProbe = false;
  // During a query the old result is not decision-safe: the grant may have just changed, or the Helper is mid-handover.
  publish(slot, { status: slot.snapshot.status, fresh: false, settled: slot.snapshot.settled });

  let completed: CuaPermissionStatusResult | null = null;
  void Promise.resolve()
    .then(() => service.getStatus(workspacePath, workspaceIdentity, { includeFunctionalProbes }))
    .then((result) => {
      completed = result;
    })
    .catch(() => {
      // Keep lastKnown for display; the backoff retry below converges.
    })
    .finally(() => {
      slot.inFlight = false;
      if (slot.rerunRequested) {
        // Refresh during flight: the old result may predate the Helper restart -- publish nothing, queue one new query.
        slot.rerunRequested = false;
        fetchCuaPermissionStatus({ service, workspacePath, workspaceIdentity });
        return;
      }
      // Query failure / Helper not running are environmental transients, not grant verdicts. With retry budget left, keep the prior state
      // (fresh=false, unconfirmed) and let backoff converge.
      //
      // Once the budget is gone the two branches diverge, stated honestly:
      // - unavailable result (Helper truly down) -> the honest publish below, UI shows the error state;
      // - a rejected query (RPC channel fault) -> the if (!completed) arm keeps lastKnown + fresh=false only,
      //   **no error terminal**. On a cacheless cold start the entry stays starting and settings stays Verifying
      //   until the next real event (focus/remount/explicit refresh) samples again. Deliberate: a channel fault means
      //   we do not know the permission state -- not that it is broken; red-error UI would mislead users into
      // re-granting. The cost: no visible error for this case, surfacing only under sustained RPC failure.
      const transient = !completed || !isCuaPermissionStatusAvailable(completed);
      if (transient && scheduleTransientRetry(slot, params)) {
        publish(slot, {
          status: slot.snapshot.status,
          fresh: false,
          settled: slot.snapshot.settled,
        });
        return;
      }
      if (!completed) {
        // Rejected with budget spent: keep lastKnown + fresh=false pending the next real event (above).
        publish(slot, {
          status: slot.snapshot.status,
          fresh: false,
          settled: slot.snapshot.settled,
        });
        return;
      }
      slot.retryAttempt = 0;
      const published = withStickyProbes(slot, completed);
      publish(slot, { status: published, fresh: true, settled: true });
      // For the next cold start's first paint. persist ignores unavailable internally: Helper-down is environmental,
      // and remembering it would only prolong the next cold start's wrong first paint.
      persistCuaPermissionStatus(published);
    });
}
