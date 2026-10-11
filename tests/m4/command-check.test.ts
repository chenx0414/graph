import { lstatSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';
import { git as runGit } from '../../src/git/git.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const write = (path: string, content: string): ResponsePlan => ({ tools: [{ id: path.replaceAll('/', '-'), name: 'write_file', arguments: JSON.stringify({ path, content }) }] });

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

async function start(root: string, plans: ResponsePlan[], input: { command: string; args: string[] }, options: { program?: { readPaths?: string[]; env?: Record<string, string>; nodeModulesPath?: string } } = {}) {
  const provider = await openaiServer([...plans,
    { tools: [{ id: 'output', name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: {} } } }) }] }, { text: 'Files written' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], ...options,
    limits: { defaultBudgetTokens: 20_000_000 },
    models: { entries: [{ id: 'local', provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl,
      contextWindow: 32000, maxTokens: 256 }], apiKey: 'local-only', modelRuntime: provider.runtime } });
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Run the check', requestId: 'begin' });
  const main = runtime.supervisor(taskId);
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'Run the check', protocols: { data: { type: 'object' } },
    nodes: { work: { recipe: 'coder@1', model: 'local', task: 'work', inputs: { job: { protocol: 'data' } }, outputs: { out: { protocol: 'data' } }, submission: { required: ['out'] } } },
    modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
      operation: { action: 'workspace.command', version: 1, ...input, output: 'result' } } },
    edges: { checked: { from: 'work.out', to: 'check.job', enabled: false } },
    acceptance: [{ id: 'tests', description: 'Tests pass', kind: 'check', module: 'check' }],
  });
  const proposed = await main.propose({ requirementVersion: 1, summary: 'Run the check',
    acceptance: [{ id: 'tests', description: 'Tests pass', checkNode: 'check' }], definition }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, draftRevision: 1, targetBranch: 'main', requestId: 'accept' });
  await main.graphSend({ graphId: taskId, nodeId: 'work', input: 'job', value: {} });
  await runtime.host.drive();
  expect(runtime.nodeRun(taskId, 'work').node.status).toBe('succeeded');
  // A submitted value is immediately routed; integration settles after the turn.
  // Explicitly start the integration check after that settlement.
  await main.graphSend({ graphId: taskId, nodeId: 'check', input: 'job', value: {} });
  return { runtime, task, main };
}

async function operations(runtime: Awaited<ReturnType<typeof openTaskRuntime>>, graphId: string) {
  expect(runtime.nodeRun(graphId, 'work').entries.filter(entry => entry.kind === 'result' && entry.data !== null && typeof entry.data === 'object' && 'isError' in entry.data && entry.data.isError)).toEqual([]);
  return runtime.supervisor(graphId).graphInspect({ graphId, query: 'operations' }) as Promise<{
    module_id: string; state: string; result: { outputs: { result: { passed: boolean; record: string; verifiedCommit: string } } } | null;
  }[]>;
}

async function checkStatus(runtime: Awaited<ReturnType<typeof openTaskRuntime>>, graphId: string) {
  const check = (await operations(runtime, graphId)).find(item => item.module_id === 'check');
  return { state: check?.state, passed: check?.result?.outputs.result.passed };
}

async function checkRecord(runtime: Awaited<ReturnType<typeof openTaskRuntime>>, graphId: string) {
  const check = (await operations(runtime, graphId)).find(item => item.module_id === 'check')!;
  return JSON.parse(await readFile(check.result!.outputs.result.record, 'utf8')) as { code: number; stdout: string; verifiedCommit: string };
}

const workAction: ResponsePlan[] = [
  write('test/ok.test.js', [
      "import { test } from 'node:test';",
      "import assert from 'node:assert';",
      "test('ok', () => assert.equal(1, 1));",
    ].join('\n'))
];

test('a native command module runs an allowed check on the integration copy and emits bound evidence', async () => {
  const root = await repo();
  const { runtime, task } = await start(root, workAction, { command: 'node', args: ['--test'] });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.questions).toEqual([]);
  await expect(checkStatus(runtime, view.id)).resolves.toEqual({ state: 'settled', passed: true });
  const acceptance = await runtime.supervisor(view.id).graphInspect({ graphId: view.id, query: 'acceptance' });
  expect(acceptance).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: 'tests', status: 'passed', source: expect.objectContaining({ commit: view.integrationSha }) })]) });
  const body = await checkRecord(runtime, view.id);
  expect(body.verifiedCommit).toBe(view.integrationSha);
  expect(body.code).toBe(0);
  expect(body.stdout).toContain('pass');
});

