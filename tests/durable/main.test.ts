import { mkdtemp, rm, readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { TaskStore } from '../../src/core/store.ts';
import { appendMessage } from '../../src/core/conversation.ts';
import { createDurableSessionTransport } from '../../src/runtime/durable-session.ts';
import { openAgentContextLibrary } from '../../src/runtime/agent-context.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

test('public main preserves legacy tool context without replay and continues the durable transcript after reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-durable-main-'));
  const provider = await openaiServer([{ tools: [{ id: 'durable-effect', name: 'write', arguments: JSON.stringify({ path: join(root, 'durable-proof.txt'), content: 'durable-write-completed' }) }] }, { text: 'Reply using earlier conversation.' }, { text: 'Durable reopened reply.' }]);
  const agentContext = openAgentContextLibrary(join(root, 'prompts'));
  await agentContext.ensure();
  const options = { projects: [{ id: 'p', root }], stateDir: join(root, 'state'), sessionTransport: createDurableSessionTransport, agentContext,
    catalog: { capabilityRoot: join(root, 'graph', 'capabilities'), recipesPath: join(root, 'graph', 'recipes.json') },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  };
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  try {
    runtime = await openTaskRuntime(options);
    const { conversationId } = await runtime.conversations.create({ projectId: 'p', title: 'Retained historical main', text: 'Remember the phrase blue heron.', requestId: 'first' });
    const anchor = await runtime.conversations.view(conversationId);
    const instanceId = runtime.nodeRun(anchor.anchorTaskId, 'master').instance!.id;
    await runtime.close();
    // A historical migration fixture, captured in the published JSONL/storage formats.
    // Importing it is passive; no old Agent loop runs to manufacture the source.
    const legacyStore = new TaskStore(join(root, 'state', 'tasks.sqlite'));
    legacyStore.db.prepare("UPDATE messages SET state='done' WHERE conversation_id=?").run(conversationId);
    appendMessage(legacyStore, { conversationId, role: 'assistant', kind: 'chat', text: 'First persisted reply.' });
    legacyStore.db.prepare("UPDATE nodes SET status='completed' WHERE task_id=? AND id='master'").run(anchor.anchorTaskId);
    legacyStore.db.prepare('UPDATE instances SET used=50 WHERE id=?').run(instanceId);
    legacyStore.close();
    const instanceDir = join(root, 'state', 'instances', instanceId);
    await mkdir(instanceDir, { recursive: true });
    const sessionFile = join(instanceDir, 'legacy.jsonl');
    const assistant = { role: 'assistant', api: 'openai-completions', provider: 'graph-openai', model: 'local', timestamp: 1,
      usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const records = [
      { type: 'session', version: 3, id: 'historical-main', timestamp: '2026-01-01T00:00:00.000Z', cwd: root },
      { type: 'message', id: 'old-user', parentId: null, message: { role: 'user', content: 'Remember the phrase blue heron.', timestamp: 1 } },
      { type: 'message', id: 'old-call', parentId: 'old-user', message: { ...assistant, content: [{ type: 'toolCall', id: 'native-proof', name: 'bash', arguments: { command: "printf 'native durable proof'" } }], stopReason: 'toolUse' } },
      { type: 'message', id: 'old-tool', parentId: 'old-call', message: { role: 'toolResult', toolCallId: 'native-proof', toolName: 'bash', content: [{ type: 'text', text: 'native durable proof' }], isError: false, timestamp: 1 } },
      { type: 'message', id: 'old-reply', parentId: 'old-tool', message: { ...assistant, content: [{ type: 'text', text: 'First persisted reply.' }], stopReason: 'stop' } },
      { type: 'message', id: 'abandoned-branch', parentId: 'old-reply', message: { role: 'user', content: 'Abandoned branch must stay archived', timestamp: 1 } },
      { type: 'compaction', id: 'legacy-compaction', parentId: 'old-reply', summary: 'Retained summary with Unicode\u2028separator', tokensBefore: 200, firstKeptEntryId: 'old-user' },
    ];
    await writeFile(sessionFile, records.map(entry => JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', ...entry })).join('\n') + '\n');
    await writeFile(join(instanceDir, 'instance.json'), JSON.stringify({ version: 3, binding: { instanceId, nodeId: 'master', definitionVersion: 'master@1' }, sessionId: 'historical-main', sessionFile, workspace: root }));
    const manifest = join(instanceDir, 'instance.json');
    await rename(manifest, `${manifest}.held`);
    await expect(openTaskRuntime(options)).rejects.toThrow(/history|manifest|source|conversation/i);
    expect(provider.requests).toHaveLength(0);
    await rename(`${manifest}.held`, manifest);
    runtime = await openTaskRuntime(options);
    const first = await runtime.conversations.view(conversationId);
    expect(first.messages.filter(message => message.role === 'assistant').map(message => message.text)).toContain('First persisted reply.');
    expect(first.master?.used).toBe(50);
    expect(provider.requests).toHaveLength(0);
    await runtime.conversations.chat(conversationId, { text: 'Continue our discussion.', requestId: 'second' });
    await runtime.host.runReady();
    const second = await runtime.conversations.view(conversationId);
    expect(second.messages.filter(message => message.role === 'assistant').map(message => message.text)).toContain('Reply using earlier conversation.');
    expect(second.master?.used).toBeGreaterThan(first.master?.used ?? 0);
    expect(provider.requests).toHaveLength(2);
    expect((provider.requests[1] as {messages:{role:string;content?:string}[]}).messages.filter(message=>message.role === 'tool')).toEqual(expect.arrayContaining([expect.objectContaining({content: expect.stringContaining('Successfully wrote')})]));
    expect(await readFile(join(root, 'durable-proof.txt'), 'utf8')).toBe('durable-write-completed');
    expect(JSON.stringify(provider.requests[0])).toContain('blue heron');
    expect(JSON.stringify(provider.requests[0])).toContain('First persisted reply.');
    expect(JSON.stringify(provider.requests[0])).toContain('Retained summary with Unicode\u2028separator');
    expect(JSON.stringify(provider.requests[0])).not.toContain('Abandoned branch must stay archived');
    expect(JSON.stringify(provider.requests[0])).toContain('native durable proof');
    expect(provider.authorizations).toEqual(Array(2).fill('Bearer scripted-local-key'));
    await runtime.close();
    runtime = await openTaskRuntime(options);
    await runtime.conversations.chat(conversationId, { text: 'A third turn.', requestId: 'third' });
    await runtime.host.runReady();
    expect(provider.requests).toHaveLength(3);
    expect(JSON.stringify(provider.requests[2])).toContain('Reply using earlier conversation.');
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
    import {dirname,join} from 'node:path'; import {fileURLToPath} from 'node:url'; import {writeFile} from 'node:fs/promises';
    export default pi => {
      createMcpAdapter({config:{mcpServers:{},settings:{scriptMode:false}}})(pi);
      pi.registerTool({name:'undeclared_extra',label:'Extra',description:'Unbound plugin registration',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'must not be offered'}]})});
      pi.on('resources_discover', () => ({skillPaths:[join(dirname(fileURLToPath(import.meta.url)), 'skills')]}));
      pi.on('session_checkpoint', () => { throw new Error('Retired resident sleep hook must never execute'); });
      pi.on('session_shutdown', async (event,ctx) => { await writeFile(join(ctx.cwd, 'gateway-shutdown.txt'), 'real shutdown'); });
      pi.on('input', (event,ctx) => { ctx.ui.notify('Headless plugin notice', 'info'); if (!ctx.sessionManager.getSessionId()) throw new Error('Missing durable identity'); return {action:'continue'}; });
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
    expect(await readFile(join(workspace, 'gateway-shutdown.txt'), 'utf8')).toBe('real shutdown');
    const declaredTools = (provider.requests[0] as { tools: { function: { name: string } }[] }).tools.map(tool => tool.function.name);
    expect(declaredTools).toContain('mcp');
    expect(declaredTools).not.toContain('undeclared_extra');
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
}, 120_000);

