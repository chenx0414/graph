import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, NodeSpec } from '../../src/core/types.ts';
import { git as runGit } from '../../src/git/git.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };

function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'graph-command-check-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), 'project\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

async function start(root: string, actions: Record<string, ActionAdapter>, nodes: NodeSpec[], input: unknown, options: { program?: { readPaths?: string[]; env?: Record<string, string>; nodeModulesPath?: string } } = {}) {
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions, ...options });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Run the check', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Run the check',
    acceptance: [{ id: 'tests', description: 'Tests pass', checkNode: 'check' }],
    nodes: nodes.map(node => node.id === 'check' ? { ...node, ...(input === undefined ? {} : { input: input as import('../../src/core/types.ts').Json }) } : node),
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  return { runtime, task };
}

const workAction: ActionAdapter = {
  kind: 'agent', reserveTokens: 100,
  prepare: async operation => async () => {
    await mkdir(join(operation.workspace!, 'test'), { recursive: true });
    await writeFile(join(operation.workspace!, 'test', 'ok.test.js'), [
      "import { test } from 'node:test';",
      "import assert from 'node:assert';",
      "test('ok', () => assert.equal(1, 1));",
    ].join('\n'));
    return { outcome: 'completed', output: null, usage };
  },
};

const nodes: NodeSpec[] = [
  { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
  { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'] },
];

test('a graph.command program node runs an allowed check on the integration copy and emits bound evidence', async () => {
  const root = await repo();
  const { runtime, task } = await start(root, { work: workAction }, nodes, { command: 'node', args: ['--test'] });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.questions).toEqual([]);
  expect(view.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');
  const evidence = view.evidence.find(item => item.acceptanceId === 'tests');
  expect(evidence).toMatchObject({ valid: true, nodeId: 'check', commitSha: view.integrationSha });
  const body = JSON.parse(await readFile(evidence!.artifact.path, 'utf8')) as { code: number; stdout: string };
  expect(body.code).toBe(0);
  expect(body.stdout).toContain('pass');
});

test('a graph.command node that fails its check does not produce acceptance evidence', async () => {
  const root = await repo();
  const { runtime, task } = await start(root, { work: workAction }, nodes, { command: 'node', args: ['--test', 'test/missing.test.js'] });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.evidence.some(item => item.acceptanceId === 'tests')).toBe(false);
  expect(view.questions.map(question => question.kind)).toContain('execution_failed');
});

test('a graph.command node refuses an unallowed command instead of running it', async () => {
  const root = await repo();
  const { runtime, task } = await start(root, { work: workAction }, nodes, { command: 'sh', args: ['-c', 'touch proof.txt'] });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.questions.map(question => question.kind)).toContain('adapter_error');
  const hash = createHash('sha256').update('absent').digest('hex');
  expect(view.evidence.every(item => item.artifact.digest !== hash)).toBe(true);
});

test('a graph.command check can write inside its own TMPDIR', async () => {
  const root = await repo();
  // The check runs in the OS sandbox, which grants writes only under the
  // workspace and the check's own scratch directory. A check whose TMPDIR points
  // at the host temporary directory cannot create a file at all, which is exactly
  // what broke a real check that ran the m1 suite (git init writes .git/config
  // inside its temporary repository).
  const probe: ActionAdapter = {
    kind: 'agent', reserveTokens: 100,
    prepare: async operation => async () => {
      await writeFile(join(operation.workspace!, 'tmpdir-probe.js'), [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "writeFileSync(join(process.env.TMPDIR, 'probe.txt'), 'ok');",
        "console.log('wrote', process.env.TMPDIR);",
      ].join('\n'));
      return { outcome: 'completed', output: null, usage };
    },
  };
  const { runtime, task } = await start(root, { work: probe }, nodes, { command: 'node', args: ['tmpdir-probe.js'] });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.questions).toEqual([]);
  expect(view.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');
});

