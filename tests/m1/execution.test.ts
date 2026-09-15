import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter } from '../../src/core/types.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

test('confirmed work reaches a program check after restart and retains delivery evidence without repeating the Agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-delivery-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let builds = 0;
  const artifact = join(root, 'result.txt');
  const actions: Record<string, ActionAdapter> = {
    build: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => {
      builds++;
      await writeFile(artifact, 'Implemented title search');
      return { outcome: 'completed', output: { artifact }, usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } };
    } },
    verify: { kind: 'program', prepare: async () => async () => {
      const content = await readFile(artifact, 'utf8');
      if (content !== 'Implemented title search') throw new Error('Invalid implementation');
      return { outcome: 'completed', output: { passed: true }, evidence: [{ acceptanceId: 'search', summary: 'Verified exact artifact content', artifact: { path: artifact, digest: createHash('sha256').update(content).digest('hex') } }] };
    } },
  };
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions };
  let runtime = await openTaskRuntime(options);
  cleanup.push(async () => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Implement title search', requestId: 'begin' });
  const task = runtime.user.task(taskId);
  const proposal = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Title search', acceptance: [{ id: 'search', description: 'Search works', checkNode: 'verify' }],
    nodes: [{ id: 'build', kind: 'agent', action: 'build', definitionVersion: 'coder@1', model: 'scripted' }, { id: 'verify', kind: 'program', action: 'verify', dependsOn: ['build'] }],
  }, 'proposal');
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  await task.accept({ proposalVersion: proposal.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  const before = await task.view();
  expect(before.phase).toBe('running');
  await runtime.close();
  runtime = await openTaskRuntime(options);
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  const delivered = await runtime.user.task(taskId).view();
  expect(delivered.phase).toBe('completed');
  expect(delivered.evidence).toMatchObject([{ acceptanceId: 'search', nodeId: 'verify', proposalVersion: proposal.proposalVersion, requirementVersion: 1 }]);
  expect(delivered.nodes[0]).toMatchObject({ instanceId: before.nodes[0]!.instanceId, used: 50, status: 'succeeded' });
  expect(builds).toBe(1);
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function singleAgent(actions: Record<string, ActionAdapter>) {
  const root = await mkdtemp(join(tmpdir(), 'graph-execution-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  // This suite verifies the finite-budget acceptance path; new instances are
  // unlimited by default, so pin the legacy cap explicitly.
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions, limits: { defaultBudgetTokens: 20_000_000 } };
  const runtime = await openTaskRuntime(options);
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Work', requestId: 'begin' });
  const task = runtime.user.task(taskId);
  const proposal = await runtime.supervisor(taskId).propose({ requirementVersion: 1, summary: 'Work',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [{ id: 'work', kind: 'agent', action: 'work', model: 'scripted', definitionVersion: 'worker@1' }, { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] }],
  }, 'proposal');
  await task.accept({ proposalVersion: proposal.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  return { runtime, task, options, taskId };
}

test('pause during preparation prevents the actual send, and pause after send drains before reporting paused', async () => {
  const preparing = deferred<void>();
  const prepared = deferred<void>();
  const sent = deferred<void>();
  const finish = deferred<void>();
  let sends = 0;
  const { runtime, task } = await singleAgent({ work: { kind: 'agent', reserveTokens: 100,
    prepare: async () => { preparing.resolve(); await prepared.promise; return async () => {
      sends++; sent.resolve(); await finish.promise;
      return { outcome: 'continue', output: null, usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 } };
    }; },
  } });
  cleanup.push(async () => { prepared.resolve(); finish.resolve(); });
  const first = runtime.host.runReady();
  await preparing.promise;
  const pause = await task.pause('pause-1');
  expect(await task.pause('pause-1')).toEqual(pause);
  prepared.resolve();
  expect(await first).toEqual({ dispatched: 0 });
  expect(sends).toBe(0);
  expect(await task.view()).toMatchObject({ status: 'paused', nodes: [{ reserved: 0, used: 0 }, {}] });
  await task.resume('resume-1');
  const second = runtime.host.runReady();
  await sent.promise;
  await task.pause('pause-2');
  expect(await task.view()).toMatchObject({ status: 'pausing' });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  finish.resolve();
  expect(await second).toEqual({ dispatched: 1 });
  expect(await task.view()).toMatchObject({ status: 'paused', nodes: [{ used: 30, reserved: 0 }, {}] });
  expect(sends).toBe(1);
});

test('unknown usage retains the reservation and blocks replay until a deduplicated result settles it', async () => {
  let sends = 0;
  const { runtime, task } = await singleAgent({ work: { kind: 'agent', reserveTokens: 100,
    prepare: async () => async () => { sends++; return { outcome: 'continue', output: { draft: true } }; },
  } });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  const unknown = await task.view();
  expect(unknown).toMatchObject({ status: 'blocked', nodes: [{ used: 0, reserved: 100, status: 'blocked' }, {}], questions: [{ kind: 'unknown_usage', status: 'open' }] });
  await task.resume('resume');
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  expect(sends).toBe(1);
  const operation = unknown.operations[0]!;
  const result = { outcome: 'continue' as const, output: { draft: true }, usage: { input: 30, output: 10, cacheRead: 5, cacheWrite: 5 } };
  await runtime.host.report(operation.id, operation.generation, result);
  await runtime.host.report(operation.id, operation.generation, result);
  expect(await task.view()).toMatchObject({ status: 'running', nodes: [{ used: 50, reserved: 0, status: 'pending' }, {}], questions: [{ status: 'resolved' }] });
  await expect(runtime.host.report(operation.id, operation.generation, { ...result, usage: { ...result.usage, output: 11 } })).rejects.toMatchObject({ code: 'result_conflict' });
});

test('a host can reconcile unavailable unknown usage without recording it as zero', async () => {
  const { runtime, task } = await singleAgent({ work: { kind: 'agent', reserveTokens: 100,
    prepare: async () => async () => ({ outcome: 'continue', output: { draft: true } }),
  } });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  const blocked = await task.view();
  expect(blocked).toMatchObject({ status: 'blocked', nodes: [{ used: 0, reserved: 100, status: 'blocked' }, {}], questions: [{ kind: 'unknown_usage', status: 'open' }] });
  await expect(task.answer(blocked.questions[0]!.id, { type: 'reconcile_usage', proof: '   ' }, 'no-proof')).rejects.toMatchObject({ code: 'invalid_answer' });
  await task.answer(blocked.questions[0]!.id, { type: 'reconcile_usage', proof: 'Provider exposes no per-request usage for the failed call' }, 'reconcile');
  const after = await task.view();
  // The result proceeds through the normal settlement path: output and version
  // are recorded for successors, while the unaccounted call is not counted.
  expect(after).toMatchObject({ status: 'running', nodes: [{ used: 0, reserved: 0, status: 'pending' }, {}], questions: [{ status: 'resolved' }], operations: [{ state: 'succeeded' }] });
  expect(after.nodes[0]).toMatchObject({ outputVersion: 1 });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
});

test('a reconciled result is delivered to successors', async () => {
  const seen: unknown[] = [];
  const { runtime, task } = await singleAgent({
    work: { kind: 'agent', reserveTokens: 100,
      prepare: async () => async () => ({ outcome: 'completed', output: { answer: 42 } }),
    },
    check: { kind: 'program',
      prepare: async operation => async () => {
        seen.push(operation.dependencies.work);
        return { outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path: operation.workspace ?? '/', digest: 'a'.repeat(64) } }] };
      },
    },
  });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  const blocked = await task.view();
  await task.answer(blocked.questions[0]!.id, { type: 'reconcile_usage', proof: 'Provider exposes no usage for the failed call' }, 'reconcile');
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect(seen).toEqual([{ answer: 42 }]);
  expect((await task.view()).evidence.some(item => item.acceptanceId === 'works' && item.valid)).toBe(true);
});

