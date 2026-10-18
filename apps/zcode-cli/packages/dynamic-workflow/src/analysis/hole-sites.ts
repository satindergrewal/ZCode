/**
 * Hole sites (docs/dynamic-workflow/authoring.md "Holes: `hole<T>()`", docs/analysis.md
 * "Sites"): the sites' construction (argument dispatch across the three overloads, the tail
 * check) and compile-time rule 9012.
 *
 * Every 9012 rule is of the kind "better taught at rewrite time than exploded at run time"
 * (seated with 9003 / 9004):
 *  - The type argument must be explicit: T is the contract the fill is checked against; an
 *    inferred `unknown` is no contract.
 *  - The name is a non-empty literal, at most 128 characters, and **unique** across the script's
 *    holes and phase markers (nested fills included): the name is the hole's phase label and the
 *    identity every surface shows — two markers of one name are one phase, two holes of one name
 *    are two broken gaps.
 *  - The call must be awaited: an unawaited hole lets the script run past a gap that has no
 *    value yet.
 *  - It must not sit inside a fan-out **callback** (a callback of an array method, hoisted or
 *    not): the elements run concurrently, so the fill would have to be written while they are
 *    already running. A `for...of` body **is allowed**: for...of with await is sequential — the
 *    first round stops at the hole, the fill lands, every later round runs the body; that is
 *    exactly the "fill once in the loop, run per round" rule.
 *  - The body must not reference a binding declared after the hole: the body is a closure the
 *    compiler does not check for use-before-declare; referencing a later `const` throws a TDZ
 *    error at run time.
 *  - The body must be an inline function literal: lowering prints it verbatim as the fill text,
 *    and an identifier has no text to print.
 */

import ts from "typescript";
import type { CompileDiagnostic, ScriptLoc, WorkflowProgram } from "../compiler/compile.js";
import type { HoleSite, SiteTable } from "./sites.js";
import { literalText } from "./sites-labels.js";

/** The hole rule's diagnostic code (9001 = facade-siting, ..., 9010 = model name, and so on). */
export const HOLE_CODE = 9012;

/** Length cap for hole names: same rule as phase names (docs/dynamic-workflow/authoring.md "Holes"). */
export const HOLE_NAME_MAX_CHARS = 128;

const TYPE_MESSAGE =
  "hole() needs an explicit type argument (hole<Plan>(...)): the type is the contract the " +
  "fill is compiled against, and an inferred unknown is no contract. Write what the rest of " +
  "the script needs from the hole.";

const NAME_LITERAL_MESSAGE =
  "hole()'s name must be a compile-time string literal: it is the hole's phase name and the " +
  "identity every surface shows (the station, the notification, the fill file). Write it inline.";

const NAME_EMPTY_MESSAGE =
  'hole("") has no name to show. Give the gap a word in the user\'s language ("决定分组", ' +
  '"choose the plan"); it labels the station and the notification.';

const NAME_LONG_MESSAGE = `hole()'s name is longer than ${HOLE_NAME_MAX_CHARS} characters; a phase name is a label, not a paragraph.`;

const AWAIT_MESSAGE =
  "hole() must be awaited where it is called (await hole<T>(...) or return await hole<T>(...)): " +
  "the script must not run past a gap that has no value yet.";

const FANOUT_MESSAGE =
  "hole() cannot stand inside a fan-out callback (xs.map(...), Promise.all(xs.map(...)) and the " +
  "other per-element array methods): the elements run concurrently, so its fill would have to " +
  "be written while they are already running. Hoist the decision out of the callback, or use a " +
  "loop (for, for...of, while), where one round waits and the fill runs in every later round.";

const BODY_INLINE_MESSAGE =
  "hole()'s body must be an inline async arrow (async () => { ... }): a fill is spliced into the " +
  "script as text, so a function held in a variable has nothing to splice.";

