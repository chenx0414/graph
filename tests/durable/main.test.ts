import { mkdtemp, rm, readFile, appendFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { createInProcessAgentSessionTransport } from '../../src/runtime/agent-session.ts';
import { createDurableSessionTransport } from '../../src/runtime/durable-session.ts';
import { openAgentContextLibrary } from '../../src/runtime/agent-context.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

test('public main preserves legacy tool context without replay and continues the durable transcript after reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-durable-main-'));
  const provider = await openaiServer([{ tools: [{ id: 'native-proof', name: 'bash', arguments: JSON.stringify({ command: "printf 'native durable proof'" }) }] }, { text: 'First persisted reply.' }, { tools: [{ id: 'durable-effect', name: 'write', arguments: JSON.stringify({ path: join(root, 'durable-proof.txt'), content: 'durable-write-completed' }) }] }, { text: 'Reply using earlier conversation.' }, { text: 'Durable reopened reply.' }]);
  const agentContext = openAgentContextLibrary(join(root, 'prompts'));
  await agentContext.ensure();
  const options = { projects: [{ id: 'p', root }], stateDir: join(root, 'state'), sessionTransport: createDurableSessionTransport, agentContext,
    catalog: { capabilityRoot: join(root, 'graph', 'capabilities'), recipesPath: join(root, 'graph', 'recipes.json') },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  };
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  try {
    runtime = await openTaskRuntime({ ...options, sessionTransport: async () => ({ ...createInProcessAgentSessionTransport({ modelRuntime: provider.runtime }), close: async () => {} }) });
    const { conversationId } = await runtime.conversations.create({ projectId: 'p', text: 'Remember the phrase blue heron.', requestId: 'first' });
    await runtime.host.runReady();
    const first = await runtime.conversations.view(conversationId);
    expect(first.messages.filter(message => message.role === 'assistant').map(message => message.text)).toContain('First persisted reply.');
    expect(first.master?.used).toBeGreaterThan(0);
    const instanceId = runtime.nodeRun(first.anchorTaskId, 'master').instance!.id;
    await runtime.close();
    const manifest = JSON.parse(await readFile(join(root, 'state', 'instances', instanceId, 'instance.json'), 'utf8')) as { sessionFile: string };
    const entries = (await readFile(manifest.sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { id: string; type: string; message?: { role: string } });
    const parentId = entries.at(-1)!.id;
    const firstKeptEntryId = entries.find(entry => entry.type === 'message' && entry.message?.role === 'user')!.id;
    await appendFile(manifest.sessionFile, [
      { type: 'message', id: 'abandoned-branch', parentId, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Abandoned branch must stay archived', timestamp: Date.now() } },
      { type: 'compaction', id: 'legacy-compaction', parentId, timestamp: new Date().toISOString(), summary: 'Retained summary with Unicode\u2028separator', tokensBefore: 200, firstKeptEntryId },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    runtime = await openTaskRuntime(options);
    await runtime.conversations.chat(conversationId, { text: 'Continue our discussion.', requestId: 'second' });
    await runtime.host.runReady();
    const second = await runtime.conversations.view(conversationId);
    expect(second.messages.filter(message => message.role === 'assistant').map(message => message.text)).toContain('Reply using earlier conversation.');
    expect(second.master?.used).toBeGreaterThan(first.master?.used ?? 0);
    expect(provider.requests).toHaveLength(4);
    expect((provider.requests[3] as {messages:{role:string;content?:string}[]}).messages.filter(message=>message.role === 'tool')).toEqual(expect.arrayContaining([expect.objectContaining({content: expect.stringContaining('Successfully wrote')})]));
    expect(await readFile(join(root, 'durable-proof.txt'), 'utf8')).toBe('durable-write-completed');
    expect(JSON.stringify(provider.requests[2])).toContain('blue heron');
    expect(JSON.stringify(provider.requests[2])).toContain('First persisted reply.');
    expect(JSON.stringify(provider.requests[2])).toContain('Retained summary with Unicode\u2028separator');
    expect(JSON.stringify(provider.requests[2])).not.toContain('Abandoned branch must stay archived');
    expect(JSON.stringify(provider.requests[2])).toContain('native durable proof');
    expect(JSON.stringify(provider.requests[1])).toContain('native durable proof');
    expect(provider.authorizations).toEqual(Array(4).fill('Bearer scripted-local-key'));
    await runtime.close();
    runtime = await openTaskRuntime(options);
    await runtime.conversations.chat(conversationId, { text: 'A third turn.', requestId: 'third' });
    await runtime.host.runReady();
    expect(provider.requests).toHaveLength(5);
    expect(JSON.stringify(provider.requests[4])).toContain('Reply using earlier conversation.');
    expect((await runtime.conversations.view(conversationId)).messages.filter(message => message.role === 'assistant').map(message => message.text)).toContain('Durable reopened reply.');
  } finally { await runtime?.close(); await provider.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);


test('public durable main uses the published MCP gateway with real history hooks and discovered Skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-durable-main-gateway-'));
  const workspace = join(root, 'workspace');
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const plugin = join(capabilityRoot, 'gateway');
  const remote = join(capabilityRoot, 'remote');
  await Promise.all([workspace, plugin, remote, join(plugin, 'skills', 'gateway-proof')].map(path => mkdir(path, { recursive: true })));
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString()); methods.push(rpc.method);
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    const result = rpc.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : rpc.method === 'tools/list' ? { tools: [{ name: 'record', description: 'Record the approved result', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
      : rpc.method === 'tools/call' ? (await writeFile(join(workspace, 'gateway-effect.txt'), rpc.params.arguments.text), { content: [{ type: 'text', text: 'Actual MCP result persisted' }] }) : {};
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const adapter = fileURLToPath(import.meta.resolve('pi-mcp-adapter'));
  await writeFile(join(plugin, 'index.mjs'), `
    import {createMcpAdapter} from ${JSON.stringify(adapter)};
    import {dirname,join} from 'node:path'; import {fileURLToPath} from 'node:url';
    export default pi => {
      createMcpAdapter({config:{mcpServers:{},settings:{scriptMode:false}}})(pi);
      pi.on('resources_discover', () => ({skillPaths:[join(dirname(fileURLToPath(import.meta.url)), 'skills')]}));
      pi.on('input', (event,ctx) => { if (!ctx.sessionManager.getSessionId()) throw new Error('Missing durable identity'); return {action:'continue'}; });
      pi.on('tool_call', (event,ctx) => { if (!ctx.sessionManager.getBranch().some(entry=>entry.message?.role==='user')) throw new Error('Missing actual durable user history'); });
    };
  `);
  await writeFile(join(plugin, 'skills', 'gateway-proof', 'SKILL.md'), '---\nname: gateway-proof\ndescription: Approved durable gateway skill discovered from its frozen plugin\n---\nUse the bound gateway.\n');
  await writeFile(join(plugin, 'capability.json'), JSON.stringify({ id: 'gateway', kind: 'pi-extension', version: '1.0.0', name: 'Gateway', entry: './index.mjs',
    tools: [{ name: 'mcp', description: 'Published MCP gateway', parameters: { type: 'object' } }],
    runtime: { readPaths: [dirname(adapter)], writePaths: ['${stateDir}'], env: { PI_CODING_AGENT_DIR: '${stateDir}' }, networkDomains: ['127.0.0.1'] },
  }));
  await writeFile(join(remote, 'capability.json'), JSON.stringify({ id: 'remote', kind: 'mcp', version: '1.0.0', name: 'Remote', transport: 'http', url: `http://127.0.0.1:${address.port}/mcp` }));
  const provider = await openaiServer([{ tools: [{ id: 'gateway-proof', name: 'mcp', arguments: JSON.stringify({ server: 'remote', tool: 'record', args: { text: 'public durable gateway effect' } }) }] }, { text: 'The real gateway completed.' }, { text: 'Gateway history retained.' }]);
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace, grants: ['mcp:remote:record'] }],
    catalog: { capabilityRoot, recipesPath: join(root, 'graph', 'recipes.json') }, network: { mcpDomains: ['127.0.0.1'] },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  };
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  try {
    runtime = await openTaskRuntime(options);
    runtime.catalog.publishDefinition('master', { recommendedGrade: 'high', capabilities: [{ id: 'gateway', version: '1.0.0' }, { id: 'remote', version: '1.0.0' }] }, 'master');
    const created = await runtime.conversations.create({ projectId: 'p', text: 'Use the bound MCP gateway.', requestId: 'gateway' });
    await runtime.host.runReady();
    expect(await readFile(join(workspace, 'gateway-effect.txt'), 'utf8')).toBe('public durable gateway effect');
    expect(methods).toContain('initialize'); expect(methods).toContain('tools/call');
    expect(JSON.stringify(provider.requests[0])).toContain('Approved durable gateway skill');
    expect(JSON.stringify(provider.requests[1])).toContain('Actual MCP result persisted');
    const view = await runtime.conversations.view(created.conversationId);
    expect(view.questions).toEqual([]);
    expect(view.messages.some(message => message.role === 'assistant' && message.text === 'The real gateway completed.')).toBe(true);
    await runtime.close(); runtime = await openTaskRuntime(options);
    await runtime.conversations.chat(created.conversationId, { text: 'Continue after reopening.', requestId: 'continue' });
    await runtime.host.runReady();
    expect(JSON.stringify(provider.requests[2])).toContain('The real gateway completed.');
    expect(view.master?.used).toBeTypeOf('number');
    expect((await runtime.conversations.view(created.conversationId)).master?.used).toBeGreaterThan(view.master?.used ?? 0);
  } finally { await runtime?.close(); await provider.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 30_000);
