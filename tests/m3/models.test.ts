import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import type { ModelEntry } from '../../src/catalog/models.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 };

function entry(id: string, extra: Partial<ModelEntry> = {}): ModelEntry {
  return { id, provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', contextWindow: 32_000, maxTokens: 256, ...extra };
}

test('a Pi agent records one invocation per request, restores the session, and does not treat unknown prices as zero', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-pi-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer([{ text: 'Implemented the briefing' }]);
  cleanup.push(() => provider.close());
  const options = {
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    models: { entries: [entry('local', { baseUrl: provider.model.baseUrl })], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
  };
  let runtime = await openTaskRuntime(options);
  cleanup.push(async () => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'def-1');
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Ship the feature', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Ship the feature',
    acceptance: [{ id: 'works', description: 'Feature works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.runReady();
  const before = await task.view();
  expect(before.nodes.find(node => node.id === 'work')).toMatchObject({ selectedModel: 'local', boundDefinition: 'coder@1', used: 50 });
  expect(before.invocations).toHaveLength(1);
  expect(before.invocations[0]).toMatchObject({ instanceId: before.nodes[0]!.instanceId, model: 'local' });
  expect(before.cost).toEqual({ unknown: true });
  expect(before.operations[0]?.context.briefing).toContain('Feature works');
  expect(provider.requests).toHaveLength(1);
  const instanceId = before.nodes[0]!.instanceId;
  await runtime.close();
  runtime = await openTaskRuntime({
    ...options,
    actions: { check: { kind: 'program', prepare: async operation => async () => {
      expect(operation.context.briefing).toContain('Ship the feature');
      return { outcome: 'completed', output: { passed: true }, evidence: [{ acceptanceId: 'works', summary: 'Checked', artifact: { path: join(root, 'ok.txt'), digest: 'a'.repeat(64) } }] };
    } } },
  });
  await runtime.host.runReady();
  const restored = await runtime.user.task(taskId).view();
  expect(restored.nodes.find(node => node.id === 'work')?.instanceId).toBe(instanceId);
  expect(restored.phase).toBe('completed');
});

test('review excludes the implementer model and missing candidates become a durable problem', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-review-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    models: { entries: [entry('writer'), entry('reader', { grade: 'high' })], preferences: { high: ['writer'] }, apiKey: 'k', modelRuntime: await (await import('../fixtures/models.ts')).testModelRuntime() },
    actions: {
      work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: { done: true }, usage }) },
      review: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: { ok: true }, usage }) },
      check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path: join(root, 'a.txt'), digest: 'b'.repeat(64) } }] }) },
    },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Review', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Review',
    acceptance: [{ id: 'works', description: 'Reviewed', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'writer' },
      { id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'writer', dependsOn: ['work'] },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['review'] },
    ],
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.runReady();
  await runtime.host.runReady();
  const view = await task.view();
  expect(view.nodes.find(node => node.id === 'work')?.selectedModel).toBe('writer');
  expect(view.nodes.find(node => node.id === 'review')?.selectedModel).toBe('reader');
});

test('a review with no remaining candidate opens a durable model problem', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-none-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    models: { entries: [entry('writer')], apiKey: 'k', modelRuntime: await (await import('../fixtures/models.ts')).testModelRuntime() },
    actions: {
      work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: { done: true }, usage }) },
    },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Review', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Review',
    acceptance: [{ id: 'works', description: 'Reviewed', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'writer' },
      { id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'writer', dependsOn: ['work'] },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['review'] },
    ],
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.runReady();
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  expect((await task.view()).questions).toMatchObject([{ kind: 'model_unavailable', nodeId: 'review' }]);
});

test('a requested missing model is replaced from the same grade without changing the instance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-switch-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    models: { entries: [entry('backup')], preferences: { high: ['backup'] }, apiKey: 'k', modelRuntime: await (await import('../fixtures/models.ts')).testModelRuntime() },
    actions: {
      work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: null, usage }) },
      check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path: join(root, 'a.txt'), digest: 'b'.repeat(64) } }] }) },
    },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Switch', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Switch',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'gone' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  const view = await runtime.user.task(taskId).view();
  expect(view.nodes[0]).toMatchObject({ selectedModel: 'backup', instanceId: view.nodes[0]!.instanceId });
  expect(view.phase).toBe('completed');
});
