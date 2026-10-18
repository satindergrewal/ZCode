import ts from "typescript";
import {
  collectDiagnostics,
  createWorkflowProgram,
  WORKFLOW_FUNCTION_NAME,
  type CompileDiagnostic,
  type WorkflowProgram,
} from "../compiler/compile.js";
import { FACADE_FILE_NAME } from "../facade/dts.js";
import { isArtifactPresetOp, type ArtifactOp, type WorldReadOp } from "../facade/registry.js";
import { collectFacadeMisuse } from "../analysis/facade-misuse.js";
import {
  collectSites,
  isFacadeDeclared,
  resolveSymbol,
  type SiteTable,
} from "../analysis/sites.js";

/**
 * Lowering (the instrumentation emit step): degrades a typecheck+analyze-clean workflow script into sandbox-runnable
 * **JavaScript**. Two things:
 *
 *   1. Strip types -- already typechecked; this is transpile-level type erasure of the same source.
 *   2. Stub every facade call with the site-table static site id, rewriting to Boundary A host calls:
 *        agent(name, persona)        -> __host.createActor("actor#2", name, persona)
 *        planner.ask<Plan>(text)     -> __host.ask("ask#3", planner, text)
 *        maybe?.ask<Plan>(text)      -> maybe === null || maybe === undefined
 *                                         ? undefined : __host.ask("ask#3", maybe, text)
 *                                       (optional-chain short circuit kept: a nullish receiver skips the ask,
 *                                        args unevaluated; non-identifier receivers evaluated once via a temp)
 *        files.glob(p) / files.read(p)
 *                                    -> __host.worldRead("world-read#1", "glob", [p])
 *                                       __host.worldRead("world-read#2", "read", [p])
 *        report(x)                   -> __host.report("report#1", x)
 *        report(x, "perf")           -> __host.report("report#1", x, "perf")
 *        artifact.file(id, p, o)     -> __host.publishArtifact("artifact#1", "file", [id, p, o])
 *        artifact.chart(id, spec)    -> __host.declareArtifact("artifact#2", "chart", [id, spec])
 *        log(msg)                    -> __host.log(msg)
 *        phase marker -> host enterPhase (no site; the engine emits one event)
 *        Join (Promise.all) and fan-out are ordinary in-sandbox promise mechanics, not host calls -- untouched.
 *
 * ————————————————————————————————————————————————————————————————
 * Output contract (the harness contract; the sandbox wraps):
 * ————————————————————————————————————————————————————————————————
 * The lowered code is the script **async function body**: a top-level await and a trailing
 * return are both legal -- the harness wraps it in an async function,
 *
 *     const __run = async (__host) => { <code> };
 *
 * So the only free identifier in the code is the host binding -- agent / log / files / phase
 * are rewritten away; the sandbox vm globals need only ES intrinsics plus the host handle.
 * Schemas never cross the sandbox boundary: the engine looks schemas up by site id from compile products; the code carries none.
 *
 * The exported site id list covers every stubbed facade site in source order (asks /
 * actors / world-reads / reports / artifacts; log and phase take no site id, hence absent) -- letting the
 * harness and tests assert each site id appears exactly once.
 *
 * Determinism: printer and transpile are pure; same input, byte-identical output.
 */

/** The free identifier the harness must bind for lowered code (the Boundary A host handle). */
export const HOST_BINDING = "__host";

/** The lowering product: the sandbox-input JS body plus the stubbed site ids. */
export interface LoweredWorkflow {
  /** The lowered script async function body (top-level await / trailing return legal; the only free identifier is the host). */
  code: string;
  /** Stubbed facade site ids in source order (log excluded; it has none). */
  siteIds: string[];
}

/** The lower result, isomorphic to analyze: dirty scripts do not lower; the payload present only when ok. */
export interface LowerResult {
  diagnostics: CompileDiagnostic[];
  ok: boolean;
  lowered?: LoweredWorkflow;
}

/** For each site-table facade call, which host form it becomes (phase has no site id, name only). */
type SiteEmit =
  | { kind: "actor"; siteId: string }
  | { kind: "artifact"; siteId: string; op: ArtifactOp }
  | { kind: "ask"; siteId: string }
  /** Phase marker: no site id; carries the trimmed name (an absent name degrades to void undefined). */
  | { kind: "phase"; name: string | undefined }
  | { kind: "report"; siteId: string }
  | { kind: "world-read"; siteId: string; op: WorldReadOp };

