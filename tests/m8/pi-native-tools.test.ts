import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { git } from '../../src/git/git.ts';
import { PI_NATIVE_TOOL_NAMES } from '../../src/runtime/pi-native-tools.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

test('all Agents expose Pi native tools and the master executes them in the restricted workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pi-native-tools-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# Native tools\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'init']);

  const provider = await openaiServer([
    { tools: [{ id: 'write-1', name: 'write', arguments: JSON.stringify({ path: 'native.txt', content: 'alpha' }) }] },
    { tools: [{ id: 'edit-1', name: 'edit', arguments: JSON.stringify({ path: 'native.txt', edits: [{ oldText: 'alpha', newText: 'beta' }] }) }] },
    { tools: [{ id: 'read-1', name: 'read', arguments: JSON.stringify({ path: 'native.txt' }) }] },
    { tools: [{ id: 'ls-1', name: 'ls', arguments: JSON.stringify({ path: '.' }) }] },
    { tools: [{ id: 'bash-1', name: 'bash', arguments: JSON.stringify({ command: "printf 'bash-ok' > bash.txt" }) }] },
    { tools: [{ id: 'grep-1', name: 'grep', arguments: JSON.stringify({ pattern: 'beta', path: '.' }) }] },
    { text: 'Native tools completed.' },
  ]);
  cleanup.push(() => provider.close());

  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: project }],
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      apiKey: 'scripted-local-key',
      modelRuntime: provider.runtime,
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');

  const created = await runtime.conversations.create({ projectId: 'p', text: 'Exercise the native Pi tools.', requestId: 'native-tools' });
  await runtime.host.runReady();
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.tasks).toEqual([]);

  const firstRequest = provider.requests[0] as { tools?: { function?: { name?: string } }[] } | undefined;
  const offered = (firstRequest?.tools ?? []).map(tool => tool.function?.name ?? '');
  expect(offered).toEqual(expect.arrayContaining([...PI_NATIVE_TOOL_NAMES]));

  expect(await readFile(join(project, 'native.txt'), 'utf8')).toBe('beta');
  expect(await readFile(join(project, 'bash.txt'), 'utf8')).toBe('bash-ok');
  const toolActivity = view.messages.filter(message => message.role === 'tool').map(message => message.text).join('\n');
  for (const name of ['write', 'edit', 'read', 'ls', 'bash', 'grep']) {
    expect(toolActivity).toContain(name);
  }
}, 120_000);
