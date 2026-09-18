import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

test('an unbound Main Agent can call a definition-bound MCP without a permission question', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-main-capability-access-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const capability = join(capabilityRoot, 'github');
  await mkdir(capability, { recursive: true });
  await copyFile(new URL('../fixtures/mcp-read-capability-server.mjs', import.meta.url), join(capability, 'server.mjs'));
  await writeFile(join(capability, 'capability.json'), JSON.stringify({
    id: 'github',
    kind: 'mcp',
    version: '1.0.0',
    name: 'GitHub',
    command: 'node',
    args: ['./server.mjs'],
    networkDomains: ['github.com'],
  }, null, 2));

  const provider = await openaiServer([
    { tools: [{ id: 'github-search', name: 'mcp_github_search_repositories', arguments: JSON.stringify({ query: 'graph' }) }] },
    { text: 'GitHub search completed.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    catalog: { capabilityRoot, recipesPath: join(root, 'graph', 'agent-combinations.json') },
    models: {
      entries: [{
        id: 'local',
        provider: 'graph-openai',
        grade: 'high',
        api: 'openai-completions',
        baseUrl: provider.model.baseUrl,
        contextWindow: 32_000,
        maxTokens: 256,
      }],
      apiKey: 'scripted-local-key',
      modelRuntime: provider.runtime,
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', {
    recommendedGrade: 'high',
    capabilities: [{ id: 'github', version: '1.0.0' }],
  }, 'master');

  const created = await runtime.conversations.create({
    text: '用 GitHub 搜索 Graph 仓库。',
    requestId: 'main-capability-access',
  });
  await runtime.host.runReady();

  const requestTools = (provider.requests[0] as { tools?: { function?: { name?: string } }[] }).tools?.map(tool => tool.function?.name) ?? [];
  expect(requestTools).toContain('mcp_github_search_repositories');
  expect(JSON.stringify(provider.requests[1])).toContain('repositories:graph');
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.questions).toEqual([]);
  expect(view.messages.filter(message => message.role === 'assistant').at(-1)?.text).toContain('GitHub search completed');
}, 120_000);

test('the Main Agent can call a bound Pi extension that imports package files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-main-extension-access-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const capability = join(capabilityRoot, 'browser');
  await mkdir(join(capability, 'lib'), { recursive: true });
  await writeFile(join(capability, 'index.mjs'), `
    import { value } from './lib/probe.mjs';
    export default function (pi) {
      pi.registerTool({
        name: 'browser_probe',
        label: 'Browser probe',
        description: 'Return a value from the browser extension package.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return { content: [{ type: 'text', text: value }], details: {} };
        },
      });
    }
  `);
  await writeFile(join(capability, 'lib', 'probe.mjs'), `export const value = 'browser-extension-ok';\n`);
  await writeFile(join(capability, 'capability.json'), JSON.stringify({
    id: 'browser',
    kind: 'pi-extension',
    version: '1.0.0',
    name: 'Browser',
    entry: './index.mjs',
    tools: [{ name: 'browser_probe', description: 'Return a value from the browser extension package.' }],
  }, null, 2));

  const provider = await openaiServer([
    { tools: [{ id: 'browser-probe', name: 'browser_probe', arguments: '{}' }] },
    { text: 'Browser probe completed.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    catalog: { capabilityRoot, recipesPath: join(root, 'graph', 'agent-combinations.json') },
    models: {
      entries: [{
        id: 'local',
        provider: 'graph-openai',
        grade: 'high',
        api: 'openai-completions',
        baseUrl: provider.model.baseUrl,
        contextWindow: 32_000,
        maxTokens: 256,
      }],
      apiKey: 'scripted-local-key',
      modelRuntime: provider.runtime,
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', {
    recommendedGrade: 'high',
    capabilities: [{ id: 'browser', version: '1.0.0' }],
  }, 'master');

  const created = await runtime.conversations.create({
    text: '用浏览器扩展检查页面。',
    requestId: 'main-extension-access',
  });
  await runtime.host.runReady();

  const requestTools = (provider.requests[0] as { tools?: { function?: { name?: string } }[] }).tools?.map(tool => tool.function?.name) ?? [];
  expect(requestTools).toContain('browser_probe');
  expect(JSON.stringify(provider.requests[1])).toContain('browser-extension-ok');
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.questions).toEqual([]);
  expect(view.messages.filter(message => message.role === 'assistant').at(-1)?.text).toContain('Browser probe completed');
}, 120_000);