test('a reconciled waiting result keeps its waiting question instead of re-running', async () => {
  const { runtime, task } = await singleAgent({ work: { kind: 'agent', reserveTokens: 100,
    prepare: async () => async () => ({ outcome: 'waiting', output: null, question: { prompt: 'Provide the missing source' } }),
  } });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  const blocked = await task.view();
  expect(blocked.questions.map(question => question.kind)).toEqual(['unknown_usage']);
  await task.answer(blocked.questions[0]!.id, { type: 'reconcile_usage', proof: 'Provider exposes no usage for the failed call' }, 'reconcile');
  const after = await task.view();
  expect(after.questions).toMatchObject([
    { kind: 'unknown_usage', status: 'resolved' },
    { kind: 'waiting', status: 'open', data: { prompt: 'Provide the missing source' } },
  ]);
  expect(after.nodes[0]).toMatchObject({ status: 'waiting' });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  await task.answer(after.questions[1]!.id, { type: 'respond', value: 'done' }, 'respond');
  expect((await task.view()).nodes[0]).toMatchObject({ status: 'pending' });
});

test('the cumulative instance budget survives restart and only a scoped user answer permits more work', async () => {
  let sends = 0;
  const { runtime, task, options, taskId } = await singleAgent({ work: { kind: 'agent', reserveTokens: 20_000_000,
    prepare: async () => async () => { sends++; return { outcome: 'continue', output: null, usage: { input: 19_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 } }; },
  } });
  await runtime.host.runReady();
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  const blocked = await task.view();
  expect(blocked.nodes[0]).toMatchObject({ budget: 20_000_000, used: 20_000_000, reserved: 0, status: 'blocked' });
  expect(blocked.questions[0]).toMatchObject({ kind: 'budget', nodeId: 'work', status: 'open' });
  await runtime.close();
  const restored = await openTaskRuntime(options);
  cleanup.push(() => restored.close());
  const recovered = restored.user.task(taskId);
  await recovered.resume('resume');
  expect(await restored.host.runReady()).toEqual({ dispatched: 0 });
  const answer = { type: 'add_budget' as const, tokens: 20_000_000 };
  const receipt = await recovered.answer(blocked.questions[0]!.id, answer, 'budget');
  expect(await recovered.answer(blocked.questions[0]!.id, answer, 'budget')).toEqual(receipt);
  expect((await recovered.view()).nodes[0]).toMatchObject({ instanceId: blocked.nodes[0]!.instanceId, budget: 40_000_000, used: 20_000_000 });
  expect(await restored.host.runReady()).toEqual({ dispatched: 1 });
  expect((await recovered.view()).nodes[0]).toMatchObject({ budget: 40_000_000, used: 40_000_000 });
  expect(sends).toBe(2);
});

