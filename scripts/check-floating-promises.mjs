import { API } from 'typescript/unstable/sync';
import { isExpressionStatement } from 'typescript/unstable/ast';

// TypeScript 7 exposes the checker through a sidecar process. This guard only
// needs the syntax tree, so it avoids the slower full type-checking API.
const UNAWAITED_EXPECT = /^\s*\(*\s*expect\s*\([\s\S]*\)\s*\.\s*(?:resolves|rejects)\b/;

function isUnguardedExpectation(text) {
  return UNAWAITED_EXPECT.test(text);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(isUnguardedExpectation('expect(value).resolves.toBe(true)'), 'self-test missed a resolves chain');
assert(isUnguardedExpectation('expect(\n value\n).rejects.toThrow()'), 'self-test missed a multiline rejects chain');
assert(!isUnguardedExpectation('void expect(value).resolves.toBe(true)'), 'self-test rejected an explicitly void promise');

const failures = [];
const api = new API();
let snapshot;

function visit(node, source) {
  if (isExpressionStatement(node) && isUnguardedExpectation(node.getText(source))) {
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
  console.error('Unawaited expect().resolves/.rejects chains found. Await each assertion:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('No unawaited expect().resolves/.rejects chains found.');
