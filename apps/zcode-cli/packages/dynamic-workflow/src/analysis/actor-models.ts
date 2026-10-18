/**
 * Compile-time rules for subagent models
 * (docs/dynamic-workflow/authoring.md "Choosing a model per subagent"; line 9010 in
 * docs/analysis.md "Diagnostics").
 *
 * The rule in one sentence: **the set of model names a script can hand to a subagent is closed
 * before the run**. The launch tool resolves every name against the host's model catalog before
 * the confirmation dialog
 * (docs/dynamic-workflow/launch.md "Models the script names") — the dialog shows the model that
 * will take effect, and a name that cannot resolve comes back as 9011 with nothing run.
 *
 * The set has two sources:
 *
 * 1. The arguments of `model("…")` calls — must be non-empty hole-free string literals (9010).
 *    A `ModelRef` can only be built by it (in the facade it is a class with a private constructor
 *    and private members; neither `new` nor an object literal can build one), so any value of
 *    type `ModelRef` comes from some `model()` call and its name is already in the set.
 * 2. The **type** of the persona's `model` property on each `agent(name, persona)` site: it must
 *    be `ModelRef`, a string literal type, or a union of those (9010). Every literal member of
 *    the union enters the set.
 *
 * Why judge the **type** instead of syntactic literals: with `const FLASH = "…"`,
 * `hard ? "a" : "b"`, `MODELS[k]`, which value appears at run time is undecidable, but the
 * checker has already computed the value set — judging by type, one rule covers inline literals,
 * const bindings and conditionals at once, while a value widened to `string` (a `let`, a
 * parameter, a holed template, a persona object stored in a variable first) is precisely the
 * kind whose set is not closed.
 *
 * Why an inline persona object literal has its `model` initializer expression taken **syntactically** and
 * its type asked, instead of asking the whole object's type: an object literal's property type is
 * widened when the contextual type carries no literal types (`{ model: "x" }` against the
 * `AgentPersona` context: the property type is `string`), so judging by the object type would
 * false-positive the most common spelling. The initializer expression's own type escapes that
 * widening.
 *
 * Unlike actor-names.ts (9005/9006), this diagnostic has **no run-time backstop**: nothing
 * downstream re-checks "what might a subagent's model be". If the host cannot resolve the binding
 * at session creation, that one ask fails loudly (only a cast can get that far) — and that is
 * already past the confirmation dialog. So here false positives beat false negatives.
 *
 * Incidentally: `ModelRef` does not exist at run time (lowering erases `model("x")` to `"x"`;
 * the class is absent in the sandbox), so a script referencing `ModelRef` in **value position**
 * (`x instanceof ModelRef`) is also reported here as 9010, rather than left as a run-time
 * ReferenceError.
 */

import ts from "typescript";
import type { CompileDiagnostic, ScriptLoc, WorkflowProgram } from "../compiler/compile.js";
import { facadeMemberOf, valueFunctionOfSymbol } from "../facade/registry.js";
import { findWorkflowBody, resolveSymbol, type SiteTable } from "./sites.js";

/** The model name set is not closed (a persona's `model` type, a `model()` argument, `ModelRef` in value position). */
export const MODEL_REFERENCE_CODE = 9010;

/**
 * A model name in the script does not resolve in the host's model catalog (missing, ambiguous,
 * disabled, wrong level). **Not** a diagnostic produced by this package — the compiler cannot
 * know the host's configured models; the launch tool (packages/core) reports it after
 * `resolveInput`, at {@link ModelReference}'s position. The code lives here so both sides share
 * one number and the diagnostic table stays single.
 */
export const MODEL_UNRESOLVED_CODE = 9011;

/** A model name the script can hand to a subagent, plus one place it appears in the script. */
export interface ModelReference {
  /** The name, **verbatim** as written: the run-time persona carries this string, and the launch binding table keys on it. */
  name: string;
  line: number;
  column: number;
}

export interface ActorModels {
  /** One entry per occurrence, in discovery order (`model()` calls first, then each `agent()` site). */
  references: ModelReference[];
  /** 9010; non-empty means the script cannot be submitted. */
  diagnostics: CompileDiagnostic[];
}

/** The shared explanation for a rejected `model` value: three fixes, so the author gets it right in one pass. */
const WIDENED_MODEL_MESSAGE =
  "A subagent's `model` must be known before the run starts: a string literal, a union of " +
  'string literals, or a ModelRef from model("…"). This value\'s type is {type}, which could ' +
  "be any model name. Write the name inline, add `as const` where it is declared, or declare " +
  "the candidates with model() and choose among those ModelRefs at run time.";

const MODEL_CALL_MESSAGE =
  "model() takes the model name as a non-empty string literal (a model id or " +
  '"providerId/modelId", optionally with "$level"): every model a script can use is checked ' +
  "against the configured models before the run starts. Put runtime choices in which ModelRef " +
  "you pass, not in the name.";

const MODEL_REF_VALUE_MESSAGE =
  "ModelRef exists only as a type: at run time a ModelRef is its model name. Use it in type " +
  "positions only; compare ModelRefs directly or keep a table keyed by your own choice.";

