// ============================================================
// Model Catalog Port - read-only snapshot boundary over the host's configured models
// ============================================================
// It exists for exactly one reason:
// the tool layer must resolve a user-named model ("GLM-5.3-Flash") into a workflow run's subagent choice, and core
// cannot see the provider registry. The port hands in the host fact "which models exist"; resolution stays in core
// (pure function, no I/O).
//
// Deliberately **synchronous, no I/O**: the call sites are `resolveInput` and the `ListModels` handler; neither should
// wait on the network to list a table; the host side is just an in-memory registry view.

/** One model entry in the catalog (one provider x model pair). */
export interface ModelCatalogEntry {
  providerId: string;
  modelId: string;
  /** Human-readable provider name; absent when the registry gives none (read side falls back to `providerId`). */
  providerLabel?: string;
  /** Reasoning levels this model supports (legal `$level` values). No levels = **empty array**, not absent. */
  reasoningLevels: string[];
  /** Registry default level; absent when `reasoningLevels` is empty. */
  defaultReasoningLevel?: string;
  contextWindow?: number;
  /** Whether this entry is the session's current selection (provider + model equal). At most one true per table. */
  current: boolean;
  /** Why it is unusable (missing key, policy-disabled, ...); absent when usable. */
  disabledReason?: string;
}

export interface ModelCatalogPort {
  /**
   * List the models selectable right now.
   *
   * **Every call must read the live registry view**, never a copy frozen at construction: providers can be
   * added/removed/changed mid-session (the stale-registry lesson: subagents clinging to the adapter
   * captured at parent-session construction). A stale catalog has resolution pick a model that no longer exists, and the failure
   * only explodes at the subagent's first turn - far from the user's confirm click.
   */
  listModels(): ModelCatalogEntry[];
}
