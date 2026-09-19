import { cp, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { CapabilityLibrary } from '../../src/catalog/capability-library.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { git as runGit } from '../../src/git/git.ts';
import { capabilityConfigViews } from '../../src/catalog/capability-config.ts';
import { verifyMcpCapability } from '../../src/runtime/capabilities.ts';
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

function catalogOptions(root: string) {
  return {
    catalog: {
      capabilityRoot: join(root, 'graph', 'capabilities'),
      recipesPath: join(root, 'graph', 'agent-combinations.json'),
    },
  };
}

async function installCapability(
  runtime: Awaited<ReturnType<typeof openTaskRuntime>>,
  root: string,
  input: { id: string; kind: 'skill' | 'mcp' | 'extension' | 'pi-extension'; source: string; version: string; role?: 'agent' | 'tool' },
) {
  const destination = join(root, 'graph', 'capabilities', input.id);
  await cp(input.source, destination, { recursive: true });
  const manifestPath = join(destination, 'capability.json');
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>; } catch { /* source may not have a Graph manifest */ }
  await writeFile(manifestPath, JSON.stringify({
    ...existing,
    id: input.id,
    kind: input.kind,
    version: input.version,
    name: input.id,
    ...(input.role ? { role: input.role } : {}),
  }, null, 2));
  await runtime.catalog.refreshCatalog();
  return destination;
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

test('allowlisted local MCP commands resolve through PATH and start the server', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-mcp-command-path-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const capabilityRoot = join(root, 'graph', 'capabilities');
  await mkdir(bin, { recursive: true });
  await symlink(process.execPath, join(bin, 'uvx'));
  await writeFile(join(bin, 'npx'), [
    "import { pathToFileURL } from 'node:url';",
    "await import(pathToFileURL(process.argv[2]).href);",
  ].join('\n'), { mode: 0o755 });

  for (const command of ['uvx', 'npx']) {
    const capability = join(capabilityRoot, `${command}-lookup`);
    await mkdir(capability, { recursive: true });
    await copyFile(join(fixtureDir, 'mcp-read-capability-server.mjs'), join(capability, 'server.mjs'));
    await writeFile(join(capability, 'capability.json'), JSON.stringify({
      id: `${command}-lookup`,
      kind: 'mcp',
      version: '1.0.0',
      name: `${command} lookup`,
      command,
      args: ['./server.mjs'],
      networkDomains: ['github.com'],
    }, null, 2));
  }

  const library = new CapabilityLibrary({ capabilityRoot });
  await library.refresh();
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  try {
    for (const command of ['uvx', 'npx']) {
      const result = await verifyMcpCapability(library.capability(`${command}-lookup`, '1.0.0')!);
      expect(result.ok, result.message).toBe(true);
      expect(result.tools).toEqual(['search_repositories']);
    }
  } finally {
    process.env.PATH = originalPath;
  }
}, 120_000);

