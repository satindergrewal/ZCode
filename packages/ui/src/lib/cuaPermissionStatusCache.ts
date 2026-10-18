/**
 * Local cache for CUA permission status.
 *
 * Why: useCuaPermissionStatus status is null on cold start while the settings detail buttons
 * hide only at === granted, so during null both rows render Open Accessibility / Open Screen
 * Recording buttons that vanish once the first (usually granted) result lands, collapsing rows --
 * a shimmy on every visit. The composer entry likewise walks starting before ready on cold start.
 *
 * The cache carries the last real result across launches as an optimistic first-paint value, so
 * the common path (grants unchanged) renders its final state immediately with no jump.
 *
 * Boundary (important): cached values are render-only and never drive grant decisions.
 * - Display follows settled (any showable content), so on a cache hit the settings Open System
 *   Settings button is clickable at once, not after the real result -- deliberate, or the label
 *   shimmys between verifying and final. Safety never rests on that disabled state but on the
 *   click edge: openPermissionSettings re-runs getStatus and validates with
 *   requiredCuaPermissionsForFreshStatus, so stale values open no wrong pane, just toast plus refresh.
 * - fresh still flips true only when a real result lands; decision logic uses it.
 * - Real gating lives in the helper/producer; failures reach the model as plain MCP tool errors,
 *   unrelated to this cache, with no renderer-driven permission side effects.
 * Worst case: one frame of unverified status on first paint, overwritten by the next event-driven query.
 */
import {
  isCuaPermissionStatusAvailable,
  type CuaPermissionState,
  type CuaPermissionStatus,
  type CuaPermissionStatusResult,
} from "@zcode/services";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** TCC grants are app-level (helper bundle), not per workspace: one global key. */
export const CUA_PERMISSION_STATUS_CACHE_KEY = "zcode-cua-permission-status";

/**
 * Cache TTL. Grants can change in System Settings while ZCode is closed; the older the cache
 * the less trustworthy. Past TTL, prefer the cold-start null over a possibly revoked granted.
 */
export const CUA_PERMISSION_STATUS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PERMISSION_STATES: readonly CuaPermissionState[] = ["granted", "stale", "denied", "unknown"];

interface CachedEnvelope {
  savedAt: number;
  status: CuaPermissionStatus;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isPermissionState(value: unknown): value is CuaPermissionState {
  return PERMISSION_STATES.includes(value as CuaPermissionState);
}

/**
 * Full-shape validation. The cache survives upgrades; drifted fields (renames, type changes)
 * would feed undefined into render branches, harder to debug than a shimmy. Fail to null instead.
 */
function parseCachedStatus(value: unknown): CuaPermissionStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.grantOwner !== "string" ||
    !isPermissionState(candidate.accessibility) ||
    !isPermissionState(candidate.screenRecording) ||
    typeof candidate.accessibilityProbeOk !== "boolean" ||
    typeof candidate.screenCaptureProbeOk !== "boolean"
  ) {
    return null;
  }
  if (
    candidate.grantOwnerDisplayName !== undefined &&
    typeof candidate.grantOwnerDisplayName !== "string"
  ) {
    return null;
  }

  const parsed: CuaPermissionStatus = {
    grantOwner: candidate.grantOwner,
    accessibility: candidate.accessibility,
    accessibilityProbeOk: candidate.accessibilityProbeOk,
    screenRecording: candidate.screenRecording,
    screenCaptureProbeOk: candidate.screenCaptureProbeOk,
  };
  if (typeof candidate.grantOwnerDisplayName === "string") {
    parsed.grantOwnerDisplayName = candidate.grantOwnerDisplayName;
  }
  return parsed;
}

export function readCachedCuaPermissionStatus(
  storage: StorageLike | null = getBrowserStorage(),
  now: number = Date.now(),
): CuaPermissionStatus | null {
  let raw: string | null;
  try {
    raw = storage?.getItem(CUA_PERMISSION_STATUS_CACHE_KEY) ?? null;
  } catch {
    // Private mode or disabled storage: same as no cache.
    return null;
  }
  if (!raw) return null;

  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;

  const { savedAt, status } = envelope as Partial<CachedEnvelope>;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
  // savedAt in the future means clock skew or tampering; freshness unknowable, discard.
  const age = now - savedAt;
  if (age < 0 || age > CUA_PERMISSION_STATUS_CACHE_TTL_MS) return null;

  return parseCachedStatus(status);
}

export function persistCuaPermissionStatus(
  status: CuaPermissionStatusResult,
  storage: StorageLike | null = getBrowserStorage(),
  now: number = Date.now(),
): void {
  // unavailable means helper down, non-macOS or non-product mode: environment, not grants.
  // Persisting it replays a wrong first paint, so skip writing (keep any valid cache too).
  if (!isCuaPermissionStatusAvailable(status)) return;

  const envelope: CachedEnvelope = { savedAt: now, status };
  try {
    storage?.setItem(CUA_PERMISSION_STATUS_CACHE_KEY, JSON.stringify(envelope));
  } catch {
    // Quota or private mode: the cache is a first-paint optimization; a failed write is harmless.
  }
}
