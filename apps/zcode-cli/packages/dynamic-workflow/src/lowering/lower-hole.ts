import ts from "typescript";
import type { HoleSite } from "../analysis/sites.js";

/**
 * Lowering of holes (the two-line hole in execution-engine.md "From script to sandbox input:
 * lowering", and "The vm cell"):
 *
 *   hole<T>(n, p?)                 -> __host.hole("hole#1", n, p ?? void 0, (__src) => eval(__src))
 *   hole<T>(n, p?, async () => …)  -> __host.hole("hole#1", n, p ?? void 0, (__src) => eval(__src),
 *                                                 async () => { …lowered body… })
 *
 * The trailing `(__src) => eval(__src)` is the evaluator emitted at the site: its `eval` is a
 * direct call, so the fill text is evaluated in the hole's lexical scope — every binding before
 * the hole is readable, `__host` included; a fresh evaluator is built on each arrival, so a hole
 * inside a loop sees each round's bindings. A filled hole passes its body as the fifth argument;
 * the cell calls it directly instead of messaging.
 *
 * Split out of lower.ts (max-lines gate) and deliberately a pure function: the rewrite keys off
 * the node identity the site table provides, one transform pass alongside the other sites, no
 * second recognition pass.
 */

/** The evaluator's parameter name: the cell feeds the fill text to it. */
const EVALUATOR_PARAM = "__src";

/** Erasure options shared by both lowering passes: the body and hole bodies must be produced by the **same** options (execution-engine.md "The text that runs"). */
export const TRANSPILE_OPTIONS: ts.CompilerOptions = {
  isolatedModules: false,
  module: ts.ModuleKind.ESNext,
  newLine: ts.NewLineKind.LineFeed,
  removeComments: false,
  target: ts.ScriptTarget.ES2022,
};

/** Rewrites one hole call; a filled hole records its rewritten body into `bodies` for {@link printHoleBodies} to print. */
export function lowerHoleCall(
  call: ts.CallExpression,
  site: HoleSite,
  factory: ts.NodeFactory,
  hostMember: (name: string) => ts.Expression,
  siteArg: (id: string) => ts.Expression,
  visitExpr: (expr: ts.Expression) => ts.Expression,
  bodies: Map<string, ts.Expression>,
): ts.Expression {
  const [first] = call.arguments;
  const name = first === undefined ? factory.createVoidZero() : visitExpr(first);
  const prompt = site.prompt === undefined ? factory.createVoidZero() : visitExpr(site.prompt);
  const evaluator = factory.createArrowFunction(
    undefined,
    undefined,
    [factory.createParameterDeclaration(undefined, undefined, EVALUATOR_PARAM)],
    undefined,
    factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    factory.createCallExpression(factory.createIdentifier("eval"), undefined, [
      factory.createIdentifier(EVALUATOR_PARAM),
    ]),
  );
  const args: ts.Expression[] = [siteArg(site.id), name, prompt, evaluator];
  if (site.body !== undefined) {
    const body = visitExpr(site.body);
    bodies.set(site.id, body);
    args.push(body);
  }
  return factory.createCallExpression(hostMember("hole"), undefined, args);
}

/**
 * Each filled hole's body as **printed, type-erased** text `(async () => {\n…\n})`: a live fill
 * has the cell `eval` it, while a later replay runs the same rewrite inlined in the body — both
 * paths carry the same `hole#<hash>/…` id per site, because the text comes from one transform
 * pass (execution-engine.md "The text that runs").
 *
 * Printed as an expression statement and then erased: the trailing `;\n` is the statement
 * terminator transpile adds, so strip it — what remains is a parenthesized expression that
 * `eval`s straight to a function value.
 */
export function printHoleBodies(
  bodies: ReadonlyMap<string, ts.Expression>,
  printer: ts.Printer,
  sourceFile: ts.SourceFile,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [siteId, body] of bodies) {
    const printed = printer.printNode(ts.EmitHint.Expression, body, sourceFile);
    const erased = ts.transpileModule(`(${printed})`, {
      compilerOptions: TRANSPILE_OPTIONS,
      reportDiagnostics: false,
    }).outputText;
    out[siteId] = erased.replace(/;\n?$/, "");
  }
  return out;
}