// The current execution must read immutable skills even without a restart;
// an actually declared native write must fail at the resource boundary.
test('an admitted main reads frozen skill bytes and refuses an authorized write while its next input reads current bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-live-frozen-skill-'));
  const folder = join(root, 'capabilities', 'frozen-skill');
  await mkdir(folder, { recursive: true });
  const skill = join(folder, 'SKILL.md');
  const original = '---\nname: frozen-skill\ndescription: Frozen execution knowledge.\n---\nORIGINAL_SKILL_BYTES\n';
  const updated = original.replace('ORIGINAL_SKILL_BYTES', 'LATEST_SKILL_BYTES');
  await writeFile(join(folder, 'capability.json'), JSON.stringify({ id: 'frozen-skill', kind: 'skill', version: '1.0.0', name: 'Frozen skill' }));
  await writeFile(skill, original);
  const provider = await openaiServer([
    { beforeReply: async () => { await writeFile(skill, updated); }, tools: [{ id: 'read-original', name: 'read', arguments: JSON.stringify({ path: skill }) }] },
    { tools: [{ id: 'deny-write', name: 'write', arguments: JSON.stringify({ path: skill, content: 'ILLEGAL_WRITE' }) }] },
    { text: 'Original bytes remained frozen.' },
    { tools: [{ id: 'read-current', name: 'read', arguments: JSON.stringify({ path: skill }) }] },
    { text: 'New input reads the current bytes.' },
  ]);
  const agentContext = openAgentContextLibrary(join(root, 'prompts'));
  await agentContext.ensure();
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  try {
    runtime = await openTaskRuntime({ stateDir: join(root, 'state'), agentContext,
      catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') },
      models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }], apiKey: 'local-test' },
      master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
    });
    runtime.catalog.publishDefinition('master', { recommendedGrade: 'high', capabilities: [{ id: 'frozen-skill', version: '1.0.0' }] }, 'master');
    const created = await runtime.conversations.create({ text: 'Read your skill and preserve its immutable bytes.', requestId: 'frozen' });
    await runtime.host.runReady();
    expect(provider.requests).toHaveLength(3);
    expect(JSON.stringify(provider.requests[1])).toContain('ORIGINAL_SKILL_BYTES');
    expect(JSON.stringify(provider.requests[1])).not.toContain('LATEST_SKILL_BYTES');
    expect(JSON.stringify(provider.requests[0])).toContain('"name":"write"');
    expect(JSON.stringify(provider.requests[2])).toContain('Frozen capability resources are read-only');
    expect(await readFile(skill, 'utf8')).toBe(updated);
    await runtime.conversations.chat(created.conversationId, { text: 'Read your skill for the new input.', requestId: 'current' });
    await runtime.host.runReady();
    expect(provider.requests).toHaveLength(5);
    expect(JSON.stringify(provider.requests[4])).toContain('LATEST_SKILL_BYTES');
  } finally { await runtime?.close(); await provider.close(); await rm(root, { recursive: true, force: true }); }
}, 40000);