test('a graph.command check can bind loopback for a local application test', async () => {
  const root = await repo();
  const localAction: ActionAdapter = {
    kind: 'agent', reserveTokens: 100,
    prepare: async operation => async () => {
      await mkdir(join(operation.workspace!, 'test'), { recursive: true });
      await writeFile(join(operation.workspace!, 'test', 'local.test.js'), [
        "import { test } from 'node:test';",
        "import assert from 'node:assert';",
        "import { createServer } from 'node:http';",
        "test('loopback', async () => {",
        "  const server = createServer((req, res) => { res.end('local-ok'); });",
        "  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));",
        "  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);",
        "  assert.equal(await response.text(), 'local-ok');",
        "  await new Promise(resolve => server.close(resolve));",
        "});",
      ].join('\n'));
      return { outcome: 'completed', output: null, usage };
    },
  };
  const { runtime, task } = await start(root, { work: localAction }, nodes, { command: 'node', args: ['--test'] });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.questions).toEqual([]);
  expect(view.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');
});

test('a graph.command check may bind loopback but not a non-loopback interface', async () => {
  const root = await repo();
  const networkAction: ActionAdapter = {
    kind: 'agent', reserveTokens: 100,
    prepare: async operation => async () => {
      await mkdir(join(operation.workspace!, 'test'), { recursive: true });
      await mkdir(join(operation.workspace!, 'support'), { recursive: true });
      await writeFile(join(operation.workspace!, 'support', 'net-child.cjs'), [
        "const { createServer } = require('node:http');",
        "const attempt = host => new Promise(resolve => { const server = createServer(); server.on('error', error => resolve(error.code || String(error))); server.listen(0, host, () => { server.close(); resolve('LISTENED'); }); });",
        "(async () => { console.log(JSON.stringify({ wildcard: await attempt('0.0.0.0'), loopback: await attempt('127.0.0.1') })); })();",
      ].join('\n'));
      await writeFile(join(operation.workspace!, 'test', 'network.test.js'), [
        "import { test } from 'node:test';",
        "import assert from 'node:assert';",
        "import { createServer } from 'node:http';",
        "import { spawnSync } from 'node:child_process';",
        "test('loopback binds, any-interface does not, and a child cannot clear the guard', async () => {",
        "  const loopback = createServer(() => {});",
        "  await new Promise((resolve, reject) => { loopback.on('error', reject); loopback.listen(0, '127.0.0.1', resolve); });",
        "  await new Promise(resolve => loopback.close(resolve));",
        "  const anyInterface = createServer(() => {});",
        "  await assert.rejects(new Promise((resolve, reject) => { anyInterface.on('error', reject); anyInterface.listen(0, '0.0.0.0', resolve); }), error => error.code === 'EPERM');",
        "  anyInterface.close();",
        "  const env = { ...process.env }; delete env.NODE_OPTIONS;",
        "  const child = spawnSync(process.execPath, ['support/net-child.cjs'], { cwd: process.cwd(), encoding: 'utf8', env });",
        "  assert.equal(child.status, 0, child.stderr);",
        "  assert.deepEqual(JSON.parse(child.stdout), { wildcard: 'EPERM', loopback: 'EPERM' });",
        "});",
      ].join('\n'));
      return { outcome: 'completed', output: null, usage };
    },
  };
  const { runtime, task } = await start(root, { work: networkAction }, nodes, { command: 'node', args: ['--test'] });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.questions).toEqual([]);
  expect(view.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');
});