/**
 * Convenience entry: compile + facade-siting check + site table + lower, isomorphic to analyzeWorkflowScript.
 * Dirty scripts (typecheck or facade-siting errors) do not lower -- lowering runs on clean programs only.
 */
export function lowerWorkflowScript(scriptText: string): LowerResult {
  const workflow = createWorkflowProgram(scriptText);
  const diagnostics = collectDiagnostics(workflow.program);
  if (diagnostics.length > 0) return { diagnostics, ok: false };

  const table = collectSites(workflow);
  const misuse = collectFacadeMisuse(workflow, table);
  if (misuse.length > 0) return { diagnostics: misuse, ok: false };

  return { diagnostics, lowered: lowerWorkflow(workflow, table), ok: true };
}

/**
 * Core: degrade an already-analyzed clean workflow.
 * Site calls (ask/actor/world-read) match by **ts.Node identity** (the raw call refs the site table holds),
 * never by re-recognizing name/shape -- that would mint a second truth. The log call is not in the site table; it is
 * recognized via checker signature resolution (into the facade d.ts, the same mechanism as sites.ts) -- identity, not name heuristics.
 */
export function lowerWorkflow(workflow: WorkflowProgram, table: SiteTable): LoweredWorkflow {
  const checker = workflow.program.getTypeChecker();
  const siteMap = buildSiteMap(table);

  // Pass 1, instrumentation: transform over the same script file (the site table references its nodes),
  // so site-table hits work by node identity; types not yet erased.
  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const { factory } = context;
    const hostMember = (name: string): ts.Expression =>
      factory.createPropertyAccessExpression(factory.createIdentifier(HOST_BINDING), name);
    const siteArg = (id: string): ts.Expression => factory.createStringLiteral(id);

    const visit: ts.Visitor = (node) => {
      // args is the only facade **value** rather than callable, hence the only identifier-level rewrite:
      // reading it is not a wait point -- no site, no causal graph. Detected via checker resolution
      // (the same mechanism as site identity), so a script-local args resolves to the script symbol and stays.
      //
      // Deliberately **not** injecting a const binding into the wrapper body: a user-declared
      // args would become a runtime duplicate-declaration SyntaxError, invisible at compile time.
      if (ts.isIdentifier(node) && node.text === "args" && isFacadeArgsRead(node, checker)) {
        return hostMember("args");
      }
      if (ts.isCallExpression(node)) {
        const emit = siteMap.get(node);
        if (emit !== undefined) return lowerSited(node, emit);
        // A non-site facade call can only be log (the others always become sites, already in the map).
        const name = facadeCalleeName(node, checker);
        if (name === "log") {
          return factory.createCallExpression(
            hostMember("log"),
            undefined,
            node.arguments.map(visitExpr),
          );
        }
      }
      return ts.visitEachChild(node, visit, context);
    };

    const visitExpr = (expr: ts.Expression): ts.Expression =>
      ts.visitNode(expr, visit) as ts.Expression;

    const lowerSited = (call: ts.CallExpression, emit: SiteEmit): ts.Expression => {
      if (emit.kind === "phase") {
        // phase marker -> host enterPhase. Still **no site, no journal row** -- not a unit of work; but the engine must
        // see that control flow passed (one phase-entered event), else a nodeless phase is an empty circle on the timeline forever.
        // The name is trimmed, the same key the analyzer mints phase ids from; an absent name (non-literal,
        // which the 9004 diagnostic should have caught) degrades to void undefined -- no free phase identifier may remain in the sandbox.
        const name = emit.name?.trim();
        if (name === undefined || name.length === 0) return factory.createVoidZero();
        return factory.createCallExpression(hostMember("enterPhase"), undefined, [
          factory.createStringLiteral(name),
        ]);
      }
      if (emit.kind === "actor") {
        // agent(name?, persona?) -> __host.createActor(siteId, name?, persona?)
        return factory.createCallExpression(hostMember("createActor"), undefined, [
          siteArg(emit.siteId),
          ...call.arguments.map(visitExpr),
        ]);
      }
      if (emit.kind === "ask") {
        // receiver.ask(instr) -> host ask(siteId, receiver, instr) (the type argument dropped).
        // facade-siting guarantees ask is a direct property call, so the callee is a property access.
        const access = call.expression as ts.PropertyAccessExpression;
        const receiver = visitExpr(access.expression);
        const loweredAsk = (recv: ts.Expression): ts.Expression =>
          factory.createCallExpression(hostMember("ask"), undefined, [
            siteArg(emit.siteId),
            recv,
            ...call.arguments.map(visitExpr),
          ]);
        if (!ts.isOptionalChain(call)) return loweredAsk(receiver);
        // An ask on an optional chain cannot be unconditionally rewritten to
        // the host form -- the optional short-circuit would be lost. With a nullish receiver the author semantics are
        // skip-this-ask and chain-undefined, and a lowered undefined reaching the engine
        // fails the whole run as UnknownActor -- and only when the optional branch is truly empty,
        // possibly after burning a long run. Rewrite as a nullish-guard ternary: on guard hit the args are not evaluated,
        // matching optional-chain semantics; an identifier receiver is re-read (side-effect free), any other expression goes
        // through a hoisted temp evaluated exactly once -- isomorphic to the tsc optional-chain lowering.
        const once = ts.isIdentifier(receiver)
          ? receiver
          : factory.createTempVariable(context.hoistVariableDeclaration);
        const evaluated = once === receiver ? receiver : factory.createAssignment(once, receiver);
        const isNullish = factory.createBinaryExpression(
          factory.createBinaryExpression(
            evaluated,
            factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
            factory.createNull(),
          ),
          factory.createToken(ts.SyntaxKind.BarBarToken),
          factory.createBinaryExpression(
            once,
            factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
            factory.createIdentifier("undefined"),
          ),
        );
        return factory.createConditionalExpression(
          isNullish,
          factory.createToken(ts.SyntaxKind.QuestionToken),
          factory.createIdentifier("undefined"),
          factory.createToken(ts.SyntaxKind.ColonToken),
          loweredAsk(once),
        );
      }
      if (emit.kind === "artifact") {
        // artifact.file(id, path, opts)  -> __host.publishArtifact(siteId, "file", [id, path, opts])
        // artifact.chart(id, spec)       -> __host.declareArtifact(siteId, "chart", [id, spec])
        // The two families are same-shape-different-name: names differ because the return types differ (promise vs void), and
        // the engine dispatches by method name, not op -- a script awaiting a declaration as an effect should be
        // stopped at the type layer, not handed a runtime undefined. Args as in world-read: packed by position
        // verbatim; lowering ignores op and arity (validation belongs to the engine and driver).
        const member = isArtifactPresetOp(emit.op) ? "declareArtifact" : "publishArtifact";
        return factory.createCallExpression(hostMember(member), undefined, [
          siteArg(emit.siteId),
          factory.createStringLiteral(emit.op),
          factory.createArrayLiteralExpression(call.arguments.map(visitExpr)),
        ]);
      }
      if (emit.kind === "report") {
        // report(item, artifactId?) -> __host.report(siteId, item, artifactId?)
        // report goes through the **site map**, not the checker-name log path below: it is
        // sited (the journal dedupes replay by site x ordinal), and site identity lives only in the site table.
        return factory.createCallExpression(hostMember("report"), undefined, [
          siteArg(emit.siteId),
          ...call.arguments.map(visitExpr),
        ]);
      }
      // files.glob(arg)/files.read(arg) -> __host.worldRead(siteId, op, [arg])
      // Args are packed **verbatim by position** into an array literal: no op peeking, no arity check, no validation. Per-op arity/arg checks belong to the driver,
      // so adding a world-read primitive is a zero-touch change in this pass.
      return factory.createCallExpression(hostMember("worldRead"), undefined, [
        siteArg(emit.siteId),
        factory.createStringLiteral(emit.op),
        factory.createArrayLiteralExpression(call.arguments.map(visitExpr)),
      ]);
    };

    return (sourceFile) => ts.visitNode(sourceFile, visit) as ts.SourceFile;
  };

  const result = ts.transform(workflow.scriptFile, [transformer]);
  const transformed = result.transformed[0];
  if (transformed === undefined) throw new Error("lowering: transform produced no source file");

  // Take only the body statements of the workflow script (wrapper/facade/exports never enter the lowered code).
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });
  const instrumented = workflowBody(transformed)
    .map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, transformed))
    .join("\n");
  result.dispose();

  // Pass 2, type erasure: stubbing done, node identity no longer needed -- text-level transpile erasure suffices.
  const code = ts.transpileModule(instrumented, {
    compilerOptions: {
      isolatedModules: false,
      module: ts.ModuleKind.ESNext,
      newLine: ts.NewLineKind.LineFeed,
      removeComments: false,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: false,
  }).outputText;

  return { code, siteIds: sourceOrderSiteIds(table) };
}

