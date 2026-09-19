import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { sandboxNetworkDomains } from '../../src/core/domains.ts';
import { openRestrictedExecutor } from '../../src/runtime/restricted-process.ts';
import { createWorkerRequests } from '../../src/runtime/worker-requests.ts';
import { CallBroker } from '../../src/runtime/call-broker.ts';
import { controlledOpenAIStream } from '../../src/runtime/controlled-openai.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const dirs: string[] = [];
const activeServerHandles = () =>
  (process as unknown as { _getActiveHandles(): { constructor: { name: string } }[] })._getActiveHandles()
    .filter(handle => handle.constructor.name === 'Server');
let executor: Awaited<ReturnType<typeof openRestrictedExecutor>>;
beforeAll(async () => { executor = await openRestrictedExecutor(); });
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
afterAll(async () => { await executor?.close(); });

test('bare capability domains match their subdomains in the OS network boundary', () => {
  expect(sandboxNetworkDomains(['github.com', '*.example.com', '127.0.0.1'])).toEqual([
    'github.com',
    '*.github.com',
    '*.example.com',
    '127.0.0.1',
  ]);
});

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
  const beforePause = activeServerHandles().length;
  const pendingRun = executor.run({ broker, cwd: workspace, executable: process.execPath, args: ['probe.mjs'], readPaths: [dirname(process.execPath)], writePaths: [workspace], localNetwork: true });
  broker.pause(); // Pause during asynchronous sandbox preparation, before OS spawn.
  await expect(pendingRun).rejects.toThrow('paused');
  await new Promise(resolve => setTimeout(resolve, 20));
  // A denied dispatch must not leave a host listener behind; the old fixed
  // pool created eight of them before the gate ran.
  expect(activeServerHandles()).toHaveLength(beforePause);
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

test('host filesystem mode reaches outside the workspace while protected paths stay denied', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-host-filesystem-'))); dirs.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const outside = join(root, 'outside.txt'); await writeFile(outside, 'outside');
  await mkdir(join(workspace, '.git'));
  const gitHead = join(workspace, '.git', 'HEAD'); await writeFile(gitHead, 'ref: refs/heads/main\n');
  const protectedDir = join(root, 'protected'); await mkdir(protectedDir);
  const protectedFile = join(protectedDir, 'state.sqlite'); await writeFile(protectedFile, 'formal');
  const scratch = join(root, 'scratch'); await mkdir(scratch);
  const broker = new CallBroker(join(root, 'calls.sqlite'), 'agent-1');
  const script = `
    import { readFileSync, writeFileSync } from 'node:fs';
    const results = {};
    const attempt = (key, action) => { try { action(); results[key] = 'allowed'; } catch { results[key] = 'denied'; } };
    attempt('outsideRead', () => readFileSync(${JSON.stringify(outside)}, 'utf8'));
    attempt('outsideWrite', () => writeFileSync(${JSON.stringify(join(root, 'created.txt'))}, 'created'));
    attempt('protectedRead', () => readFileSync(${JSON.stringify(protectedFile)}, 'utf8'));
    attempt('protectedWrite', () => writeFileSync(${JSON.stringify(join(protectedDir, 'new.sqlite'))}, 'bad'));
    attempt('gitWrite', () => writeFileSync(${JSON.stringify(gitHead)}, 'ref: refs/heads/changed\\n'));
    console.log(JSON.stringify(results));
  `;
  await writeFile(join(workspace, 'probe.mjs'), script);
  try {
    const result = await executor.run({
      broker,
      cwd: workspace,
      scratchDir: scratch,
      executable: process.execPath,
      args: ['probe.mjs'],
      filesystem: 'host',
      protectedPaths: [protectedDir],
      readPaths: [],
      writePaths: [],
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      outsideRead: 'allowed',
      outsideWrite: 'allowed',
      protectedRead: 'denied',
      protectedWrite: 'denied',
      gitWrite: 'denied',
    });
    expect(await readFile(join(root, 'created.txt'), 'utf8')).toBe('created');
    expect(await readFile(protectedFile, 'utf8')).toBe('formal');
    expect(await readFile(gitHead, 'utf8')).toBe('ref: refs/heads/main\n');
  } finally { broker.close(); }
});

