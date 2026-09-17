import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-conversation-readonly-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A bound extension tries to write a business file. Discussion must refuse;
 * the confirmed worker with the same capability proves the write path works. */
test('a bound extension cannot write business files during discussion but a worker can', async () => {
  const root = await temp('extension');
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'check.js'), 'console.log("ok");\n');
  const source = join(root, 'graph', 'capabilities', 'ext');
  await mkdir(source, { recursive: true });
  await copyFile(new URL('../fixtures/extension-capability.mjs', import.meta.url), join(source, 'extension.mjs'));
  await writeFile(join(source, 'capability.json'), JSON.stringify({ id: 'ext', kind: 'extension', version: '1.0.0', name: 'Extension', entry: './extension.mjs' }));

  const provider = await openaiServer([
    { tools: [{ id: 'discussion-call', name: 'mcp_ext_write_proof', arguments: JSON.stringify({ outside: join(root, 'outside.txt') }) }] },
    { text: 'Discussion completed.' },
    { tools: [{ id: 'worker-call', name: 'mcp_ext_write_proof', arguments: JSON.stringify({ outside: join(root, 'outside.txt') }) }] },
    { text: 'Worker completed.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: workspace }],
    catalog: { capabilityRoot: join(root, 'graph', 'capabilities'), recipesPath: join(root, 'graph', 'agent-combinations.json') },
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      apiKey: 'scripted-local-key', modelRuntime: provider.runtime,
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high', capabilities: [{ id: 'ext', version: '1.0.0' }] }, 'master');
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium', capabilities: [{ id: 'ext', version: '1.0.0' }] }, 'coder');

  // Discussion: the model calls the same capability tool, but the worker runs
  // with the business directory read-only.
  const created = await runtime.conversations.create({ projectId: 'p', text: '只讨论，先看看项目。不要修改业务文件。', requestId: 'create' });
  await runtime.host.runReady();
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.tasks).toHaveLength(0);
  await expect(readFile(join(workspace, 'extension-capability.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  const refusal = view.messages.filter(message => message.role === 'tool').map(message => message.text).join('\n');
  expect(refusal).toContain('mcp_ext_write_proof');

  // Positive control: the same capability bound to a confirmed worker writes.
  await runtime.supervisor(created.taskId).propose({
    requirementVersion: 1, summary: '验证能力边界',
    acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
    ],
  }, 'draft');
  await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm' });
  await runtime.host.runReady();
  const confirmed = await runtime.conversations.view(created.conversationId);
  const feature = confirmed.tasks[0]!;
  const taskView = await runtime.user.task(feature.id).view();
  const tree = taskView.worktrees.find(item => item.nodeId === 'work')!.path;
  expect(await readFile(join(tree, 'extension-capability.txt'), 'utf8')).toBe('extension capability write');
}, 60_000);

test('a remote HTTP MCP tool is not offered during discussion even with a write grant', async () => {
  const root = await temp('remote');
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  const business = join(workspace, 'business.txt');
  await writeFile(business, 'original business file');
  let effects = 0;
  const mcp = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: unknown; method?: string };
    let result: unknown;
    if (message.method === 'notifications/initialized') { response.writeHead(202); response.end(); return; }
    if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'local-service', version: '1' } };
    else if (message.method === 'tools/list') result = { tools: [{ name: 'write_business', description: 'Replace business file', inputSchema: { type: 'object', properties: {}, required: [] } }] };
    else if (message.method === 'tools/call') { effects += 1; await writeFile(business, 'modified during read-only chat'); result = { content: [{ type: 'text', text: 'modified' }], isError: false }; }
    else { response.writeHead(500); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>(resolve => mcp.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { mcp.closeAllConnections(); await new Promise<void>(resolve => mcp.close(() => resolve())); });
  const source = join(root, 'graph', 'capabilities', 'remote');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'capability.json'), JSON.stringify({ id: 'remote', kind: 'mcp', version: '1.0.0', name: 'Remote', transport: 'http', url: `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp` }));
  const provider = await openaiServer([
    { tools: [{ id: 'remote-call', name: 'mcp_remote_write_business', arguments: '{}' }] },
    { text: 'Discussion finished.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: workspace, grants: ['mcp:remote:write_business'] }],
    catalog: { capabilityRoot: join(root, 'graph', 'capabilities'), recipesPath: join(root, 'graph', 'agent-combinations.json') },
    network: { mcpDomains: ['127.0.0.1'] },
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      apiKey: 'scripted-local-key', modelRuntime: provider.runtime,
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high', capabilities: [{ id: 'remote', version: '1.0.0' }] }, 'master');
  const created = await runtime.conversations.create({ projectId: 'p', text: '只讨论，先看看项目。不要修改业务文件。', requestId: 'create' });
  await runtime.host.runReady();
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.tasks).toHaveLength(0);
  expect(effects).toBe(0);
  expect(await readFile(business, 'utf8')).toBe('original business file');
  const offered = (provider.requests[0] as { tools?: { function?: { name?: string } }[] } | undefined)?.tools?.map(tool => tool.function?.name) ?? [];
  expect(offered).not.toContain('mcp_remote_write_business');
}, 60_000);
