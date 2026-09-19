import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('an unrestricted Pi extension does not deadlock a bound MCP call in the same Main Agent turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-main-mixed-network-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const extension = join(capabilityRoot, 'unrestricted-extension');
  const mcp = join(capabilityRoot, 'github');
  await mkdir(extension, { recursive: true });
  await mkdir(mcp, { recursive: true });
  await writeFile(join(extension, 'index.mjs'), 'export default () => {};\n');
  await writeFile(join(extension, 'capability.json'), JSON.stringify({
    id: 'unrestricted-extension',
    kind: 'pi-extension',
    version: '1.0.0',
    name: 'Unrestricted extension',
    entry: './index.mjs',
    runtime: {
      networkAccess: 'unrestricted',
      allowLocalBinding: true,
    },
  }, null, 2));
  await copyFile(new URL('../fixtures/mcp-read-capability-server.mjs', import.meta.url), join(mcp, 'server.mjs'));
  await writeFile(join(mcp, 'capability.json'), JSON.stringify({
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
    { text: 'Mixed capability call completed.' },
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
    capabilities: [
      { id: 'unrestricted-extension', version: '1.0.0' },
      { id: 'github', version: '1.0.0' },
    ],
  }, 'master');

  const created = await runtime.conversations.create({
    text: '调用 GitHub MCP。',
    requestId: 'main-mixed-network',
  });
  await runtime.host.runReady();

  expect(JSON.stringify(provider.requests[1])).toContain('repositories:graph');
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.questions).toEqual([]);
  expect(view.messages.filter(message => message.role === 'assistant').at(-1)?.text).toContain('Mixed capability call completed');
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

test('a bound Pi extension receives its declared command, environment, loopback and Unix socket runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-main-extension-runtime-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const capability = join(capabilityRoot, 'runtime-probe');
  const runtimeSocketRoot = join('/private/tmp', `graph-runtime-${process.pid}`);
  await mkdir(capability, { recursive: true });
  cleanup.push(() => rm(runtimeSocketRoot, { recursive: true, force: true }));
  const probe = join(capability, 'runtime-probe');
  await writeFile(probe, `#!/usr/bin/env node
    import { createServer as createTcpServer } from 'node:http';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { connect, createServer as createUnixServer } from 'node:net';
    import { join } from 'node:path';
    const run = async () => {
      mkdirSync(process.env.GRAPH_RUNTIME_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(process.env.GRAPH_RUNTIME_OUTPUT, 'written');
      const loopback = await new Promise((resolve, reject) => {
        const server = createTcpServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
        });
      });
      const socketPath = join(process.env.GRAPH_RUNTIME_SOCKET_DIR, 'probe.sock');
      const socket = await new Promise((resolve, reject) => {
        const server = createUnixServer(connection => connection.end('socket-ok'));
        server.once('error', reject);
        server.listen(socketPath, () => {
          const client = connect(socketPath);
          client.once('data', data => server.close(() => resolve(data.toString())));
          client.once('error', reject);
        });
      });
      console.log(JSON.stringify({ marker: process.env.GRAPH_RUNTIME_MARKER, loopback, socket }));
    };
    run().catch(error => { console.error(error); process.exit(1); });
  `);
  await chmod(probe, 0o755);
  await writeFile(join(capability, 'index.mjs'), `
    import { spawnSync } from 'node:child_process';
    export default function (pi) {
      pi.registerTool({
        name: 'runtime_probe',
        label: 'Runtime probe',
        description: 'Run the declared host command.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          const child = spawnSync('runtime-probe', [], { encoding: 'utf8' });
          if (child.error) throw child.error;
          if (child.status !== 0) throw new Error(child.stderr || 'runtime probe failed');
          return { content: [{ type: 'text', text: child.stdout.trim() }], details: {} };
        },
      });
    }
  `);
  await writeFile(join(capability, 'capability.json'), JSON.stringify({
    id: 'runtime-probe',
    kind: 'pi-extension',
    version: '1.0.0',
    name: 'Runtime probe',
    entry: './index.mjs',
    tools: [{ name: 'runtime_probe', description: 'Run the declared host command.' }],
    runtime: {
      commands: ['./runtime-probe'],
      env: {
        GRAPH_RUNTIME_MARKER: 'runtime-ok',
        GRAPH_RUNTIME_DIR: '${scratchDir}/runtime',
        GRAPH_RUNTIME_OUTPUT: '${scratchDir}/runtime/output.txt',
        GRAPH_RUNTIME_SOCKET_DIR: runtimeSocketRoot,
      },
      writePaths: ['${scratchDir}/runtime'],
      allowLocalBinding: true,
      unixSockets: [runtimeSocketRoot],
    },
  }, null, 2));

  const provider = await openaiServer([
    { tools: [{ id: 'runtime-probe', name: 'runtime_probe', arguments: '{}' }] },
    { text: 'Runtime probe completed.' },
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
    capabilities: [{ id: 'runtime-probe', version: '1.0.0' }],
  }, 'master');

  const created = await runtime.conversations.create({
    text: '执行运行时探针。',
    requestId: 'main-extension-runtime',
  });
  await runtime.host.runReady();

  const toolResult = (provider.requests[1] as { messages?: { role?: string; content?: string }[] }).messages
    ?.find(message => message.role === 'tool')?.content ?? '';
  expect(toolResult).toContain('"marker":"runtime-ok"');
  expect(toolResult).toContain('"socket":"socket-ok"');
  expect(toolResult).toContain('"loopback":');
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.questions).toEqual([]);
  expect(view.messages.filter(message => message.role === 'assistant').at(-1)?.text).toContain('Runtime probe completed');
}, 120_000);
