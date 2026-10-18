// ============================================================
// Dynamic Workflow rollout: the server feature key's value domain and the client snapshot
// ============================================================
// The server's /api/v1/client/configs sends data.configs.dynamicWorkflow.mode.

// Only the shared value domain, normalization, and snapshot shape live here (host services, desktop main, UI);
// remote reads, overrides, and delivery stay in each owner--shared never issues requests.

export const DYNAMIC_WORKFLOW_MODES = ["disabled", "onDemand", "alwaysOn"] as const;
export type DynamicWorkflowMode = (typeof DYNAMIC_WORKFLOW_MODES)[number];

/**
 * Env var for local overrides, with build-tier semantics in three layers; desktop main **rewrites or deletes** it before forking the host
 *(buildHostProcessEnv in desktopRuntimeEnv.ts), and the host consumes without provenance:
 *   - unpackaged dev: pass through legal values from the developer's shell;
 *   - packaged preview: pinned to `alwaysOn`, shell ignored;
 *   - packaged production: inherited value deleted, never written.
 * Web/server hosts without main read process env directly (ops/dev setting).
 */
export const ZCODE_DYNAMIC_WORKFLOW_MODE_ENV = "ZCODE_DYNAMIC_WORKFLOW_MODE";

/** Value on missing server config, malformed payload, or request failure: fail-closed, matching the off-peak rollout. */
export const DEFAULT_DYNAMIC_WORKFLOW_MODE: DynamicWorkflowMode = "disabled";

export function normalizeDynamicWorkflowMode(value: unknown): DynamicWorkflowMode | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return (DYNAMIC_WORKFLOW_MODES as readonly string[]).includes(trimmed)
    ? (trimmed as DynamicWorkflowMode)
    : undefined;
}

/**
 * Parse the server contract's three states; consumers convert to a boolean.
 * When onDemand gains distinct behavior, only consumers change.
 */
export function isDynamicWorkflowModeEnabled(mode: DynamicWorkflowMode): boolean {
  return mode !== "disabled";
}

/** Snapshot provenance, for observability: UI and logs tell "server-off" from "local override". */
export type DynamicWorkflowClientConfigSource = "remote" | "override" | "default";

export interface DynamicWorkflowClientConfig {
  readonly mode: DynamicWorkflowMode;
  /// Equals isDynamicWorkflowModeEnabled(mode); a dedicated field spares every consumer the folding rule.
  readonly enabled: boolean;
  readonly source: DynamicWorkflowClientConfigSource;
}

export function createDynamicWorkflowClientConfig(
  mode: DynamicWorkflowMode,
  source: DynamicWorkflowClientConfigSource,
): DynamicWorkflowClientConfig {
  return { mode, enabled: isDynamicWorkflowModeEnabled(mode), source };
}

/**
 * Pure: fold the remote envelope's configs.dynamicWorkflow and the local override env into one snapshot.
 * Precedence: override > legal remote value > default. A successful remote response **without** the key also counts disabled--
 * a removed key means off; never reuse the stale snapshot (same ruling as desktopContextPromptRollout).
 */
export function resolveDynamicWorkflowClientConfig(input: {
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
