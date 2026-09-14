import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { git as runGit } from '../../src/git/git.ts';
import { openWorkspaceCommandRunner, resolveNodeCommand, validateWorkspaceCommand } from '../../src/runtime/workspace-command.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

function entry(baseUrl: string) {
  return { id: 'local', provider: 'graph-openai' as const, grade: 'high' as const, api: 'openai-completions' as const, baseUrl, contextWindow: 32_000, maxTokens: 256 };
}

async function fixture(plans: Parameters<typeof openaiServer>[0]) {
  const root = await mkdtemp(join(tmpdir(), 'graph-command-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(join(workspace, 'test'), { recursive: true });
  await writeFile(join(workspace, 'test/sample.test.js'), [
    "import { test } from 'node:test';",
    "import { writeFileSync } from 'node:fs';",
    "test('writes proof', () => { writeFileSync('ran.txt', 'ran'); });",
  ].join('\n'));
  const provider = await openaiServer(plans);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }],
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: { kind: 'program', prepare: async () => async () => ({
      outcome: 'completed', output: null,
      evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: join(workspace, 'ok.txt'), digest: 'a'.repeat(64) } }],
    }) } },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Run the tests.', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Run the tests',
    acceptance: [{ id: 'ok', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  return { runtime, provider, workspace, task: runtime.user.task(taskId) };
}

test('a worker can run an allowed build/test command inside the sandbox', async () => {
  const { runtime, provider, workspace, task } = await fixture([
    { tools: [{ id: 'c1', name: 'run_command', arguments: JSON.stringify({ command: 'node', args: ['--test', 'test/sample.test.js'] }) }] },
    { text: 'Ran the test suite.' },
  ]);
  await runtime.host.drive();
  expect(await readFile(join(workspace, 'ran.txt'), 'utf8')).toBe('ran');
  expect(JSON.stringify(provider.requests[1])).toContain('exit 0');
  const view = await task.view();
  expect(view.invocations.some(row => row.usage && row.usage.input === 0 && row.usage.output === 0)).toBe(true);
});

test('a worker cannot run commands outside the allowlist or inline evaluation', async () => {
  const { runtime, provider, workspace } = await fixture([
    { tools: [
      { id: 'c1', name: 'run_command', arguments: JSON.stringify({ command: 'sh', args: ['-c', 'echo bad'] }) },
      { id: 'c2', name: 'run_command', arguments: JSON.stringify({ command: 'node', args: ['-e', 'require("fs").writeFileSync("inline.txt","bad")'] }) },
    ] },
    { text: 'Both commands were refused.' },
  ]);
  await runtime.host.drive();
  const second = JSON.stringify(provider.requests[1]);
  expect(second).toContain('not allowed');
  expect(second).toContain('Inline node evaluation');
  await expect(readFile(join(workspace, 'inline.txt'), 'utf8')).rejects.toThrow();
});

function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

async function commandWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'graph-command-git-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  git(workspace, ['init', '-b', 'main']);
  await writeFile(join(workspace, 'README.md'), 'project\n');
  git(workspace, ['add', 'README.md']);
  git(workspace, ['commit', '-m', 'init']);
  const runner = await openWorkspaceCommandRunner({ workspace, scratchDir: join(root, 'scratch'), gate: { dispatch: (_id, _reservation, send) => send(), settle: () => {} } });
  cleanup.push(() => runner.close());
  return { workspace, runner };
}

test('a command cannot rewrite the repository Git metadata through any path form', async () => {
  const { workspace, runner } = await commandWorkspace();
  const nested = join(workspace, 'sub');
  await mkdir(nested);
  git(nested, ['init', '-b', 'main']);
  await writeFile(join(nested, '.git', 'HEAD'), 'ref: refs/heads/nested\n');
  const before = await readFile(join(workspace, '.git', 'HEAD'), 'utf8');
  const nestedBefore = await readFile(join(nested, '.git', 'HEAD'), 'utf8');
  await writeFile(join(workspace, 'attempt.mjs'), [
    "import { writeFileSync, linkSync } from 'node:fs';",
    "const results = {};",
    "for (const [name, path] of [['relative', '.git/HEAD'], ['nested', 'sub/.git/HEAD'], ['absolute', process.cwd() + '/.git/HEAD']]) {",
    "  try { writeFileSync(path, 'ref: refs/heads/changed\\n'); results[name] = 'wrote'; } catch (error) { results[name] = error.code; }",
    "}",
    "try { linkSync('.git/HEAD', 'linked-head'); results.hardlink = 'linked'; } catch (error) { results.hardlink = error.code; }",
    "writeFileSync('allowed.txt', 'allowed');",
    'console.log(JSON.stringify(results));',
  ].join('\n'));
  const result = await runner.run('node', ['attempt.mjs']);
  expect(result.code).toBe(0);
  const attempted = JSON.parse(result.stdout.trim()) as Record<string, string>;
  expect(Object.entries(attempted).filter(([name]) => ['relative', 'nested', 'absolute', 'hardlink'].includes(name)).map(([, outcome]) => outcome)).toEqual(['EPERM', 'EPERM', 'EPERM', 'EPERM']);
  expect(await readFile(join(workspace, '.git', 'HEAD'), 'utf8')).toBe(before);
  expect(await readFile(join(nested, '.git', 'HEAD'), 'utf8')).toBe(nestedBefore);
  expect(await readFile(join(workspace, 'allowed.txt'), 'utf8')).toBe('allowed');
});

