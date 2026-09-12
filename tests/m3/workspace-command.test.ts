import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
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
