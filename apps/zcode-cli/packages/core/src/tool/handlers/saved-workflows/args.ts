// ============================================================
// Saved workflows - argument validation
// ============================================================
//
// Validation precedes the **dialog**: broken args hold nothing worth deciding; a doomed dialog only
// interrupts the fix loop with a no-op decision — the same rule as CreateWorkflow on non-compiling scripts
// (the `prepareApproval` note in create-workflow.ts).

import type { SavedWorkflowArgDeclaration, SavedWorkflowArgsDeclaration } from "@zcode/contracts";

export type WorkflowArgsValidation =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; errors: string[] };

/**
 * Validate caller args against declarations; backfill defaults.
 *
 * Collect **all** violations, return once, no exit-on-first: told missing-pr-plus-extra-
 * prNumber the model fixes in one pass; told only missing-pr it fixes, retries, bumps again.
 *
 * Any args on a workflow declaring none is an error — it cannot read them; silent dropping fakes
 * applied args.
 */
export function validateWorkflowArgs(
  declaration: SavedWorkflowArgsDeclaration | undefined,
  provided: Record<string, unknown> | undefined,
): WorkflowArgsValidation {
  const declared = declaration ?? {};
  const given = provided ?? {};
  const errors: string[] = [];
  const args: Record<string, unknown> = {};

  const declaredNames = Object.keys(declared);
  for (const key of Object.keys(given)) {
    if (declared[key] !== undefined) continue;
    errors.push(
      declaredNames.length === 0
        ? `unknown argument '${key}': this workflow declares no arguments`
        : `unknown argument '${key}' (declared: ${declaredNames.join(", ")})`,
    );
  }

  for (const [key, spec] of Object.entries(declared)) {
    const supplied = given[key];
    // Absent and explicit undefined alike: JSON cannot carry undefined, so they are the same thing.
    if (supplied === undefined) {
      if (spec.default !== undefined) {
        // Default and passed values run the **same** check: a number-declared arg defaulting to "3"
        // is wrong at save time, not at first read.
        const failure = typeMismatch(key, spec, spec.default, "default value");
        if (failure === undefined) args[key] = spec.default;
        else errors.push(failure);
        continue;
      }
      if (spec.required === true) errors.push(`missing required argument '${key}'`);
      continue;
    }

    const failure = typeMismatch(key, spec, supplied, "value");
    if (failure === undefined) args[key] = supplied;
    else errors.push(failure);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, args };
}

/**
 * The mismatch explanation; `undefined` when it matches.
 *
 * `json` takes anything — that is what unchecked means; even null is legal. The three primitives go by
 * typeof; `number` also rejects NaN/Infinity — they cannot cross JSON into the sandbox; passing them
 * only moves a readable error into the script as `null`.
 */
function typeMismatch(
  key: string,
  spec: SavedWorkflowArgDeclaration,
  value: unknown,
  what: string,
): string | undefined {
  const describe = (expected: string): string =>
    `argument '${key}': expected ${expected}, got ${describeValue(value)} (${what})`;

  switch (spec.type) {
    case "string":
      return typeof value === "string" ? undefined : describe("a string");
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? undefined
        : describe("a finite number");
    case "boolean":
      return typeof value === "boolean" ? undefined : describe("a boolean");
    case "json":
      return undefined;
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
