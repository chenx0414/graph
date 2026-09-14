import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-conversation-readonly-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A bound extension tries to write a business file. Discussion must refuse;
 * the confirmed worker with the same capability proves the write path works. */
test('a bound extension cannot write business files during discussion but a worker can', async () => {
  const root = await temp('extension');
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'check.js'), 'console.log("ok");\n');
  const source = join(root, 'extension');
  await mkdir(source, { recursive: true });
  await copyFile(new URL('../fixtures/extension-capability.mjs', import.meta.url), join(source, 'extension.mjs'));
  await writeFile(join(source, 'capability.json'), JSON.stringify({ kind: 'extension', entry: './extension.mjs' }));

  const provider = await openaiServer([
    { tools: [{ id: 'discussion-call', name: 'mcp_ext_write_proof', arguments: JSON.stringify({ outside: join(root, 'outside.txt') }) }] },
    { text: 'Discussion completed.' },
    { tools: [{ id: 'worker-call', name: 'mcp_ext_write_proof', arguments: JSON.stringify({ outside: join(root, 'outside.txt') }) }] },
    { text: 'Worker completed.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: workspace }],
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      apiKey: 'scripted-local-key', modelRuntime: provider.runtime,
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high', capabilities: [{ id: 'ext', version: '1.0.0' }] }, 'master');
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium', capabilities: [{ id: 'ext', version: '1.0.0' }] }, 'coder');
  await runtime.catalog.install({ id: 'ext', kind: 'extension', source, version: '1.0.0', requestId: 'install' });

  // Discussion: the model calls the same capability tool, but the worker runs
  // with the business directory read-only.
  const created = await runtime.conversations.create({ projectId: 'p', text: '只讨论，先看看项目。不要修改业务文件。', requestId: 'create' });
  await runtime.host.runReady();
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.tasks).toHaveLength(0);
  await expect(readFile(join(workspace, 'extension-capability.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  const refusal = view.messages.filter(message => message.role === 'tool').map(message => message.text).join('\n');
  expect(refusal).toContain('mcp_ext_write_proof');

  // Positive control: the same capability bound to a confirmed worker writes.
  await runtime.supervisor(created.taskId).propose({
    requirementVersion: 1, summary: '验证能力边界',
    acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
    ],
  }, 'draft');
  await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm' });
  await runtime.host.runReady();
  expect(await readFile(join(workspace, 'extension-capability.txt'), 'utf8')).toBe('extension capability write');
}, 60_000);
