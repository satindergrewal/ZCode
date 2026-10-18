import type { SiteGraph } from "../analysis/types.js";
import { interpret } from "../analysis/interpret.js";
import { projectSiteGraph } from "../analysis/graph.js";
import type { SiteTable } from "../analysis/sites.js";
import type { WorkflowProgram } from "../compiler/compile.js";
import type { AskSpec } from "../engine/types.js";
import { canonicalJson } from "../engine/hash.js";
import type { JsonSchema } from "./types.js";

/**
  * Per actor-site **submit profile**: which kind of submit_result tool the actor's subagent session gets.
 *
  * - untyped: every ask that can reach this actor is untyped (or there are none) -> no submit_result registered.
  * - mono: every typed ask reaching this actor has the **same** schema (canonical-JSON equal; untyped asks may
  *   mix in) -> the tool declaration is result-with-that-schema, frozen for the actor across asks, hence cache-neutral.
  * - generic: more than one schema among the typed asks -> today's generic tool plus a per-ask schema footnote.
 *
  * Why compile time: the tool block renders at the very front of the prompt; swapping schemas per ask would
  * destroy that actor's whole cached prefix. Only when schema-constancy-over-the-actor-lifetime is
  * decidable at compile time is the typed tool free; otherwise fall back to generic, byte-equivalent behavior.
 */
export type ActorSubmitProfile =
  | { kind: "untyped" }
  | { kind: "mono"; schema: JsonSchema }
  | { kind: "generic" };

/** The profile when absent/undecidable: today's behavior. */
export const GENERIC_SUBMIT_PROFILE: ActorSubmitProfile = { kind: "generic" };

/**
  * Derive each actor site's submit profile from the site graph and ask specs. Pure.
 *
  * **Soundness rule**: the ask-to-actor binding is the site graph's may-set (SiteNode.actors). If **any**
  * ask site has an empty actor set (receiver unresolved), analysis cannot say whom that ask reaches -- so
  * **every** actor is marked generic. Deliberately conservative: a typed ask landing on an untyped subagent
  * would have no tool to submit with and fail after exhausting nudges; better to save less cache than to remove tools on an incomplete graph.
  * Likewise, an ask whose actor set has several members (a conditional receiver) counts its schema into each.
 *
  * A missing ask-site entry also falls back to generic wholesale: site table and specs come from one compilation, so absence means only
  * a wiring bug; do not guess here (the engine hard-fails with MissingAskSpec; here, just do not amplify it).
 *
  * The returned table covers every actor site in graph.actors.
 */
export function deriveActorSubmitProfiles(
  graph: SiteGraph,
  askSpecs: ReadonlyMap<string, AskSpec>,
): Map<string, ActorSubmitProfile> {
  const profiles = new Map<string, ActorSubmitProfile>();
  const actorIds = graph.actors.map((actor) => actor.id);

    // Per-actor typed schemas, deduped by canonical JSON (the same schema is synthesized
    // once per ask site -- different references, equal content; compare by content).
  const schemasByActor = new Map<string, Map<string, JsonSchema>>();
  for (const id of actorIds) schemasByActor.set(id, new Map());

  for (const node of graph.nodes) {
    if (node.kind !== "ask") continue;
    const actors = node.actors ?? [];
    const spec = askSpecs.get(node.id);
    if (actors.length === 0 || spec === undefined) {
      for (const id of actorIds) profiles.set(id, GENERIC_SUBMIT_PROFILE);
      return profiles;
    }
    if (!spec.typed) continue;
    const schema = spec.schema as JsonSchema;
    const key = canonicalJson(schema);
    for (const actorId of actors) {
            // An actor id from the site graph is necessarily in graph.actors; add a bucket defensively instead of skipping silently.
      let bucket = schemasByActor.get(actorId);
      if (bucket === undefined) {
        bucket = new Map();
        schemasByActor.set(actorId, bucket);
      }
      bucket.set(key, schema);
    }
  }

  for (const [actorId, bucket] of schemasByActor) {
    if (bucket.size === 0) profiles.set(actorId, { kind: "untyped" });
    else if (bucket.size === 1)
      profiles.set(actorId, { kind: "mono", schema: [...bucket.values()][0]! });
    else profiles.set(actorId, GENERIC_SUBMIT_PROFILE);
  }
  return profiles;
}

/**
  * The one-shot compile entry: interpret and project the site graph on the **same** {@link WorkflowProgram} used for the site table and schema
  * synthesis (exactly the two steps analyzeWorkflowScript runs), then derive profiles. For the run-submit path,
  * sparing callers from assembling interpret + projectSiteGraph (neither is on the package's public face).
 */
export function deriveActorSubmitProfilesFor(
  workflow: WorkflowProgram,
  table: SiteTable,
  askSpecs: ReadonlyMap<string, AskSpec>,
): Map<string, ActorSubmitProfile> {
  return deriveActorSubmitProfiles(projectSiteGraph(interpret(workflow, table)), askSpecs);
}
