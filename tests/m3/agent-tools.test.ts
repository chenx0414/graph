import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { agentTools } from '../../src/runtime/agent-tools.ts';
import { Catalog } from '../../src/catalog/catalog.ts';
import { TaskStore } from '../../src/core/store.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'graph-tools-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const scope = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(scope); await mkdir(outside);
  const tools = agentTools({ workspace: scope });
  const call = (name: string, params: Record<string, unknown>) =>
    (tools.find(item => item.name === name)!.execute as unknown as (id: string, params: unknown) => Promise<{ content: { type: string; text?: string }[] }>)('probe', params);
  return { root, scope, outside, call };
}

test('a workspace tool cannot write through a symlinked directory', async () => {
  const { scope, outside, call } = await workspace();
  await writeFile(join(outside, 'evidence.txt'), 'outside');
  await symlink(outside, join(scope, 'linked'));
  await expect(call('write_file', { path: 'linked/evidence.txt', content: 'changed' }))
    .rejects.toThrow('symbolic link');
  expect(await readFile(join(outside, 'evidence.txt'), 'utf8')).toBe('outside');
});

test('a workspace tool cannot write to or read through a symlinked file', async () => {
  const { scope, outside, call } = await workspace();
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await symlink(join(outside, 'secret.txt'), join(scope, 'alias.txt'));
  await expect(call('read', { path: 'alias.txt' })).rejects.toThrow('symbolic link');
  await expect(call('write_file', { path: 'alias.txt', content: 'changed' }))
    .rejects.toThrow('symbolic link');
  expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
});

test('a workspace tool refuses a hard link onto a file outside the work copy', async () => {
  const { scope, outside, call } = await workspace();
  await writeFile(join(outside, 'formal.txt'), 'formal');
  await link(join(outside, 'formal.txt'), join(scope, 'hard.txt'));
  await expect(call('write_file', { path: 'hard.txt', content: 'changed' }))
    .rejects.toThrow('multiply-linked');
  expect(await readFile(join(outside, 'formal.txt'), 'utf8')).toBe('formal');
});

test('a workspace tool refuses Git metadata and escaping paths', async () => {
  const { scope, call } = await workspace();
  await mkdir(join(scope, '.git'));
  await writeFile(join(scope, '.git', 'config'), 'safe');
  await expect(call('write_file', { path: '.git/config', content: 'bad' })).rejects.toThrow('Git metadata');
  await expect(call('read', { path: '.git/config' })).rejects.toThrow('Git metadata');
  await expect(call('write_file', { path: '../outside.txt', content: 'bad' })).rejects.toThrow('outside the workspace');
  await expect(call('read', { path: '/etc/hosts' })).rejects.toThrow('outside the workspace');
  expect(await readFile(join(scope, '.git', 'config'), 'utf8')).toBe('safe');
});

test('a workspace tool still creates nested files and lists directories inside the work copy', async () => {
  const { scope, call } = await workspace();
  await writeFile(join(scope, 'README.md'), 'project\n');
  await expect(call('write_file', { path: 'src/web/index.html', content: '<html>ok</html>' }))
    .resolves.toMatchObject({ details: {} });
  expect(await readFile(join(scope, 'src/web/index.html'), 'utf8')).toBe('<html>ok</html>');
  expect(await call('list_dir', { path: '.' })).toMatchObject({
    content: [{ type: 'text', text: expect.stringContaining('src') }],
  });
  expect((await call('read', { path: 'src/web/index.html' })).content[0]).toMatchObject({ text: '<html>ok</html>' });
  expect((await call('read', { path: join(await realpath(scope), 'src/web/index.html') })).content[0]).toMatchObject({ text: '<html>ok</html>' });
});

test('the main Agent cannot author composer suggestions as part of its reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-tools-suggestion-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const tools = agentTools({
    workspace: root,
    role: 'master',
    supervisor: { propose: async () => ({}), revise: async () => ({}) },
  });
  expect(tools.map(tool => tool.name)).not.toContain('suggest_prompt');
});

test('only the master receives read-only resource and system inventory tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-tools-system-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const reviewer = join(capabilityRoot, 'reviewer');
  await mkdir(reviewer, { recursive: true });
  await writeFile(join(reviewer, 'agent.md'), 'Review code independently.\n');
  await writeFile(join(reviewer, 'capability.json'), JSON.stringify({ id: 'reviewer', kind: 'prompt', role: 'agent', version: '1.0.0', name: '代码审查员', description: '审查代码修改' }));
  await writeFile(join(root, 'graph', 'agent-combinations.json'), JSON.stringify({
    version: 1,
    combinations: [{
      id: 'review', name: '代码审查', description: '组合代码审查资源', recommendedGrade: 'high', review: true, tags: ['审查'],
      resources: [{ resourceId: 'reviewer', version: '1.0.0', role: 'identity', required: true }],
    }],
  }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const catalog = new Catalog(store, { capabilityRoot, recipesPath: join(root, 'graph', 'agent-combinations.json') });
  await catalog.refresh();
  const systemContext = {
    systemSummary: () => ({ configuredModels: [{ id: 'local', grade: 'high' }], subscriptionPlans: [] }),
  };
  const masterTools = agentTools({
    workspace: root,
    role: 'master',
    supervisor: { propose: async () => ({}), revise: async () => ({}) },
    catalog,
    systemContext: {
      ...systemContext,
      requestModelAccess: async input => ({ requestType: 'model_access', ...input }),
    },
  });
  expect(masterTools.map(tool => tool.name)).toEqual(expect.arrayContaining([
    'search_resources', 'get_resource', 'list_agent_combinations', 'get_agent_combination',
    'save_agent_combination', 'delete_agent_combination', 'compile_agent_combination',
    'read_system_capabilities', 'request_model_access',
  ]));
  const execute = (name: string) => masterTools.find(tool => tool.name === name)!.execute as unknown as (id: string, params: unknown) => Promise<{ content: { text?: string }[] }>;
  const search = JSON.parse((await execute('search_resources')('probe', { query: '审查' })).content[0]!.text!) as { items: { id: string }[] };
  expect(search.items).toEqual([expect.objectContaining({ id: 'reviewer' })]);
  const detail = JSON.parse((await execute('get_resource')('probe', { id: 'reviewer' })).content[0]!.text!) as { grantsNoPermission: boolean };
  expect(detail.grantsNoPermission).toBe(true);
  const combinations = JSON.parse((await execute('list_agent_combinations')('probe', { query: '审查' })).content[0]!.text!) as { items: { id: string }[] };
  expect(combinations.items).toEqual([expect.objectContaining({ id: 'review' })]);
  const combination = JSON.parse((await execute('get_agent_combination')('probe', { id: 'review' })).content[0]!.text!) as { resolved: { resourceId: string; version: string }[] };
  expect(combination.resolved[0]).toMatchObject({ resourceId: 'reviewer', version: '1.0.0' });

  const workerTools = agentTools({ workspace: root, systemContext });
  expect(workerTools.map(tool => tool.name)).not.toContain('search_resources');
  expect(workerTools.map(tool => tool.name)).not.toContain('list_agent_combinations');
  expect(workerTools.map(tool => tool.name)).not.toContain('read_system_capabilities');
});