/**
 * The four site-call kinds + phase markers, as a call-expression-to-emit map
 * (matched by node identity). Phase rides this map for node identity and name -- it has no site id, hence
 * never enters the source-order id list.
 */
function buildSiteMap(table: SiteTable): Map<ts.CallExpression, SiteEmit> {
  const map = new Map<ts.CallExpression, SiteEmit>();
  for (const site of table.actors) map.set(site.call, { kind: "actor", siteId: site.id });
  for (const site of table.artifacts) {
    map.set(site.call, { kind: "artifact", op: site.op, siteId: site.id });
  }
  for (const site of table.asks) map.set(site.call, { kind: "ask", siteId: site.id });
  for (const marker of table.phases) map.set(marker.call, { kind: "phase", name: marker.name });
  for (const site of table.reports) map.set(site.call, { kind: "report", siteId: site.id });
  for (const site of table.worldReads) {
    map.set(site.call, { kind: "world-read", op: site.op, siteId: site.id });
  }
  return map;
}

/** Stubbed site ids in source order (the site-table global discovery order). */
function sourceOrderSiteIds(table: SiteTable): string[] {
  const sited = [
    ...table.actors,
    ...table.artifacts,
    ...table.asks,
    ...table.reports,
    ...table.worldReads,
  ];
  return sited.sort((a, b) => a.order - b.order).map((site) => site.id);
}

