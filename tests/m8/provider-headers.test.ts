import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openaiServer } from '../fixtures/openai-server.ts';
import { startGraphDaemon } from '../../src/server/start.ts';
import { parseGraphConfig } from '../../src/server/config.ts';
import type { Proposal } from '../../src/core/types.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

test('configured model headers reach the provider on a real dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m8-provider-headers-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const webDir = join(root, 'web');
  await mkdir(project, { recursive: true });
  await mkdir(webDir, { recursive: true });
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');

  const provider = await openaiServer([{ text: 'header check' }]);
  cleanup.push(() => provider.close());

  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    models: {
      entries: [{
        id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local',
        headers: { 'x-opencode-session': 'graph-header-test' },
      }],
    },
    credentials: { local: { secretRef: 'GRAPH_HEADER_KEY' } },
    limits: { credentials: { local: 1 }, sharedGroups: {} },
  }, null, 2));

  const daemon = await startGraphDaemon({
    configPath, stateDir: join(root, 'state'), webDir, port: 0, mode: 'execute',
    graphHome: join(root, 'graph'),
    env: { GRAPH_HEADER_KEY: 'header-key' }, log: () => undefined,
  });
  cleanup.push(() => daemon.close());
  const { taskId } = await daemon.server.runtime.user.begin({ projectId: 'p', request: 'header task', requestId: 'begin' });
  await daemon.server.runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'headers',
    acceptance: [{ id: 'works', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['-e', 'process.exit(0)'] } },
    ],
  }, 'proposal-headers');
  await daemon.server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await daemon.server.runtime.host.runReady();
    const node = (await daemon.server.runtime.user.task(taskId).view()).nodes.find(candidate => candidate.id === 'work');
    if (node && ['succeeded', 'failed', 'blocked'].includes(node.status)) break;
    await sleep(100);
  }

  expect(provider.requests.length).toBeGreaterThan(0);
  expect(provider.authorizations[0]).toBe('Bearer header-key');
  expect(provider.headerList.some(headers => headers['x-opencode-session'] === 'graph-header-test')).toBe(true);
  const view = await daemon.server.runtime.user.task(taskId).view();
  expect(view.nodes.find(node => node.id === 'work')?.status).toBe('succeeded');
}, 90_000);

test('config parsing validates and keeps per-model request headers', () => {
  const document = (headers: unknown) => ({
    version: 1,
    projects: [{ id: 'p', root: '/tmp' }],
    models: {
      entries: [{
        id: 'local', provider: 'opencode-go', grade: 'high', api: 'openai-completions',
        baseUrl: 'https://opencode.ai/zen/go/v1', contextWindow: 32_000, maxTokens: 256,
        credentialId: 'go', headers,
      }],
    },
    credentials: { go: { secretRef: 'OPENCODE_GO_API_KEY' } },
    limits: {},
  });
  const parsed = parseGraphConfig(document({ 'x-opencode-session': 'graph-console' }), '/tmp/graph.config.json');
  expect(parsed.models?.entries[0]?.headers).toEqual({ 'x-opencode-session': 'graph-console' });
  expect(() => parseGraphConfig(document({ 'bad header': 'x' }), '/tmp/graph.config.json')).toThrow(/not a valid header name/);
  expect(() => parseGraphConfig(document({ 'x-test': '' }), '/tmp/graph.config.json')).toThrow(/non-empty string/);
  expect(() => parseGraphConfig(document({ 'x-test': 42 }), '/tmp/graph.config.json')).toThrow(/non-empty string/);
});

test('OpenCode Go adds its routing header to connection tests and real dispatches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m8-opencode-go-headers-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const webDir = join(root, 'web');
  await mkdir(project, { recursive: true });
  await mkdir(webDir, { recursive: true });
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');

  const provider = await openaiServer([{ text: 'pong' }, { text: 'task complete' }]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    models: {
      entries: [{
        id: 'opencode-go:deepseek-v4.1-flash', provider: 'opencode-go', modelId: 'deepseek-v4.1-flash',
        grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl,
        contextWindow: 1_000_000, maxTokens: 384_000, reasoning: true, credentialId: 'opencode-go',
      }],
    },
    credentials: { 'opencode-go': { secretRef: 'GRAPH_OPENCODE_GO_KEY' } },
    limits: {},
  }, null, 2));
  const daemon = await startGraphDaemon({
    configPath, stateDir: join(root, 'state'), webDir, port: 0, mode: 'execute',
    graphHome: join(root, 'graph'),
    env: { GRAPH_OPENCODE_GO_KEY: 'opencode-go-key' }, log: () => undefined,
  });
  cleanup.push(() => daemon.close());

  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const headers = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  const tested = await fetch(`${daemon.url}/api/config/test`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ modelId: 'opencode-go:deepseek-v4.1-flash' }),
  });
  expect(await tested.json()).toMatchObject({ ok: true, model: 'opencode-go:deepseek-v4.1-flash' });
  expect(provider.headerList[0]?.['x-opencode-session']).toBeTruthy();

  const { taskId } = await daemon.server.runtime.user.begin({ projectId: 'p', request: 'header task', requestId: 'begin' });
  await daemon.server.runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'headers',
    acceptance: [{ id: 'works', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'opencode-go:deepseek-v4.1-flash' },
      { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['-e', 'process.exit(0)'] } },
    ],
  }, 'proposal-opencode-headers');
  await daemon.server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await daemon.server.runtime.host.runReady();
    const node = (await daemon.server.runtime.user.task(taskId).view()).nodes.find(candidate => candidate.id === 'work');
    if (node && ['succeeded', 'failed', 'blocked'].includes(node.status)) break;
    await sleep(100);
  }
  expect(provider.headerList.length).toBeGreaterThan(1);
  expect(provider.headerList.slice(1).every(headers => Boolean(headers['x-opencode-session']))).toBe(true);
  expect((await daemon.server.runtime.user.task(taskId).view()).nodes.find(node => node.id === 'work')?.status).toBe('succeeded');
}, 90_000);

