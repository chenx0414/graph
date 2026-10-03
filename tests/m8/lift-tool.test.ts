import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Issue #1 HB-297: the migration tool itself is tested.
 *
 * `scripts/lift-v2-test-proposals.py` rewrites the setup of ~70 test files, so a silent gap
 * in it is expensive and invisible: the files it misses simply keep failing as "old shape"
 * with nothing obviously wrong in them. That is exactly what happened - the
 * `propose(graph({...}))` shape was missed, and the affected files looked like a product
 * problem rather than a tool problem.
 *
 * Every call shape the suite actually uses is pinned here, plus the property that matters
 * most: assertions are never touched.
 *
 * Failure modes first (R24):
 *   T1  an inline object literal is wrapped and its assertions survive verbatim
 *   T2  a variable argument is wrapped
 *   T3  a factory call argument is wrapped - the shape that was originally missed
 *   T4  a multi-line argument with nested braces and strings is wrapped correctly
 *   T5  the file's assertion lines are byte-identical before and after
 */

const script = join(import.meta.dirname, '..', '..', 'scripts', 'lift-v2-test-proposals.py');

const run = (source: string) => {
  const root = mkdtempSync(join(tmpdir(), 'graph-lift-tool-'));
  const file = join(root, 'sample.test.ts');
  writeFileSync(file, source);
  const out = execFileSync('python3', [script, file], { encoding: 'utf8' });
  const after = readFileSync(file, 'utf8');
  rmSync(root, { recursive: true, force: true });
  return { report: out.trim(), after };
};

const header = "import { openTaskRuntime } from '../../src/core/task-runtime.ts';\n";

const assertions = [
  "  expect(dispatched).toBe(1);",
  "  expect(nodes.map(n => n.id)).toEqual(['a', 'b']);",
].join('\n');

const beforeAssertions = (src: string) => src.split('\n').filter(l => l.trim().startsWith('expect(')).join('\n');

test('T1/T5: an inline object literal is wrapped and every assertion survives verbatim', () => {
  const source = [
    header,
    "test('one', async () => {",
    "  await runtime.supervisor(taskId).propose({ requirementVersion: 1, summary: 's',",
    "    acceptance: [{ id: 'ok', description: 'd', checkNode: 'check' }],",
    "    nodes: [{ id: 'a', kind: 'agent', action: 'a', definitionVersion: 'coder@1', model: 'm' }],",
    "  }, 'draft');",
    assertions,
    "});",
  ].join('\n');
  const { report, after } = run(source);
  expect(report).toContain('lifted(1)');
  expect(after).toContain('withLiftedDefinition({');
  expect(after).toContain('as Proposal');
  expect(beforeAssertions(after)).toBe(beforeAssertions(source));
});

test('T2: a variable argument is wrapped', () => {
  const source = [
    header,
    "test('two', async () => {",
    "  const spec = { nodes: [] };",
    "  await runtime.supervisor(taskId).propose(spec, 'draft');",
    assertions,
    "});",
  ].join('\n');
  const { report, after } = run(source);
  expect(report).toContain('lifted(1)');
  expect(after).toContain('propose(withLiftedDefinition(spec)');
});

test('T3: a factory call argument is wrapped - the shape originally missed', () => {
  const source = [
    header,
    "test('three', async () => {",
    "  await runtime.supervisor(taskId).propose(graph({ path: 'a.md', name: 'a' }), 'draft');",
    assertions,
    "});",
  ].join('\n');
  const { report, after } = run(source);
  expect(report).toContain('lifted(1)');
  expect(after).toContain("propose(withLiftedDefinition(graph({ path: 'a.md', name: 'a' }))");
});

test('T4: a multi-line argument with nested braces and a template string is wrapped whole', () => {
  const source = [
    header,
    "test('four', async () => {",
    "  await runtime.supervisor(taskId).propose(graph({",
    "    path: 'a.md',",
    "    title: `line ${n}`,",
    "    meta: { nested: { deep: true } },",
    "  }), 'draft');",
    assertions,
    "});",
  ].join('\n');
  const { report, after } = run(source);
  expect(report).toContain('lifted(1)');
  expect(after).toContain('withLiftedDefinition(graph({');
  // The trailing requestId must survive OUTSIDE the wrapper, and the object's own closing
  // brace plus the factory call's paren must both be there: .
  expect(after).toContain("})), 'draft');");
  expect(after).not.toContain("'draft'), 'draft');");
  expect(beforeAssertions(after)).toBe(beforeAssertions(source));
});

test('the tool refuses a file with no propose call rather than editing it', () => {
  const { report, after } = run([header, "test('none', () => { expect(1).toBe(1); });"].join('\n'));
  expect(report).toContain('no-propose');
  expect(after).toBe([header, "test('none', () => { expect(1).toBe(1); });"].join('\n'));
});