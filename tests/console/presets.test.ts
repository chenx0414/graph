import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { installPresets } from '../../src/catalog/presets.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const presetsRoot = fileURLToPath(new URL('../../presets', import.meta.url));

async function runtimeAt(root: string, provider?: Awaited<ReturnType<typeof openaiServer>>) {
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }],
    actions: {
      check: { kind: 'program' as const, prepare: async () => async () => ({
        outcome: 'completed' as const, output: null,
        evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: join(workspace, 'ok.txt'), digest: 'a'.repeat(64) } }],
      }) },
    },
    ...(provider ? { models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'scripted-local-key', modelRuntime: provider.runtime } } : {}),
  });
  cleanup.push(() => runtime.close());
  return { runtime, workspace };
}

async function taskFor(runtime: Awaited<ReturnType<typeof openTaskRuntime>>, workspace: string, definitionVersion = 'coder@1') {
  await writeFile(join(workspace, 'note.txt'), 'preset-marker appears in this line\n');
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Use presets', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Use presets',
    acceptance: [{ id: 'ok', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion, model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  return runtime.user.task(taskId);
}

test('presets install idempotently and upgrades publish new versions without touching old ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-presets-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const { runtime } = await runtimeAt(root);
  const first = await installPresets(runtime.catalog, presetsRoot);
  expect(first).toMatchObject({ available: true, failed: [] });
  expect(first.installed).toContain('skill-project-investigation');
  expect(first.installed).toContain('mcp-project-index');
  expect(first.installed).toContain('agent-master');
  const definitions = runtime.catalog.definitions();
  const capabilities = runtime.catalog.capabilities();
  expect(definitions.map(item => `${item.id}@${item.version}`)).toEqual(expect.arrayContaining(['master@1', 'coder@1', 'reviewer@1', 'tester@1']));
  expect(capabilities.map(item => item.id)).toEqual(expect.arrayContaining(['skill-project-investigation', 'skill-implement-and-verify', 'skill-independent-review', 'skill-test-and-deliver', 'mcp-project-index']));
  const master = runtime.catalog.definitionSpec('master', 1) as { capabilities?: { id: string; version: string }[]; snapshot?: { preset?: { id: string; hash: string } } };
  expect(master.capabilities).toEqual([{ id: 'skill-project-investigation', version: '1.0.0' }]);
  expect(master.snapshot?.preset?.hash).toBeTruthy();

  // Unchanged pack: nothing is republished, the state stays identical.
  const second = await installPresets(runtime.catalog, presetsRoot);
  expect(second.installed).toEqual([]);
  expect(second.skipped.length).toBe(first.installed.length);
  expect(runtime.catalog.definitions()).toEqual(definitions);
  expect(runtime.catalog.capabilities().length).toBe(capabilities.length);

  // Upgrade: a new version creates new capability and definition versions while
  // the old ones stay available for running instances.
  const upgraded = join(root, 'presets-next');
  await cp(presetsRoot, upgraded, { recursive: true });
  const manifest = await readFile(join(upgraded, 'manifest.json'), 'utf8');
  await writeFile(join(upgraded, 'manifest.json'), manifest.replaceAll('"version": "1.0.0"', '"version": "1.0.1"'));
  await writeFile(join(upgraded, 'skills', 'project-investigation', 'SKILL.md'), `${await readFile(join(upgraded, 'skills', 'project-investigation', 'SKILL.md'), 'utf8')}\n- New investigation guidance.\n`);
  const third = await installPresets(runtime.catalog, upgraded);
  expect(third.failed).toEqual([]);
  expect(runtime.catalog.capability('skill-project-investigation', '1.0.1')?.status).toBe('installed');
  const after = runtime.catalog.definitions();
  expect(after.map(item => `${item.id}@${item.version}`)).toContain('master@2');
  // The previous version remains addressable so running instances keep it.
  expect(runtime.catalog.definitionSpec('master', 1)).toBeTruthy();
  expect(runtime.catalog.definitionSpec('master', 1)).not.toEqual(runtime.catalog.definitionSpec('master', 2));
}, 120_000);

test('a worker loads the preset skill and runs the read-only project index MCP', async () => {
  const provider = await openaiServer([
    { tools: [{ id: 'm1', name: 'mcp_mcp_project_index_project_search', arguments: JSON.stringify({ query: 'preset-marker' }) }] },
    { text: 'Found the marker with the project index.' },
  ]);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-presets-worker-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const { runtime, workspace } = await runtimeAt(root, provider);
  await installPresets(runtime.catalog, presetsRoot);
  const task = await taskFor(runtime, workspace);
  await runtime.host.drive();

  const view = await task.view();
  expect(view.questions).toEqual([]);
  expect(view.nodes.find(node => node.id === 'work')).toMatchObject({ status: 'succeeded' });
  const first = JSON.stringify(provider.requests[0]);
  // The bound Skill reaches the production prompt.
  expect(first).toContain('implement-and-verify');
  // The MCP search result came back into the session with the workspace content.
  expect(JSON.stringify(provider.requests[1])).toContain('preset-marker');
  // The MCP call itself is metered as an invocation (zero-token local call).
  expect(view.invocations.some(invocation => invocation.usage && invocation.usage.input === 0 && invocation.usage.output === 0)).toBe(true);
}, 120_000);

test('the preset project index refuses paths outside the workspace', async () => {
  const outside = join(tmpdir(), 'graph-presets-outside.txt');
  await writeFile(outside, 'formal');
  cleanup.push(() => rm(outside, { force: true }));
  const provider = await openaiServer([
    { tools: [{ id: 'm1', name: 'mcp_mcp_project_index_project_read', arguments: JSON.stringify({ path: '../graph-presets-outside.txt' }) }] },
    { text: 'The read was refused.' },
  ]);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-presets-boundary-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const { runtime, workspace } = await runtimeAt(root, provider);
  await installPresets(runtime.catalog, presetsRoot);
  const task = await taskFor(runtime, workspace);
  await runtime.host.drive();
  expect(await readFile(outside, 'utf8')).toBe('formal');
  expect(JSON.stringify(provider.requests[1])).toContain('escapes the project root');
  expect((await task.view()).questions).toEqual([]);
}, 120_000);

test('a failed preset install is retryable after the source is fixed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-presets-retry-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const brokenRoot = join(root, 'broken');
  await mkdir(join(brokenRoot, 'skills'), { recursive: true });
  await writeFile(join(brokenRoot, 'manifest.json'), JSON.stringify({
    version: 1,
    presets: [{ id: 'skill-project-investigation', kind: 'skill', version: '1.0.0', path: 'skills/project-investigation' }],
  }));
  const { runtime } = await runtimeAt(root);
  const failed = await installPresets(runtime.catalog, brokenRoot);
  expect(failed.failed.map(item => item.id)).toEqual(['skill-project-investigation']);
  expect(runtime.catalog.capability('skill-project-investigation', '1.0.0')).toBeUndefined();
  await cp(join(presetsRoot, 'skills', 'project-investigation'), join(brokenRoot, 'skills', 'project-investigation'), { recursive: true });
  const retried = await installPresets(runtime.catalog, brokenRoot);
  expect(retried.failed).toEqual([]);
  expect(retried.installed).toEqual(['skill-project-investigation']);
}, 120_000);