/** The copy for a name collision: say whether it hit a marker or another hole. */
function duplicateMessage(name: string, other: "hole" | "marker"): string {
  return other === "hole"
    ? `two holes are named "${name}"; a hole's name is its identity and must be unique among the script's holes and phase markers.`
    : `hole "${name}" shares its name with a phase("${name}") marker; a hole is a phase of its own, so the name must be unique among holes and markers.`;
}

/** A hash collision between two distinct names (hole-id.ts): rare, but never guess — renaming one fixes it. */
function idCollisionMessage(name: string, other: string): string {
  return (
    `hole "${name}" and hole "${other}" hash to the same site id; rename one of them ` +
    "(any change to the name gives it a new id)."
  );
}

function lateBindingMessage(name: string): string {
  return (
    `the hole's body reads "${name}", which is declared after the hole. The body runs at the ` +
    "hole, before that declaration executes, so the read would throw at run time. Declare it " +
    "before the hole, or compute it inside the body."
  );
}

function isFunctionLiteral(
  expr: ts.Expression | undefined,
): expr is ts.ArrowFunction | ts.FunctionExpression {
  return expr !== undefined && (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr));
}

/** Whether the call is the operand of a top-level `return` (`return await hole(...)` or `return hole(...)`). */
function isTailPosition(call: ts.CallExpression): boolean {
  const parent = call.parent;
  if (ts.isReturnStatement(parent)) return true;
  return ts.isAwaitExpression(parent) && ts.isReturnStatement(parent.parent);
}

/**
 * Build a site from a call already judged to be the facade `hole`. The three-overload dispatch
 * looks only at argument shapes: a function-literal second argument is the body, else the prompt;
 * a third argument (if present) is the body. A non-literal body counts as neither prompt nor
 * body — left for 9012 to report as "must be inline".
 */
export function holeSiteOf(
  call: ts.CallExpression,
  id: string,
  order: number,
  loc: ScriptLoc,
  funcDepth: number,
  fill: string | undefined,
): HoleSite {
  const [first, second, third] = call.arguments;
  const body = isFunctionLiteral(second) ? second : isFunctionLiteral(third) ? third : undefined;
  const prompt = second !== undefined && body !== second ? second : undefined;
  const typeArg = call.typeArguments?.[0];
  const name = literalText(first);
  return {
    call,
    ...(fill === undefined ? {} : { fill }),
    id,
    loc,
    ...(name === undefined ? {} : { name }),
    nameExpr: first,
    order,
    ...(prompt === undefined ? {} : { prompt }),
    ...(body === undefined ? {} : { body }),
    tail: funcDepth === 0 && isTailPosition(call),
    ...(typeArg === undefined ? {} : { typeArg, typeText: typeArg.getText() }),
  };
}

/** Whether `node` lies entirely within the source range of the `span` node. */
function within(node: ts.Node, span: ts.Node, scriptFile: ts.SourceFile): boolean {
  return span.getStart(scriptFile) <= node.getStart(scriptFile) && node.getEnd() <= span.getEnd();
}

/**
 * Whether the declaration is hoisted to the top of its scope, making use-before-declare harmless
 * at run time: `function` and `var`. `let` / `const` / `class` / `enum` are not (TDZ or an empty
 * object); referencing them is a run-time error.
 */
function isHoisted(declaration: ts.Declaration): boolean {
  if (ts.isFunctionDeclaration(declaration)) return true;
  if (!ts.isVariableDeclaration(declaration)) return false;
  const list = declaration.parent;
  return ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.BlockScoped) === 0;
}

