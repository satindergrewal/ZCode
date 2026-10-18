/**
 * Compile-time courtesy diagnostics for duplicate named actors.
 *
 * The rule itself is a **run-time** one: the engine checks for duplicate non-empty valid names at
 * createActor, and a collision fails the run (`DuplicateActorName`). The reason: a named actor is
 * the identity key of amend-resume cache imports, and any run can become the predecessor of a
 * later revision — duplicates in a predecessor make that import match ambiguously.
 *
 * This module handles the half that literals can see through, in two clauses:
 *
 * 1. **Same name twice**: when two `agent(...)` sites have the same effective name as string
 *    literals, report one locatable diagnostic at the latter, so the author renames on the cheap
 *    side instead of failing mid-run. Anything dynamic (`` `worker-${i}` ``, an identifier, a
 *    spread, shorthand properties) is skipped — only the run time can check those.
 * 2. **A static name inside a fan-out**: when an `agent("x")` site runs in a fan-out body, every
 *    element creates a new actor under the same name — one site, N duplicates, a guaranteed loud
 *    run-time failure.
 *
 * Clause 1 **can only under-report, never over-report**: skipping a maybe-duplicate site costs
 * nothing (the engine backstops), while a false hit would block a legal script.
 *
 * A `.map` collection may hold ≤1
 * element; such a script is actually legal at run time, so this clause can in principle
 * over-report. The accepted trade is asymmetric — the fix is free (a per-element name
 * `` `x-${item}` ``, or anonymous), while not reporting costs the model a whole run to learn the
 * rule. `paths.map((p) => agent("reviewer").ask(…))` is the textbook fan-out shape; leaving it
 * silently to the run time is the worst slot.
 *
 * Fan-out detection **reuses the site table's classification** (`IterationCandidate` in
 * `analysis/sites.ts`: array methods with inline callbacks + `for...of`), rather than growing a
 * second loop recognizer. The cost: plain `for` / `while` / `do` loops are not in that
 * classification and thus not covered by this clause — they fall back to clause 1's old stance
 * (invisible, left to the run time). That is the under-reporting direction, consistent with this
 * module's conservative bias.
 *
 * Both the `CreateWorkflow` and
 * `SaveWorkflow` handlers run `analyzeScript` first (this diagnostic is in the authoring batch of
 * `analyzeWorkflowScript`) and return early with the diagnostics on `!ok` — **no submit, no
 * persist** — so a 9005/9006 really does block submit and save. But the run service's
 * `compileOnce` (the recompile on submit and resume) re-verifies only typecheck / schema /
 * world.run literals, **not** this diagnostic — it is not a mandatory gate on the submit path, so
 * do not treat it as load-bearing: the authority for named uniqueness is always the engine's
 * run-time createActor check.
 */

import ts from "typescript";
import type { CompileDiagnostic, WorkflowProgram } from "../compiler/compile.js";
import type { SiteTable } from "./sites.js";

/** The same literal name in two places (clause 1). 9001 = facade-siting, 9002 = schema, 9003 = world-run, 9004 = phase. */
export const DUPLICATE_ACTOR_NAME_CODE = 9005;

/**
 * A static name inside a fan-out body (clause 2), its own code instead of reusing 9005.
 *
 * The two clauses are one rule, but their **certainty differs**: 9005 appears only when the
 * duplicate is statically certain, 9006 is the clause above that deliberately accepts false
 * positives. Readers therefore need to tell them apart — most notably the analysis side's fixture
 * corpus: those scripts never execute and exist to pin graph shapes, and static-name + fan-out is
 * exactly the shape the analyzer must handle (`ActorNode.family`, actor labels), so the corpus is
 * exempted from 9006 while staying strict about 9005. One shared code would force discrimination
 * by matching message text, and routing on error text is banned across this repo.
 */
export const FANOUT_ACTOR_NAME_CODE = 9006;

/**
 * Collect the literal-duplicate diagnostics. Non-empty means the script cannot be submitted
 * (`analyzeWorkflowScript`, alongside the world.run / phase compile-time rules).
 */
