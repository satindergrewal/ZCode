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
  type HoleSite,
  type SiteTable,
} from "../analysis/sites.js";
import { collectHoleDiagnostics } from "../analysis/hole-sites.js";
import { lowerHoleCall, printHoleBodies, TRANSPILE_OPTIONS } from "./lower-hole.js";

/**
 * Lowering (the instrumentation emit step): lower an already typechecked+analyzed-clean
 * workflow script into sandbox-runnable **JavaScript**. Two things:
 *
 *   1. strip types - the program already typechecked; this is transpile-grade erasure on the same source,
 *   2. stub every facade call with the **static site id** from the site table, rewriting into Boundary A's `__host.*`:
 *        agent(name, persona)        -> __host.createActor("actor#2", name, persona)
 *        planner.ask<Plan>(text)     -> __host.ask("ask#3", planner, text)
 *        maybe?.ask<Plan>(text)      -> maybe === null || maybe === undefined
 *                                         ? undefined : __host.ask("ask#3", maybe, text)
 *                                       (optional-chain short-circuit preserved: nullish receiver skips the ask and
 *                                        argument evaluation; non-identifier receivers evaluate once via a temp)
 *        files.glob(p) / files.read(p)
 *                                    -> __host.worldRead("world-read#1", "glob", [p])
 *                                       __host.worldRead("world-read#2", "read", [p])
 *        report(x)                   -> __host.report("report#1", x)
 *        report(x, "perf")           -> __host.report("report#1", x, "perf")
 *        artifact.file(id, p, o)     -> __host.publishArtifact("artifact#1", "file", [id, p, o])
 *        artifact.chart(id, spec)    -> __host.declareArtifact("artifact#2", "chart", [id, spec])
 *        log(msg)                    -> __host.log(msg)
 *        phase("gate")               -> __host.enterPhase("gate") (no site; the engine emits one event)
 *        model("GLM-5.3-Flash")      -> "GLM-5.3-Flash" (no site, no host call: ModelRef is the name at runtime)
 *        channel<T>("facts")         -> __host.channel("facts") (no site; the queue is built inside the cell)
 *        future(async () => {...})   -> __host.future(async () => {...}) (no site; the cell invokes immediately)
 *        hole<T>(n, p?, body?)       -> __host.hole("hole#1", n, p ?? void 0, (__src) => eval(__src), body?)
 *                                       (lower-hole.ts; filled bodies also go into holeBodies as text)
 *      Join (Promise.all) and fan-out are ordinary in-sandbox promise mechanics, not host calls; kept verbatim.。
 *
 * ————————————————————————————————————————————————————————————————
 * Output contract (the harness contract; wrapping is the sandbox's job):
 * ————————————————————————————————————————————————————————————————
 * {@link LoweredWorkflow.code} is the lowered script's **async function body**: top-level `await` and a trailing
 * `return <artifact>` are both legal, because the harness wraps it in an async function, shaped
 *
 *     const __run = async (__host) => { <code> };
 *
 * That is, the only free identifier in code is `__host` (see {@link HOST_BINDING}) - the facade's
 * `agent` / `log` / `files` / `phase` are all rewritten away; the sandbox vm's globals need
 * only the ES intrinsics plus one `__host`.
 * Schema never crosses the sandbox boundary: the engine looks schemas up by site id from the compile artifacts; code carries none.
 *
 * {@link LoweredWorkflow.siteIds} lists every stubbed facade site id in source order (asks /
 * actors / world-reads / reports / artifacts; `log`/`phase` take no site id, hence absent) - for
 * the harness and tests to assert "every site id appears exactly once".
 *
 * Determinism: printer + transpile are pure; same input in, byte-identical output out.
 */

/** The free identifier the harness must bind for lowered code (Boundary A's host handle). */
export const HOST_BINDING = "__host";

/**
 * Siteless top-level facade functions passed through by name to `__host.<name>(...)`:
 * `log` (progress narrative) and `channel` / `future` (in-sandbox pipeline primitives,
 * docs/dynamic-workflow/authoring.md "Streams"). None has a journal key, so none enters the
 * site table; identity is still checker-resolved against facade declarations.
 */