test('consecutive public main steering waits for the latest replacement input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-durable-main-steering-'));
  const firstStarted = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  const provider = await openaiServer([
    { beforeReply: async () => { firstStarted.resolve(); await releaseFirst.promise; }, text: 'Superseded initial answer.' },
    { beforeReply: async () => { secondStarted.resolve(); await releaseSecond.promise; }, text: 'Superseded first replacement.' },
    { text: 'Latest replacement completed.' },
  ]);
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  try {
    runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
      models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
      master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
    });
    const created = await runtime.conversations.create({ projectId: 'p', text: 'Original task.', requestId: 'initial' });
    const drive = runtime.host.runReady();
    await firstStarted.promise;
    await runtime.conversations.chat(created.conversationId, { text: 'First clarification.', requestId: 'first-clarification' });
    expect(await runtime.conversations.steer(created.conversationId, { requestId: 'first-steering' })).toMatchObject({ state: 'steered', steered: 1 });
    releaseFirst.resolve();
    await secondStarted.promise;
    await runtime.conversations.chat(created.conversationId, { text: 'Latest clarification.', requestId: 'latest-clarification' });
    expect(await runtime.conversations.steer(created.conversationId, { requestId: 'latest-steering' })).toMatchObject({ state: 'steered', steered: 1 });
    releaseSecond.resolve();
    await drive;
    const view = await runtime.conversations.view(created.conversationId);
    expect(view.messages.filter(message => message.role === 'assistant').map(message => message.text)).toContain('Latest replacement completed.');
    expect(view.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['Original task.', 'First clarification.', 'Latest clarification.']);
    expect(provider.requests).toHaveLength(3);
    expect(view.master?.used).toBe(50);
    expect(JSON.stringify(provider.requests[2])).toContain('Latest clarification.');
    expect(view.questions.filter(question => question.status === 'open')).toEqual([]);
  } finally { releaseFirst.resolve(); releaseSecond.resolve(); await runtime?.close(); await provider.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