/** Validate the collected hole sites. Non-empty means the script cannot be submitted (`analyzeWorkflowScript`, seated with misuse). */
export function collectHoleDiagnostics(
  workflow: WorkflowProgram,
  table: SiteTable,
): CompileDiagnostic[] {
  const { program, scriptFile, toScriptLoc } = workflow;
  const checker = program.getTypeChecker();
  const diagnostics: CompileDiagnostic[] = [];
  const push = (loc: ScriptLoc, message: string): void => {
    diagnostics.push({ code: HOLE_CODE, column: loc.column, line: loc.line, message });
  };
  const at = (node: ts.Node | undefined, fallback: ScriptLoc): ScriptLoc =>
    node === undefined ? fallback : toScriptLoc(node.getStart(scriptFile));

  // Name uniqueness spans holes and markers: markers register first, so any hole sharing a
  // marker's name is reported regardless of order; two holes of one name report on the latter
  // (source order). Holes and markers inside nested fills are in the table too and count
  // naturally.
  const seen = new Map<string, "hole" | "marker">();
  for (const marker of table.phases) {
    const name = marker.name?.trim();
    if (name !== undefined && name !== "") seen.set(name, "marker");
  }
  // Hash collisions of the name key: one id belongs to one name (same-name duplicates were
  // already reported above).
  const idOwner = new Map<string, string>();

  for (const site of [...table.holes].sort((a, b) => a.order - b.order)) {
    const nameLoc = at(site.nameExpr, site.loc);
    if (site.typeArg === undefined) push(site.loc, TYPE_MESSAGE);

    if (site.name === undefined) push(nameLoc, NAME_LITERAL_MESSAGE);
    else if (site.name.trim() === "") push(nameLoc, NAME_EMPTY_MESSAGE);
    else if (site.name.length > HOLE_NAME_MAX_CHARS) push(nameLoc, NAME_LONG_MESSAGE);
    else {
      const name = site.name.trim();
      const other = seen.get(name);
      if (other !== undefined) push(nameLoc, duplicateMessage(name, other));
      else {
        seen.set(name, "hole");
        const owner = idOwner.get(site.id);
        if (owner !== undefined && owner !== name) push(nameLoc, idCollisionMessage(name, owner));
        else idOwner.set(site.id, name);
      }
    }

    if (!ts.isAwaitExpression(site.call.parent)) push(site.loc, AWAIT_MESSAGE);

    // Only array-method callbacks count (hoisted or not); a for...of statement body is
    // sequential, so a hole may stand inside it.
    const inCallback = table.iterations.some(
      (cand) => cand.form === "array-method" && within(site.call, cand.body, scriptFile),
    );
    if (inCallback) push(site.loc, FANOUT_MESSAGE);

    // A non-inline body: the second argument is neither a prompt (not a string) nor a literal,
    // or the third argument is not a literal.
    const [, second, third] = site.call.arguments;
    const heldBody =
      (third !== undefined && site.body !== third ? third : undefined) ??
      (second !== undefined && site.prompt === second && isCallable(second, checker)
        ? second
        : undefined);
    if (heldBody !== undefined) push(at(heldBody, site.loc), BODY_INLINE_MESSAGE);

    if (site.body !== undefined) {
      collectLateBindings(site.call, site.body, checker, scriptFile, (node, name) =>
        push(at(node, site.loc), lateBindingMessage(name)),
      );
    }
  }
  return diagnostics;
}

function isCallable(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  return checker.getTypeAtLocation(expr).getCallSignatures().length > 0;
}

/**
 * Every identifier reference in the body that resolves to a script declaration positioned after
 * the hole and outside the body, not hoisted: one report per binding (at the first reference).
 * Property names and the declaration's own name are not references; skip them.
 */
function collectLateBindings(
  call: ts.CallExpression,
  body: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
  scriptFile: ts.SourceFile,
  report: (node: ts.Node, name: string) => void,
): void {
  const holeStart = call.getStart(scriptFile);
  const reported = new Set<ts.Symbol>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isValueReference(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol !== undefined && !reported.has(symbol)) {
        const late = symbol.declarations?.some(
          (decl) =>
            decl.getSourceFile() === scriptFile &&
            !within(decl, body, scriptFile) &&
            decl.getStart(scriptFile) > holeStart &&
            !isHoisted(decl),
        );
        if (late === true) {
          reported.add(symbol);
          report(node, node.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body.body);
}

/** Whether the identifier is a value reference (not a `x.NAME` member name, not a declaration's own name, not a property key). */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node)
    return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  return true;
}
