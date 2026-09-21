import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { installPresets, loadPresetBootstrap } from '../../src/catalog/presets.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const presetsRoot = fileURLToPath(new URL('../../presets', import.meta.url));

async function runtimeAt(root: string, provider?: Awaited<ReturnType<typeof openaiServer>>) {
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  const bootstrap = await loadPresetBootstrap(presetsRoot);
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }],
    catalog: {
      capabilityRoot: join(root, 'graph', 'capabilities'),
      recipesPath: join(root, 'graph', 'agent-combinations.json'),
      bootstrapPrompts: bootstrap.prompts,
      ...(bootstrap.toolPrompt ? { bootstrapToolPrompt: bootstrap.toolPrompt } : {}),
    },
    actions: {
      check: { kind: 'program' as const, prepare: async () => async () => ({
        outcome: 'completed' as const, output: null,
        evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: join(workspace, 'ok.txt'), digest: 'a'.repeat(64) } }],
      }) },
    },
    ...(provider ? { models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'scripted-local-key', modelRuntime: provider.runtime } } : {}),
  });
  cleanup.push(() => runtime.close());
  return { runtime, workspace, bootstrap };
}

async function taskFor(runtime: Awaited<ReturnType<typeof openTaskRuntime>>, workspace: string) {
  await writeFile(join(workspace, 'note.txt'), 'bootstrap prompt test\n');
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Use bootstrap', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Use bootstrap',
    acceptance: [{ id: 'ok', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  return runtime.user.task(taskId);
}

test('presets publish only immutable Graph bootstrap definitions and prompts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-presets-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const { runtime, bootstrap } = await runtimeAt(root);
  const masterPrompt = bootstrap.prompts.master ?? '';
  expect(masterPrompt).toContain('You are the Master Agent for one Graph feature task.');
  expect(masterPrompt).not.toContain('# Master Agent identity');
  expect(masterPrompt.trimStart().startsWith('You are the Master Agent for one Graph feature task.')).toBe(true);
  expect(bootstrap).not.toHaveProperty('toolPrompt');
  expect(bootstrap).not.toHaveProperty('agentDocs');
  const first = await installPresets(runtime.catalog, presetsRoot);
  expect(first).toMatchObject({ available: true, failed: [] });
  expect(first.installed).toEqual(['master', 'coder', 'reviewer', 'tester']);
  expect(runtime.catalog.capabilities()).toEqual([]);
  expect(runtime.catalog.definitions().map(item => `${item.id}@${item.version}`)).toEqual([
    'coder@1', 'master@1', 'reviewer@1', 'tester@1',
  ]);
  const second = await installPresets(runtime.catalog, presetsRoot);
  expect(second.installed).toEqual(first.installed);
  expect(runtime.catalog.definitions().map(item => `${item.id}@${item.version}`)).toEqual([
    'coder@1', 'master@1', 'reviewer@1', 'tester@1',
  ]);
});

test('the bootstrap prompts are injected without creating user capabilities', async () => {
  const provider = await openaiServer([{ text: 'Acknowledged.' }]);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-presets-worker-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const { runtime, workspace } = await runtimeAt(root, provider);
  await installPresets(runtime.catalog, presetsRoot);
  const task = await taskFor(runtime, workspace);
  await runtime.host.drive();
  const request = JSON.stringify(provider.requests[0]);
  expect(request).toContain('You are the work Agent in Graph.');
  expect(request).not.toContain('Capability awareness');
  expect(request).not.toContain('skill-implement-and-verify');
  expect((await task.view()).nodes.find(node => node.id === 'work')).toMatchObject({ status: 'succeeded' });
});
