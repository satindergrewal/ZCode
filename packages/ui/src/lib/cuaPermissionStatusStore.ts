/**
 * In-process shared cache for Computer Use Helper permission status.
 *
 * Why it exists: permission status has two consumers -- the settings page's "Computer
 * Control" section and the always-visible composer entry button. Both used to keep their
 * own useCuaPermissionStatus instance, polling independently with separate sticky probe
 * snapshots, so one machine's single TCC grant could show different states in the two
 * places while doubling request volume. This store collapses "last result + in-flight
 * dedup + sticky probes" into a single source of truth, slotted per workspace.
 *
 * Refreshes are event-driven, not timed (page entry / app focus / explicit refresh),
 * triggered by useCuaPermissionStatus. The cache survives component unmount: re-entering
 * the settings page renders the previous grant immediately instead of flashing
 * null -> "unknown" -> granted.
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

interface CuaPermissionStatusSnapshot {
  /** Result of the last successful query; null = no status observed for this workspace yet. */
  status: CuaPermissionStatusResult | null;
  /**
   * Whether status is safe to act on. False while a query is in flight or after the
   * latest query failed -- display may keep lastKnown, but actions like "Open System
   * Settings" must wait for a fresh result.
   */
  fresh: boolean;
  /**
   * Whether any definite content is available to render. True on a cold-start cache hit
   * and, once a real result arrives, monotonically non-decreasing.
   *
   * Division of labor with fresh: fresh means "just confirmed", resetting to false at the
   * start of every query; if display followed it, the grant button would oscillate between
   * "Open System Settings" and "Verifying..." and its width would jump. settled exists for
   * display only, avoiding that flicker.
   */
  settled: boolean;
}

/**
 * Snapshot returned on slot miss. useSyncExternalStore requires a referentially stable
 * getSnapshot return; allocating a new object each call triggers infinite re-renders, so
 * build once lazily and reuse.
 *
 * The initial value comes from the cross-process cache: in-process slots start empty, and
 * a null first frame would render the settings page's two permission rows with grant
 * buttons that vanish once the first query returns (row-height collapse). TCC grants belong
 * to the Helper bundle, not to a workspace, so this cache is the best guess for any
 * workspace; "not yet confirmed" is expressed by fresh=false.
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
   * Ready snapshot: once fully-ready is observed (both TCC grants + both functional probes
   * ok), later read-only refreshes reuse the confirmed-ok probe results as long as both TCC
   * grants still hold. Read-only queries never run the screenshot probe anyway (upstream
   * shouldRunCuaScreenCaptureProbe requires explicit includeFunctionalProbes); pushing down
   * a faithful false would erase the previously measured ready conclusion. Real degradations
   * (TCC revoked / Helper unavailable) clear sticky via the else branch and publish as-is.
   */
  stickyReady: CuaPermissionStatus | null;
}

const slots = new Map<string, Slot>();
const listeners = new Set<() => void>();

/**
 * Isomorphic to the settings page's helperContextKey: permissions belong to
 * (workspace path, workspace identity). NUL-separated so spaces in paths cannot collide
 * distinct workspaces into one slot.
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
 * Why display ignores the functional probes: read-only refreshes never run the screenshot
 * probe by upstream contract (shouldRunCuaScreenCaptureProbe requires explicit
 * includeFunctionalProbes -- screen capture must be explicit user intent), so
 * screenCaptureProbeOk is always false; gating display on it would permanently mark granted
 * users as pending. Real unavailability (TCC recorded but WindowServer withholding pixels,
 * etc.) surfaces to the model as a plain MCP error from the tool call; the Renderer never
 * guesses permissions from constant polling or error text.
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
 * Runtime end-to-end readiness: both TCC grants **and** both functional probes measured ok.
 * Only possible right after an explicit active probe (post-grant verification or after a
 * Helper restart); used solely as the sticky-snapshot record condition below, never as the
 * display definition.
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
 * Why: main-side getStatus faithfully reports unavailable while the Helper host is not yet
 * running (see packages/services/src/node.ts). Helper cold starts and post-plugin-enable
 * recreates land in that window -- measured ~3s from installed to ready locally. Event
 * driven refresh samples only on mount/focus/explicit refresh; treating such a sample as
 * final would leave the composer entry red + "error" and unclickable with no self-healing
 * path inside the app. The old polling implementation papered over this with the next
 * sample; a bounded backoff replaces it: ~7s total covers the cold-start window, the error
 * is reported faithfully once exhausted, and the steady state runs no timers at all.
 */
