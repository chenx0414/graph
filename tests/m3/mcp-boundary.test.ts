import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { callMcpTool, httpExchange } from '../../src/runtime/mcp-client.ts';
import type { RestrictedGate } from '../../src/runtime/restricted-process.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

/** Minimal Streamable HTTP MCP server with one read and one destructive tool. */
async function remoteTools(onRequest?: (method: string) => Promise<void> | void) {
  let calls = 0;
  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method?: string };
    methods.push(request.method ?? '');
    await onRequest?.(request.method ?? '');
    if (request.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    let result: unknown;
    if (request.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-external', version: '1' } };
    else if (request.method === 'tools/list') result = { tools: [
      { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'delete_records', description: 'Delete external service records', annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { type: 'object', properties: {} } },
    ] };
    else if (request.method === 'tools/call') { calls += 1; result = { content: [{ type: 'text', text: 'external records deleted' }], isError: false }; }
    else { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    methods,
    calls: () => calls,
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }),
  };
}

test('a pause between HTTP requests stops the next request of the same MCP exchange', async () => {
  const server = await remoteTools();
  cleanup.push(() => server.close());
  const dispatches: string[] = [];
  const gate: RestrictedGate = {
    dispatch(id, _reservation, send) {
      dispatches.push(id);
      if (dispatches.length >= 2) throw new Error('paused');
      return send();
    },
    settle() {},
  };
  const exchange = httpExchange({ gate, url: server.url });
  await expect(callMcpTool(exchange, 'echo', { text: 'do not send' })).rejects.toThrow('paused');
  expect(dispatches).toHaveLength(2);
  expect(server.methods).toEqual(['initialize']);
  expect(server.calls()).toBe(0);
});

function entry(baseUrl: string) {
  return {
    id: 'local', provider: 'graph-openai' as const, grade: 'high' as const, api: 'openai-completions' as const,
    baseUrl, contextWindow: 32_000, maxTokens: 256, cost: { input: 1_000_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0 },
  };
}

async function checkedTask(runtime: Awaited<ReturnType<typeof openTaskRuntime>>, workspace: string) {
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Use the remote capability.', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Use the remote capability',
    acceptance: [{ id: 'ok', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  return runtime.user.task(taskId);
}

function checkAction(workspace: string) {
  return {
    kind: 'program' as const,
    prepare: async () => async () => ({
      outcome: 'completed' as const, output: null,
      evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: join(workspace, 'ok.txt'), digest: 'a'.repeat(64) } }],
    }),
  };
}

async function permissionFixture(grants: string[], plans?: ResponsePlan[], hooks: { onRequest?: (method: string) => Promise<void> | void } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'graph-mcp-boundary-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  const capability = join(root, 'graph', 'capabilities', 'remote');
  await mkdir(capability, { recursive: true });
  const server = await remoteTools(method => hooks.onRequest?.(method));
  cleanup.push(() => server.close());
  await writeFile(join(capability, 'capability.json'), JSON.stringify({ id: 'remote', kind: 'mcp', version: '1.0.0', name: 'Remote', transport: 'http', url: server.url }));
  const provider = await openaiServer(plans ?? [
    { tools: [{ id: 'x', name: 'mcp_remote_delete_records', arguments: '{}' }] },
    { text: 'Stopped after the denial.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace, ...(grants.length ? { grants } : {}) }],
    catalog: { capabilityRoot: join(root, 'graph', 'capabilities'), recipesPath: join(root, 'graph', 'agent-combinations.json') },
    network: { mcpDomains: ['127.0.0.1'] },
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: checkAction(workspace) },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high', capabilities: [{ id: 'remote', version: '1.0.0' }] }, 'coder');
  const task = await checkedTask(runtime, workspace);
  return { runtime, task, server, provider };
}

test('a remote MCP write tool without a task grant is refused with a permission question', async () => {
  const { runtime, task, server, provider } = await permissionFixture([]);
  await runtime.host.drive();
  const view = await task.view();
  expect(server.calls()).toBe(0);
  expect(server.methods).not.toContain('tools/call');
  expect(view.questions).toEqual([expect.objectContaining({ kind: 'permission', data: { grant: 'mcp:remote:delete_records' } })]);
  expect(JSON.stringify(provider.requests[1])).toContain('Permission required');
  expect(JSON.stringify(provider.requests[1])).toContain('mcp:remote:delete_records');
  expect(view.nodes.find(node => node.id === 'work')!.status).not.toBe('succeeded');
});

test('a grant for another tool or service does not authorize the call', async () => {
  const { runtime, task, server } = await permissionFixture(['mcp:remote:echo', 'mcp:other:delete_records']);
  await runtime.host.drive();
  const view = await task.view();
  expect(server.calls()).toBe(0);
  expect(view.questions).toEqual([expect.objectContaining({ kind: 'permission', data: { grant: 'mcp:remote:delete_records' } })]);
});

test('a matching task grant authorizes the remote tool and is metered', async () => {
  const { runtime, task, server } = await permissionFixture(['mcp:remote:delete_records']);
  await runtime.host.drive();
  const view = await task.view();
  expect(server.calls()).toBe(1);
  expect(view.questions).toEqual([]);
  expect(view.phase).toBe('completed');
  const measured = view.invocations.filter(row => row.usage && row.usage.input === 0 && row.usage.output === 0);
  expect(measured.length).toBeGreaterThanOrEqual(2); // handshake plus tools/call
});

test('a task pause during the tool-call handshake stops the tools/call request', async () => {
  const hooks: { onRequest?: (method: string) => Promise<void> | void } = {};
  const { runtime, task, server } = await permissionFixture(['mcp:remote:delete_records'], undefined, hooks);
  let initializations = 0;
  hooks.onRequest = async method => { if (method === 'initialize' && ++initializations === 2) await task.pause('pause-in-handshake'); };
  await runtime.host.drive();
  expect(server.calls()).toBe(0);
  expect(server.methods.filter(method => method === 'tools/call')).toEqual([]);
  expect(server.methods.filter(method => method === 'initialize')).toHaveLength(2);
  expect((await task.view()).paused).toBe(true);
});

test('answering the permission question with the grant lets the next attempt run', async () => {
  const { runtime, task, server, provider } = await permissionFixture([], [
    { tools: [{ id: 'x', name: 'mcp_remote_delete_records', arguments: '{}' }] },
    { text: 'Stopped after the denial.' },
    { tools: [{ id: 'y', name: 'mcp_remote_delete_records', arguments: '{}' }] },
    { text: 'Deleted after the grant.' },
  ]);
  await runtime.host.drive();
  const blocked = await task.view();
  const question = blocked.questions.find(item => item.kind === 'permission')!;
  expect(server.calls()).toBe(0);
  await task.answer(question.id, { type: 'grant', grant: 'mcp:remote:delete_records' }, 'grant');
  await runtime.host.drive();
  const done = await task.view();
  expect(server.calls()).toBe(1);
  expect(done.questions.filter(item => item.status === 'open')).toEqual([]);
  expect(done.questions).toEqual([expect.objectContaining({ kind: 'permission', status: 'resolved' })]);
  expect(done.evidence).toHaveLength(1);
  expect(provider.requests.length).toBeGreaterThanOrEqual(4);
});