const HOST_PASSTHROUGH_FUNCTIONS: ReadonlySet<string> = new Set(["log", "channel", "future"]);

/** The lowering product: the sandbox input's JS body plus the list of stubbed site ids. */
export interface LoweredWorkflow {
  /** The lowered script's async body (top-level await / trailing return legal; sole free identifier `__host`). */
  code: string;
  /** Stubbed facade site ids in source order (no log: it has none; holes and their bodies' sites included).
   */
  siteIds: string[];
  /**
   * Per **filled** hole, the body text `(async () => {...})` keyed by site id: printed by the
   * same transform pass and the same parameter erasure as the main body
   * (execution-engine.md "The text that runs"). Open holes absent.
   */
  holeBodies: Record<string, string>;
}

/** Result of {@link lowerWorkflowScript}: analyze-shaped - dirty scripts are not lowered; `lowered` only when `ok`. */
export interface LowerResult {
  diagnostics: CompileDiagnostic[];
  ok: boolean;
  lowered?: LoweredWorkflow;
}

/** Which `__host.*` call each site-table-registered facade call becomes (`phase` has no site id, name only). */
type SiteEmit =
  | { kind: "actor"; siteId: string }
  | { kind: "artifact"; siteId: string; op: ArtifactOp }
  | { kind: "ask"; siteId: string }
  /** Holes: the rewrite reads name / prompt / body, so the whole site rides along (lower-hole.ts).
   */
  | { kind: "hole"; site: HoleSite }
  /** Phase markers: no site id, trimmed name only (nameless markers degrade to `void 0`).
   */
  | { kind: "phase"; name: string | undefined }
  | { kind: "report"; siteId: string }
  | { kind: "world-read"; siteId: string; op: WorldReadOp };

/**
 * Convenience entry: compile + facade-siting check + site-table collection + lower, shaped as
 * `analyzeWorkflowScript`. Dirty scripts (typecheck or facade-siting diagnostics) are not
 * lowered - lowering runs on clean programs only.
 */
export function lowerWorkflowScript(scriptText: string): LowerResult {
  const workflow = createWorkflowProgram(scriptText);
  const diagnostics = collectDiagnostics(workflow.program);
  if (diagnostics.length > 0) return { diagnostics, ok: false };

  const table = collectSites(workflow);
  // The hole rules (9012) share the gate with facade-siting: a non-awaited or fan-out-located
  // hole would lower into a runtime error; the same gate as analyzeWorkflowScript.
  const misuse = [
    ...collectFacadeMisuse(workflow, table),
    ...collectHoleDiagnostics(workflow, table),
  ];
  if (misuse.length > 0) return { diagnostics: misuse, ok: false };

  return { diagnostics, lowered: lowerWorkflow(workflow, table), ok: true };
}

/**
 * The core: lower an already-analyzed-clean workflow into a {@link LoweredWorkflow}.
 * Site calls (ask/actor/world-read) always match by **ts.Node identity** (the raw call references held by the site table),
 * never re-recognized by name/shape - that would mint a second source of truth. `log` stays out of the site table and is identified via the checker's
 * signature resolution (into the facade .d.ts, the same mechanism as sites.ts) - identity, not name heuristics.
 */