test.each(['prepare', 'dispatch'])('%s failure becomes a durable problem and only proven unsent work is retried', async stage => {
  let fail = true; let sends = 0;
  const { runtime, task } = await singleAgent({ work: { kind: 'agent', reserveTokens: 100,
    prepare: async () => {
      if (stage === 'prepare' && fail) { fail = false; throw new Error('Preparation unavailable'); }
      return async () => {
        sends++;
        if (fail) { fail = false; throw new Error('Transport lost before result'); }
        return { outcome: 'continue', output: null, usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } };
      };
    },
    reconcile: async () => ({ state: 'not_started', quiescent: true, proof: 'Scripted service confirms no request was accepted and worker is stopped' }),
  } });
  expect(await runtime.host.runReady()).toEqual({ dispatched: stage === 'dispatch' ? 1 : 0 });
  const blocked = await task.view();
  expect(blocked.status).toBe('blocked');
  expect(blocked.operations[0]!.state).toBe(stage === 'dispatch' ? 'unknown' : 'not_sent');
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  if (stage === 'prepare') await task.answer(blocked.questions[0]!.id, { type: 'retry' }, 'retry');
  else await runtime.host.reconcile(blocked.operations[0]!.id);
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect((await task.view()).nodes[0]).toMatchObject({ instanceId: blocked.nodes[0]!.instanceId, used: 50, reserved: 0 });
  expect(sends).toBe(stage === 'dispatch' ? 2 : 1);
});

test('new capability grants require a scoped user answer, persist, and do not clear manual pause', async () => {
  let sends = 0;
  const { runtime, task, taskId, options } = await singleAgent({ work: { kind: 'agent', reserveTokens: 100, grant: 'artifact:write',
    prepare: async operation => async () => { sends++; expect(operation.grants).toContain('artifact:write'); return { outcome: 'continue', output: null, usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } }; },
  } });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  const blocked = await task.view();
  expect(blocked.questions[0]).toMatchObject({ kind: 'permission', data: { grant: 'artifact:write' } });
  expect(blocked.operations).toHaveLength(0);
  const question = blocked.questions[0]!.id;
  const other = await runtime.user.begin({ projectId: 'project', request: 'Another feature', requestId: 'other' });
  await expect(runtime.user.task(other.taskId).answer(question, { type: 'grant', grant: 'artifact:write' }, 'wrong-task')).rejects.toMatchObject({ code: 'invalid_question' });
  await expect(task.answer(question, { type: 'grant', grant: 'publish' }, 'wrong-grant')).rejects.toMatchObject({ code: 'invalid_answer' });
  await task.pause('pause');
  await task.answer(question, { type: 'grant', grant: 'artifact:write' }, 'grant');
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  await runtime.close();
  const restored = await openTaskRuntime(options);
  cleanup.push(() => restored.close());
  expect((await restored.user.task(taskId).view()).status).toBe('paused');
  await restored.user.task(taskId).resume('resume');
  expect(await restored.host.runReady()).toEqual({ dispatched: 1 });
  expect(sends).toBe(1);
});

