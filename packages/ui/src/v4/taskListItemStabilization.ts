// Reference stabilization for task-list rows (shared across lanes).
//
// sessions-index / Controller tasks-index rebuild the whole ZCodeTaskMeta[] on every content frame,
// even when nothing changed (e.g. only an activity timestamp the list ignores). Downstream reads a fresh array reference as new data:
// the grouped view refreshes whole subtrees, the virtualizer remeasures, workspace row caches invalidate - observed as
// the left list reloading entirely whenever the right pane emits one tool result. Stabilize per item: content-equal entries reuse old objects;
// an all-equal table reuses the old array, short-circuiting every dep-array/identity memo and effect.
import type { ZCodeTaskMeta } from "@zcode/shared";

export function buildTaskListItemIdentityKey(meta: ZCodeTaskMeta): string {
  return `${meta.workspaceIdentity?.trim() || meta.workspacePath}::${meta.taskId}`;
}

/**
 * Structural equality: ignore key insertion order, treat undefined as absent (JSON-serialization semantics).
 *
 * Deliberately no JSON.stringify comparison: upstream Controller / tasks-index joins build objects with heavy conditional
 * spread (`...(x ? { k: v } : {})`); equal content in a different key order never equals as strings, so stabilization
 * would silently degrade to fresh references per frame - the whole-list blink regression, silent, no log, no metric.
 * Field-by-field equality drops the implicit construction-order assumption and short-circuits at the first difference.
 */
export function areStabilizedValuesEquivalent(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => areStabilizedValuesEquivalent(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => areStabilizedValuesEquivalent(leftRecord[key], rightRecord[key]));
}

/** Field-wise equality (nested structural compare; task meta is small, the cost is negligible). */
export function areTaskListItemsEquivalent(left: ZCodeTaskMeta, right: ZCodeTaskMeta): boolean {
  return areStabilizedValuesEquivalent(left, right);
}

/** Reference stabilization: equal items reuse old objects; identical order+content reuses the whole old array. */
export function stabilizeTaskListItems<T extends ZCodeTaskMeta>(previous: T[], next: T[]): T[] {
  if (previous.length === 0) {
    return next;
  }
  const previousByKey = new Map(
    previous.map((meta) => [buildTaskListItemIdentityKey(meta), meta] as const),
  );
  let identical = previous.length === next.length;
  const stabilized = next.map((meta, index) => {
    const previousMeta = previousByKey.get(buildTaskListItemIdentityKey(meta));
    if (previousMeta && areTaskListItemsEquivalent(previousMeta, meta)) {
      if (identical && previous[index] !== previousMeta) {
        identical = false;
      }
      return previousMeta;
    }
    identical = false;
    return meta;
  });
  return identical ? previous : stabilized;
}
