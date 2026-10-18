import { parseModule, type ESTree } from "meriyah";

/**
 * Pure helpers to instrument REPL code (route B: top-level bindings persist across calls).
 *
 * Motivation:
 * NodeReplSession wraps user code in `(async () => {...})()` for top-level await, trapping top-level
 * `const/let/var/function/class` in the IIFE scope, never reaching the persistent vm context. Using meriyah
 * we find top-level declarations and inject `globalThis.<name> = <name>;` after each, copying the bindings
 * into the persistent context, so the next `js` call resolves bare names to globalThis via the scope chain.
 *
 * This module is the A-ready seam: once `--experimental-vm-modules` is viable, upgrading to SourceTextModule (route A)
 * means swapping the executor and writing a harvest-style instrument; `parseReplCode`/`collectTopLevelBindingNames` carry over
 * (parser swaps touch only parseReplCode's internals).
 */

/** parseReplCode result: AST on success, parseError on failure (no throw; the caller falls back). */
export type ParseReplCodeResult = { ast: ESTree.Program } | { parseError: Error };

/**
 * Parse REPL code into an ESTree AST. Wraps meriyah.parseModule (parser swaps touch only here = the A-ready seam).
 * module + latest for newest syntax; ranges give every node start/end (instrument slicing needs them).
 * On failure returns { parseError }, never throwing (callers fall back to verbatim execution).
 */
