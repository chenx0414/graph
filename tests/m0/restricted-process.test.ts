import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { openRestrictedExecutor } from '../../src/runtime/restricted-process.ts';
import { createWorkerRequests } from '../../src/runtime/worker-requests.ts';
import { CallBroker } from '../../src/runtime/call-broker.ts';
import { controlledOpenAIStream } from '../../src/runtime/controlled-openai.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const dirs: string[] = [];
let executor: Awaited<ReturnType<typeof openRestrictedExecutor>>;
beforeAll(async () => { executor = await openRestrictedExecutor(); });
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
afterAll(async () => { await executor?.close(); });

test('real macOS workers allow granted writes and block host state, credentials, symlinks, subprocess and network bypasses', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-sandbox-'))); dirs.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const protectedFile = join(root, 'formal.sqlite'); await writeFile(protectedFile, 'formal-state');
  const credentialFile = join(root, 'credentials'); await writeFile(credentialFile, 'synthetic-secret');
  const broker = new CallBroker(join(root, 'calls.sqlite'), 'agent-1');
  await symlink(protectedFile, join(workspace, 'link'));
  let networkHits = 0;
  const server = createServer((_req, res) => { networkHits++; res.end('reachable'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const script = `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    const results = {};
    const attempt = (key, action) => { try { action(); results[key] = 'allowed'; } catch { results[key] = 'denied'; } };
    attempt('workspace', () => writeFileSync('allowed.txt', 'ok'));
    attempt('formal', () => writeFileSync(${JSON.stringify(protectedFile)}, 'bad'));
    attempt('credential', () => readFileSync(${JSON.stringify(credentialFile)}));
    attempt('symlink', () => writeFileSync('link', 'bad'));
    attempt('child', () => execFileSync(process.execPath, ['-e', ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(protectedFile)},'bad')`)}], {stdio:'pipe'}));
    results.environment = process.env.GRAPH_TEST_CREDENTIAL === undefined ? 'denied' : 'allowed';
    try { await fetch(${JSON.stringify(url)}, {signal:AbortSignal.timeout(1000)}); results.network='allowed'; }
    catch { results.network='denied'; }
    console.log(JSON.stringify(results));
  `;
  await writeFile(join(workspace, 'probe.mjs'), script);
  process.env.GRAPH_TEST_CREDENTIAL = 'synthetic-parent-only';
  let result;
  try { result = await executor.run({ broker, cwd: workspace, executable: process.execPath, args: ['probe.mjs'], readPaths: [dirname(process.execPath)], writePaths: [workspace] }); }
  finally { delete process.env.GRAPH_TEST_CREDENTIAL; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ workspace: 'allowed', formal: 'denied', credential: 'denied', symlink: 'denied', child: 'denied', environment: 'denied', network: 'denied' });
  expect(await readFile(protectedFile, 'utf8')).toBe('formal-state');
  expect(await readFile(join(workspace, 'allowed.txt'), 'utf8')).toBe('ok');
  expect(networkHits).toBe(0);
  const pendingRun = executor.run({ broker, cwd: workspace, executable: process.execPath, args: ['probe.mjs'], readPaths: [dirname(process.execPath)], writePaths: [workspace] });
  broker.pause(); // Pause during asynchronous sandbox preparation, before OS spawn.
  await expect(pendingRun).rejects.toThrow('paused');
  expect(broker.inspect().calls).toHaveLength(1);
  broker.close();
});

test('worker preparation writes only to its granted scratch directory, even with a read-only cwd', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-readonly-worker-'))); dirs.push(root);
  const workspace = join(root, 'readonly'); await mkdir(workspace);
  const scratchDir = join(root, 'scratch'); await mkdir(scratchDir);
  await writeFile(join(workspace, 'source.txt'), 'Readable source');
  const broker = new CallBroker(join(root, 'calls.sqlite'), 'agent-1');
  try {
    const result = await executor.run({
      broker, cwd: workspace, scratchDir, executable: process.execPath,
      args: ['-e', "console.log(require('fs').readFileSync('source.txt','utf8'))"],
      readPaths: [dirname(process.execPath)], writePaths: [scratchDir],
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('Readable source');
    expect(await readdir(workspace)).toEqual(['source.txt']);
    expect((await readdir(scratchDir)).sort()).toEqual(['.worker-home', '.worker-tmp']);
  } finally { broker.close(); }
});

test('replacing a granted subdirectory with a symlink cannot redirect a later host grant', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-grant-swap-'))); dirs.push(root);
  const workspace = join(root, "worker's files"); await mkdir(workspace);
  const cache = join(workspace, 'cache'); await mkdir(cache);
  const protectedDir = join(root, 'protected'); await mkdir(protectedDir);
  const formal = join(protectedDir, 'formal.sqlite'); await writeFile(formal, 'unchanged');
  const broker = new CallBroker(join(root, 'calls.sqlite'), 'agent-1');
  const base = { broker, cwd: workspace, executable: process.execPath, readPaths: [dirname(process.execPath)] };
  try {
    const first = await executor.run({ ...base, writePaths: [workspace], args: ['-e', `
      const fs=require('fs'); fs.rmdirSync('cache'); fs.symlinkSync(${JSON.stringify(protectedDir)},'cache');
    `] });
    expect(first.code, first.stderr).toBe(0);
    await expect(executor.run({ ...base, writePaths: [cache], args: ['-e', "require('fs').writeFileSync('cache/formal.sqlite','bad')"] })).rejects.toThrow('canonical grant');
    expect(await readFile(formal, 'utf8')).toBe('unchanged');
  } finally { broker.close(); }
});

test('a scripted MCP server uses real stdio and inherits the same OS write restrictions', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-mcp-'))); dirs.push(root);
  const workspace = join(root, 'mcp'); await mkdir(workspace);
  const outside = join(root, 'formal'); await writeFile(outside, 'unchanged');
  const broker = new CallBroker(join(root, 'calls.sqlite'), 'agent-1');
  try {
    const result = await executor.run({
      broker, cwd: workspace, executable: process.execPath, args: [resolve('tests/fixtures/mcp-server.ts')],
      readPaths: [dirname(process.execPath), resolve('tests/fixtures'), resolve('package.json')], writePaths: [workspace],
      input: [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'graph', version: '0.0.0' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write', arguments: { outside } } },
      ].map(value => JSON.stringify(value) + '\n').join(''),
    });
    expect(result.code, result.stderr).toBe(0);
    const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(replies[1].result).toMatchObject({ content: [{ type: 'text', text: '{"outsideDenied":true}' }], isError: false });
    expect(await readFile(join(workspace, 'mcp-result.txt'), 'utf8')).toBe('authorized MCP write');
    expect(await readFile(outside, 'utf8')).toBe('unchanged');
  } finally { broker.close(); }
});

test('the real Pi SDK runs in the OS sandbox while the host owns its provider credential and usage ledger', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-real-pi-worker-'))); dirs.push(root);
  const workspace = join(root, 'worker'); await mkdir(workspace);
  const provider = await openaiServer([{}]);
  const gate = new CallBroker(join(root, 'calls.sqlite'), 'agent-1');
  try {
    const result = await executor.run({
      broker: gate,
      cwd: workspace, executable: process.execPath, args: [resolve('tests/fixtures/sandboxed-pi.ts'), workspace, JSON.stringify(provider.model)],
      readPaths: [dirname(process.execPath), resolve('src'), resolve('tests/fixtures'), resolve('node_modules'), resolve('package.json')],
      writePaths: [workspace],
      onRequest: createWorkerRequests({ broker: gate, model: provider.model, stream: controlledOpenAIStream(gate, 'host-only-key'), resources: {} }),
    });
    expect(result.code, result.stderr).toBe(0);
    const snapshot = JSON.parse(result.stdout);
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[1]).toMatchObject({ role: 'assistant', stopReason: 'stop' });
    expect(provider.requests).toHaveLength(1);
    expect(gate.inspect().used).toBe(50);
  } finally { gate.close(); await provider.close(); }
});

test('dependency installation and its lifecycle script work within grants without widening write access', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-install-'))); dirs.push(root);
  const workspace = join(root, 'install'); await mkdir(workspace);
  const packageDir = join(root, 'source', 'package'); await mkdir(packageDir, { recursive: true });
  const protectedFile = join(root, 'formal-state'); await writeFile(protectedFile, 'unchanged');
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'graph-install-fixture', version: '1.0.0', scripts: { postinstall: 'node install.cjs' } }));
  await writeFile(join(packageDir, 'install.cjs'), `
    const fs = require('fs');
    let denied = false;
    try { fs.writeFileSync(${JSON.stringify(protectedFile)}, 'bad'); } catch { denied = true; }
    fs.writeFileSync('proof.json', JSON.stringify({ installed:true, outsideDenied:denied }));
  `);
  await promisify(execFile)('/usr/bin/tar', ['-czf', join(workspace, 'dependency.tgz'), '-C', join(root, 'source'), 'package']);
  await writeFile(join(workspace, 'package.json'), '{"private":true}');
  const npmPath = await realpath((await promisify(execFile)('/usr/bin/which', ['npm'])).stdout.trim());
  const broker = new CallBroker(join(root, 'calls.sqlite'), 'agent-1');
  const result = await executor.run({
    broker,
    cwd: workspace, executable: process.execPath,
    args: [npmPath, 'install', './dependency.tgz', '--offline', '--no-audit', '--no-fund', '--cache', join(workspace, '.cache')],
    readPaths: [dirname(process.execPath), dirname(dirname(npmPath))], writePaths: [workspace],
  });
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(await readFile(join(workspace, 'node_modules/graph-install-fixture/proof.json'), 'utf8'))).toEqual({ installed: true, outsideDenied: true });
  expect(await readFile(protectedFile, 'utf8')).toBe('unchanged');
  broker.close();
});

test('an extension or MCP process can request authorized reads and models only through the paused host broker', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-rpc-'))); dirs.push(root);
  const workspace = join(root, 'worker'); await mkdir(workspace);
  const provider = await openaiServer([{}]);
  const gate = new CallBroker(join(root, 'calls.sqlite'), 'agent-1');
  let readHits = 0;
  const resource = createServer((req, res) => { readHits++; expect(req.method).toBe('GET'); res.end('Reference material'); });
  await new Promise<void>(resolve => resource.listen(0, '127.0.0.1', resolve));
  const handle = createWorkerRequests({
    broker: gate, model: provider.model, stream: controlledOpenAIStream(gate, 'host-only-test-key'),
    resources: { docs: { url: `http://127.0.0.1:${(resource.address() as AddressInfo).port}` } },
  });
  const script = `
    import { Socket } from 'node:net';
    import { createInterface } from 'node:readline';
    const channel = new Socket({fd:3, readable:true, writable:true});
    const lines = createInterface({input:channel})[Symbol.asyncIterator]();
    const rpc = async request => { channel.write(JSON.stringify(request)+'\\n'); return JSON.parse((await lines.next()).value); };
    const read = await rpc({operation:'read',resource:'docs'});
    const write = await rpc({operation:'publish',resource:'docs',body:'bad'});
    const model = await rpc({operation:'model',prompt:'An extension requests a model'});
    const paused = await rpc({operation:'model',prompt:'Try to bypass pause',apiKey:'invented',baseUrl:'http://elsewhere'});
    console.log(JSON.stringify({read,write,model,paused}));
    channel.destroy();
  `;
  await writeFile(join(workspace, 'extension.mjs'), script);
  try {
    const result = await executor.run({
      broker: gate,
      cwd: workspace, executable: process.execPath, args: ['extension.mjs'], readPaths: [dirname(process.execPath)], writePaths: [workspace],
      onRequest: async request => { const result = await handle(request); if ((request as { operation?: string }).operation === 'model') gate.pause(); return result; },
    });
    expect(result.code, result.stderr).toBe(0);
    const replies = JSON.parse(result.stdout);
    expect(replies.read).toEqual({ ok: true, value: 'Reference material' });
    expect(replies.write.ok).toBe(false);
    expect(replies.model).toMatchObject({ ok: true, value: { role: 'assistant', stopReason: 'stop' } });
    expect(replies.paused).toMatchObject({ ok: true, value: { role: 'assistant', stopReason: 'error' } });
    expect(provider.requests).toHaveLength(1);
    expect(readHits).toBe(1);
    expect(gate.inspect().used).toBe(50);
  } finally { gate.close(); await provider.close(); resource.closeAllConnections(); await new Promise<void>(resolve => resource.close(() => resolve())); }
});
