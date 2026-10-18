/**
  * The compile-time courtesy diagnostic for duplicate named actors.
 *
  * The rule proper is **runtime**: the engine checks duplicate non-empty effective names in createActor and fails the run
  * (DuplicateActorName). Reason: named actors are the amend-resume cache-import identity key, and any
  * run is a future amendment potential predecessor -- duplicates there make import matching ambiguous.
 *
  * This pass does the literal-visible half, two clauses:
 *
  * 1. **Same name twice**: two agent sites with the same string-literal effective name get a
  *    located diagnostic at the later site, so the author renames on the cheap side instead of failing mid-run. Anything dynamic
  *    (a holey template, identifier, spread, shorthand property) is skipped -- runtime alone can check those.
  * 2. **A static name inside a fan-out**: an agent site in a fan-out body builds one actor per element,
  *    all sharing the name -- one site, N duplicates; runtime failure is certain and loud.
 *
  * Clause 1 can only under-report, never over-report: skipping a maybe-duplicate is free (the engine backstops), while a false hit
  * against a legal script blocks submission.
 *
  * The mapped collection may hold a single element, legal at runtime, so this clause can in theory over-report.
  * Accepted because the costs are asymmetric --
  * the fix is free (per-element name or anonymous) while not reporting costs a whole run
  * before the model learns the rule. A map producing agents is the textbook fan-out,
  * and leaving it to runtime is the worst tier.
 *
  * Fan-out detection **reuses the site-table classification** (IterationCandidate in analysis/sites.ts: array
  * methods with inline callbacks + for-of), not a second loop recognizer. The cost: plain for / while /
  * do loops are not in that classification, hence uncovered -- they fall back to clause 1 old behavior (invisible, runtime).
  * That is the under-report direction, consistent with this module conservative stance.
 *
  * Both the CreateWorkflow
  * and SaveWorkflow handlers run analyzeScript first (this diagnostic rides in the analyzeWorkflowScript
  * authoring batch); non-ok returns early with diagnostics, no submit, no persist -- so a 9005/9006 does
  * block submit and save. But the run service compileOnce (the submit/resume recompile) re-checks only
  * typecheck / schema / world.run literal, **not** this diagnostic -- not a mandatory gate on the submit path;
  * not load-bearing: the authority on named uniqueness is the engine runtime check in createActor.
 */

import ts from "typescript";
import type { CompileDiagnostic, WorkflowProgram } from "../compiler/compile.js";
import type { SiteTable } from "./sites.js";

/** Same literal name twice (clause 1). 9001 facade-siting, 9002 schema, 9003 world-run, 9004 phase. */
const DUPLICATE_ACTOR_NAME_CODE = 9005;

/**
  * A static name inside a fan-out body (clause 2), its own code instead of reusing 9005.
 *
  * One rule, two clauses, **different certainty**: 9005 only when the duplicate is statically certain; 9006 deliberately
  * accepts false hits. Readers must tell them apart -- especially the analysis-side fixture corpus:
  * those scripts never run, they pin graph shapes, and static-name-in-fanout is exactly the shape the **analyzer must handle**
  * (ActorNode.family, actor labels), so the corpus exempts 9006 while staying strict on 9005.
  * One shared code would force message-text matching -- branching on error text is banned repo-wide.
 */
export const FANOUT_ACTOR_NAME_CODE = 9006;

/**
  * Collect literal-duplicate diagnostics. Non-empty means the script cannot be submitted (riding with the world.run / phase
  * compile-time rules in analyzeWorkflowScript).
 */