test('a graph.command check keeps fixed loopback ports, concurrent listeners and cancellation', async () => {
  const root = await repo();
  const listenAction: ActionAdapter = {
    kind: 'agent', reserveTokens: 100,
    prepare: async operation => async () => {
      await mkdir(join(operation.workspace!, 'test'), { recursive: true });
      await writeFile(join(operation.workspace!, 'test', 'listen.test.js'), [
        "import { test } from 'node:test';",
        "import assert from 'node:assert';",
        "import { createServer } from 'node:http';",
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const serve = async port => {",
        "  const server = createServer((request, response) => response.end('ok-' + port));",
        "  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });",
        "  return server;",
        "};",
        "test('a fixed port stays fixed and repeated start/stop stays alive', async () => {",
        "  const probe = createServer();",
        "  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });",
        "  const fixed = probe.address().port;",
        "  await new Promise(resolve => probe.close(resolve));",
        "  const fixedServer = await serve(fixed);",
        "  assert.equal(fixedServer.address().port, fixed);",
        "  assert.equal(await (await fetch('http://127.0.0.1:' + fixed + '/')).text(), 'ok-' + fixed);",
        "  await new Promise(resolve => fixedServer.close(resolve));",
        "  for (let round = 1; round <= 6; round += 1) {",
        "    const server = await serve(0);",
        "    const port = server.address().port;",
        "    assert.equal(await (await fetch('http://127.0.0.1:' + port + '/')).text(), 'ok-0');",
        "    await new Promise(resolve => server.close(resolve));",
        "  }",
        "  const held = await serve(0);",
        "  const busy = createServer();",
        "  const conflict = await new Promise(resolve => { busy.once('error', resolve); busy.listen(held.address().port, '127.0.0.1', () => resolve(undefined)); });",
        "  assert.equal(conflict && conflict.code, 'EADDRINUSE');",
        "  if (!conflict) await new Promise(resolve => busy.close(resolve));",
        "  await new Promise(resolve => held.close(resolve));",
        "  const concurrent = await Promise.all([serve(0), serve(0), serve(0)]);",
        "  const bodies = await Promise.all(concurrent.map(server => fetch('http://127.0.0.1:' + server.address().port + '/').then(response => response.text())));",
        "  assert.deepEqual(bodies, ['ok-0', 'ok-0', 'ok-0']);",
        "  await Promise.all(concurrent.map(server => new Promise(resolve => server.close(resolve))));",
        "  const cancelled = createServer();",
        "  let late = false;",
        "  cancelled.listen(0, '127.0.0.1', () => { late = true; });",
        "  await new Promise(resolve => cancelled.close(() => resolve()));",
        "  await new Promise(resolve => setTimeout(resolve, 250));",
        "  assert.equal(late, false);",
        "  assert.equal(cancelled.listening, false);",
        "  assert.equal(cancelled.address(), null);",
        "  const after = await serve(0);",
        "  assert.equal(await (await fetch('http://127.0.0.1:' + after.address().port + '/')).text(), 'ok-0');",
        "  await new Promise(resolve => after.close(resolve));",
        "});",
        "test('the listening event waits for the host hand-off', async () => {",
        "  writeFileSync('event-client.cjs', [",
        "    \"const { readFileSync } = require('node:fs');\",",
        "    \"const { get } = require('node:http');\",",
        "    \"const deadline = Date.now() + 3000;\",",
        "    \"const poll = () => {\",",
        "    \"  try {\",",
        "    \"    const { port } = JSON.parse(readFileSync('listening-ready.json', 'utf8'));\",",
        "    \"    const request = get({ host: '127.0.0.1', port, agent: false, timeout: 2000 }, response => {\",",
        "    \"      let body = '';\",",
        "    \"      response.on('data', chunk => { body += chunk; });\",",
        "    \"      response.on('end', () => { console.log(body); process.exit(0); });\",",
        "    \"    });\",",
        "    \"    request.on('error', error => { console.error('CLIENT_ERROR', error.message); process.exit(1); });\",",
        "    \"    request.on('timeout', () => request.destroy(new Error('timeout')));\",",
        "    \"  } catch {\",",
        "    \"    if (Date.now() > deadline) { console.error('CLIENT_READY_TIMEOUT'); process.exit(1); }\",",
        "    \"    else setTimeout(poll, 10);\",",
        "    \"  }\",",
        "    \"};\",",
        "    \"poll();\",",
        "  ].join('\\n'));",
        "  const client = spawn(process.execPath, ['event-client.cjs'], { stdio: ['ignore', 'pipe', 'pipe'] });",
        "  let output = '';",
        "  client.stdout.on('data', data => { output += String(data); });",
        "  client.stderr.on('data', data => { output += String(data); });",
        "  const server = createServer((request, response) => response.end('event-ok'));",
        "  await new Promise((resolve, reject) => {",
        "    server.once('error', reject);",
        "    server.once('listening', () => {",
        "      writeFileSync('listening-ready.json', JSON.stringify({ port: server.address().port }));",
        "      const end = Date.now() + 150;",
        "      while (Date.now() < end) { /* synchronous startup work */ }",
        "      resolve();",
        "    });",
        "    server.listen(0, '127.0.0.1');",
        "  });",
        "  const result = await new Promise(resolve => client.on('close', code => resolve({ code, output })));",
        "  assert.equal(result.code, 0, result.output);",
        "  assert.equal(result.output.trim(), 'event-ok');",
        "  await new Promise(resolve => server.close(resolve));",
        "});",
        "test('the listen callback keeps its registration position', async () => {",
        "  const events = [];",
        "  let ready = false;",
        "  const server = createServer();",
        "  server.once('listening', () => { events.push('before'); });",
        "  await new Promise((resolve, reject) => {",
        "    server.once('error', reject);",
        "    server.listen(0, '127.0.0.1', () => { events.push('callback'); ready = true; });",
        "    server.once('listening', () => { events.push('after'); resolve(); });",
        "  });",
        "  assert.deepEqual(events, ['before', 'callback', 'after']);",
        "  assert.equal(ready, true);",
        "  await new Promise(resolve => server.close(resolve));",
        "});",
      ].join('\n'));
      return { outcome: 'completed', output: null, usage };
    },
  };
  const { runtime, task } = await start(root, { work: listenAction }, nodes, { command: 'node', args: ['--test'] });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.questions).toEqual([]);
  expect(view.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');
});

test('a graph.command check resolves host-provided dependencies and environment', async () => {
  const root = await repo();
  // Host-provided dependencies live outside the tracked project tree so the
  // project stays clean for Git admission.
  const modules = join(root, 'state', 'deps');
  await mkdir(join(modules, 'probe'), { recursive: true });
  await writeFile(join(modules, 'probe', 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', type: 'module', exports: './index.js' }));
  await writeFile(join(modules, 'probe', 'index.js'), 'export const value = "probe-dependency";\n');
  const env = { GRAPH_CHECK_PROBE: 'host-env' };
  const dependencyAction: ActionAdapter = {
    kind: 'agent', reserveTokens: 100,
    prepare: async operation => async () => {
      await mkdir(join(operation.workspace!, 'test'), { recursive: true });
      await writeFile(join(operation.workspace!, 'test', 'deps.test.js'), [
        "import { test } from 'node:test';",
        "import assert from 'node:assert';",
        "import { value } from 'probe';",
        "test('dependencies and environment', () => {",
        "  assert.equal(value, 'probe-dependency');",
        "  assert.equal(process.env.GRAPH_CHECK_PROBE, 'host-env');",
        "});",
      ].join('\n'));
      return { outcome: 'completed', output: null, usage };
    },
  };
  const { runtime, task } = await start(root, { work: dependencyAction }, nodes, { command: 'node', args: ['--test'] }, { program: { readPaths: [modules], env, nodeModulesPath: modules } });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.questions).toEqual([]);
  expect(view.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');
  const evidence = view.evidence.find(item => item.acceptanceId === 'tests');
  const body = JSON.parse(await readFile(evidence!.artifact.path, 'utf8')) as { code: number; stdout: string };
  expect(body.stdout).toContain('pass');
});

test('a graph.command check resolves the project-owned dependencies without a host grant', async () => {
  const root = await repo();
  // Dependencies installed in the project itself are host configuration; the
  // check must find them even though the host named no grant.
  const modules = join(root, 'node_modules');
  await mkdir(join(modules, 'probe'), { recursive: true });
  await writeFile(join(modules, 'probe', 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', type: 'module', exports: './index.js' }));
  await writeFile(join(modules, 'probe', 'index.js'), 'export const value = "project-dependency";\n');
  const dependencyAction: ActionAdapter = {
    kind: 'agent', reserveTokens: 100,
    prepare: async operation => async () => {
      await mkdir(join(operation.workspace!, 'test'), { recursive: true });
      await writeFile(join(operation.workspace!, 'test', 'project-deps.test.js'), [
        "import { test } from 'node:test';",
        "import assert from 'node:assert';",
        "import { value } from 'probe';",
        "test('project dependencies', () => assert.equal(value, 'project-dependency'));",
      ].join('\n'));
      return { outcome: 'completed', output: null, usage };
    },
  };
  const { runtime, task } = await start(root, { work: dependencyAction }, nodes, { command: 'node', args: ['--test'] });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.questions).toEqual([]);
  expect(view.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');
  const evidence = view.evidence.find(item => item.acceptanceId === 'tests');
  const body = JSON.parse(await readFile(evidence!.artifact.path, 'utf8')) as { code: number; stdout: string };
  expect(body.code).toBe(0);
  expect(body.stdout).toContain('pass');
  // The check gets a host-owned link; the project's own directory is untouched.
  // The worktree path and branch come from the runtime, not from a hardcoded layout:
  // their naming is a product decision (a readable slug plus the short task id).
  const integration = view.worktrees.find(item => item.nodeId === 'integration');
  expect(integration).toBeDefined();
  expect(integration!.branch).toMatch(/^graph\/task\/[a-z0-9-]+-[0-9a-f]{8}$/);
  expect(basename(dirname(integration!.path))).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/);
  const link = join(integration!.path, 'node_modules');
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(realpathSync(link)).toBe(realpathSync(modules));
  expect(lstatSync(modules).isSymbolicLink()).toBe(false);
});

test('a graph revision cannot weaken the confirmed command of an acceptance check', async () => {
  const root = await repo();
  const { runtime, task } = await start(root, { work: workAction }, nodes, { command: 'node', args: ['--test'] });
  await runtime.host.drive();
  const before = await task.view();
  expect(before.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');
  const weakened = nodes.map(node => node.id === 'check' ? { ...node, input: { command: 'node', args: ['--version'] } } : node);
  await expect(runtime.supervisor(before.id).revise({
    baseVersion: before.graphVersion, reason: 'Skip the required test', nodes: weakened, requestId: 'weaken',
  })).rejects.toMatchObject({ code: 'invalid_proposal' });
  const after = await task.view();
  expect(after.graphVersion).toBe(before.graphVersion);
  expect(after.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');
  expect(after.nodes.find(node => node.id === 'check')?.input).toEqual({ command: 'node', args: ['--test'] });
  expect(after.evidence.find(item => item.acceptanceId === 'tests')?.valid).toBe(true);
});

test('a graph revision that keeps confirmed check inputs intact still applies', async () => {
  const root = await repo();
  const { runtime, task } = await start(root, { work: workAction }, nodes, { command: 'node', args: ['--test'] });
  await runtime.host.drive();
  const before = await task.view();
  const extra: NodeSpec = { id: 'extra', kind: 'program', action: 'graph.command', dependsOn: ['check'], input: { command: 'node', args: ['--version'] } };
  const confirmed = nodes.map(node => node.id === 'check' ? { ...node, input: { command: 'node', args: ['--test'] } } : node);
  const revised = await runtime.supervisor(before.id).revise({
    baseVersion: before.graphVersion, reason: 'Add an environment probe', nodes: [...confirmed, extra], requestId: 'add-probe',
  });
  expect(revised.graphVersion).toBe(before.graphVersion + 1);
  await runtime.host.drive();
  const after = await task.view();
  expect(after.nodes.find(node => node.id === 'extra')?.status).toBe('succeeded');
  expect(after.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');
});

test('a packaged app routes sandboxed helpers to the bundled node runtime', async () => {
  const { graphNodeRuntime, resolveNodeCommand } = await import('../../src/runtime/workspace-command.ts');
  expect(graphNodeRuntime({ GRAPH_APP_NODE: '/App/Contents/Resources/app/runtime/node' })).toEqual({ execPath: '/App/Contents/Resources/app/runtime/node' });
  const resolved = resolveNodeCommand(['check.js'], { execPath: '/App/Contents/Resources/app/runtime/node' });
  expect(resolved.executable).toBe('/App/Contents/Resources/app/runtime/node');
  expect(resolved.env).toBeUndefined();
});
