// A tool call that fails must record WHY it failed, where somebody can read it afterwards.
//
// Measured 2026-09-30 on task 68543fed: 7 of 27 artifact_publish calls failed, and the reason existed
// nowhere in the record - `node_entries` held `{isError:true}` and the text "工具执行失败", and
// `instances/<id>/tool-calls/*.jsonl` held a boolean and a duration. The only surviving account of
// the cause was the model's own next sentence, which is not a record: diagnosing a ten-minute
// failure cannot depend on the agent having narrated its own mistake.
//
// This drives a real subagent node against a local provider, so the entry that is asserted is the one
// the runtime really wrote (R23: end to end, not a fixture standing in for it).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';
import { startGraphDaemon } from '../../src/server/start.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function subagentRun(name: string, plans: ResponsePlan[]) {
  const root = await mkdtemp(join(tmpdir(), `graph-tool-failure-${name}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const webDir = join(root, 'web');
  await mkdir(project, { recursive: true });
  await mkdir(webDir, { recursive: true });
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');

  const provider = await openaiServer(plans);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    models: {
      entries: [{
        id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local',
      }],
    },
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    limits: { credentials: { local: 1 }, sharedGroups: {} },
  }, null, 2));

  const daemon = await startGraphDaemon({
    configPath, stateDir: join(root, 'state'), webDir, port: 0, mode: 'execute',
    graphHome: join(root, 'graph'), env: { GRAPH_LOCAL_KEY: 'local-key' }, log: () => undefined,
  });
  cleanup.push(() => daemon.close());
  const { taskId } = await daemon.server.runtime.user.begin({ projectId: 'p', request: 'tool failure', requestId: 'begin' });
  await daemon.server.runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'tool failure',
    acceptance: [{ id: 'works', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['-e', 'process.exit(0)'] } },
    ],
  }, 'proposal-tool-failure');
  await daemon.server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await daemon.server.runtime.host.runReady();
    const node = (await daemon.server.runtime.user.task(taskId).view()).nodes.find(candidate => candidate.id === 'work');
    if (node && ['succeeded', 'failed', 'blocked'].includes(node.status)) break;
    await sleep(100);
  }
  return { root, provider, runtime: daemon.server.runtime, taskId };
}

test('a failed tool call leaves its reason in the node record, readable afterwards', async () => {
  const { runtime, taskId } = await subagentRun('record', [
    // The model asks to read a file that does not exist: the tool fails for a reason worth knowing.
    { finishReason: 'tool_calls', tools: [{ id: 'bad-read', name: 'read', arguments: JSON.stringify({ path: 'no/such/lane-notes.md' }) }] },
    { text: '那个文件不存在，我换个办法。' },
  ]);

  const entries = runtime.nodeRun(taskId, 'work').entries;
  const results = entries.filter(entry => entry.kind === 'result');
  expect(results.length, 'the failed call should have produced a result entry').toBeGreaterThan(0);
  const failed = results.filter(entry => /失败/.test(entry.text));
  expect(failed).toHaveLength(1);

  // The record names the failure instead of only flagging it: a boolean cannot be diagnosed.
  expect(failed[0]!.text).not.toBe('工具执行失败');
  const data = failed[0]!.data as { isError?: boolean; message?: string } | undefined;
  expect(data?.isError).toBe(true);
  // And the reason is machine-readable too, not only prose in a summary line.
  expect(typeof data?.message).toBe('string');
  expect((data?.message ?? '').length).toBeGreaterThan(0);
  expect(failed[0]!.text).toContain(data!.message!.slice(0, 20));

  // A call that succeeded is not dressed up as a failure.
  for (const entry of results.filter(item => !/失败/.test(item.text))) {
    expect((entry.data as { isError?: boolean } | undefined)?.isError).not.toBe(true);
  }
}, 120_000);