/** Locate the workflow-script body statements post-transform (same shape as the sites.ts helper). */
function workflowBody(sourceFile: ts.SourceFile): ts.NodeArray<ts.Statement> {
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === WORKFLOW_FUNCTION_NAME &&
      statement.body !== undefined
    ) {
      return statement.body.statements;
    }
  }
  throw new Error(`lowering: ${WORKFLOW_FUNCTION_NAME} not found in transformed source`);
}

/**
  * The facade callable name the call resolves to (via the resolved-signature declaration, inside the facade d.ts),
  * else undefined. Same idea as the sites.ts helper -- identity via signature declaration,
  * not callee spelling, so element accesses resolve too.
  // Only used here to recognize log: site-kind facade calls already hit the map and returned.
 */

/**
 * True iff this `args` identifier is a READ of the facade global (not a shadowing local,
 * not a property name, not a declaration site).
 *
 * Identity comes from the checker, exactly as facade call sites do: a script that writes
 * its own `const args = ...` resolves to a symbol declared in the script file, so it is
 * left alone and keeps shadowing benignly. The syntactic guards below are for positions
 * where an identifier is not a value read at all — `x.args`, `{ args: 1 }`, and the name
 * in `const args = ...` — where rewriting would produce nonsense like `{ __host.args: 1 }`.
 */
function isFacadeArgsRead(node: ts.Identifier, checker: ts.TypeChecker): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent !== undefined) {
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (ts.isQualifiedName(parent) && parent.right === node) return false;
    if (
      (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) &&
      parent.name === node
    ) {
      return false;
    }
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return false;
    if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
    // The declaration site (a const binding, a parameter, an import): building a binding, not reading the facade.
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
  }
  return isFacadeDeclared(resolveSymbol(node, checker));
}

function facadeCalleeName(call: ts.CallExpression, checker: ts.TypeChecker): string | undefined {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration === undefined || declaration.getSourceFile().fileName !== FACADE_FILE_NAME) {
    return undefined;
  }
  const name = (declaration as ts.FunctionDeclaration | ts.MethodSignature).name;
  return name !== undefined && ts.isIdentifier(name) ? name.text : undefined;
}
