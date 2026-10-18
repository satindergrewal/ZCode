/**
  * The deliverable's primary mark: at most one ID per run carries it.
  * Content and preset members share the same admission predicates.
 *
  * These functions only read state.artifacts -- no persistence, no events; state derives from the journal and stays consistent after resume.
  * Callers decide between rejecting the publish and failing the whole run.
 */

import type { EngineState } from "./engine-state.js";
import type { InstanceRef } from "./types.js";
import { refToString } from "./types.js";

/** The run's current primary id (at most one); undefined when none. Derived from state.artifacts, consistent after resume. */
export function primaryArtifactId(state: EngineState): string | undefined {
  for (const [id, idState] of state.artifacts) if (idState.primary) return id;
  return undefined;
}

/** id wants primary while a **different** id already is => that id; else undefined (no want / itself). */
export function primaryConflict(
  state: EngineState,
  id: string,
  primary: boolean,
): string | undefined {
  if (!primary) return undefined;
  const holder = primaryArtifactId(state);
  return holder === undefined || holder === id ? undefined : holder;
}

export function primaryConflictMessage(
  id: string,
  holder: string,
  fix: string,
  instance: InstanceRef | undefined,
): string {
  const where = instance === undefined ? "" : ` (at ${refToString(instance)})`;
  return (
    `Cannot mark "${id}" as primary${where}: "${holder}" is already this run's primary artifact. ` +
    `A run has one deliverable; ${fix}, or publish it as a new version of "${holder}".`
  );
}