test('a definition-bound skill is loaded into the production worker prompt and readable', async () => {
  const { root, workspace } = await project();
  const skill = join(root, 'skill');
  await mkdir(skill);
  await writeFile(join(skill, 'SKILL.md'), [
    '---', 'name: title-lookup', 'description: Case-insensitive title matching rules.', '---',
    '# Title lookup', 'Always match titles case-insensitively.',
  ].join('\n'));
  // The capability copy lives under the user-owned Graph home; Pi prints the same path.
  const skillFile = join(await realpath(root), 'graph', 'capabilities', 'lookup', 'SKILL.md');
  const provider = await openaiServer([
    { tools: [{ id: 'r1', name: 'read', arguments: JSON.stringify({ path: skillFile }) }] },
    { text: 'Read the bound skill.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }],
    ...catalogOptions(root),
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: checkAction(workspace) },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high', capabilities: [{ id: 'lookup', version: '1.0.0' }] }, 'coder');
  await installCapability(runtime, root, { id: 'lookup', kind: 'skill', source: skill, version: '1.0.0' });

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
    ...catalogOptions(root),
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: checkAction(workspace) },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high', capabilities: [{ id: 'proof', version: '1.0.0' }] }, 'coder');
  await installCapability(runtime, root, { id: 'proof', kind: 'mcp', source: mcp, version: '1.0.0' });

  const task = await checkedTask(runtime, workspace);
  await runtime.host.drive();

  const view = await task.view();
  // Capability writes land in the worker's isolated work copy.
  const workerTree = view.worktrees.find(item => item.nodeId === 'work')!.path;
  expect(await readFile(join(workerTree, 'mcp-capability.txt'), 'utf8')).toBe('mcp capability write');
  expect(await readFile(outside, 'utf8')).toBe('formal');
  expect(JSON.stringify(provider.requests[1])).toContain('outsideDenied');
  const measurements = view.invocations.filter(row => row.usage && row.usage.input === 0 && row.usage.output === 0 && row.usage.cacheRead === 0);
  expect(measurements.length).toBeGreaterThanOrEqual(2); // one tools/list plus one tools/call
  expect(view.cost).toMatchObject({ amount: expect.any(Number) });
  expect((view.cost as { amount: number }).amount).toBeGreaterThan(0);
  expect(view.questions).toEqual([]);
});

test('credential-bound MCP configuration is visible, explicit values load it, and missing values fail closed', async () => {
  const { root, workspace } = await project();
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const mcp = join(capabilityRoot, 'configured');
  await mkdir(mcp, { recursive: true });
  await copyFile(join(fixtureDir, 'mcp-config-capability-server.mjs'), join(mcp, 'server.mjs'));
  const manifest = {
    id: 'configured',
    kind: 'mcp',
    version: '1.0.0',
    name: 'Configured MCP',
    command: process.execPath,
    args: ['./server.mjs'],
    env: { MCP_CONFIG_TEST_TOKEN: '${MCP_CONFIG_TEST_TOKEN}' },
  };
  await writeFile(join(mcp, 'capability.json'), JSON.stringify(manifest, null, 2));
  const provider = await openaiServer([
    { tools: [{ id: 'configured-call', name: 'mcp_configured_configured_search', arguments: JSON.stringify({ query: 'graph' }) }] },
    { text: 'Configured MCP completed.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: workspace }],
    catalog: { capabilityRoot, recipesPath: join(root, 'graph', 'agent-combinations.json') },
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: checkAction(workspace) },
    capabilitySecrets: () => ({ MCP_CONFIG_TEST_TOKEN: 'test-value' }),
  });
  cleanup.push(() => runtime.close());
  const record = runtime.catalog.capability('configured', '1.0.0');
  expect(record).toBeDefined();

  const missing = await capabilityConfigViews([record!], {});
  expect(missing).toEqual([
    expect.objectContaining({
      id: 'configured',
      ready: false,
      missing: ['MCP_CONFIG_TEST_TOKEN'],
      fields: [expect.objectContaining({ env: 'MCP_CONFIG_TEST_TOKEN', secret: true, reason: '环境变量 MCP_CONFIG_TEST_TOKEN' })],
    }),
  ]);
  const configured = await capabilityConfigViews([record!], { MCP_CONFIG_TEST_TOKEN: 'test-value' });
  expect(configured[0]).toMatchObject({ ready: true, configured: ['MCP_CONFIG_TEST_TOKEN'], missing: [] });

  const denied = await verifyMcpCapability(record!, {});
  expect(denied.ok).toBe(false);
  expect(denied.message).toContain('MCP_CONFIG_TEST_TOKEN');
  const verified = await verifyMcpCapability(record!, { MCP_CONFIG_TEST_TOKEN: 'test-value' });
  expect(verified).toMatchObject({ ok: true, tools: ['configured_search'] });

  runtime.catalog.publishDefinition('coder', {
    recommendedGrade: 'high',
    capabilities: [{ id: 'configured', version: '1.0.0' }],
  }, 'configured-agent');
  const task = await checkedTask(runtime, workspace);
  await runtime.host.drive();
  expect(JSON.stringify(provider.requests[1])).toContain('configured:graph:10');
  expect((await task.view()).questions).toEqual([]);
});

test('a local MCP reaches only the network domains declared by its capability manifest', async () => {
  const { root, workspace } = await project();
  let hits = 0;
  const server = createServer((_request, response) => { hits += 1; response.end('network-ok'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  const port = (server.address() as AddressInfo).port;
  const mcp = join(root, 'network-mcp');
  await mkdir(mcp);
  await copyFile(join(fixtureDir, 'mcp-network-capability-server.mjs'), join(mcp, 'server.mjs'));
  await writeFile(join(mcp, 'capability.json'), JSON.stringify({
    kind: 'mcp', command: process.execPath, args: ['./server.mjs'], networkDomains: ['127.0.0.1'],
  }));
  const provider = await openaiServer([
    { tools: [{ id: 'n1', name: 'mcp_network_probe_network', arguments: JSON.stringify({ url: `http://127.0.0.1:${port}/probe` }) }] },
    { text: 'Network capability completed.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace, grants: ['mcp:network:probe_network'] }],
    ...catalogOptions(root),
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: checkAction(workspace) },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high', capabilities: [{ id: 'network', version: '1.0.0' }] }, 'coder');
  await installCapability(runtime, root, { id: 'network', kind: 'mcp', source: mcp, version: '1.0.0' });

  const task = await checkedTask(runtime, workspace);
  await runtime.host.drive();

  expect(hits).toBe(1);
  expect(JSON.stringify(provider.requests[1])).toContain('network:200:network-ok');
  expect((await task.view()).questions).toEqual([]);
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
    ...catalogOptions(root),
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: checkAction(workspace) },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high', capabilities: [{ id: 'proof', version: '1.0.0' }] }, 'coder');
  await installCapability(runtime, root, { id: 'proof', kind: 'mcp', source: mcp, version: '1.0.0' });

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
    ...catalogOptions(root),
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: checkAction(workspace) },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high', capabilities: [{ id: 'proof', version: '1.0.0' }] }, 'coder');
  await installCapability(runtime, root, { id: 'proof', kind: 'mcp', source: mcp, version: '1.0.0' });

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
    ...catalogOptions(root),
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: checkAction(workspace) },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high', capabilities: [{ id: 'ext', version: '1.0.0' }] }, 'coder');
  await installCapability(runtime, root, { id: 'ext', kind: 'extension', source: extension, version: '1.0.0' });

  const task = await checkedTask(runtime, workspace);
  await runtime.host.drive();

  const view = await task.view();
  const workerTree = view.worktrees.find(item => item.nodeId === 'work')!.path;
  expect(await readFile(join(workerTree, 'extension-capability.txt'), 'utf8')).toBe('extension capability write');
  expect(await readFile(outside, 'utf8')).toBe('formal');
  expect(JSON.stringify(provider.requests[1])).toContain('outsideDenied');
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
    ...catalogOptions(root),
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: checkAction(workspace) },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high', capabilities: [{ id: 'remote', version: '1.0.0' }] }, 'coder');
  await installCapability(runtime, root, { id: 'remote', kind: 'mcp', source: mcp, version: '1.0.0' });

  const task = await checkedTask(runtime, workspace);
  await runtime.host.drive();

  expect(JSON.stringify(provider.requests[1])).toContain('remote:hello');
  expect(server.calls()).toBe(1);
  const view = await task.view();
  expect(view.questions).toEqual([]);
  const measurements = view.invocations.filter(row => row.usage && row.usage.input === 0 && row.usage.output === 0);
  expect(measurements.length).toBeGreaterThanOrEqual(2); // one tools/list plus one tools/call
});

test('a packaged Electron runtime grants its own bundle frameworks to sandboxed helpers', async () => {
  const { nodeReadPaths } = await import('../../src/runtime/capabilities.ts');
  expect(nodeReadPaths('/Applications/Graph.app/Contents/MacOS/Graph', '44.3.0')).toEqual([
    '/Applications/Graph.app/Contents/MacOS',
    '/Applications/Graph.app/Contents',
  ]);
  expect(nodeReadPaths('/usr/local/bin/node', undefined)).toEqual(['/usr/local/bin']);
});