export function collectDuplicateActorNames(
  workflow: WorkflowProgram,
  table: SiteTable,
): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const claimed = new Map<string, ts.CallExpression>();
    // The fan-out body set comes from the site-table IterationCandidate (inline callbacks of array methods + for-of
    // bodies) -- the same notion as ActorNode.fanOutId for is-this-site-in-a-fan-out.
  const fanOutBodies = new Set<ts.Node>(table.iterations.map((iteration) => iteration.body));
  for (const site of table.actors) {
        // The site-table name must **not** be used here: it falls back to the binding name (const planner = agent()
        // recorded as planner) -- a display label for the graph, not the runtime effective name. What is needed is the value
        // the engine will see, so read it from the arguments.
    const name = staticEffectiveName(site.call);
    if (name === undefined || name === "") continue;
    const first = claimed.get(name);
    if (first === undefined) claimed.set(name, site.call);
    const loc = workflow.toScriptLoc(site.call.getStart(workflow.scriptFile));
        // At most one report per site: the fan-out clause is more specific (even the fix differs -- per-element naming, not a rename),
        // so it wins. The name is still registered; later same-named sites keep reporting.
    if (isInsideFanOut(site.call, fanOutBodies)) {
      diagnostics.push({
        code: FANOUT_ACTOR_NAME_CODE,
        column: loc.column,
        line: loc.line,
        message:
          `this agent(...) runs once per element of a fan-out but its name "${name}" is a fixed ` +
          `string, so every element creates a different actor under the same name — the run ` +
          `fails with DuplicateActorName as soon as the collection holds more than one item. ` +
          `An actor name must be unique within a run: it is the identity key an amended re-run ` +
          `matches its imported cache against. Build a per-element name (\`${name}-\${item}\`), ` +
          `or drop the name — anonymous actors are legal (they just never reuse cached work).`,
      });
      continue;
    }
    if (first === undefined) continue;
        // The diagnostic lands on the **later** site: the first occurrence is established fact; the later one is what changes.
    const firstLoc = workflow.toScriptLoc(first.getStart(workflow.scriptFile));
    diagnostics.push({
      code: DUPLICATE_ACTOR_NAME_CODE,
      column: loc.column,
      line: loc.line,
      message:
        `two actors are named "${name}" (the first is on line ${firstLoc.line}): an actor name ` +
        `must be unique within a run. The name is the identity key an amended re-run matches ` +
        `its imported cache against, and any run can become the predecessor of one, so a ` +
        `repeated name makes that match ambiguous. Give this one its own name, or drop the ` +
        `name entirely — anonymous actors are legal (they just never reuse cached work).`,
    });
  }
  return diagnostics;
}

/**
  * Whether the call is **lexically** inside some fan-out body. Walk the parent chain from the call itself (the call may be the body:
  * the arrow shorthand of a map producing agents); any candidate body hit counts.
 */
function isInsideFanOut(call: ts.CallExpression, fanOutBodies: ReadonlySet<ts.Node>): boolean {
  for (let node: ts.Node | undefined = call; node !== undefined; node = node.parent) {
    if (fanOutBodies.has(node)) return true;
  }
  return false;
}

/**
  * The **effective name** of an agent call when statically knowable, else undefined (skip).
 *
  * One rule as the engine normalizePersona: persona name beats the name arg; a string persona is
  * a system prompt, nameless. Any opacity gives up entirely -- prefer under-reporting.
 *
  * The facade AgentPersona declares no name today, so every writable persona is nameless and the effective name
  * always comes from the name arg. The persona branch thus never fires today; kept in lockstep with normalizePersona,
  * not for present effect -- once the facade grows a name field while this still judges by the arg, an actor renamed via persona
  * would be **false-positived**, and false hits block legal scripts (under-reporting is free: the engine backstops).
 */
function staticEffectiveName(call: ts.CallExpression): string | undefined {
  const [nameArg, personaArg] = call.arguments;
  if (personaArg !== undefined && !ts.isStringLiteralLike(personaArg)) {
        if (!ts.isObjectLiteralExpression(personaArg)) return undefined; // dynamic persona: may carry a name
    for (const property of personaArg.properties) {
            // A spread may smuggle in a name; statically undecidable.
      if (ts.isSpreadAssignment(property)) return undefined;
            // A computed key may itself be the name; undecidable. Give up entirely here,
            // rather than continue -- continuing would fall back to the name arg, asserting the persona did not rename; that is
            // a guess whose failure mode is exactly the false hit (blocking legal scripts).
      if (property.name !== undefined && ts.isComputedPropertyName(property.name)) return undefined;
      if (property.name === undefined || !isNameKey(property.name)) continue;
            if (!ts.isPropertyAssignment(property)) return undefined; // shorthand / method: dynamic
      return ts.isStringLiteralLike(property.initializer) ? property.initializer.text : undefined;
    }
        // No name in the object literal; fall back to the name argument.
  }
  return nameArg !== undefined && ts.isStringLiteralLike(nameArg) ? nameArg.text : undefined;
}

/** Whether the property key is **statically** the name (computed keys gave up at the call; never here). */
function isNameKey(key: ts.PropertyName): boolean {
  return (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === "name";
}
