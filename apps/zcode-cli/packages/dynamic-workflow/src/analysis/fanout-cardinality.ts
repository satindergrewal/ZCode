import ts from "typescript";

/**
  * The **literal cardinality** of a fan-out:
  * when the iterated expression is an array literal of unspread elements, or a once-initialized never-written const
  * bound to such a literal, the cardinality is the literal length; otherwise always undefined.
 *
  * This is **mint-time** work (interpret.ts) -- it needs the AST and checker; projections must not re-read code.
  * Rule: prefer absence over guessing -- any doubt yields absence, the handoff graph draws a many card, never a guessed number.
 */
export function literalCardinality(iterated: ts.Expression, checker: ts.TypeChecker): number | undefined {
  const expr = unwrap(iterated);
  if (ts.isArrayLiteralExpression(expr)) return spreadFreeLength(expr);
  if (!ts.isIdentifier(expr)) return undefined;

  const symbol = checker.getSymbolAtLocation(expr);
  const decl = symbol?.valueDeclaration;
  if (symbol === undefined || decl === undefined || !ts.isVariableDeclaration(decl)) return undefined;
  if (!ts.isIdentifier(decl.name)) return undefined;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return undefined;
  if (decl.initializer === undefined) return undefined;
  const init = unwrap(decl.initializer);
  if (!ts.isArrayLiteralExpression(init)) return undefined;
  const length = spreadFreeLength(init);
  if (length === undefined) return undefined;
  return isEverWritten(symbol, decl.getSourceFile(), checker) ? undefined : length;
}

/** (xs), xs as const, xs!, xs satisfies T are all the same array. */
function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else if (ts.isTypeAssertionExpression(current)) current = current.expression;
    else return current;
  }
}

function spreadFreeLength(literal: ts.ArrayLiteralExpression): number | undefined {
  if (literal.elements.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element))) {
    return undefined;
  }
  return literal.elements.length > 0 ? literal.elements.length : undefined;
}

/** In-place array mutators: a binding called through them no longer counts as literal-length. */
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin", "length"]);

/**
  * Whether the binding is written: in-place methods such as xs.push(...), xs[i] = ... / xs[i]++, xs.length = 0,
  * and (though const forbids it) assignment to the name itself. Aliases (const ys = xs; ys.push()) and passing the array
  * into functions are out of scope -- only these three write shapes; anything else would answer absence anyway.
 */
function isEverWritten(symbol: ts.Symbol, file: ts.SourceFile, checker: ts.TypeChecker): boolean {
  let written = false;
  const visit = (node: ts.Node): void => {
    if (written) return;
    if (ts.isIdentifier(node) && node.parent !== undefined && checker.getSymbolAtLocation(node) === symbol) {
      if (isWriteReference(node)) written = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return written;
}

function isWriteReference(id: ts.Identifier): boolean {
  const parent = id.parent;
    // The declaration site itself is not a write.
  if (ts.isVariableDeclaration(parent) && parent.name === id) return false;
  // xs.push(...) / xs.length = 0
  if (ts.isPropertyAccessExpression(parent) && parent.expression === id) {
    const name = parent.name.text;
    if (!MUTATORS.has(name)) return false;
    if (name === "length") return isAssignmentTarget(parent);
    return ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
  }
  // xs[i] = ... / xs[i]++ / delete xs[i]
  if (ts.isElementAccessExpression(parent) && parent.expression === id) return isAssignmentTarget(parent);
    // xs = ... (a type error under const, but still a write)
  return isAssignmentTarget(id);
}

function isAssignmentTarget(node: ts.Expression): boolean {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    const op = parent.operatorToken.kind;
    return op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment;
  }
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken;
  }
  if (ts.isDeleteExpression(parent)) return true;
    // Destructuring assignment targets: [xs[0]] = ... / ({ a: xs[0] } = ...)
  if (ts.isArrayLiteralExpression(parent) || ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) {
    let up: ts.Node = parent;
    while (ts.isArrayLiteralExpression(up) || ts.isObjectLiteralExpression(up) || ts.isPropertyAssignment(up) || ts.isShorthandPropertyAssignment(up) || ts.isSpreadElement(up)) {
      up = up.parent;
    }
    return ts.isBinaryExpression(up) && up.operatorToken.kind === ts.SyntaxKind.EqualsToken && up.left !== undefined && containsNode(up.left, node);
  }
  return false;
}

function containsNode(root: ts.Node, target: ts.Node): boolean {
  return target.pos >= root.pos && target.end <= root.end;
}