test('read-only Git commands still run inside the sandbox', async () => {
  const { workspace, runner } = await commandWorkspace();
  const status = await runner.run('git', ['status']);
  expect(status.code).toBe(0);
  expect(status.stderr).not.toContain('not permitted');
  const log = await runner.run('git', ['log', '--oneline']);
  expect(log.code).toBe(0);
  expect(log.stdout).toContain('init');
  await expect(runner.run('git', ['commit', '-m', 'changed'])).rejects.toMatchObject({ code: 'permission' });
  expect(await readFile(join(workspace, 'README.md'), 'utf8')).toBe('project\n');
});

test('graph.command checks run in the project root of a non-git project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-command-plain-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(join(workspace, 'test'), { recursive: true });
  await writeFile(join(workspace, 'test/sample.test.js'), [
    "import { test } from 'node:test';",
    "import { writeFileSync } from 'node:fs';",
    "test('writes proof', () => { writeFileSync('ran-plain.txt', 'ran'); });",
  ].join('\n'));
  const provider = await openaiServer([{ text: 'Done.' }]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }],
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: {},
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Run the tests.', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Run the tests',
    acceptance: [{ id: 'ok', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['--test', 'test/sample.test.js'] } },
    ],
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await runtime.host.runReady();
    const view = await task.view();
    if (view.phase === 'completed' || view.nodes.some(node => node.id === 'check' && node.status === 'failed')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const view = await task.view();
  expect(view.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');
  expect(await readFile(join(workspace, 'ran-plain.txt'), 'utf8')).toBe('ran');
  expect(view.questions.filter(question => question.kind === 'adapter_error')).toHaveLength(0);
}, 90_000);

test('node resolves to Electron in Node mode with framework read access inside a packaged app', () => {
  const packaged = resolveNodeCommand(['--test'], { execPath: '/Applications/Graph.app/Contents/MacOS/Graph', electron: '44.3.0' });
  expect(packaged.executable).toBe('/Applications/Graph.app/Contents/MacOS/Graph');
  expect(packaged.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  expect(packaged.readPaths).toContain('/Applications/Graph.app/Contents');
  expect(packaged.args[0]).toBe('--require');
  expect(packaged.args.slice(2)).toEqual(['--test']);
  const plain = resolveNodeCommand(['--test'], { execPath: '/usr/local/bin/node' });
  expect(plain.executable).toBe('/usr/local/bin/node');
  expect(plain.args.slice(2)).toEqual(['--test']);
  expect(plain.env).toBeUndefined();
  // --check parses a single file and rejects additional options.
  expect(resolveNodeCommand(['--check', 'file.js'], { execPath: '/usr/local/bin/node' }).args).toEqual(['--check', 'file.js']);
  expect(validateWorkspaceCommand('node', ['--test']).args.slice(2)).toEqual(['--test']);
  expect(() => validateWorkspaceCommand('node', ['-e', 'x'])).toThrow(/Inline node evaluation/);
});

test('checks can resolve loopback host names inside the sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-command-dns-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'resolve.mjs'), [
    "import { lookup } from 'node:dns/promises';",
    "const { address } = await lookup('localhost');",
    'console.log(address);',
  ].join('\n'));
  const runner = await openWorkspaceCommandRunner({ workspace, scratchDir: join(root, 'scratch'), localNetwork: true, gate: { dispatch: (_id, _reservation, send) => send(), settle: () => {} } });
  cleanup.push(() => runner.close());
  const result = await runner.run('node', ['resolve.mjs']);
  expect(result.code, result.stderr || result.stdout).toBe(0);
  expect(result.stdout.trim()).toMatch(/^(127\.0\.0\.1|::1)$/);
});