test('a native command module that fails its check does not produce acceptance evidence', async () => {
  const root = await repo();
  const { runtime, task } = await start(root, workAction, { command: 'node', args: ['--test', 'test/missing.test.js'] });
  await runtime.host.drive();
  const view = await task.view();
  await expect(checkStatus(runtime, view.id)).resolves.toEqual({ state: 'settled', passed: false });
  await expect(runtime.supervisor(view.id).graphInspect({ graphId: view.id, query: 'acceptance' })).resolves.toMatchObject({ ready: false, items: expect.arrayContaining([expect.objectContaining({ id: 'tests', status: 'failed' })]) });
});

test('a native command module refuses an unallowed command instead of running it', async () => {
  const root = await repo();
  const { runtime, task } = await start(root, workAction, { command: 'sh', args: ['-c', 'touch proof.txt'] });
  await runtime.host.drive();
  const view = await task.view();
  await expect(checkStatus(runtime, view.id)).resolves.toMatchObject({ state: 'failed' });
  const integration = view.worktrees.find(item => item.nodeId === 'integration')!;
  await expect(readFile(join(integration.path, 'proof.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a native command module can write inside its own TMPDIR', async () => {
  const root = await repo();
  // The check runs in the OS sandbox, which grants writes only under the
  // workspace and the check's own scratch directory. A check whose TMPDIR points
  // at the host temporary directory cannot create a file at all, which is exactly
  // what broke a real check that ran the m1 suite (git init writes .git/config
  // inside its temporary repository).
  const probe: ResponsePlan[] = [
    write('tmpdir-probe.js', [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "writeFileSync(join(process.env.TMPDIR, 'probe.txt'), 'ok');",
        "console.log('wrote', process.env.TMPDIR);",
      ].join('\n'))
  ];
  const { runtime, task } = await start(root, probe, { command: 'node', args: ['tmpdir-probe.js'] });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.questions).toEqual([]);
  expect(await checkStatus(runtime, view.id), JSON.stringify(await checkRecord(runtime, view.id))).toEqual({ state: 'settled', passed: true });
});

test('a native command module can bind loopback for a local application test', async () => {
  const root = await repo();
  const localAction: ResponsePlan[] = [
    write('test/local.test.js', [
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
      ].join('\n'))
  ];
  const { runtime, task } = await start(root, localAction, { command: 'node', args: ['--test'] });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.questions).toEqual([]);
  await expect(checkStatus(runtime, view.id)).resolves.toEqual({ state: 'settled', passed: true });
});

test('a native command module may bind loopback but not a non-loopback interface', async () => {
  const root = await repo();
  const networkAction: ResponsePlan[] = [
    write('support/net-child.cjs', [
        "const { createServer } = require('node:http');",
        "const attempt = host => new Promise(resolve => { const server = createServer(); server.on('error', error => resolve(error.code || String(error))); server.listen(0, host, () => { server.close(); resolve('LISTENED'); }); });",
        "(async () => { console.log(JSON.stringify({ wildcard: await attempt('0.0.0.0'), loopback: await attempt('127.0.0.1') })); })();",
      ].join('\n')),
    write('test/network.test.js', [
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
      ].join('\n'))
  ];
  const { runtime, task } = await start(root, networkAction, { command: 'node', args: ['--test'] });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.questions).toEqual([]);
  await expect(checkStatus(runtime, view.id)).resolves.toEqual({ state: 'settled', passed: true });
});

test('a native command module keeps fixed loopback ports, concurrent listeners and cancellation', async () => {
  const root = await repo();
  const listenAction: ResponsePlan[] = [
    write('test/listen.test.js', [
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
      ].join('\n'))
  ];
  const { runtime, task } = await start(root, listenAction, { command: 'node', args: ['--test'] });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.questions).toEqual([]);
  await expect(checkStatus(runtime, view.id)).resolves.toEqual({ state: 'settled', passed: true });
});

