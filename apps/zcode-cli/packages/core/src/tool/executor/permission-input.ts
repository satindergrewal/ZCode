import type { ToolEntry } from "../types.js";
import { normalizeToolExecutionInput } from "../input-normalization.js";
import type { ToolExecutorDeps } from "./types.js";
import { validateInput } from "./validation.js";

/** Approval-time read-only snapshot; freeze before descent so a trusted Hook returning cyclic references cannot recurse forever. */
export function snapshotPermissionInput<T>(input: T): T {
  const snapshot = structuredClone(input);
  function freeze(value: unknown): void {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  freeze(snapshot);
  return snapshot;
}

export function preparePermissionInput(
  input: unknown,
  entry: ToolEntry,
  deps: ToolExecutorDeps,
): unknown {
  const normalized = normalizeToolExecutionInput({
    entry,
    input,
    logger: deps.logger,
    source: "permission",
  });
  // Why: the approval rework used to re-run every tool's semantic precheck, widening the legacy behavior change; the rewrite keeps the original schema validation.
  const error = validateInput(normalized, entry);
  if (error) throw error;
  return normalized;
}
