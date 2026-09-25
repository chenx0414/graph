import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { CapabilityLibrary } from '../../src/catalog/capability-library.ts';
import { Catalog } from '../../src/catalog/catalog.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { TaskStore } from '../../src/core/store.ts';
import { fullAccessPolicy, resolveAccessPolicy } from '../../src/core/access-policy.ts';
import { git as runGit } from '../../src/git/git.ts';
import { capabilityConfigViews } from '../../src/catalog/capability-config.ts';
import { loadCapabilities } from '../../src/runtime/capabilities.ts';
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

test('a packaged Electron runtime grants its own bundle frameworks to sandboxed helpers', async () => {
  const { nodeReadPaths } = await import('../../src/runtime/capabilities.ts');
  expect(nodeReadPaths('/Applications/Graph.app/Contents/MacOS/Graph', '44.3.0')).toEqual([
    '/Applications/Graph.app/Contents/MacOS',
    '/Applications/Graph.app/Contents',
  ]);
  expect(nodeReadPaths('/usr/local/bin/node', undefined)).toEqual(['/usr/local/bin']);
});
