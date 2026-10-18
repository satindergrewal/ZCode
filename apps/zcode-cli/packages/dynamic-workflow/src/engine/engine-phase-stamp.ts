/**
  * Reading and stamping of an instance's birth phase.
  * Both readers share instancePhases (instance siteId@ordinal -> phase name at birth):
  * decorating events, and decorating ProviderStop details.
  * The table is engine-owned, written at instance creation; this module only reads.
 */

import type { RunEvent } from "./types.js";
import { refToString, WorkflowError } from "./types.js";

/** Instance key (siteId@ordinal) -> phase name at its birth. A read-only view of the engine's instancePhases. */
export type InstancePhases = ReadonlyMap<string, string>;

/**
  * Stamps the birth phase onto **birth events**: the actor's actor-created looks up by actor, the node's node-queued
  * by instance, and a cache-hit node-settled cached-true also by instance -- a cache-hit node
  * has no queued, so that settle is its birth event. Every other event **returns as-is**: the scheduler's other emit points stay untouched,
  * and the reducer carries the field forward following the actorSiteId precedent.
 *
  * ask's node-dispatched is the one exception: it repeats its own birth facts (the same-named event in types.ts), so
  * both phase names are stamped here: phaseName by instance, actorPhaseName by its actor -- both from the same
  * birth table, hence verbatim-equal to that instance's node-queued and that actor's actor-created. Stamped only when an actor is present:
  * world-read dispatches carry no subagent and stay bare.
 *
  * This is not the current phase at emit time: node-queued may be held past a later marker,
  * and dispatch can sit behind the concurrency cap while the script passes several more markers.
 */
export function stampBirthPhase(event: RunEvent, instancePhases: InstancePhases): RunEvent {
  if (event.type === "actor-created") {
    const phaseName = instancePhases.get(refToString(event.actor));
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  if (event.type === "node-queued") {
    const phaseName = instancePhases.get(refToString(event.instance));
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  if (event.type === "node-dispatched" && event.actor !== undefined) {
    const phaseName = instancePhases.get(refToString(event.instance));
    const actorPhaseName = instancePhases.get(refToString(event.actor));
    if (phaseName === undefined && actorPhaseName === undefined) return event;
    return {
      ...event,
      ...(phaseName === undefined ? {} : { phaseName }),
      ...(actorPhaseName === undefined ? {} : { actorPhaseName }),
    };
  }
  if (event.type === "node-settled" && event.cached === true) {
    const phaseName = instancePhases.get(refToString(event.instance));
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  return event;
}

/**
  * Stamps ProviderStop with the **birth phase** of the subagent that triggered the stop: the driver knows only the actor ref, the phase only the engine (the same
  * table as phaseName on the event stream). No providerStop, no subagent, phase already present, or the ref born before any phase()
  * marker: returned as-is.
 */
export function enrichProviderStopPhase(
  error: WorkflowError,
  instancePhases: InstancePhases,
): WorkflowError {
  const details = error.providerStop;
  if (details === undefined || details.subagent === undefined || details.phase !== undefined) {
    return error;
  }
  const phase = instancePhases.get(details.subagent);
  if (phase === undefined) return error;
  return new WorkflowError(error.code, error.message, {
    providerStop: { ...details, phase },
    cause: (error as { cause?: unknown }).cause,
  });
}
