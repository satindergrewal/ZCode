import ts from "typescript";
import type { CompileDiagnostic, WorkflowProgram } from "../compiler/compile.js";
import { collectSites, type SiteTable } from "../analysis/sites.js";
import { createWorkflowProgram, collectDiagnostics } from "../compiler/compile.js";
// AskSpec is the engine input vocabulary; imported type-only here (erased at compile time, no runtime edge). The engine side
// likewise imports the schema Violation as a type -- both directions type-only, no import cycle.
import type { AskSpec } from "../engine/types.js";
import { SchemaEmitter, SchemaRejection } from "./emit.js";
import { harvestConstraints, mergeConstraints } from "./jsdoc.js";
import type { JsonSchema } from "./types.js";
import { SCHEMA_DIAGNOSTIC_CODE } from "./types.js";

/**
 * Schema synthesis (compile side): for every typed ask site, emit the result type T as pure JSON Schema via the checker structural view,
 * filed by site id.
 *
 * Typed means: the ask carries an explicit type argument and T resolves to something other than plain string.
 * The default and the explicit string argument are untyped asks (the result is the final text; no schema emitted).
 * Unserializable T is rejected with a diagnostic pinned to the ask site (the analysis pipeline CompileDiagnostic shape).
 *
 * The same pass checks report-item argument serializability -- one emitter, one diagnostic channel;
 * see reportItemDiagnostics. Report sites **produce no schema**, only diagnostics.
 */

export interface SchemaSynthesisResult {
  /** The JSON Schema per typed ask site, filed by site id. */
  schemas: Record<string, JsonSchema>;
  /** Rejection diagnostics, located at the corresponding ask site. */
  diagnostics: CompileDiagnostic[];
}

/**
 * An ask site result type T, or undefined for an untyped ask. The single source of truth for typed-ness:
 * the site table keeps only the call expression, no typed flag,
 * so it is resolved from the checker here. Untyped = T resolves to plain string (the default
 * and the explicit string argument alike; an alias to string also resolves so).
 *
 * Module-private on purpose: downstream (lowering / engine / driver) needs no separate predicate -- a successfully launched run has zero
 * diagnostics, so site-id-in-schemas is the typed test. But do **not** build the engine askSpecs from the schema keys:
 * untyped sites would go absent, and the engine hard-fails absence as a wiring bug.
 * Build askSpecs only via buildAskSpecs (iterating the site table).
 */
function askResultType(checker: ts.TypeChecker, call: ts.CallExpression): ts.Type | undefined {
  const typeNode = call.typeArguments?.[0];
  if (typeNode === undefined) return undefined;
  const type = checker.getTypeFromTypeNode(typeNode);
  return (type.flags & ts.TypeFlags.String) !== 0 ? undefined : type;
}

/**
 * Core entry: on the same checker that built the site table, emit a schema per typed ask. Mirrors
 * the documented two-argument form; takes the WorkflowProgram
 * for location-aware diagnostics via toScriptLoc.
 */
export function synthesizeAskSchemas(
  workflow: WorkflowProgram,
  table: SiteTable,
): SchemaSynthesisResult {
  const checker = workflow.program.getTypeChecker();
  const schemas: Record<string, JsonSchema> = {};
  const diagnostics: CompileDiagnostic[] = [];

  for (const site of table.asks) {
    const type = askResultType(checker, site.call);
    if (type === undefined) continue; // untyped ask: the result is the final text, no schema

    try {
      const typeNode = site.call.typeArguments![0]!;
      const emitter = new SchemaEmitter(checker, typeNode);
      schemas[site.id] = attachTopDoc(emitter.emitTop(type), type, checker);
    } catch (error) {
      if (!(error instanceof SchemaRejection)) throw error;
      diagnostics.push({
        code: SCHEMA_DIAGNOSTIC_CODE,
        column: site.loc.column,
        line: site.loc.line,
        message: rejectionMessage(error, "ask result type"),
      });
    }
  }

  for (const site of table.reports) diagnostics.push(...reportItemDiagnostics(checker, site));

  return { diagnostics, schemas };
}

