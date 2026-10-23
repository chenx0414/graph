import { API } from 'typescript/unstable/sync';
import { isExpressionStatement } from 'typescript/unstable/ast';
import { SyntaxKind } from 'typescript/unstable/ast';

// TypeScript 7 exposes the checker through a sidecar process. This guard only
// needs the syntax tree, so it avoids the slower full type-checking API.

/**
 * Methods that return a promise while their neighbours do not.
 *
 * A missing `await` here is invisible: the value looks usable, `JSON.stringify` of it prints `{}`,
 * and the failure only shows up later as "the thing I saved is not there". The type does not catch
 * it either, because passing a promise to a function that takes `unknown` (a logger, JSON, a test
 * assertion) is legal. So the names are listed and the call shape is checked mechanically.
 *
 * Keep this list to APIs whose callers cannot tell a promise from a value.
 */
const PROMISE_RETURNING_METHODS = new Set([
  'saveAgentCombination', 'updateAgentCombinationDescription', 'deleteAgentCombination',
]);

/** The two properties that turn an assertion about a promise into a promise itself. */
const PROMISE_EXPECTATIONS = new Set(['resolves', 'rejects']);

/** Binary operators whose left operand's value is discarded, so a call there drops its promise too. */
const DISCARDING_OPERATORS = new Set([SyntaxKind.AmpersandAmpersandToken, SyntaxKind.BarBarToken, SyntaxKind.CommaToken]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Self-test on the node shapes the checks branch on.
const identifier = text => ({ kind: SyntaxKind.Identifier, text });
const method = (expression, name) => ({ kind: SyntaxKind.PropertyAccessExpression, expression, name: identifier(name) });
const call = expression => ({ kind: SyntaxKind.CallExpression, expression });
const statement = expression => ({ kind: SyntaxKind.ExpressionStatement, expression });
const declaration = expression => ({ kind: SyntaxKind.VariableDeclaration, initializer: expression });
const awaitOf = expression => ({ kind: SyntaxKind.AwaitExpression, expression });
const voidOf = expression => ({ kind: SyntaxKind.VoidExpression, expression });
const wrapped = expression => ({ kind: SyntaxKind.ParenthesizedExpression, expression });
const sequence = (left, kind) => ({ kind: SyntaxKind.BinaryExpression, operatorToken: { kind }, left });
const saved = call(method(identifier('catalog'), 'saveAgentCombination'));
const resolves = call(method(method(call(identifier('expect')), 'resolves'), 'toBe'));

assert(rootCall(statement(saved)) === saved, 'self-test missed the call a statement drops');
assert(rootCall(declaration(saved)) === saved, 'self-test missed the call a declaration drops');
assert(rootCall(statement(wrapped(saved))) === saved, 'self-test missed a parenthesized dropped call');
assert(rootCall(statement(awaitOf(saved))) === undefined, 'self-test flagged an awaited call');
assert(rootCall(statement(voidOf(saved))) === undefined, 'self-test flagged an explicitly void promise');
assert(rootCall(statement(wrapped(voidOf(saved)))) === undefined, 'self-test flagged a void promise inside parentheses');
assert(rootCall(declaration(awaitOf(saved))) === undefined, 'self-test flagged an awaited call nested in a test body');
assert(rootCall(statement(sequence(saved, SyntaxKind.AmpersandAmpersandToken))) === saved, 'self-test missed a call dropped on the left of &&');
assert(rootCall(statement(sequence(saved, SyntaxKind.CommaToken))) === saved, 'self-test missed a call dropped on the left of a sequence');
assert(rootCall(statement(sequence(identifier('done'), SyntaxKind.BarBarToken))) === undefined, 'self-test flagged an operand that is not a call');
assert(dropsPromiseCall(rootCall(statement(sequence(call(identifier('log')), SyntaxKind.BarBarToken)))) === false, 'self-test flagged a plain call on the left of ||');

assert(dropsPromiseCall(saved) === true, 'self-test missed an unawaited combination save');
assert(dropsPromiseCall(call(method(method(identifier('this'), 'catalog'), 'deleteAgentCombination'))) === true, 'self-test missed a property-access call');
assert(dropsPromiseCall(call(method(identifier('catalog'), 'compileAgentCombination'))) === false, 'self-test flagged a synchronous method');
assert(dropsPromiseCall(call(method(saved, 'then'))) === true, 'self-test missed a method whose promise is consumed by .then');
assert(dropsPromiseCall(call(method(identifier('catalog'), 'saveOther'))) === false, 'self-test flagged a method outside the list');
assert(dropsExpectation(resolves) === true, 'self-test missed a resolves chain');
assert(dropsExpectation(call(method(method(call(identifier('expect')), 'rejects'), 'toThrow'))) === true, 'self-test missed a rejects chain');
assert(dropsExpectation(call(method(call(identifier('expect')), 'toBe'))) === false, 'self-test flagged a plain assertion');
assert(dropsExpectation(call(method(call(method(call(identifier('other')), 'resolves')), 'toBe'))) === false, 'self-test flagged a chain that is not an assertion');

/**
 * The call whose promise a statement drops, or undefined.
 *
 * A statement's or a declaration's own expression, when that expression is a plain call. `await x()`
 * and `void x()` wrap the call in an AwaitExpression or a VoidExpression, `return x()` hands it to the
 * caller and `x().then(...)` consumes it - none of those is a bare call, so none reaches the checks
 * below. Parentheses and the left side of `&&`, `||` and `,` discard a value exactly as a bare
 * statement does, so those are stepped through too.
 */
function rootCall(node) {
  const expression = isExpressionStatement(node) ? node.expression : node.kind === SyntaxKind.VariableDeclaration ? node.initializer : undefined;
  let bare = expression;
  for (;;) {
    if (bare?.kind === SyntaxKind.ParenthesizedExpression) { bare = bare.expression; continue; }
    if (bare?.kind === SyntaxKind.BinaryExpression && DISCARDING_OPERATORS.has(bare.operatorToken.kind)) { bare = bare.left; continue; }
    break;
  }
  return bare?.kind === SyntaxKind.CallExpression ? bare : undefined;
}

/** The property accesses a call reaches its method through, outermost first: `a.b.save(x).then(y)` reads then, b, save. */
function* calleePath(callNode) {
  for (let node = callNode; node;) {
    if (node.kind === SyntaxKind.CallExpression || node.kind === SyntaxKind.ParenthesizedExpression || node.kind === SyntaxKind.ElementAccessExpression) {
      node = node.expression;
      continue;
    }
    if (node.kind === SyntaxKind.PropertyAccessExpression) {
      yield node;
      node = node.expression;
      continue;
    }
    return;
  }
}

/** Whether the call runs one of the promise-returning methods and nobody is waiting on it. */
function dropsPromiseCall(callNode) {
  for (const access of calleePath(callNode)) {
    if (PROMISE_RETURNING_METHODS.has(access.name.text)) return true;
  }
  return false;
}

/** Whether the call asserts on a promise - `expect(x).resolves` / `.rejects` - and drops the result. */
function dropsExpectation(callNode) {
  for (const access of calleePath(callNode)) {
    const base = access.expression;
    if (PROMISE_EXPECTATIONS.has(access.name.text)
      && base.kind === SyntaxKind.CallExpression
      && base.expression.kind === SyntaxKind.Identifier
      && base.expression.text === 'expect') {
      return true;
    }
  }
  return false;
}

const failures = [];
const api = new API();
let snapshot;

function visit(node, source) {
  const callNode = rootCall(node);
  if (callNode && (dropsPromiseCall(callNode) || dropsExpectation(callNode))) {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    failures.push(`${source.fileName}:${position.line + 1}:${position.character + 1}`);
  }
  node.forEachChild(child => visit(child, source));
}

try {
  snapshot = api.updateSnapshot({ openProjects: ['tsconfig.json'] });
  const project = snapshot.getProjects()[0];
  if (!project) throw new Error('TypeScript project tsconfig.json was not found');

  for (const fileName of project.rootFiles) {
    const source = project.program.getSourceFile(fileName);
    if (source) visit(source, source);
  }
} finally {
  snapshot?.dispose();
  api.close();
}

if (failures.length) {
  console.error('Unawaited promises found. Await each one (or write `void` to mean fire-and-forget):');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('No unawaited expect().resolves/.rejects chains found.');