test('host filesystem mode writes Git metadata only through the explicit high-risk switch', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-host-git-'))); dirs.push(root);
  const workspace = join(root, 'workspace'); await mkdir(join(workspace, '.git'), { recursive: true });
  const scratch = join(root, 'scratch'); await mkdir(scratch);
  const head = join(workspace, '.git', 'HEAD'); await writeFile(head, 'ref: refs/heads/main\n');
  const broker = new CallBroker(join(root, 'calls.sqlite'), 'agent-1');
  try {
    const result = await executor.run({
      broker,
      cwd: workspace,
      scratchDir: scratch,
      executable: process.execPath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(head)}, 'ref: refs/heads/high-risk\\n')`],
      filesystem: 'host',
      allowGitMetadataWritesAll: true,
      readPaths: [],
      writePaths: [],
    });
    expect(result.code, result.stderr).toBe(0);
    expect(await readFile(head, 'utf8')).toBe('ref: refs/heads/high-risk\n');
  } finally { broker.close(); }
});

test('Graph-managed provisioning caches may write VCS metadata without weakening workspace Git protection', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-provisioning-cache-'))); dirs.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const cache = join(root, 'cache'); await mkdir(cache);
  const scratch = join(root, 'scratch'); await mkdir(scratch);
  await mkdir(join(workspace, '.git'));
  const workspaceHead = join(workspace, '.git', 'HEAD');
  const cacheConfig = join(cache, '.git', 'config');
  await writeFile(workspaceHead, 'ref: refs/heads/main\n');
  await writeFile(join(workspace, 'probe.mjs'), `
    import { mkdirSync, writeFileSync } from 'node:fs';
    const results = {};
    const attempt = (key, action) => { try { action(); results[key] = 'allowed'; } catch { results[key] = 'denied'; } };
    attempt('workspaceGit', () => writeFileSync(${JSON.stringify(workspaceHead)}, 'bad'));
    attempt('cacheGit', () => {
      mkdirSync(${JSON.stringify(join(cache, '.git'))}, { recursive: true });
      writeFileSync(${JSON.stringify(cacheConfig)}, 'cache-owned');
    });
    console.log(JSON.stringify(results));
  `);
  const broker = new CallBroker(join(root, 'calls.sqlite'), 'agent-1');
  try {
    const result = await executor.run({
      broker, cwd: workspace, scratchDir: scratch, executable: process.execPath, args: ['probe.mjs'],
      readPaths: [dirname(process.execPath)], writePaths: [workspace, cache, scratch],
      allowGitMetadataWrites: [cache],
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ workspaceGit: 'denied', cacheGit: 'allowed' });
    expect(await readFile(workspaceHead, 'utf8')).toBe('ref: refs/heads/main\n');
    expect(await readFile(cacheConfig, 'utf8')).toBe('cache-owned');
  } finally { broker.close(); }
});

test('unix socket grants also authorize their directory metadata', async () => {
  const root = await realpath(await mkdtemp('/private/tmp/graph-unix-socket-')); dirs.push(root);
  const workspace = join(root, 'workspace');
  const socketDir = join(root, 'socket');
  await mkdir(workspace);
  await mkdir(socketDir);
  await writeFile(join(workspace, 'probe.mjs'), `
    import { readdirSync } from 'node:fs';
    import { createServer } from 'node:net';
    import { join } from 'node:path';
    readdirSync(${JSON.stringify(socketDir)});
    const server = createServer();
    server.listen(join(${JSON.stringify(socketDir)}, 'probe.sock'), () => {
      console.log('bound');
      server.close();
    });
  `);
  const broker = new CallBroker(join(root, 'calls.sqlite'), 'agent-1');
  try {
    const result = await executor.run({
      broker,
      cwd: workspace,
      executable: process.execPath,
      args: ['probe.mjs'],
      readPaths: [dirname(process.execPath)],
      writePaths: [workspace, socketDir],
      unixSockets: [socketDir],
      allowLocalBinding: true,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('bound');
  } finally {
    broker.close();
  }
});

test('restricted workers reach only explicitly granted outbound domains', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-network-'))); dirs.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  let hits = 0;
  const server = createServer((_request, response) => { hits += 1; response.end('reachable'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/probe`;
  await writeFile(join(workspace, 'network.mjs'), `
    try {
      const response = await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(1_000) });
      console.log(JSON.stringify({ network: 'allowed', body: await response.text() }));
    } catch {
      console.log(JSON.stringify({ network: 'denied' }));
    }
  `);
  const broker = new CallBroker(join(root, 'calls.sqlite'), 'agent-1');
  try {
    const allowed = await executor.run({
      broker, cwd: workspace, executable: process.execPath, args: ['network.mjs'],
      readPaths: [dirname(process.execPath)], writePaths: [workspace], networkDomains: ['127.0.0.1'],
    });
    expect(allowed.code, allowed.stderr).toBe(0);
    expect(JSON.parse(allowed.stdout)).toEqual({ network: 'allowed', body: 'reachable' });
    expect(hits).toBe(1);

    const denied = await executor.run({
      broker, cwd: workspace, executable: process.execPath, args: ['network.mjs'],
      readPaths: [dirname(process.execPath)], writePaths: [workspace], networkDomains: ['example.com'],
    });
    expect(denied.code, denied.stderr).toBe(0);
    expect(JSON.parse(denied.stdout)).toEqual({ network: 'denied' });
    expect(hits).toBe(1);
  } finally {
    broker.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('explicit unrestricted network mode reaches the network but still cannot bind listeners', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-unrestricted-network-'))); dirs.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const declaredTmp = join(workspace, 'declared-tmp'); await mkdir(declaredTmp);
  const server = createServer((_request, response) => response.end('reachable'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await writeFile(join(workspace, 'network.mjs'), `
    import { writeFileSync } from 'node:fs';
    import { createServer } from 'node:http';
    const response = await fetch(${JSON.stringify(`http://127.0.0.1:${port}/probe`)});
    writeFileSync('declared-tmp/probe.txt', 'ok');
    let bind = 'allowed';
    try {
      const listener = createServer();
      await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
      listener.close();
    } catch { bind = 'denied'; }
    console.log(JSON.stringify({ network: await response.text(), bind, tmp: process.env.TMPDIR }));
  `);
  const broker = new CallBroker(join(root, 'calls.sqlite'), 'agent-1');
  try {
    const result = await executor.run({
      broker, cwd: workspace, executable: process.execPath, args: ['network.mjs'],
      readPaths: [dirname(process.execPath)], writePaths: [workspace], allowUnrestrictedNetwork: true,
      env: { TMPDIR: declaredTmp },
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ network: 'reachable', bind: 'denied', tmp: declaredTmp });
    expect(await readFile(join(declaredTmp, 'probe.txt'), 'utf8')).toBe('ok');
  } finally {
    broker.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('macOS browser runtime keeps Chrome startup, nested-process, and DNS dependencies available', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-browser-profile-'))); dirs.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const broker = new CallBroker(join(root, 'calls.sqlite'), 'agent-1');
  const profilePath = join(root, 'sandbox.sb');
  const previousDump = process.env.GRAPH_SANDBOX_PROFILE_DUMP;
  process.env.GRAPH_SANDBOX_PROFILE_DUMP = profilePath;
  try {
    const result = await executor.run({
      broker, cwd: workspace, executable: process.execPath, args: ['-e', ''],
      readPaths: [dirname(process.execPath)], writePaths: [workspace],
      allowUnrestrictedNetwork: true, allowLocalBinding: true, timeoutMs: 5_000,
    });
    expect(result.code, result.stderr).toBe(0);
    const profile = await readFile(profilePath, 'utf8');
    expect(profile).toContain('(allow mach-register (global-name-regex #"^com\\.google\\.chrome(?:\\.|$)"))');
    expect(profile).toContain('(allow mach-lookup (global-name "com.apple.SystemConfiguration.DNSConfiguration"))');
    expect(profile).toContain('(allow sysctl-read (sysctl-name "kern.hv_vmm_present"))');
    expect(profile).toContain('(allow network-outbound (remote unix-socket (literal "/private/var/run/mDNSResponder")))');
    expect(profile).toContain('(allow file-read-metadata (literal "/etc"))');
  } finally {
    if (previousDump === undefined) delete process.env.GRAPH_SANDBOX_PROFILE_DUMP;
    else process.env.GRAPH_SANDBOX_PROFILE_DUMP = previousDump;
    broker.close();
  }
});

test('unrestricted network does not leak proxy access into a concurrent no-network worker', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-network-isolation-'))); dirs.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  let hits = 0;
  const server = createServer((_request, response) => { hits += 1; response.end('reachable'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/probe`;
  await writeFile(join(workspace, 'unrestricted.mjs'), `
    import { writeFileSync } from 'node:fs';
    writeFileSync('started.txt', 'yes');
    await new Promise(resolve => setTimeout(resolve, 300));
    try {
      const response = await fetch(${JSON.stringify(url)});
      console.log(JSON.stringify({ network: await response.text() }));
    } catch {
      console.log(JSON.stringify({ network: 'denied' }));
    }
  `);
  await writeFile(join(workspace, 'no-network.mjs'), `
    try { await fetch(${JSON.stringify(url)}); console.log(JSON.stringify({ network: 'allowed' })); }
    catch { console.log(JSON.stringify({ network: 'denied' })); }
  `);
  const broker = new CallBroker(join(root, 'calls.sqlite'), 'agent-1');
  try {
    const unrestricted = executor.run({
      broker, cwd: workspace, executable: process.execPath, args: ['unrestricted.mjs'],
      readPaths: [dirname(process.execPath)], writePaths: [workspace], allowUnrestrictedNetwork: true,
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await readFile(join(workspace, 'started.txt'), 'utf8'); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    const isolated = await executor.run({
      broker, cwd: workspace, executable: process.execPath, args: ['no-network.mjs'],
      readPaths: [dirname(process.execPath)], writePaths: [workspace],
    });
    expect(JSON.parse(isolated.stdout)).toEqual({ network: 'denied' });
    expect(JSON.parse((await unrestricted).stdout)).toEqual({ network: 'reachable' });
    expect(hits).toBe(1);
  } finally {
    broker.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('an unrestricted worker does not block a concurrent allowlisted host call', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-network-concurrency-'))); dirs.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const started = join(workspace, 'started.txt');
  const release = join(workspace, 'release.txt');
  const server = createServer((_request, response) => response.end('reachable'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/probe`;
  await writeFile(join(workspace, 'unrestricted.mjs'), `
    import { existsSync, writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(started)}, 'yes');
    await new Promise(resolve => {
      const timer = setInterval(() => {
        if (!existsSync(${JSON.stringify(release)})) return;
        clearInterval(timer);
        resolve();
      }, 20);
    });
    console.log('released');
  `);
  await writeFile(join(workspace, 'allowlisted.mjs'), `
    const response = await fetch(${JSON.stringify(url)});
    console.log(await response.text());
  `);
  const broker = new CallBroker(join(root, 'calls.sqlite'), 'agent-1');
  let unrestricted: ReturnType<typeof executor.run> | undefined;
  let allowlisted: ReturnType<typeof executor.run> | undefined;
  try {
    unrestricted = executor.run({
      broker, cwd: workspace, executable: process.execPath, args: ['unrestricted.mjs'],
      readPaths: [dirname(process.execPath)], writePaths: [workspace], allowUnrestrictedNetwork: true,
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await readFile(started, 'utf8').catch(() => undefined)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(await readFile(started, 'utf8')).toBe('yes');
    allowlisted = executor.run({
      broker, cwd: workspace, executable: process.execPath, args: ['allowlisted.mjs'],
      readPaths: [dirname(process.execPath)], writePaths: [workspace], networkDomains: ['127.0.0.1'],
    });
    const result = await Promise.race([
      allowlisted,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('allowlisted call was blocked by unrestricted worker')), 1_500)),
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('reachable');
  } finally {
    await writeFile(release, 'yes');
    await Promise.allSettled([...(unrestricted ? [unrestricted] : []), ...(allowlisted ? [allowlisted] : [])]);
    broker.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a check cannot overwrite a host listener with a duplicate request id', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-duplicate-listener-'))); dirs.push(root);
  const broker = new CallBroker(join(root, 'calls.sqlite'), 'agent-1');
  // The check sends raw IPC messages, so the host must treat ids as
  // untrusted: a repeated id could otherwise overwrite a live listener that
  // the run-end cleanup can no longer reach.
  await writeFile(join(root, 'duplicate.cjs'), [
    "process.send({type:'graph-check-listener',id:44,port:0,host:'127.0.0.1'});",
    "process.send({type:'graph-check-listener',id:44,port:0,host:'127.0.0.1'});",
    'setTimeout(() => process.exit(0), 200);',
  ].join('\n'));
  const before = activeServerHandles().length;
  try {
    const result = await executor.run({
      broker, cwd: root, executable: process.execPath, args: ['duplicate.cjs'],
      readPaths: [dirname(process.execPath)], writePaths: [root], localNetwork: true, timeoutMs: 5_000,
    });
    expect(result.code, result.stderr).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(activeServerHandles()).toHaveLength(before);
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