export function parseReplCode(code: string): ParseReplCodeResult {
  try {
    const ast = parseModule(code, { next: true, ranges: true });
    return { ast };
  } catch (error) {
    return { parseError: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * Recursively collect every identifier declared by a binding pattern.
 * Covers Identifier / ObjectPattern (shorthand and RestElement) / ArrayPattern (holes and RestElement)
 * / AssignmentPattern (defaults) / RestElement.
 */
function collectPatternNames(node: ESTree.Node | null | undefined, out: string[]): void {
  if (!node) {
    // Holes (elisions) in an ArrayPattern are null; skip.
    return;
  }
  switch (node.type) {
    case "Identifier":
      out.push(node.name);
      return;
    case "ObjectPattern":
      for (const prop of node.properties) {
        // In pattern positions meriyah emits RestElement/Property, but its types are wider
        // (ObjectLiteralElementLike includes SpreadElement), so narrow by type one by one.
        const p = prop as ESTree.Node;
        if (p.type === "RestElement") {
          collectPatternNames(p.argument, out);
        } else if (p.type === "Property") {
          // The destructuring target is the value (`{x:xx}`'s xx; shorthand `{x}`'s value is x too).
          collectPatternNames(p.value as ESTree.Node, out);
        } else if (p.type === "SpreadElement") {
          // Defensive: if a pattern is (rarely) typed SpreadElement, collect its argument too.
          collectPatternNames(p.argument as ESTree.Node, out);
        }
      }
      return;
    case "ArrayPattern":
      for (const el of node.elements) {
        collectPatternNames(el, out);
      }
      return;
    case "AssignmentPattern":
      // `const {x = 1} = o` / `const [a = 1] = arr`: the binding name is in left.
      collectPatternNames(node.left, out);
      return;
    case "RestElement":
      collectPatternNames(node.argument, out);
      return;
    default:
      // Non-declaration targets such as MemberExpression (assigning into existing properties) bind nothing; ignore.
      return;
  }
}

/** Collect every binding declared by one top-level declaration statement (for per-statement injection). */
function collectStatementBindingNames(node: ESTree.Node): string[] {
  const names: string[] = [];
  if (node.type === "VariableDeclaration") {
    for (const decl of node.declarations) {
      collectPatternNames(decl.id, names);
    }
  } else if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
    if (node.id) {
      names.push(node.id.name);
    }
  }
  return names;
}

/**
 * Rewrite dynamic import() in the cell to the injected importModule().
 * vm.Script cannot execute import expressions directly, so the executor uses the host loader and replaces only
 * real ImportExpressions in the AST; strings, comments, and import.meta are untouched.
 */
export function collectTopLevelBindingNames(ast: ESTree.Program): string[] {
  const names: string[] = [];
  for (const stmt of ast.body) {
    for (const name of collectStatementBindingNames(stmt)) {
      names.push(name);
    }
  }
  // Dedupe (a name declared twice, or the same name across statements, gets only one assignment).
  return [...new Set(names)];
}

/**
 * Rewrites dynamic `import(...)` in the cell into the injected `importModule(...)`.
 *
 * Node's vm.Script runs import expressions only with a vm module loader configured, and desktop/SEA
 * agents cannot reliably carry `--experimental-vm-modules`. The old contract therefore made the model write ZCode's private
 * `importModule(...)`, inconsistent with the standard `await import(...)` used in skills. AST targeting rewrites only real
 * ImportExpressions; strings, comments, and `import.meta` are untouched.
 */
export function rewriteDynamicImports(code: string, ast: ESTree.Program): string {
  const starts: number[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as { type?: unknown; start?: unknown; range?: unknown };
    if (node.type === "ImportExpression") {
      const start =
        typeof node.start === "number"
          ? node.start
          : Array.isArray(node.range) && typeof node.range[0] === "number"
            ? node.range[0]
            : undefined;
      if (start !== undefined) starts.push(start);
    }
    for (const child of Object.values(value as Record<string, unknown>)) visit(child);
  };
  visit(ast);
  let rewritten = code;
  for (const start of starts.sort((left, right) => right - left)) {
    rewritten = `${rewritten.slice(0, start)}importModule${rewritten.slice(start + "import".length)}`;
  }
  return rewritten;
}

/**
 * Rewrite dynamic imports under REPL syntax. User code may use top-level return, which the module parser forbids; if direct parsing fails,
 * temporarily wrap in an async function solely to obtain reliable AST ranges, then strip the wrapper. No regex fallback, and
 * no false edits inside strings or comments.
 */
export function rewriteDynamicImportsForRepl(code: string): string {
  const direct = parseReplCode(code);
  if ("ast" in direct) return rewriteDynamicImports(code, direct.ast);

  const prefix = "(async () => {\n";
  const suffix = "\n})";
  const wrapped = `${prefix}${code}${suffix}`;
  const wrappedParsed = parseReplCode(wrapped);
  if (!("ast" in wrappedParsed)) return code;
  const rewritten = rewriteDynamicImports(wrapped, wrappedParsed.ast);
  return rewritten.slice(prefix.length, rewritten.length - suffix.length);
}

/** End offset of a node; guaranteed under ranges:true, defaulted only to satisfy type narrowing. */
function nodeEnd(node: ESTree.Node): number {
  const end = node.end ?? node.range?.[1];
  if (end === undefined) {
    throw new Error("instrument requires node end (parseReplCode should set ranges:true)");
  }
  return end;
}

/** Start offset of a node; as nodeEnd, used for the completion-value slice of the last expression statement. */
function nodeStart(node: ESTree.Node): number {
  const start = node.start ?? node.range?.[0];
  if (start === undefined) {
    throw new Error("instrument requires node start (parseReplCode should set ranges:true)");
  }
  return start;
}

/**
 * After each top-level declaration, copy bindings into the persistent context, and turn the last expression statement into a return so the
 * cell's completion value returns. Per-statement injection keeps already-run declarations when a later statement throws.
 */
export function instrumentForContextPersistence(code: string, ast: ESTree.Program): string {
  let cursor = 0;
  let out = "";
  const lastIndex = ast.body.length - 1;
  ast.body.forEach((stmt, index) => {
    // Last top-level expression statement: turn into return so the async-IIFE returns the completion value (the REPL echo).
    // Declaration/control-flow statements stay (their completion value is undefined anyway, matching REPL semantics).
    if (index === lastIndex && stmt.type === "ExpressionStatement") {
      const stmtStart = nodeStart(stmt);
      const stmtEnd = nodeEnd(stmt);
      // meriyah's expression range for `({ value: 1 })` excludes the outer parens.
      // Inserting return at expression.start would emit invalid `(return ({...});)`; bound the rewrite to the full
      // ExpressionStatement and strip only the trailing semicolon.
      const expressionSource = code.slice(stmtStart, stmtEnd).replace(/;\s*$/, "");
      // Keep the original trivia before the statement (whitespace/comments), then wrap the full expression as return (...).
      out += code.slice(cursor, stmtStart);
      out += `return (${expressionSource});`;
      cursor = nodeEnd(stmt);
      return;
    }
    const end = nodeEnd(stmt);
    // Keep the original segment through the statement's end (leading trivia, comments, and the statement).
    out += code.slice(cursor, end);
    cursor = end;
    const names = collectStatementBindingNames(stmt);
    if (names.length > 0) {
      const assigns = names.map((name) => `globalThis.${name}=${name};`).join("");
      out += `;${assigns}`;
    }
  });
  // Keep the trailing original segment after the last statement.
  out += code.slice(cursor);
  return out;
}