export function collectDuplicateActorNames(
  workflow: WorkflowProgram,
  table: SiteTable,
): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const claimed = new Map<string, ts.CallExpression>();
  // The fan-out bodies come from the site table's IterationCandidate (array methods' inline
  // callback bodies + for...of loop bodies) — the same notion as `ActorNode.fanOutId`'s "is the
  // site inside a fan-out body".
  const fanOutBodies = new Set<ts.Node>(table.iterations.map((iteration) => iteration.body));
  for (const site of table.actors) {
    // The site table's `site.name` must not be used here: it falls back to the binding name
    // (`const planner = agent()` recorded as "planner"), which is a display label for the graph,
    // not the run-time effective name. What is wanted is the value the engine will see, so read
    // it from the arguments directly.
    const name = staticEffectiveName(site.call);
    if (name === undefined || name === "") continue;
    const first = claimed.get(name);
    if (first === undefined) claimed.set(name, site.call);
    const loc = workflow.toScriptLoc(site.call.getStart(workflow.scriptFile));
    // At most one diagnostic per site: the fan-out clause is the more specific (its fix differs
    // too — a per-element name, not just a different name), so it wins. The name is still
    // registered as usual, and later same-name sites still report.
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
    // The diagnostic lands on the **later** site: the earlier name is established fact; the one to change is the newcomer.
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
 * Whether the call is **lexically** inside some fan-out body. Walk the parent chain from the call
 * itself (the call may be the body: the arrow shorthand of
 * `paths.map((p) => agent("x"))`); any candidate body hit means yes.
 */
function isInsideFanOut(call: ts.CallExpression, fanOutBodies: ReadonlySet<ts.Node>): boolean {
  for (let node: ts.Node | undefined = call; node !== undefined; node = node.parent) {
    if (fanOutBodies.has(node)) return true;
  }
  return false;
}

/**
 * The **effective name** of an `agent(...)` call when statically knowable, else undefined
 * (= skip).
 *
 * The same rule as the engine's `normalizePersona`: persona.name overrides the name argument; a
 * string persona is a system prompt and carries no name. Any spot that cannot be seen through
 * gives up entirely — prefer under-reporting.
 *
 * The facade's `AgentPersona` **does not declare name today**, so every persona writable in a
 * script is nameless and the effective name always comes from the name argument. That persona
 * branch is therefore currently dead; it exists to stay in lockstep with normalizePersona, not to
 * fire today — once the facade grows `name` while this check still keys on the name argument, an
 * actor renamed via persona would be **mis-reported**, and a false positive blocks legal scripts
 * (under-reporting is free: the engine backstops at run time).
 */
function staticEffectiveName(call: ts.CallExpression): string | undefined {
  const [nameArg, personaArg] = call.arguments;
  if (personaArg !== undefined && !ts.isStringLiteralLike(personaArg)) {
    if (!ts.isObjectLiteralExpression(personaArg)) return undefined; // dynamic persona: may carry a name
    for (const property of personaArg.properties) {
      // A spread may smuggle in a name; statically undecidable.
      if (ts.isSpreadAssignment(property)) return undefined;
      // A computed key (`{ ["na" + "me"]: … }`) is also undecidable: it **might be** name. Give
      // up wholesale rather than `continue` — continuing would fall back to the name argument,
      // asserting the persona did not rename, a guess whose failure mode is exactly a false
      // positive (blocking legal scripts).
      if (property.name !== undefined && ts.isComputedPropertyName(property.name)) return undefined;
      if (property.name === undefined || !isNameKey(property.name)) continue;
      if (!ts.isPropertyAssignment(property)) return undefined; // shorthand / method: dynamic
      return ts.isStringLiteralLike(property.initializer) ? property.initializer.text : undefined;
    }
    // No name in the object literal: fall back to the name argument.
  }
  return nameArg !== undefined && ts.isStringLiteralLike(nameArg) ? nameArg.text : undefined;
}

/** Whether the property key is **statically** `name` (computed keys already gave up at the call site; they never reach here). */
function isNameKey(key: ts.PropertyName): boolean {
  return (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === "name";
}
