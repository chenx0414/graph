import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openaiServer } from '../fixtures/openai-server.ts';
import { startGraphDaemon } from '../../src/server/start.ts';
import { parseGraphConfig } from '../../src/server/config.ts';

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
