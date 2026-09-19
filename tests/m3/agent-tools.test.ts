import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { agentTools } from '../../src/runtime/agent-tools.ts';
import { Catalog } from '../../src/catalog/catalog.ts';
import { fullAccessPolicy, resolveAccessPolicy } from '../../src/core/access-policy.ts';
import { ArtifactWorkspace } from '../../src/core/artifact-workspace.ts';
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

test('Agent tools publish, discover and read immutable shared artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-tools-artifacts-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const scope = join(root, 'workspace');
  await mkdir(scope);
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  store.db.exec(`
    INSERT INTO projects(id,root,grants) VALUES('p','${root}','[]');
    INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq)
      VALUES('t','p','shared',1,0,'discussing',0,1);
  `);
  const artifacts = new ArtifactWorkspace(store, join(root, 'artifact-workspace'));
  const tools = agentTools({
    workspace: scope,
    artifacts: {
      allowedNamespaces: ['research'],
      canPromote: true,
      list: query => artifacts.list({ taskId: 't', ...query }),
      get: (artifactId, version) => artifacts.get('t', artifactId, version),
      read: (artifactId, version, maxBytes) => artifacts.read('t', artifactId, version, maxBytes),
      publish: input => artifacts.publish({
        ...input,
        taskId: 't',
        workspace: scope,
        producer: { nodeId: 'research', instanceId: 'i', operationId: 'op', activationId: 'a', outputVersion: 1 },
      }),
      retire: (artifactId, version, reason, requestId) => artifacts.retire('t', artifactId, version, reason, requestId),
      promote: input => artifacts.promote({ ...input, taskId: 't', promotedBy: 'test' }),
    },
  });
  const call = (name: string, params: Record<string, unknown>) =>
    (tools.find(item => item.name === name)!.execute as unknown as (id: string, params: unknown) => Promise<{ content: { text?: string }[] }>)('probe', params);
  await writeFile(join(scope, 'papers.json'), '{"papers":["one"]}');
  const published = JSON.parse((await call('artifact_publish', {
    namespace: 'research',
    name: 'papers',
    sourcePath: 'papers.json',
    schema: 'source-list@1',
    expectedVersion: 0,
    requestId: 'publish-tool',
  })).content[0]!.text!) as { artifactId: string; version: number; uri: string };
  expect(published).toMatchObject({ version: 1, uri: 'graph://tasks/t/artifacts/research/papers@1' });
  const listed = JSON.parse((await call('artifact_list', { namespace: 'research' })).content[0]!.text!) as { artifacts: { artifactId: string }[] };
  expect(listed.artifacts).toMatchObject([{ artifactId: published.artifactId }]);
  const read = JSON.parse((await call('artifact_read', {
    artifactId: published.artifactId,
    version: published.version,
  })).content[0]!.text!) as { text: string; record: { digest: string } };
  expect(read.text).toBe('{"papers":["one"]}');
  expect(read.record.digest).toMatch(/^[a-f0-9]{64}$/);
});

test('full access reads and writes host paths while protected state stays unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-tools-full-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const scope = join(root, 'workspace');
  const stateDir = join(root, 'state');
  const graphHome = join(root, 'graph');
  await mkdir(scope);
  await mkdir(stateDir);
  await mkdir(graphHome);
  await writeFile(join(root, 'outside.txt'), 'outside');
  await writeFile(join(stateDir, 'tasks.sqlite'), 'formal');
  const access = resolveAccessPolicy(fullAccessPolicy(), { home: root, stateDir, graphHome });
  const tools = agentTools({ workspace: scope, access });
  const call = (name: string, params: Record<string, unknown>) =>
    (tools.find(item => item.name === name)!.execute as unknown as (id: string, params: unknown) => Promise<{ content: { type: string; text?: string }[] }>)('probe', params);

  expect((await call('read', { path: join(root, 'outside.txt') })).content[0]).toMatchObject({ text: 'outside' });
  await expect(call('write_file', { path: join(root, 'created.txt'), content: 'created' }))
    .resolves.toMatchObject({ details: {} });
  expect(await readFile(join(root, 'created.txt'), 'utf8')).toBe('created');
  await expect(call('read', { path: join(stateDir, 'tasks.sqlite') })).rejects.toThrow(/protected/i);
  await expect(call('write_file', { path: join(stateDir, 'new.sqlite'), content: 'bad' })).rejects.toThrow(/protected/i);
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
