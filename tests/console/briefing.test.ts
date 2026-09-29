import { expect, test } from 'vitest';
import { briefing, nodesReading, REWORK_OUTPUT_LIMIT, reworkBriefing } from '../../src/catalog/briefing.ts';
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

test('a dependency artifact is named by artifactId and version so artifact_read needs no lookup', () => {
  const operation = nodeOperation('review');
  operation.dependencySources = {
    'impl-a': [{
      nodeId: 'impl-a', instanceId: 'i', operationId: 'o', activationId: 'a', outputVersion: 1,
      artifacts: [{
        id: 'impl-a-diag-a', path: 'deliverables/impl-a-diag-a', digest: 'c1bf4103ac',
        artifactId: '41c2a46f-13a3-4816-911b-b7602493296c', version: 1,
        uri: 'graph://tasks/task/artifacts/deliverables/impl-a-diag-a@1',
        nodeId: 'impl-a', operationId: 'o', activationId: 'a',
      }],
    }],
  };
  const text = briefing(operation, { request: 'r', acceptance: [], graph: focusedGraph, focus: 'review' });
  // The uri and digest stay (a stable human-readable reference), but the machine key is named too.
  expect(text).toContain('graph://tasks/task/artifacts/deliverables/impl-a-diag-a@1');
  expect(text).toContain('41c2a46f-13a3-4816-911b-b7602493296c@1');
  // Without this line the Agent has to artifact_list first and usually gives up and reads the work copy.
  expect(text).toContain('artifact_read');
});

test('a node that declares a deliverable is told to write the file, and that publishing an artifact is not enough', () => {
  const text = briefing(nodeOperation('review'), { request: 'r', acceptance: [], graph: focusedGraph, focus: 'review' });
  expect(text).toContain('reviews/review.md');
  // The settle refuses a node whose declared file was never written; the briefing must say so up front,
  // because a model otherwise satisfies "shared artifact" by calling artifact_publish and skips the file.
  expect(text).toMatch(/write .*reviews\/review\.md|reviews\/review\.md.*written/i);
  expect(text).toMatch(/publish|artifact_publish/i);
});

/** A real-shaped graph: two sibling lanes, one check that reads the focused lane, one review lane. */
const focusedGraph: NodeSpec[] = [
  { id: 'impl-a', kind: 'agent' as const, action: 'work', role: 'worker', definitionVersion: 'coder@1', model: 'm', input: { files: ['src/a.ts', 'tests/a.test.ts'], focus: '实现 A 的改动' } },
  { id: 'impl-b', kind: 'agent' as const, action: 'work', role: 'worker', definitionVersion: 'coder@1', model: 'm', input: { files: ['src/b.ts'], focus: '实现 B 的改动' } },
  { id: 'check-a', kind: 'program' as const, action: 'graph.command', dependsOn: ['impl-a'], input: { command: 'node', args: ['node_modules/vitest/vitest.mjs', 'run', 'tests/a.test.ts'] } },
  { id: 'check-all', kind: 'program' as const, action: 'graph.command', dependsOn: ['impl-a', 'impl-b'], input: { command: 'node', args: ['--run', 'check'] } },
  { id: 'review', kind: 'agent' as const, action: 'review', role: 'worker', definitionVersion: 'reviewer@1', model: 'm', dependsOn: ['impl-a'], routes: ['pass', 'fail'], input: { route: { declared: null } }, deliverable: { path: 'reviews/review.md', namespace: 'reviews', name: 'review' } },
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

test('the nodes that read a node are found through the graph, not by direct edge only', () => {
  expect(nodesReading('impl-a', focusedGraph).map(node => node.id)).toEqual(['check-a', 'check-all', 'review']);
  expect(nodesReading('review', focusedGraph)).toEqual([]);
});

test('a rework briefing carries the failed evidence instead of the briefing again', () => {
  const text = reworkBriefing({
    attempt: 2,
    evidence: [{ id: 'check-types', label: 'program graph.command', status: 'failed', output: 'x'.repeat(REWORK_OUTPUT_LIMIT + 500) }],
    acceptance: [
      { id: 'a1', description: '类型检查通过', checkNode: 'check-types' },
      { id: 'a2', description: '与这次失败无关的一条', checkNode: 'check-review' },
    ],
    handlePath: '/state/instances/i/rework/impl-a-attempt-2.txt',
  });
  expect(text).toContain('Rework (attempt 2, same session)');
  expect(text).toContain('- check-types (program graph.command, failed):');
  // Only the acceptance this failure blocks is worth repeating; the rest is in the session already.
  expect(text).toContain('Acceptance this evidence blocks:\n- a1 (check check-types): 类型检查通过');
  expect(text).not.toContain('a2');
  expect(text).toContain('[truncated]');
  expect(text).toContain('/state/instances/i/rework/impl-a-attempt-2.txt');
  // None of the briefing body comes back: the session already has it.
  expect(text).not.toContain('Request:');
  expect(text).not.toContain('Task graph');
  expect(text).not.toContain('x'.repeat(REWORK_OUTPUT_LIMIT + 1));
  expect(text).toContain('Your node, its file list and every confirmed check input are unchanged.');
});

test('a rework with no recorded failure says so instead of inventing one', () => {
  const text = reworkBriefing({ attempt: 3, evidence: [], acceptance: [{ id: 'a1', description: 'd', checkNode: 'check-types' }] });
  expect(text).toContain('No downstream evidence is recorded as failed');
  expect(text).not.toContain('Acceptance this evidence blocks');
  expect(text).not.toContain('truncated');
});

// Failure mode (HB-208): an Agent router decides its own branch, but nothing in the briefing said the
// structured result must carry `route`. Live, a reviewer wrote its report and still got refused at
// settle time for a field it was never asked for. The briefing is the one place that must say it.
const routerGraph: NodeSpec[] = [
  { id: 'work', kind: 'agent' as const, action: 'implement', definitionVersion: 'coder@1', model: 'm', input: { objective: 'do it' } },
  { id: 'review', kind: 'agent' as const, action: 'review', definitionVersion: 'reviewer@1', model: 'm', dependsOn: ['work'], routes: ['pass', 'fail'], input: { route: { declared: null }, focus: '只看 work' } },
  { id: 'gate', kind: 'program' as const, action: 'graph.verify', dependsOn: ['review'], input: {}, routes: ['ship', 'fix'], verifier: { kind: 'independent', reportNodes: ['review'] } },
];

test('an Agent router is told its result must carry a route naming a declared branch', () => {
  const text = briefing(nodeOperation('review'), { request: 'r', acceptance: [], graph: routerGraph, focus: 'review' });
  expect(text).toContain('You are a router: your branch is yours to choose from pass, fail.');
  expect(text).toContain('outputJson must include a "route" field whose value is exactly one of: pass, fail');
});

test('a program router gets no such instruction: it maps status or a field, it does not speak for itself', () => {
  const text = briefing(nodeOperation('gate'), { request: 'r', acceptance: [], graph: routerGraph, focus: 'gate' });
  expect(text).not.toContain('Your branch is yours to choose');
  expect(text).not.toContain('outputJson must include a "route"');
});