/**
 * Serializability check of the report item argument.
 *
 * Why the same checker walk, the same emitter, and the same diagnostic channel as the ask schema synthesis:
 * a reported item crosses the journal and protocol boundaries for exactly the same reasons as an artifact, so
 * what-counts-as-serializable must have one answer. A parallel checker would be a second truth --
 * and the day the two disagree shows up as an empty object on some run Results panel.
 *
 * Two differences from ask:
 *   1. **No schema produced**. report has nothing to validate against -- no model submits by it; the item is a value
 *      the script computed. Only the serializable-or-not verdict is needed; the emitted schema is dropped.
 *   2. The type comes from the **argument expression**, not a type argument. The facade types the parameter unknown
 *      (legal any-JSON in the emitter), so the question is what the actually-passed value is.
 *      A plain-JSON or unknown argument passes; a Date / function / class instance
 *      /Promise is rejected, located at the call.
 */
function reportItemDiagnostics(
  checker: ts.TypeChecker,
  site: SiteTable["reports"][number],
): CompileDiagnostic[] {
  // A missing argument is typecheck to report (the facade item param is required); nothing to do here.
  if (site.item === undefined) return [];
  try {
    new SchemaEmitter(checker, site.item).emitTop(checker.getTypeAtLocation(site.item));
    return [];
  } catch (error) {
    if (!(error instanceof SchemaRejection)) throw error;
    return [
      {
        code: SCHEMA_DIAGNOSTIC_CODE,
        column: site.loc.column,
        line: site.loc.line,
        message: rejectionMessage(error, "report item type"),
      },
    ];
  }
}

/**
 * Convenience entry: one-stop synthesis from script text (typecheck, site table, synthesize). A call site for
 * package/engine sides that avoids assembling program+table; analyzeWorkflowScript belongs to the analysis domain, untouched here.
 * A script failing typecheck returns its compile diagnostics, with no synthesis.
 */
export function synthesizeWorkflowSchemas(scriptText: string): SchemaSynthesisResult {
  const workflow = createWorkflowProgram(scriptText);
  const compileDiagnostics = collectDiagnostics(workflow.program);
  if (compileDiagnostics.length > 0) return { diagnostics: compileDiagnostics, schemas: {} };
  return synthesizeAskSchemas(workflow, collectSites(workflow));
}

/**
 * Assemble the site table and synthesized schemas into the engine askSpecs.
 *
 * **Why iterate table.asks, not the schema keys**: schemas are emitted for typed sites only
 * (an untyped ask result is the final text; no schema), while the engine requires askSpecs to cover **every**
 * ask site -- a missing site hard-fails as a wiring bug (MissingAskSpec), since table and schema synthesis
 * come from one compilation; absence would mean the two products were spliced together. So untyped sites are recorded explicitly as
 * not-typed, never via an absent-means-untyped fallback: that fallback would silently
 * downgrade typed asks -- no submit_result, final text as result, schema validation gone.
 *
 * This construction is correctness-critical with exactly one right shape, so it lives here once: callers (run service, test harnesses)
 * use it, never reimplement. The site table is the identity truth; schema keys matching no site are ignored.
 */
export function buildAskSpecs(
  table: SiteTable,
  schemas: Record<string, JsonSchema>,
): Map<string, AskSpec> {
  const specs = new Map<string, AskSpec>();
  for (const site of table.asks) {
    const schema = schemas[site.id];
    specs.set(site.id, schema === undefined ? { typed: false } : { typed: true, schema });
  }
  return specs;
}

/** The root type description/constraints: from its alias or symbol (a named interface or type alias). */
function attachTopDoc(schema: JsonSchema, type: ts.Type, checker: ts.TypeChecker): JsonSchema {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (symbol === undefined) return schema;
  return mergeConstraints(schema, harvestConstraints(symbol, checker));
}

function rejectionMessage(error: SchemaRejection, subject: string): string {
  const where = error.path !== "$" && error.path.length > 0 ? ` (at ${error.path})` : "";
  return `unsupported ${subject}: ${error.reason}${where}`;
}