export function lowerWorkflow(workflow: WorkflowProgram, table: SiteTable): LoweredWorkflow {
  const checker = workflow.program.getTypeChecker();
  const siteMap = buildSiteMap(table);
  // Filled holes' bodies (the rewritten nodes), printed into holeBodies after the transform.
  const holeBodyNodes = new Map<string, ts.Expression>();

  // Pass one: instrumentation. Transform the same scriptFile (whose nodes the site table references),
  // so site-table hits work by node identity; types not yet erased.
  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const { factory } = context;
    const hostMember = (name: string): ts.Expression =>
      factory.createPropertyAccessExpression(factory.createIdentifier(HOST_BINDING), name);
    const siteArg = (id: string): ts.Expression => factory.createStringLiteral(id);

    const visit: ts.Visitor = (node) => {
      // `args` is the facade's only **value** (not a callable), hence the only identifier-level rewrite:
      // reading it is not a wait point; no site, no causality graph. The test uses checker resolution (same as site
      // identity), so a script-local `args` resolves to the script file's symbol and stays verbatim.
      //
      // Deliberately not "inject const args into the wrapper body": a user-script redeclaration
      // would become a runtime SyntaxError, invisible at compile time.
      if (ts.isIdentifier(node) && node.text === "args" && isFacadeArgsRead(node, checker)) {
        return hostMember("args");
      }
      if (ts.isCallExpression(node)) {
        const emit = siteMap.get(node);
        if (emit !== undefined) return lowerSited(node, emit);
        // Siteless facade calls: log, channel, future (agent/ask/glob/read always become sites, in siteMap).
        // Same rule for all three: identified via checker resolution to facade declarations, rewritten to the
        // same-named __host.*, type args dropped (channel<Fact>(...)), args passed through. channel/future are
        // pure in-sandbox promise mechanics (authoring.md "Streams"): no wire, no journal row, no site id.
        const name = facadeCalleeName(node, checker);
        // model("x") -> "x": ModelRef lives only in the type system; at runtime it is the name string itself
        // (docs/dynamic-workflow/authoring.md "Choosing a model per subagent"); the host looks up the
        // launch-resolved binding table by it. No site, no host call; absent arg (9010 gates) -> void 0.
        if (name === "model") {
          const arg = node.arguments[0];
          return arg === undefined ? factory.createVoidZero() : visitExpr(arg);
        }
        if (name !== undefined && HOST_PASSTHROUGH_FUNCTIONS.has(name)) {
          return factory.createCallExpression(
            hostMember(name),
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
        // phase("gate") -> __host.enterPhase("gate"). Still siteless and journal-row-less - not work; but control
        // flow passing it must be visible to the engine (one phase-entered event), else a nodeless phase is an
        // empty circle on the timeline forever. Name trimmed, the key the analyzer mints phase ids from; absent
        // name (non-literal; 9004 should have caught it) -> void 0 - no free phase may survive in the sandbox.
        const name = emit.name?.trim();
        if (name === undefined || name.length === 0) return factory.createVoidZero();
        return factory.createCallExpression(hostMember("enterPhase"), undefined, [
          factory.createStringLiteral(name),
        ]);
      }
      if (emit.kind === "hole") {
        return lowerHoleCall(
          call,
          emit.site,
          factory,
          hostMember,
          siteArg,
          visitExpr,
          holeBodyNodes,
        );
      }
      if (emit.kind === "actor") {
        // agent(name?, persona?) -> __host.createActor(siteId, name?, persona?)
        return factory.createCallExpression(hostMember("createActor"), undefined, [
          siteArg(emit.siteId),
          ...call.arguments.map(visitExpr),
        ]);
      }
      if (emit.kind === "ask") {
        // receiver.ask<T>(instr) -> __host.ask(siteId, receiver, instr) (type arg <T> dropped).
        // facade-siting guarantees ask is a direct receiver.ask(...) call; the callee is a property access.
        const access = call.expression as ts.PropertyAccessExpression;
        const receiver = visitExpr(access.expression);
        const loweredAsk = (recv: ts.Expression): ts.Expression =>
          factory.createCallExpression(hostMember("ask"), undefined, [
            siteArg(emit.siteId),
            recv,
            ...call.arguments.map(visitExpr),
          ]);
        if (!ts.isOptionalChain(call)) return loweredAsk(receiver);
        // Optional-chained asks (p?.ask(x), wrap?.p.ask(x)) cannot be unconditionally rewritten to
        // __host.ask(siteId, <receiver>, x) - that drops ?.'s short-circuit. With a nullish receiver the
        // author's semantics are "skip this ask, whole chain undefined"; the lowered product would carry
        // undefined into the engine and fail the whole run as UnknownActor - and only when the optional
        // link is empty, possibly after a long stretch. Rewrite as a nullish-guard ternary: on guard hit
        // args are skipped, matching optional chaining; identifier receivers repeat verbatim (side-effect
        // free); any other expression evaluates once via a hoisted temp - like tsc's own lowering.
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
        // Same shape, different names: names differ because the return types differ (promise vs void), and the
        // engine dispatches by method name, not op - a script awaiting a declaration as an effect should be
        // stopped at the type layer, not handed a runtime undefined. Args as in world-read: packed positionally
        // verbatim; lowering reads no op and checks no arity (the engine and driver own that).
        const member = isArtifactPresetOp(emit.op) ? "declareArtifact" : "publishArtifact";
        return factory.createCallExpression(hostMember(member), undefined, [
          siteArg(emit.siteId),
          factory.createStringLiteral(emit.op),
          factory.createArrayLiteralExpression(call.arguments.map(visitExpr)),
        ]);
      }
      if (emit.kind === "report") {
        // report(item, artifactId?) -> __host.report(siteId, item, artifactId?)
        // report goes through the site map, not the checker-name path below: it is
        // sited (journal dedupes replay by site x ordinal), and site identity lives only in the site table.
        return factory.createCallExpression(hostMember("report"), undefined, [
          siteArg(emit.siteId),
          ...call.arguments.map(visitExpr),
        ]);
      }
      // files.glob(arg)/files.read(arg) -> __host.worldRead(siteId, op, [arg])
      // Args are packed positionally verbatim into an array literal: no op read, no arity check, no validation
      // here - each op's arity/validation belongs to the driver, so a new primitive is zero-touch in this pass.
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

  // Take only the __workflowScript__ body statements (wrapper/facade/exports stay out of lowered code).
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });
  const instrumented = workflowBody(transformed)
    .map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, transformed))
    .join("\n");
  const holeBodies = printHoleBodies(holeBodyNodes, printer, transformed);
  result.dispose();

  // Pass two: type erasure. Stubbing is done and node identity is no longer needed; transpile-grade text erasure suffices.
  const code = ts.transpileModule(instrumented, {
    compilerOptions: TRANSPILE_OPTIONS,
    reportDiagnostics: false,
  }).outputText;

  return { code, holeBodies, siteIds: sourceOrderSiteIds(table) };
}

