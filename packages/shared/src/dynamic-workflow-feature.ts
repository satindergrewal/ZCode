// ============================================================
// Dynamic Workflow gray release: the server feature-key value domain and the client snapshot
// ============================================================
// The server `/api/v1/client/configs` ships `data.configs.dynamicWorkflow.mode`.

// Only the shared value domain, normalization, and snapshot shape live here (Host services, Desktop main, UI);
// remote reads, overrides, and dispatch belong to each owner -- shared never issues requests.

export const DYNAMIC_WORKFLOW_MODES = ["disabled", "onDemand", "alwaysOn"] as const;
export type DynamicWorkflowMode = (typeof DYNAMIC_WORKFLOW_MODES)[number];

/**
 * Env vars for local override. Semantics split in three tiers by build; Desktop main **rewrites or deletes** them before forking the Host
 * (buildHostProcessEnv in desktopRuntimeEnv.ts); the Host consumes without provenance:
 *   - unpackaged dev: pass valid developer-shell values through;
 *   - packaged preview: always write `alwaysOn`, ignore the shell;
 *   - packaged production: delete inherited values, never write.
 * Hosts without main (web/server) read process env directly (ops/dev settings).
 */
export const ZCODE_DYNAMIC_WORKFLOW_MODE_ENV = "ZCODE_DYNAMIC_WORKFLOW_MODE";

/** Value on server default, invalid format, or request failure: fail-closed, matching the off-peak rollout. */
export const DEFAULT_DYNAMIC_WORKFLOW_MODE: DynamicWorkflowMode = "disabled";

export function normalizeDynamicWorkflowMode(value: unknown): DynamicWorkflowMode | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return (DYNAMIC_WORKFLOW_MODES as readonly string[]).includes(trimmed)
    ? (trimmed as DynamicWorkflowMode)
    : undefined;
}

/**
 * The is-offered fold: `onDemand` and `alwaysOn` are both on -- the hub's /workflow, skills, the automation page's workflow tab,
 * and the Resume entry exist in both. They differ only in when model tooling registers
 * (launch.md, On demand: activation), adjudicated CLI-side by the mode itself; not here.
 */
export function isDynamicWorkflowModeEnabled(mode: DynamicWorkflowMode): boolean {
  return mode !== "disabled";
}

/** Snapshot provenance: observability, so UI and logs can tell server-off from local-override. Tracks where offered came from only. */
export type DynamicWorkflowClientConfigSource = "remote" | "override" | "default";

/**
 * Gray-release snapshot (launch.md, Gray release / The user's choice). Two layers:
 *   - offer: the server key or a local override decides availability and the default mode, recorded in `offeredMode`;
 *   - effective: when offered, the user's settings choice replaces it, recorded in `mode` / `enabled`.
 * Legacy consumers read `mode` / `enabled` for effective; settings reads `offeredMode` for the row and its default tag.
 */
export interface DynamicWorkflowClientConfig {
  /** Effective mode: the user's choice when offered and chosen, else offeredMode. */
  readonly mode: DynamicWorkflowMode;
  /** Equals isDynamicWorkflowModeEnabled(mode); a dedicated field spares every consumer the fold. */
  readonly enabled: boolean;
  readonly source: DynamicWorkflowClientConfigSource;
  /** Mode the server (or local override) offers: non-disabled means available; also the settings page's default option. */
  readonly offeredMode: DynamicWorkflowMode;
  /** The effective user choice; absent = follow the offer (unchosen, invalid, or not offered). */
  readonly userMode?: DynamicWorkflowMode;
}

export function createDynamicWorkflowClientConfig(
  offeredMode: DynamicWorkflowMode,
  source: DynamicWorkflowClientConfigSource,
): DynamicWorkflowClientConfig {
  return {
    mode: offeredMode,
    enabled: isDynamicWorkflowModeEnabled(offeredMode),
    source,
    offeredMode,
  };
}

/**
 * Whether the feature is offered (regardless of user choice): the settings row exists only then.
 *
 * Fix: snapshots can come from Hosts without offeredMode (a new UI -- e.g. the phone remote bundle -- attached to an old desktop).
 * Comparing !== disabled read absent as offered: the row appeared and wrote a setting the old Host ignores.
 * Absent or unreadable offeredMode always means not offered: only Hosts honoring the choice write it.
 */
export function isDynamicWorkflowOffered(config: DynamicWorkflowClientConfig): boolean {
  const offeredMode = normalizeDynamicWorkflowMode(config.offeredMode);
  return offeredMode !== undefined && isDynamicWorkflowModeEnabled(offeredMode);
}

/**
 * The sole implementation of offer-then-user-picks (launch.md, The user's choice):
 *   - not offered (offeredMode disabled): user choices never apply -- a choice cannot switch the server back on;
 *   - offered: a valid choice replaces the offered mode; absent/invalid (old files, future values) follows.
 * Derived from `offeredMode` alone, so re-applying onto an already-applied snapshot overwrites rather than stacks:
 * the Host latches the offer; each use re-applies the latest choice.
 */
export function applyDynamicWorkflowUserMode(
  config: DynamicWorkflowClientConfig,
  userMode: unknown,
): DynamicWorkflowClientConfig {
  const offer = createDynamicWorkflowClientConfig(config.offeredMode, config.source);
  const choice = normalizeDynamicWorkflowMode(userMode);
  if (!choice || !isDynamicWorkflowOffered(offer)) return offer;
  return {
    ...offer,
    mode: choice,
    enabled: isDynamicWorkflowModeEnabled(choice),
    userMode: choice,
  };
}

/**
 * Pure: folds the remote envelope's `configs.dynamicWorkflow` and the local override env into an offer, then applies the user choice.
 * Offer precedence: override > valid remote > default. A successful remote that omits the key also means disabled --
 * a withdrawn key is off; never ride a stale snapshot (same verdict as desktopContextPromptRollout).
 */
export function resolveDynamicWorkflowClientConfig(input: {
  remote: unknown;
  env?: Record<string, string | undefined>;
  userMode?: unknown;
}): DynamicWorkflowClientConfig {
  return applyDynamicWorkflowUserMode(resolveDynamicWorkflowOffer(input), input.userMode);
}

function resolveDynamicWorkflowOffer(input: {
  remote: unknown;
  env?: Record<string, string | undefined>;
}): DynamicWorkflowClientConfig {
  const override = normalizeDynamicWorkflowMode(input.env?.[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]);
  if (override) return createDynamicWorkflowClientConfig(override, "override");
  const remoteMode = normalizeDynamicWorkflowMode(
    typeof input.remote === "object" && input.remote !== null
      ? (input.remote as { mode?: unknown }).mode
      : undefined,
  );
  if (remoteMode) return createDynamicWorkflowClientConfig(remoteMode, "remote");
  return createDynamicWorkflowClientConfig(DEFAULT_DYNAMIC_WORKFLOW_MODE, "default");
}