const TRANSIENT_RETRY_DELAYS_MS = [1000, 2000, 4000];

/**
 * Schedule one backoff retry; returns false when the budget is exhausted and the caller
 * publishes the result as-is. Retries carry no options: the explicit screenshot probe is
 * user intent and must not be amplified by automatic retries.
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

interface FetchCuaPermissionStatusParams {
  service: ICuaPermissionService;
  workspacePath: string;
  workspaceIdentity?: string;
  options?: CuaPermissionStatusQueryOptions;
  /**
   * "refresh" (default) = external state may have just changed (focus regained, Helper
   * restart, plugin toggle); an in-flight query may be reading the old world, so schedule
   * a follow-up;
   * "ensure" = only require "one fresh result" (component mount); ride along when a query
   * is already in flight, otherwise the settings page and composer entry mounting in
   * sequence would queue independent copies and burn an extra host RPC;
   * "retry" = the store's own backoff retry, which does **not** reset the retry counter --
   * otherwise every retry would restore the full budget and bounded backoff would decay
   * into an unbounded fixed-interval poll.
   */
  mode?: "refresh" | "ensure" | "retry";
}

/**
 * Fetch permission status once and write the shared cache. Concurrent calls for the same
 * workspace coalesce: at most one follow-up is recorded while in flight, so rapid
 * focus flips between the native grant prompt / System Settings cannot stack AX + screenshot
 * probes into a burst.
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
  // Real events (mount / focus / explicit refresh) take over sampling: cancel any queued
  // backoff retry and reset the budget. retry does not pass through here -- otherwise every
  // retry would restore the full budget and bounded backoff would become infinite polling.
  if (mode !== "retry") {
    clearTransientRetry(slot);
    slot.retryAttempt = 0;
  }
  slot.inFlight = true;
  const includeFunctionalProbes = slot.pendingFunctionalProbe;
  slot.pendingFunctionalProbe = false;
  // While querying, the previous result is not safe to act on: the user may have just
  // changed the grant in System Settings, or the Helper may be mid-restart.
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
        // The refresh landed mid-query: the old result may predate the Helper restart, so
        // do not publish it; schedule one fresh query instead.
        slot.rerunRequested = false;
        fetchCuaPermissionStatus({ service, workspacePath, workspaceIdentity });
        return;
      }
      // Query failure / Helper not yet running are environmental transients, not grant
      // verdicts. While retry budget remains, keep the previous state (fresh=false meaning
      // unconfirmed) and let the backoff retry converge.
      //
      // Once the budget is gone the two branches diverge, stated plainly:
      // - resolved unavailable (Helper truly cannot start) -> falls through and publishes
      //   as-is; the UI shows the error state;
      // - query rejection (broken RPC channel) -> falls into `if (!completed)`, keeping
      //   lastKnown + fresh=false and **no error terminal state**. On a cold start with no
      //   cache the entry stays "starting" and the settings page stays "verifying" until the
      //   next real event (focus / remount / explicit refresh) samples again. This is
      //   deliberate: a channel failure means "permission state unknown", not "permissions
      //   broken"; rendering it as a red error would mislead users into re-granting. The
      //   trade-off is no visible error hint in that state, surfacing only while the RPC
      //   keeps failing.
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
        // Rejection with the retry budget exhausted: keep lastKnown + fresh=false and wait
        // for the next real event (see above).
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
      // Seeds the cold-start first paint. persist ignores unavailable internally: an
      // unstarted Helper is an environmental state, and remembering it would only make the
      // next cold start wrong for longer.
      persistCuaPermissionStatus(published);
    });
}