/**
 * The site table's four site-call kinds plus phase markers, as a ts.CallExpression -> SiteEmit
 * map (matched by node identity). phase rides this table for node identity and name - it has no
 * site id, hence stays out of {@link sourceOrderSiteIds}.
 */
function buildSiteMap(table: SiteTable): Map<ts.CallExpression, SiteEmit> {
  const map = new Map<ts.CallExpression, SiteEmit>();
  for (const site of table.actors) map.set(site.call, { kind: "actor", siteId: site.id });
  for (const site of table.artifacts) {
    map.set(site.call, { kind: "artifact", op: site.op, siteId: site.id });
  }
  for (const site of table.asks) map.set(site.call, { kind: "ask", siteId: site.id });
  for (const site of table.holes) map.set(site.call, { kind: "hole", site });
  for (const marker of table.phases) map.set(marker.call, { kind: "phase", name: marker.name });
  for (const site of table.reports) map.set(site.call, { kind: "report", siteId: site.id });
  for (const site of table.worldReads) {
    map.set(site.call, { kind: "world-read", op: site.op, siteId: site.id });
  }
  return map;
}

/** Stubbed site ids in source order (the site table's global order discovery sequence). */
function sourceOrderSiteIds(table: SiteTable): string[] {
  const sited = [
    ...table.actors,
    ...table.artifacts,
    ...table.asks,
    ...table.holes,
    ...table.reports,
    ...table.worldReads,
  ];
  return sited.sort((a, b) => a.order - b.order).map((site) => site.id);
}

/** Locate the transformed __workflowScript__ body statements (same shape as sites.ts's findWorkflowBody). */
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
 * The facade callable name the call resolves to (via the resolved signature's declaration, inside
 * the facade .d.ts), else undefined. Same idea as sites.ts's private facadeCalleeName - identity
 * via signature declaration, not callee spelling, so computed accesses (files["read"](x)) also
 * resolve. This module only uses it for log: site-bearing calls already hit siteMap earlier.
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
    // Declaration positions (const args, param names, import names): those build a binding, not a facade read.
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
