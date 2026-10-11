// Completion must resume when the final host check settles after the completion request.
// Real Pi turns, immutable review bytes and an actual command replace the old DAG's fabricated evidence.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { TaskStore } from '../../src/core/store.ts';
import { git } from '../../src/git/git.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

test.each([false, true])('native delivery drains its last check and requires current review after target movement: moved=%s', async moved => {
  const root = await mkdtemp(join(tmpdir(), 'graph-program-delivery-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'app.ts'), 'export const value = 1;\n');
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'g@l'], ['config', 'user.name', 'G'], ['add', '.'], ['commit', '-q', '-m', 'base']]) {
    expect(git(project, args).code).toBe(0);
  }
  const worker = await openaiServer([
    { tools: [{ id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'app.ts', content: 'export const value = 2;\n' }) }] },
    { text: 'Implementation complete.' },
  ]);
  cleanup.push(() => worker.close());
  let graphId = '';
  let disk: TaskStore;
  const reviewTurn = () => [
    { tools: [{ id: 'read', name: 'read', arguments: JSON.stringify({ path: 'app.ts' }) }] },
    { tools: [{ id: 'report', name: 'write_file', arguments: () => JSON.stringify({ path: 'review.json', content: JSON.stringify({ commit: disk.task(graphId).integration_sha, passed: true, reason: 'Independently checked the implementation.' }) }) }] },
    { text: 'Review published.' },
  ];
  const reviewer = await openaiServer([...reviewTurn(), ...(moved ? reviewTurn() : [])]);
  cleanup.push(() => reviewer.close());
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }],
    access: () => fullAccessPolicy(), models: { apiKey: 'local-only', modelRuntime: worker.runtime,
      entries: ([['writer', worker], ['reader', reviewer]] as const).map(([id, provider]) => ({ id, provider: 'graph-openai', grade: 'high' as const,
        api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 1024 })) } });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'deliver the lane', requestId: 'begin' });
  graphId = taskId;
  disk = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  cleanup.push(async () => disk.close());
  const main = runtime.supervisor(taskId);
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'delivery', protocols: { data: { type: 'object' } },
    nodes: {
      work: { recipe: 'coder@1', model: 'writer', task: 'Set value to 2.', inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {} },
      review: { recipe: 'reviewer@1', model: 'reader', task: 'Read app.ts and publish a review of the current commit.', inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {},
        deliverable: { path: 'review.json', namespace: 'reviews', name: 'review', schema: 'graph.review@1' } },
    },
    modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['-e', "const fs=require('node:fs');if(fs.readFileSync('app.ts','utf8')!=='export const value = 2;\\n')process.exit(1)"], output: 'result', sandbox: false, timeoutMs: 10000 } } },
    edges: {}, acceptance: [{ id: 'ok', description: 'Implementation contains value 2', kind: 'check', module: 'check' },
      { id: 'review', description: 'Independent review of the current commit', kind: 'review', node: 'review' }],
  });
  const proposed = await main.propose({ requirementVersion: 1, summary: 'deliver', definition,
    acceptance: definition.acceptance!.map(item => ({ id: item.id, description: item.description, checkNode: item.kind === 'check' ? 'check' : 'review' })) }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, draftRevision: 1, targetBranch: 'main', requestId: 'accept' });
  await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: {} }); await runtime.host.drive();
  await main.graphSend({ graphId, nodeId: 'review', input: 'job', value: {} }); await runtime.host.drive();
  const before = await main.graphInspect({ graphId, query: 'acceptance' }) as { items: { id: string; status: string }[] };
  expect(before.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'review', status: 'passed' }), expect.objectContaining({ id: 'ok', status: 'missing' })]));
  const reviewedCommit = disk.task(graphId).integration_sha;
  if (moved) expect(git(project, ['commit', '-q', '--allow-empty', '-m', 'target advances']).code).toBe(0);
  const targetBeforeDelivery = git(project, ['rev-parse', 'main']).stdout;
  // Queue the last check before closing external inputs. It must still drain after complete.
  await main.graphSend({ graphId, nodeId: 'check', input: 'job', value: {} });
  await main.graphControl({ graphId, action: 'complete' });
  expect((await runtime.user.task(taskId).view()).phase).not.toBe('completed');
  if (moved) {
    await expect.poll(async () => {
      await runtime.host.pump();
      return (await runtime.user.task(taskId).view()).phase;
    }, { timeout: 15000, interval: 25 }).toBe('blocked');
    const stale = await main.graphInspect({ graphId, query: 'acceptance' }) as { commit: string; items: { id: string; status: string }[] };
    expect(stale.commit).not.toBe(reviewedCommit);
    expect(stale.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'review', status: 'stale' }), expect.objectContaining({ id: 'ok', status: 'stale' }),
    ]));
    expect(git(project, ['rev-parse', 'main']).stdout).toBe(targetBeforeDelivery);
    expect(git(project, ['show', 'main:app.ts']).stdout).toBe('export const value = 1;');
    await expect(main.graphSend({ graphId, nodeId: 'review', input: 'job', value: {} })).rejects.toMatchObject({ code: 'completing' });
    await main.graphControl({ graphId, action: 'withdraw_complete' });
    await main.graphSend({ graphId, nodeId: 'review', input: 'job', value: {} }); await runtime.host.drive();
    const renewed = await main.graphInspect({ graphId, query: 'acceptance' }) as { items: { id: string; status: string }[] };
    expect(renewed.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'review', status: 'passed' }), expect.objectContaining({ id: 'ok', status: 'stale' })]));
    await main.graphSend({ graphId, nodeId: 'check', input: 'job', value: {} });
    await main.graphControl({ graphId, action: 'complete' });
    expect(reviewer.requests).toHaveLength(6);
    expect(worker.requests).toHaveLength(2);
  }
  // Use the production host tick, without drive()'s extra completion pass.
  await expect.poll(async () => {
    await runtime.host.pump();
    return (await runtime.user.task(taskId).view()).phase;
  }, { timeout: 15000, interval: 25 }).toBe('completed');
  const view = await runtime.user.task(taskId).view();
  expect(view.questions).toEqual([]);
  expect(view.phase).toBe('completed');
  expect(git(project, ['show', 'main:app.ts']).stdout).toBe('export const value = 2;');
  const accepted = await main.graphInspect({ graphId, query: 'acceptance' }) as { commit: string; items: { status: string }[] };
  expect(accepted.items.every(item => item.status === 'passed')).toBe(true);
  expect(git(project, ['rev-parse', 'main']).stdout).toBe(accepted.commit);
}, 60000);
