import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ModelEntry } from '../../src/catalog/models.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
const entry = (id: string): ModelEntry => ({ id, provider: 'graph-test', grade: 'high', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', contextWindow: 32_000, maxTokens: 256 });

test('the same definition can dispatch two instances on different models, and a new version does not rebind the running instance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-def-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    models: { entries: [entry('one'), entry('two')], apiKey: 'k', modelRuntime: await (await import('../fixtures/models.ts')).testModelRuntime() },
    actions: {
      work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: { ok: true }, usage }) },
      check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path: join(root, 'a.txt'), digest: 'b'.repeat(64) } }] }) },
    },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'v1');
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Two instances', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Two instances',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'left', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'one' },
      { id: 'right', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'two' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['left', 'right'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  const second = runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'v2');
  expect(second).toMatchObject({ version: 2, key: 'coder@2' });
  await runtime.host.drive();
  const view = await runtime.user.task(taskId).view();
  expect(view.phase).toBe('completed');
  expect(view.nodes.find(node => node.id === 'left')).toMatchObject({ boundDefinition: 'coder@1', selectedModel: 'one' });
  expect(view.nodes.find(node => node.id === 'right')).toMatchObject({ boundDefinition: 'coder@1', selectedModel: 'two' });
  expect(view.nodes.find(node => node.id === 'left')?.instanceId).not.toBe(view.nodes.find(node => node.id === 'right')?.instanceId);
});

test('a restricted capability install records source and version without expanding task grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-cap-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'skill');
  await mkdir(source);
  await writeFile(join(source, 'SKILL.md'), '# Lookup titles');
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root, grants: ['workspace:write'] }] });
  cleanup.push(() => runtime.close());
  const installed = await runtime.catalog.install({ id: 'lookup', kind: 'skill', source, version: '1.0.0', requestId: 'install' });
  expect(installed.path).toContain('capabilities/lookup/1.0.0');
  expect(runtime.catalog.capability('lookup')).toMatchObject({ id: 'lookup', version: '1.0.0', status: 'installed' });
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Use skill', requestId: 'begin' });
  expect((await runtime.user.task(taskId).view()).questions).toEqual([]);
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high', capabilities: [{ id: 'lookup', version: '1.0.0' }] }, 'with-skill');
  expect(runtime.catalog.definitions()).toMatchObject([{ id: 'coder', version: 1 }]);
});
