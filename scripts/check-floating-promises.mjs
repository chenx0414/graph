import { API } from 'typescript/unstable/sync';
import { isExpressionStatement } from 'typescript/unstable/ast';
import { SyntaxKind } from 'typescript/unstable/ast';

// TypeScript 7 exposes the checker through a sidecar process. This guard only
// needs the syntax tree, so it avoids the slower full type-checking API.
const UNAWAITED_EXPECT = /^\s*\(*\s*expect\s*\([\s\S]*\)\s*\.\s*(?:resolves|rejects)\b/;

function isUnguardedExpectation(text) {
  return UNAWAITED_EXPECT.test(text);
}

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
const PROMISE_RETURNING_CALLS = /^[\w$.\[\]]*\.(?:saveAgentCombination|updateAgentCombinationDescription|deleteAgentCombination)\s*\(/;

/**
 * Whether a statement's own call drops a promise.
 *
 * Deliberately anchored to the statement's root expression. Matching the whole statement text
 * would flag every `test('...', async () => { const x = await save(...) })`, because the awaited
 * call sits somewhere inside it - a guard that cries wolf on correct code gets switched off.
 * Awaited calls and `void`/`return` do not even reach here: their root expression is not a plain
 * call, so they are skipped rather than special-cased by text.
 */
function isUnguardedPromiseCall(text) {
  return PROMISE_RETURNING_CALLS.test(text);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(isUnguardedPromiseCall('catalog.saveAgentCombination(input)') === true, 'self-test missed an unawaited combination save');
assert(isUnguardedPromiseCall('this.catalog.deleteAgentCombination(id)') === true, 'self-test missed a property-access call');
assert(isUnguardedPromiseCall('catalog.compileAgentCombination(id)') === false, 'self-test flagged a synchronous method');
assert(isUnguardedPromiseCall("test('saving a recipe', async () => { const x = await catalog.saveAgentCombination(r); })") === false, 'self-test flagged an awaited call nested in a test body');
assert(isUnguardedExpectation('expect(value).resolves.toBe(true)'), 'self-test missed a resolves chain');
assert(isUnguardedExpectation('expect(\n value\n).rejects.toThrow()'), 'self-test missed a multiline rejects chain');
assert(!isUnguardedExpectation('void expect(value).resolves.toBe(true)'), 'self-test rejected an explicitly void promise');

const failures = [];
const api = new API();
let snapshot;

/**
 * The expression a statement's promise would be dropped in, or undefined.
 *
 * Only a *plain call* counts. `await x()`, `void x()` and `const y = await x()` have an
 * AwaitExpression, VoidExpression or AwaitExpression here instead, so deliberate forms fall out
 * without a text special-case that could drift.
 */
function rootCall(node) {
  if (isExpressionStatement(node)) return node.kind === SyntaxKind.ExpressionStatement && node.expression.kind === SyntaxKind.CallExpression ? node.expression : undefined;
  if (node.kind === SyntaxKind.VariableDeclaration && node.initializer?.kind === SyntaxKind.CallExpression) return node.initializer;
  return undefined;
}

function visit(node, source) {
  const call = rootCall(node);
  const text = node.getText(source);
  if (call && isUnguardedPromiseCall(call.getText(source))) {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    failures.push(`${source.fileName}:${position.line + 1}:${position.character + 1}`);
  } else if (isExpressionStatement(node) && isUnguardedExpectation(text)) {
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