/** Collect the model-name set and the 9010 diagnostics. Only call on a clean-compiling program. */
export function collectActorModels(workflow: WorkflowProgram, table: SiteTable): ActorModels {
  const { program, scriptFile, toScriptLoc } = workflow;
  const checker = program.getTypeChecker();
  const references: ModelReference[] = [];
  const diagnostics: CompileDiagnostic[] = [];
  const locOf = (node: ts.Node): ScriptLoc => toScriptLoc(node.getStart(scriptFile));
  const report = (at: ts.Node, message: string): void => {
    const loc = locOf(at);
    diagnostics.push({ code: MODEL_REFERENCE_CODE, column: loc.column, line: loc.line, message });
  };
  const collect = (name: string, at: ts.Node): void => {
    const loc = locOf(at);
    references.push({ column: loc.column, line: loc.line, name });
  };

  // 1. model() calls and ModelRef in value position: one pass over the whole script body
  //    (nested functions included — model tables usually sit at the top level, but a model()
  //    inside a helper is in the set all the same).
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (valueFunctionOfSymbol(resolveSymbol(node.expression, checker)) === "model") {
        const arg = node.arguments[0];
        if (arg !== undefined && ts.isStringLiteralLike(arg) && arg.text.trim().length > 0) {
          collect(arg.text, arg);
        } else {
          report(arg ?? node, MODEL_CALL_MESSAGE);
        }
      }
    } else if (ts.isIdentifier(node) && isModelRefClass(resolveSymbol(node, checker))) {
      if (!isTypePosition(node)) report(node, MODEL_REF_VALUE_MESSAGE);
    }
    ts.forEachChild(node, walk);
  };
  walk(findWorkflowBody(scriptFile));

  // 2. The persona's model on each agent() site.
  const checkModelValue = (expr: ts.Expression, type: ts.Type): void => {
    const members = type.isUnion() ? type.types : [type];
    for (const member of members) {
      // undefined contributed by an optional property = "no model chosen", not a name.
      if ((member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) continue;
      if (isModelRefType(member)) continue;
      if (member.isStringLiteral()) {
        if (member.value.trim().length > 0) {
          collect(member.value, expr);
          continue;
        }
      }
      report(expr, WIDENED_MODEL_MESSAGE.replace("{type}", `'${checker.typeToString(type)}'`));
      return;
    }
  };

  const checkPersona = (persona: ts.Expression): void => {
    if (ts.isParenthesizedExpression(persona)) {
      checkPersona(persona.expression);
      return;
    }
    if (ts.isConditionalExpression(persona)) {
      checkPersona(persona.whenTrue);
      checkPersona(persona.whenFalse);
      return;
    }
    if (ts.isObjectLiteralExpression(persona)) {
      const modelExpr = lastModelInitializer(persona);
      if (modelExpr === "spread") {
        checkPersonaType(persona);
      } else if (modelExpr !== undefined) {
        checkModelValue(modelExpr, modelValueType(modelExpr, checker));
      }
      return;
    }
    checkPersonaType(persona);
  };

  // Not an inline object literal: take the model property from the argument's type. A string
  // persona (= system prompt) has no model.
  const checkPersonaType = (persona: ts.Expression): void => {
    const type = checker.getTypeAtLocation(persona);
    const members = type.isUnion() ? type.types : [type];
    for (const member of members) {
      if ((member.flags & ts.TypeFlags.StringLike) !== 0) continue;
      const property = checker.getPropertyOfType(member, "model");
      if (property === undefined) continue;
      checkModelValue(persona, checker.getTypeOfSymbolAtLocation(property, persona));
    }
  };

  for (const site of table.actors) {
    const persona = site.call.arguments[1];
    if (persona !== undefined) checkPersona(persona);
  }

  return { diagnostics, references };
}

/**
 * The initializer expression of the **last** `model` written in an inline persona literal. If a
 * spread follows it, the spread may override it — return `"spread"` and let the type-based check
 * decide; also `"spread"` when `model` was never written but a spread exists; undefined when
 * neither.
 */
function lastModelInitializer(
  literal: ts.ObjectLiteralExpression,
): ts.Expression | "spread" | undefined {
  let found: ts.Expression | "spread" | undefined;
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) {
      found = "spread";
    } else if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === "model") {
      found = property.initializer;
    } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === "model") {
      found = property.name;
    }
  }
  return found;
}

/** The initializer expression's own type (not the object literal's widened property type); shorthand `{ model }` takes the referenced binding's type. */
function modelValueType(expr: ts.Expression, checker: ts.TypeChecker): ts.Type {
  const parent = expr.parent;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === expr) {
    const value = checker.getShorthandAssignmentValueSymbol(parent);
    if (value !== undefined) return checker.getTypeOfSymbolAtLocation(value, expr);
  }
  return checker.getTypeAtLocation(expr);
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/** The `ModelRef` class symbol from the facade. */
function isModelRefClass(symbol: ts.Symbol | undefined): boolean {
  const member = facadeMemberOf(symbol);
  return (
    member !== undefined &&
    member.container === undefined &&
    member.member === "ModelRef" &&
    symbol !== undefined &&
    (symbol.flags & ts.SymbolFlags.Class) !== 0
  );
}

/** Whether the type is the facade's `ModelRef` (its instance type). */
function isModelRefType(type: ts.Type): boolean {
  return isModelRefClass(type.getSymbol());
}

/** Whether the identifier sits in a type position (`x: ModelRef`, `typeof ModelRef`, or a `A.ModelRef` qualified-name chain). */
function isTypePosition(node: ts.Identifier): boolean {
  let parent: ts.Node = node.parent;
  while (ts.isQualifiedName(parent)) parent = parent.parent;
  return ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent);
}
