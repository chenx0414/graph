import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { git as runGit } from '../../src/git/git.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const fixtureDir = fileURLToPath(new URL('../fixtures/', import.meta.url));

/** Minimal Streamable HTTP MCP server for the remote capability tests. */
async function remoteMcp() {
  let calls = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method?: string; params?: { arguments?: { text?: string } } };
    if (request.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    if (request.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'remote-fixture', version: '1.0.0' } } }));
      return;
    }
    if (request.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } }));
      return;
    }
    if (request.method === 'tools/call') {
      calls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: `remote:${request.params?.arguments?.text ?? ''}` }], isError: false } }));
      return;
    }
    res.writeHead(500); res.end();
  });
  await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls: () => calls,
    close: () => new Promise<void>((resolvePromise, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolvePromise()); }),
  };
}

function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function entry(baseUrl: string) {
  return {
    id: 'local', provider: 'graph-openai' as const, grade: 'high' as const, api: 'openai-completions' as const,
    baseUrl, contextWindow: 32_000, maxTokens: 256, cost: { input: 1_000_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0 },
  };
}

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'graph-capability-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  return { root, workspace };
}

async function checkedTask(runtime: Awaited<ReturnType<typeof openTaskRuntime>>, workspace: string) {
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Use the bound capability.', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Use the bound capability',
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

test('a definition-bound skill is loaded into the production worker prompt and readable', async () => {
  const { root, workspace } = await project();
  const skill = join(root, 'skill');
  await mkdir(skill);
  await writeFile(join(skill, 'SKILL.md'), [
    '---', 'name: title-lookup', 'description: Case-insensitive title matching rules.', '---',
    '# Title lookup', 'Always match titles case-insensitively.',
  ].join('\n'));
  // The install snapshot lives under the canonical state directory; Pi prints the same path.
  const skillFile = join(await realpath(root), 'state', 'capabilities', 'lookup', '1.0.0', 'SKILL.md');
  const provider = await openaiServer([
    { tools: [{ id: 'r1', name: 'read', arguments: JSON.stringify({ path: skillFile }) }] },
    { text: 'Read the bound skill.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }],
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: checkAction(workspace) },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high', capabilities: [{ id: 'lookup', version: '1.0.0' }] }, 'coder');
  await runtime.catalog.install({ id: 'lookup', kind: 'skill', source: skill, version: '1.0.0', requestId: 'install' });

  await checkedTask(runtime, workspace);
  await runtime.host.drive();

  const first = provider.requests[0] as { tools?: { function: { name: string } }[] };
  expect(JSON.stringify(provider.requests[0])).toContain('title-lookup');
  expect(JSON.stringify(provider.requests[0])).toContain('Case-insensitive title matching rules');
  expect(first.tools?.map(tool => tool.function.name)).toContain('read');
  expect(JSON.stringify(provider.requests[1])).toContain('Always match titles case-insensitively');
});

test('a definition-bound MCP tool is callable, metered, and confined by the sandbox', async () => {
  const { root, workspace } = await project();
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'formal');
  const mcp = join(root, 'mcp');
  await mkdir(mcp);
  await copyFile(join(fixtureDir, 'mcp-capability-server.mjs'), join(mcp, 'server.mjs'));
  await writeFile(join(mcp, 'capability.json'), JSON.stringify({ kind: 'mcp', command: process.execPath, args: ['./server.mjs'] }));
  const provider = await openaiServer([
    { tools: [{ id: 'm1', name: 'mcp_proof_write_proof', arguments: JSON.stringify({ outside }) }] },
    { text: 'Called the bound MCP capability.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }],
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: checkAction(workspace) },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high', capabilities: [{ id: 'proof', version: '1.0.0' }] }, 'coder');
  await runtime.catalog.install({ id: 'proof', kind: 'mcp', source: mcp, version: '1.0.0', requestId: 'install' });

  const task = await checkedTask(runtime, workspace);
  await runtime.host.drive();

  expect(await readFile(join(workspace, 'mcp-capability.txt'), 'utf8')).toBe('mcp capability write');
  expect(await readFile(outside, 'utf8')).toBe('formal');
  expect(JSON.stringify(provider.requests[1])).toContain('outsideDenied');
  const view = await task.view();
  const measurements = view.invocations.filter(row => row.usage && row.usage.input === 0 && row.usage.output === 0 && row.usage.cacheRead === 0);
  expect(measurements.length).toBeGreaterThanOrEqual(2); // one tools/list plus one tools/call
  expect(view.cost).toMatchObject({ amount: expect.any(Number) });
  expect((view.cost as { amount: number }).amount).toBeGreaterThan(0);
  expect(view.questions).toEqual([]);
});

test('a paused task cannot start a bound MCP capability process', async () => {
  const { root, workspace } = await project();
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'formal');
  const mcp = join(root, 'mcp');
  await mkdir(mcp);
  await copyFile(join(fixtureDir, 'mcp-capability-server.mjs'), join(mcp, 'server.mjs'));
  await writeFile(join(mcp, 'capability.json'), JSON.stringify({ kind: 'mcp', command: process.execPath, args: ['./server.mjs'] }));
  let task: Awaited<ReturnType<Awaited<ReturnType<typeof openTaskRuntime>>['user']['task']>>;
  const provider = await openaiServer([
    { tools: [{ id: 'm1', name: 'mcp_proof_write_proof', arguments: JSON.stringify({ outside }) }], beforeReply: async () => { await task.pause('pause'); } },
    { text: 'Stopped before the capability call.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }],
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: checkAction(workspace) },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high', capabilities: [{ id: 'proof', version: '1.0.0' }] }, 'coder');
  await runtime.catalog.install({ id: 'proof', kind: 'mcp', source: mcp, version: '1.0.0', requestId: 'install' });

  task = await checkedTask(runtime, workspace);
  await runtime.host.drive();
  expect((await task.view()).paused).toBe(true);
  await expect(readFile(join(workspace, 'mcp-capability.txt'), 'utf8')).rejects.toThrow();
  expect(await readFile(outside, 'utf8')).toBe('formal');
});

test('a bound MCP tool cannot rewrite Git metadata through relative paths', async () => {
  const { root, workspace } = await project();
  git(workspace, ['init', '-b', 'main']);
  await writeFile(join(workspace, 'README.md'), 'project\n');
  git(workspace, ['add', 'README.md']);
  git(workspace, ['commit', '-m', 'init']);
  const head = await readFile(join(workspace, '.git', 'HEAD'), 'utf8');
  const mcp = join(root, 'mcp');
  await mkdir(mcp);
  await copyFile(join(fixtureDir, 'mcp-capability-server.mjs'), join(mcp, 'server.mjs'));
  await writeFile(join(mcp, 'capability.json'), JSON.stringify({ kind: 'mcp', command: process.execPath, args: ['./server.mjs'] }));
  const provider = await openaiServer([
    { tools: [{ id: 'm1', name: 'mcp_proof_write_git', arguments: JSON.stringify({}) }] },
    { text: 'Tried to rewrite Git metadata.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }],
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: checkAction(workspace) },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high', capabilities: [{ id: 'proof', version: '1.0.0' }] }, 'coder');
  await runtime.catalog.install({ id: 'proof', kind: 'mcp', source: mcp, version: '1.0.0', requestId: 'install' });

  const task = await checkedTask(runtime, workspace);
  await runtime.host.drive();

  expect(JSON.stringify(provider.requests[1])).toContain('gitDenied');
  expect(JSON.stringify(provider.requests[1])).toContain('true');
  expect(await readFile(join(workspace, '.git', 'HEAD'), 'utf8')).toBe(head);
  expect((await task.view()).questions).toEqual([]);
});

test('a definition-bound extension loads in the restricted worker and its tool is callable and metered', async () => {
  const { root, workspace } = await project();
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'formal');
  const extension = join(root, 'extension');
  await mkdir(extension);
  await copyFile(join(fixtureDir, 'extension-capability.mjs'), join(extension, 'extension.mjs'));
  await writeFile(join(extension, 'capability.json'), JSON.stringify({ kind: 'extension', entry: './extension.mjs' }));
  const provider = await openaiServer([
    { tools: [{ id: 'e1', name: 'mcp_ext_write_proof', arguments: JSON.stringify({ outside }) }] },
    { text: 'Called the bound extension.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }],
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: checkAction(workspace) },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high', capabilities: [{ id: 'ext', version: '1.0.0' }] }, 'coder');
  await runtime.catalog.install({ id: 'ext', kind: 'extension', source: extension, version: '1.0.0', requestId: 'install' });

  const task = await checkedTask(runtime, workspace);
  await runtime.host.drive();

  expect(await readFile(join(workspace, 'extension-capability.txt'), 'utf8')).toBe('extension capability write');
  expect(await readFile(outside, 'utf8')).toBe('formal');
  expect(JSON.stringify(provider.requests[1])).toContain('outsideDenied');
  const view = await task.view();
  expect(view.questions).toEqual([]);
  const measurements = view.invocations.filter(row => row.usage && row.usage.input === 0 && row.usage.output === 0);
  expect(measurements.length).toBeGreaterThanOrEqual(2); // one tools/list plus one tools/call
});

test('a definition-bound remote MCP tool is callable through the granted domain allowlist and metered', async () => {
  const { root, workspace } = await project();
  const mcp = join(root, 'remote');
  await mkdir(mcp);
  const server = await remoteMcp();
  cleanup.push(() => server.close());
  await writeFile(join(mcp, 'capability.json'), JSON.stringify({ kind: 'mcp', transport: 'http', url: server.url }));
  const provider = await openaiServer([
    { tools: [{ id: 'm1', name: 'mcp_remote_echo', arguments: JSON.stringify({ text: 'hello' }) }] },
    { text: 'Called the remote MCP capability.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace, grants: ['mcp:remote:echo'] }],
    network: { mcpDomains: ['127.0.0.1'] },
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: checkAction(workspace) },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high', capabilities: [{ id: 'remote', version: '1.0.0' }] }, 'coder');
  await runtime.catalog.install({ id: 'remote', kind: 'mcp', source: mcp, version: '1.0.0', requestId: 'install' });

  const task = await checkedTask(runtime, workspace);
  await runtime.host.drive();

  expect(JSON.stringify(provider.requests[1])).toContain('remote:hello');
  expect(server.calls()).toBe(1);
  const view = await task.view();
  expect(view.questions).toEqual([]);
  const measurements = view.invocations.filter(row => row.usage && row.usage.input === 0 && row.usage.output === 0);
  expect(measurements.length).toBeGreaterThanOrEqual(2); // one tools/list plus one tools/call
});

test('a remote MCP host outside the granted domains stops the node with a concrete reason', async () => {
  const { root, workspace } = await project();
  const mcp = join(root, 'remote');
  await mkdir(mcp);
  const server = await remoteMcp();
  cleanup.push(() => server.close());
  await writeFile(join(mcp, 'capability.json'), JSON.stringify({ kind: 'mcp', transport: 'http', url: server.url }));
  const provider = await openaiServer([{ text: 'Should not be reached.' }]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }],
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: checkAction(workspace) },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high', capabilities: [{ id: 'remote', version: '1.0.0' }] }, 'coder');
  await runtime.catalog.install({ id: 'remote', kind: 'mcp', source: mcp, version: '1.0.0', requestId: 'install' });

  const task = await checkedTask(runtime, workspace);
  await runtime.host.drive();
  const view = await task.view();
  const question = view.questions.find(item => item.kind === 'execution_failed');
  expect(question).toBeTruthy();
  expect(JSON.stringify(question!.data)).toContain('not in the granted MCP domains');
  expect(provider.requests).toHaveLength(0);
  expect(server.calls()).toBe(0);
});