test('usage above the reservation is counted once but requires acknowledgement before further dispatch', async () => {
  const { runtime, task } = await singleAgent({ work: { kind: 'agent', reserveTokens: 40,
    prepare: async () => async () => ({ outcome: 'continue', output: null, usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } }),
  } });
  await runtime.host.runReady();
  const overrun = await task.view();
  expect(overrun.nodes[0]).toMatchObject({ used: 50, reserved: 0, status: 'blocked' });
  expect(overrun.questions[0]).toMatchObject({ kind: 'reservation_exceeded' });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  await task.answer(overrun.questions[0]!.id, { type: 'acknowledge' }, 'acknowledge');
  expect((await task.view()).nodes[0]).toMatchObject({ used: 50, status: 'pending' });
});

test('a program result without its required acceptance evidence is blocked instead of silently succeeding', async () => {
  const { runtime, task } = await singleAgent({
    work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: null, usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } }) },
    check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: { passed: true } }) },
  });
  await runtime.host.runReady();
  await runtime.host.runReady();
  const result = await task.view();
  expect(result).toMatchObject({ phase: 'running', status: 'blocked', evidence: [], questions: [{ kind: 'recovery' }] });
  expect(result.nodes[1]!.status).toBe('blocked');
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
});

test('a user can reconcile known output with evidenced usage after restart without clearing other questions', async () => {
  const { runtime, task, taskId, options } = await singleAgent({ work: { kind: 'agent', reserveTokens: 100,
    prepare: async () => async () => ({ outcome: 'waiting', output: { draft: true }, question: { prompt: 'Choose format' } }),
  } });
  await runtime.host.runReady();
  const unknown = await task.view();
  await runtime.close();
  const restored = await openTaskRuntime(options);
  cleanup.push(() => restored.close());
  const recovered = restored.user.task(taskId);
  await recovered.answer(unknown.questions[0]!.id, { type: 'usage', usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 }, proof: 'Provider request receipt shows 40 input and 10 output tokens' }, 'usage');
  const known = await recovered.view();
  expect(known.nodes[0]).toMatchObject({ used: 50, reserved: 0, status: 'waiting' });
  expect(known.questions).toMatchObject([{ kind: 'unknown_usage', status: 'resolved' }, { kind: 'waiting', status: 'open' }]);
  await recovered.resume('resume');
  expect(await restored.host.runReady()).toEqual({ dispatched: 0 });
});

test('a late conflicting callback cannot undo an already settled worker report or charge it again', async () => {
  const sent = deferred<void>(); const finish = deferred<void>();
  const { runtime, task } = await singleAgent({ work: { kind: 'agent', reserveTokens: 100,
    prepare: async () => async () => { sent.resolve(); await finish.promise; return { outcome: 'continue', output: null, usage: { input: 40, output: 20, cacheRead: 0, cacheWrite: 0 } }; },
  } });
  cleanup.push(async () => finish.resolve());
  const pending = runtime.host.runReady(); await sent.promise;
  const operation = (await task.view()).operations[0]!;
  await runtime.host.report(operation.id, operation.generation, { outcome: 'continue', output: null, usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } });
  finish.resolve(); await pending;
  const view = await task.view();
  expect(view).toMatchObject({ nodes: [{ used: 50, reserved: 0, status: 'pending' }, {}], questions: [] });
  expect(view.operations[0]!.state).toBe('succeeded');
});

test('exactly exhausted quota blocks even a zero-reservation call after restart', async () => {
  const { runtime, taskId, options } = await singleAgent({ work: { kind: 'agent', reserveTokens: 20_000_000,
    prepare: async () => async () => ({ outcome: 'continue', output: null, usage: { input: 19_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 } }),
  } });
  await runtime.host.runReady(); await runtime.close();
  let sends = 0;
  const restored = await openTaskRuntime({ ...options, actions: { work: { kind: 'agent', reserveTokens: 0,
    prepare: async () => async () => { sends++; return { outcome: 'continue', output: null, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }; },
  } } });
  cleanup.push(() => restored.close());
  expect(await restored.host.runReady()).toEqual({ dispatched: 0 });
  expect(sends).toBe(0);
  expect((await restored.user.task(taskId).view()).nodes[0]).toMatchObject({ used: 20_000_000, budget: 20_000_000, status: 'blocked' });
});
