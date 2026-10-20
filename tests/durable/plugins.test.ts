import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openDurablePlugins } from '../../src/runtime/durable-plugin.ts';
import type { AgentSessionRequest } from '../../src/runtime/agent-session.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

test('a frozen plugin package runs its real tool and hooks while its OS policy denies writes outside granted roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'durable-plugins-'));
  const provider = await openaiServer([]);
  const workspace = join(root, 'workspace');
  const capability = join(root, 'capability');
  const stateDir = join(root, 'state');
  await mkdir(workspace); await mkdir(capability); await mkdir(stateDir);
  await writeFile(join(capability, 'capability.json'), '{}');
  await writeFile(join(capability, 'value.mjs'), "export const value = 'package-value';\n");
  await writeFile(join(capability, 'index.mjs'), `
    import { writeFile } from 'node:fs/promises';
    import { value } from './value.mjs';
    export default pi => {
      pi.on('before_agent_start', async (event, ctx) => ({ systemPrompt: ctx.getSystemPrompt() + ':plugin-policy', message: { customType: 'plugin-context', content: 'frozen-plugin-context', display: false } }));
      pi.registerTool({ name: 'plugin_write', label: 'Plugin write', description: 'Write from a plugin', parameters: {type:'object', properties:{path:{type:'string'}}, required:['path']},
        async execute(id, args) { await writeFile(args.path, value); return {content:[{type:'text', text:value}],details:{}}; }
      });
    };
  `);
  let plugins: Awaited<ReturnType<typeof openDurablePlugins>> | undefined;
  try {
    const request: AgentSessionRequest = { binding: { instanceId: 'plugin-owner', nodeId: 'worker', definitionVersion: 'worker@1' }, workspace, stateDir,
      model: provider.model, stream: () => { throw new Error('A capability helper must never invoke a model'); },
      piExtensionPaths: [join(capability, 'index.mjs')], piExtensionTools: ['plugin_write'], systemPrompt: 'worker-policy',
      bundleDigest: 'plugin-version-1', toolPolicyDigest: 'bounded-tools', runtimePolicyDigest: 'bounded-runtime',
      broker: { dispatch: (_id, _reservation, send) => send(), settle: () => {} },
    };
    plugins = await openDurablePlugins(request);
    const initialized = await plugins.beforePrompt('Build according to the plan');
    expect(initialized.systemPrompt).toBe('worker-policy:plugin-policy');
    expect(initialized.messages).toEqual([{ customType: 'plugin-context', content: 'frozen-plugin-context', display: false }]);
    const tool = plugins.tools.find(tool => tool.name === 'plugin_write')!;
    await tool.execute('write-approved', {path:join(workspace, 'result.txt')}, undefined, undefined, undefined!);
    expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe('package-value');
    await expect(tool.execute('write-denied', {path:join(root, 'outside.txt')}, undefined, undefined, undefined!)).rejects.toThrow();
    await expect(readFile(join(root, 'outside.txt'))).rejects.toMatchObject({code:'ENOENT'});
    await plugins.close();
    plugins = await openDurablePlugins({ ...request, readOnly: true, filesystemAccess: 'host' });
    const reviewerTool = plugins.tools.find(tool => tool.name === 'plugin_write')!;
    await expect(reviewerTool.execute('review-denied', {path:join(workspace, 'result.txt')}, undefined, undefined, undefined!)).rejects.toThrow();
    await expect(reviewerTool.execute('review-outside-denied', {path:join(root, 'outside.txt')}, undefined, undefined, undefined!)).rejects.toThrow();
    expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe('package-value');
    expect(provider.requests).toEqual([]);
  } finally { await plugins?.close(); await provider.close(); await rm(root, {recursive:true,force:true}); }
}, 30_000);

test('the published MCP adapter gateway calls its runtime-bound HTTP server inside the frozen plugin policy', async () => {
  const { createServer } = await import('node:http');
  const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(join(tmpdir(), 'durable-mcp-plugin-'));
  const workspace = join(root, 'workspace'); const stateDir = join(root, 'state');
  await mkdir(workspace); await mkdir(stateDir);
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString()); methods.push(rpc.method);
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    const result = rpc.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : rpc.method === 'tools/list' ? { tools: [{ name: 'record', description: 'Persist an approved result', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
      : rpc.method === 'tools/call' ? (await writeFile(join(workspace, 'mcp-result.txt'), rpc.params.arguments.text), { content: [{ type: 'text', text: 'MCP accepted approved result' }] }) : {};
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const adapter = fileURLToPath(import.meta.resolve('pi-mcp-adapter'));
  const entry = join(workspace, 'adapter.mjs');
  await writeFile(entry, `import {createMcpAdapter} from ${JSON.stringify(adapter)}; export default createMcpAdapter({config:{mcpServers:{},settings:{scriptMode:false}}});`);
  const provider = await openaiServer([]);
  let plugins: Awaited<ReturnType<typeof openDurablePlugins>> | undefined;
  try {
    const request: AgentSessionRequest = { binding: { instanceId: 'mcp-owner', nodeId: 'worker', definitionVersion: 'worker@1' }, workspace, stateDir,
      model: provider.model, stream: () => { throw new Error('Plugins cannot create an independent provider path'); },
      piExtensionPaths: [entry], piExtensionTools: ['mcp'], bundleDigest: 'adapter-2.38.0', toolPolicyDigest: 'mcp-only', runtimePolicyDigest: 'loopback-only',
      readRoots: [join(adapter, '..')], writeRoots: [stateDir], env: { PI_CODING_AGENT_DIR: stateDir }, networkDomains: ['127.0.0.1'],
      mcpAdapterServers: [{ name: 'fixture', definition: { url: `http://127.0.0.1:${address.port}/mcp` } }],
      broker: { dispatch: (_id, _reservation, send) => send(), settle: () => {} },
    };
    const context = { entries: [], branch: [], sessionId: 'durable:1', leafId: null, model: provider.model };
    plugins = await openDurablePlugins(request, { context });
    await plugins.beforePrompt('Call the approved gateway');
    const gateway = plugins.tools.find(tool => tool.name === 'mcp')!;
    expect(gateway).toBeDefined();
    const result = await gateway.execute('gateway-effect', { server: 'fixture', tool: 'record', args: { text: 'frozen gateway effect' } }, undefined, undefined, undefined!);
    expect(JSON.stringify(result)).toContain('MCP accepted approved result');
    expect(await readFile(join(workspace, 'mcp-result.txt'), 'utf8')).toBe('frozen gateway effect');
    expect(methods).toContain('initialize'); expect(methods).toContain('tools/call');
    await plugins.close();
    plugins = await openDurablePlugins(request, { context });
    await plugins.beforePrompt('Continue with the same approved gateway after reopening');
    const reopenedGateway = plugins.tools.find(tool => tool.name === 'mcp')!;
    await reopenedGateway.execute('gateway-reopened-effect', { server: 'fixture', tool: 'record', args: { text: 'gateway effect after reopening' } }, undefined, undefined, undefined!);
    expect(await readFile(join(workspace, 'mcp-result.txt'), 'utf8')).toBe('gateway effect after reopening');
    expect(methods.filter(method => method === 'tools/call')).toHaveLength(2);
  } finally { await plugins?.close(); await provider.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, {recursive:true,force:true}); }
}, 30_000);