test('an unresolved credential only disables its own model, not dispatch for others', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m8-partial-credentials-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const webDir = join(root, 'web');
  await mkdir(project, { recursive: true });
  await mkdir(webDir, { recursive: true });
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');

  const provider = await openaiServer([{ text: 'usable model' }]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    models: {
      entries: [
        { id: 'usable', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'usable' },
        { id: 'unusable', provider: 'graph-openai-unusable', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'unusable' },
      ],
    },
    credentials: { usable: { secretRef: 'GRAPH_USABLE_KEY' }, unusable: { secretRef: 'GRAPH_MISSING_KEY' } },
    limits: {},
  }, null, 2));

  const daemon = await startGraphDaemon({
    configPath, stateDir: join(root, 'state'), webDir, port: 0, mode: 'execute',
    graphHome: join(root, 'graph'),
    env: { GRAPH_USABLE_KEY: 'usable-key' }, log: () => undefined,
  });
  cleanup.push(() => daemon.close());
  expect(daemon.mode).toBe('execute');
  expect(daemon.configured).toBe(true);
  expect(daemon.modelCount).toBe(2);
  expect(daemon.enabledModelCount).toBe(1);

  const { taskId } = await daemon.server.runtime.user.begin({ projectId: 'p', request: 'partial credentials', requestId: 'begin' });
  await daemon.server.runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'partial',
    acceptance: [{ id: 'works', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'usable' },
      { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['-e', 'process.exit(0)'] } },
    ],
  }, 'proposal');
  await daemon.server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await daemon.server.runtime.host.runReady();
    const node = (await daemon.server.runtime.user.task(taskId).view()).nodes.find(candidate => candidate.id === 'work');
    if (node && ['succeeded', 'failed', 'blocked'].includes(node.status)) break;
    await sleep(100);
  }
  expect(provider.requests.length).toBeGreaterThan(0);
  expect((await daemon.server.runtime.user.task(taskId).view()).nodes.find(node => node.id === 'work')?.status).toBe('succeeded');
}, 90_000);

test('tasks created while dispatch was disabled are recovered on the next execute start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m8-master-recovery-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const webDir = join(root, 'web');
  await mkdir(project, { recursive: true });
  await mkdir(webDir, { recursive: true });
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');

  const provider = await openaiServer([{ text: 'master ready' }]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }],
    },
    credentials: { local: { secretRef: 'GRAPH_RECOVERY_KEY' } },
    limits: {},
  }, null, 2));

  // View-only: tasks are accepted but cannot dispatch; one belongs to a
  // project that is removed before the next start.
  const viewConfig = join(root, 'view.config.json');
  await writeFile(viewConfig, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }, { id: 'gone', root: project }],
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }] },
    credentials: { local: { secretRef: 'GRAPH_RECOVERY_KEY' } },
    limits: {},
  }, null, 2));
  const view = await startGraphDaemon({ configPath: viewConfig, stateDir: join(root, 'state'), webDir, port: 0, mode: 'view', graphHome: join(root, 'graph'), env: {}, log: () => undefined });
  const { taskId } = await view.server.runtime.user.begin({ projectId: 'p', request: 'queued while view-only', requestId: 'begin' });
  const gone = await view.server.runtime.user.begin({ projectId: 'gone', request: 'removed project', requestId: 'begin-gone' });
  expect((await view.server.runtime.user.task(taskId).view()).nodes).toHaveLength(0);
  await view.close();

  // Execute: the master is backfilled, becomes active and dispatches.
  const execute = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), webDir, port: 0, mode: 'execute', graphHome: join(root, 'graph'), env: { GRAPH_RECOVERY_KEY: 'recovery-key' }, log: () => undefined });
  cleanup.push(() => execute.close());
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await execute.server.runtime.host.runReady();
    if (provider.requests.length > 0) break;
    await sleep(100);
  }
  const nodes = (await execute.server.runtime.user.task(taskId).view()).nodes;
  expect(nodes.map(node => node.id)).toContain('master');
  expect(provider.requests.length).toBeGreaterThan(0);
  expect(provider.authorizations[0]).toBe('Bearer recovery-key');
  expect(nodes.find(node => node.id === 'master')?.status).not.toBe('pending');
  // The removed-project task keeps its history but is not recovered.
  expect((await execute.server.runtime.user.task(gone.taskId).view()).nodes).toHaveLength(0);
}, 90_000);
