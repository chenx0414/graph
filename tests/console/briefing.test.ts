import { expect, test } from 'vitest';
import { briefing } from '../../src/catalog/briefing.ts';
import type { NodeSpec, Operation } from '../../src/core/types.ts';

test('text attachments are included in the master briefing without changing the user message', () => {
  const operation: Operation = {
    id: 'operation', taskId: 'task', nodeId: 'master', instanceId: 'instance', generation: 1,
    attempt: 1, kind: 'agent', action: 'master', input: null, dependencies: {}, proposalVersion: 0,
    requirementVersion: 1,
    context: {
      previousOutput: null,
      answers: [],
      messages: [{
        id: 'message', text: '请查看附件', requirementVersion: 1,
        attachments: [{ name: 'notes.md', type: 'text/markdown', size: 8, text: '# Notes\n' }],
      }],
    },
    grants: [], activationId: 'activation', graphVersion: 0, dependencySources: {}, inputVersions: {},
  };
  const text = briefing(operation, { request: 'request', acceptance: [] });
  expect(text).toContain('User messages:\n- [message] (v1) 请查看附件');
  expect(text).toContain('Attachments supplied by the user');
  expect(text).toContain('notes.md (8 bytes, text/markdown)');
  expect(text).toContain('# Notes');
});

test('Agent recipe descriptions are included in the master catalog for subagent selection', () => {
  const operation: Operation = {
    id: 'operation', taskId: 'task', nodeId: 'master', instanceId: 'instance', generation: 1,
    attempt: 1, kind: 'agent', action: 'master', input: null, dependencies: {}, proposalVersion: 0,
    requirementVersion: 1, context: { previousOutput: null, answers: [] },
    grants: [], activationId: 'activation', graphVersion: 0, dependencySources: {}, inputVersions: {},
  };
  const text = briefing(operation, {
    request: 'request',
    acceptance: [],
    catalog: {
      definitions: ['coder@1'],
      agentCombinations: [{
        id: 'coder',
        name: 'Bob_coder',
        description: '默认主实现，承担功能开发、维护、修复和基础测试。',
        recommendedGrade: 'medium',
        status: 'valid',
      }],
    },
  });
  expect(text).toContain('- Agent recipe coder (Bob_coder, medium, valid): 默认主实现，承担功能开发、维护、修复和基础测试。');
});

/** A real-shaped graph: two sibling lanes, one check that reads the focused lane, one review lane. */
const focusedGraph: NodeSpec[] = [
  { id: 'impl-a', kind: 'agent' as const, action: 'work', role: 'worker', definitionVersion: 'coder@1', model: 'm', input: { files: ['src/a.ts', 'tests/a.test.ts'], focus: '实现 A 的改动' } },
  { id: 'impl-b', kind: 'agent' as const, action: 'work', role: 'worker', definitionVersion: 'coder@1', model: 'm', input: { files: ['src/b.ts'], focus: '实现 B 的改动' } },
  { id: 'check-a', kind: 'program' as const, action: 'graph.command', dependsOn: ['impl-a'], input: { command: 'node', args: ['node_modules/vitest/vitest.mjs', 'run', 'tests/a.test.ts'] } },
  { id: 'check-all', kind: 'program' as const, action: 'graph.command', dependsOn: ['impl-a', 'impl-b'], input: { command: 'node', args: ['--run', 'check'] } },
  { id: 'review', kind: 'agent' as const, action: 'review', role: 'worker', definitionVersion: 'reviewer@1', model: 'm', dependsOn: ['impl-a'] },
];
const nodeOperation = (focus: string): Operation => ({
  id: 'operation', taskId: 'task', nodeId: focus, instanceId: 'instance', generation: 1,
  attempt: 1, kind: 'agent', action: 'work', input: null, dependencies: {}, proposalVersion: 1,
  requirementVersion: 3,
  context: { previousOutput: null, answers: [], messages: [{ id: 'm1', text: '做这两件事', requirementVersion: 3 }] },
  grants: [], activationId: 'activation', graphVersion: 1, dependencySources: {}, inputVersions: {},
});

test('a graph node reads its own line and the checks that read its output, not the whole graph', () => {
  const text = briefing(nodeOperation('impl-a'), {
    request: '实现 A 与 B',
    summary: '实现 A 与 B',
    acceptance: [{ id: 'a1', description: '两种行为都成立', checkNode: 'check-all' }],
    decisions: '不要动 b.ts',
    graph: focusedGraph,
    focus: 'impl-a',
  });
  expect(text).toContain('Your node: impl-a (agent work)');
  expect(text).toContain('files: src/a.ts, tests/a.test.ts');
  expect(text).toContain('focus: 实现 A 的改动');
  // The check's readable form, not the JSON that describes it.
  expect(text).toContain('- check-a: node node_modules/vitest/vitest.mjs run tests/a.test.ts');
  expect(text).toContain('- check-all: node --run check');
  expect(text).toContain('Other lanes (ids only): impl-b, review');
  // A sibling's file list is 4-8 KB of every briefing and the worker must not touch those files anyway.
  expect(text).not.toContain('src/b.ts');
  expect(text).not.toContain('- impl-b (agent work)');
  // What only the master reasons about stays out of a node briefing.
  expect(text).not.toContain('Requirement version');
  expect(text).not.toContain('[m1]');
  expect(text).toContain('User messages:\n- 做这两件事');
  // A summary that only repeats the request is noise; a request copy is what masters actually write.
  expect(text).not.toContain('Summary:');
});

test('a node briefing keeps a summary that says something the request does not', () => {
  const text = briefing(nodeOperation('impl-b'), {
    request: '实现 A 与 B',
    summary: '只改 src/b.ts，A 由兄弟 lane 负责',
    acceptance: [],
    graph: focusedGraph,
    focus: 'impl-b',
  });
  expect(text).toContain('Summary: 只改 src/b.ts，A 由兄弟 lane 负责');
  // impl-b feeds check-all (it depends on both lanes), so this node does read a check.
  expect(text).toContain('Checks that read your output:\n- check-all: node --run check\nOther lanes (ids only): impl-a, check-a, review');
});

test('a node that feeds no check reads no checks block at all', () => {
  const text = briefing(nodeOperation('review'), {
    request: '实现 A 与 B',
    summary: '实现 A 与 B',
    acceptance: [],
    graph: focusedGraph,
    focus: 'review',
  });
  expect(text).toContain('Your node: review (agent review) after impl-a');
  // Absence reads as absence rather than as an empty heading nothing follows.
  expect(text).not.toContain('Checks that read your output');
  expect(text).toContain('Other lanes (ids only): impl-a, impl-b, check-a, check-all');
});

test('the master briefing keeps the full listing, the version and the message anchors', () => {
  const text = briefing(nodeOperation('master'), {
    request: '实现 A 与 B',
    summary: '实现 A 与 B',
    acceptance: [],
    graph: focusedGraph,
  });
  expect(text).toContain('Requirement version: 3');
  expect(text).toContain('User messages:\n- [m1] (v3) 做这两件事');
  expect(text).toContain('- impl-a (agent work)');
  expect(text).toContain('input={"files"');
  expect(text).toContain('- impl-b (agent work)');
});