test('a native command module resolves host-provided dependencies and environment', async () => {
  const root = await repo();
  // Host-provided dependencies live outside the tracked project tree so the
  // project stays clean for Git admission.
  const modules = join(root, 'state', 'deps');
  await mkdir(join(modules, 'probe'), { recursive: true });
  await writeFile(join(modules, 'probe', 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', type: 'module', exports: './index.js' }));
  await writeFile(join(modules, 'probe', 'index.js'), 'export const value = "probe-dependency";\n');
  const env = { GRAPH_CHECK_PROBE: 'host-env' };
  const dependencyAction: ResponsePlan[] = [
    write('test/deps.test.js', [
        "import { test } from 'node:test';",
        "import assert from 'node:assert';",
        "import { value } from 'probe';",
        "test('dependencies and environment', () => {",
        "  assert.equal(value, 'probe-dependency');",
        "  assert.equal(process.env.GRAPH_CHECK_PROBE, 'host-env');",
        "});",
      ].join('\n'))
  ];
  const { runtime, task } = await start(root, dependencyAction, { command: 'node', args: ['--test'] }, { program: { readPaths: [modules], env, nodeModulesPath: modules } });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.questions).toEqual([]);
  await expect(checkStatus(runtime, view.id)).resolves.toEqual({ state: 'settled', passed: true });
  const body = await checkRecord(runtime, view.id);
  expect(body.stdout).toContain('pass');
});

test('a native command module resolves the project-owned dependencies without a host grant', async () => {
  const root = await repo();
  // Dependencies installed in the project itself are host configuration; the
  // check must find them even though the host named no grant.
  const modules = join(root, 'node_modules');
  await mkdir(join(modules, 'probe'), { recursive: true });
  await writeFile(join(modules, 'probe', 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', type: 'module', exports: './index.js' }));
  await writeFile(join(modules, 'probe', 'index.js'), 'export const value = "project-dependency";\n');
  const dependencyAction: ResponsePlan[] = [
    write('test/project-deps.test.js', [
        "import { test } from 'node:test';",
        "import assert from 'node:assert';",
        "import { value } from 'probe';",
        "test('project dependencies', () => assert.equal(value, 'project-dependency'));",
      ].join('\n'))
  ];
  const { runtime, task } = await start(root, dependencyAction, { command: 'node', args: ['--test'] });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.questions).toEqual([]);
  await expect(checkStatus(runtime, view.id)).resolves.toEqual({ state: 'settled', passed: true });
  const body = await checkRecord(runtime, view.id);
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

test('native revision cannot replace a confirmed integration check with a version probe', async () => {
  const root = await repo();
  const { runtime, task, main } = await start(root, workAction, { command: 'node', args: ['--test'] });
  await runtime.host.drive();
  const before = await task.view();
  await expect(checkStatus(runtime, before.id)).resolves.toEqual({ state: 'settled', passed: true });
  await expect(main.graphPatch({ graphId: before.id, baseRevision: 1, changes: {
    reason: 'Skip the required test', patch: { modules: { check: { operation: { args: ['--version'] } } } },
  } })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(main.graphInspect({ graphId: before.id })).resolves.toMatchObject({ revision: 1 });
  const body = await checkRecord(runtime, before.id);
  expect(body.verifiedCommit).toBe(before.integrationSha);
});

test('native revision can add and explicitly run a probe without rerunning the confirmed check', async () => {
  const root = await repo();
  const { runtime, task, main } = await start(root, workAction, { command: 'node', args: ['--test'] });
  await runtime.host.drive();
  const before = await task.view();
  await expect(main.graphPatch({ graphId: before.id, baseRevision: 1, changes: {
    reason: 'Add an environment probe', patch: { modules: { probe: { type: 'operation', trigger: 'each',
      inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' },
    } } },
  } })).resolves.toMatchObject({ revision: 2 });
  expect(await operations(runtime, before.id)).toHaveLength(1);
  await main.graphSend({ graphId: before.id, nodeId: 'probe', input: 'job', value: {} }); await runtime.host.drive();
  const results = await operations(runtime, before.id);
  expect(results).toHaveLength(2);
  expect(results.find(item => item.module_id === 'probe')).toMatchObject({ state: 'settled', result: { outputs: { result: { passed: true } } } });
  await expect(checkStatus(runtime, before.id)).resolves.toEqual({ state: 'settled', passed: true });
});

test('a packaged app routes sandboxed helpers to the bundled node runtime', async () => {
  const { graphNodeRuntime, resolveNodeCommand } = await import('../../src/runtime/workspace-command.ts');
  expect(graphNodeRuntime({ GRAPH_APP_NODE: '/App/Contents/Resources/app/runtime/node' })).toEqual({ execPath: '/App/Contents/Resources/app/runtime/node' });
  const resolved = resolveNodeCommand(['check.js'], { execPath: '/App/Contents/Resources/app/runtime/node' });
  expect(resolved.executable).toBe('/App/Contents/Resources/app/runtime/node');
  expect(resolved.env).toBeUndefined();
});
