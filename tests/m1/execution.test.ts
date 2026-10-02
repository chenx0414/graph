import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { TaskStore } from '../../src/core/store.ts';
import { taskGate } from '../../src/runtime/task-gate.ts';
import { fullAccessPolicy, standardAccessPolicy, type AccessPolicy } from '../../src/core/access-policy.ts';
import { RuntimeError, type ActionAdapter, type Proposal } from '../../src/core/types.ts';
import { withLiftedDefinition } from '../fixtures/v2-lift.ts';

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
  const proposal = await runtime.supervisor(taskId).propose(withLiftedDefinition({
    requirementVersion: 1, summary: 'Title search', acceptance: [{ id: 'search', description: 'Search works', checkNode: 'verify' }],
    nodes: [{ id: 'build', kind: 'agent', action: 'build', definitionVersion: 'coder@1', model: 'scripted' }, { id: 'verify', kind: 'program', action: 'verify', dependsOn: ['build'] }],
  } as Proposal), 'proposal');
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

async function singleAgent(actions: Record<string, ActionAdapter>, access?: () => AccessPolicy) {
  const root = await mkdtemp(join(tmpdir(), 'graph-execution-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  // This suite verifies the finite-budget acceptance path; new instances are
  // unlimited by default, so pin the legacy cap explicitly.
  const options = {
    stateDir: join(root, 'state'),
    projects: [{ id: 'project', root }],
    actions,
    limits: { defaultBudgetTokens: 20_000_000 },
    ...(access ? { access } : {}),
  };
  const runtime = await openTaskRuntime(options);
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Work', requestId: 'begin' });
  const task = runtime.user.task(taskId);
  const proposal = await runtime.supervisor(taskId).propose(withLiftedDefinition({ requirementVersion: 1, summary: 'Work',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [{ id: 'work', kind: 'agent', action: 'work', model: 'scripted', definitionVersion: 'worker@1' }, { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] }],
  } as Proposal), 'proposal');
  await task.accept({ proposalVersion: proposal.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  return { runtime, task, options, taskId };
}

test('pause during preparation prevents the send, and a running worker drains instead of being soft-stopped', async () => {
  const preparing = deferred<void>();
  const prepared = deferred<void>();
  const sent = deferred<void>();
  const finish = deferred<void>();
  let sends = 0;
  let stopCalls = 0;
  const { runtime, task } = await singleAgent({ work: { kind: 'agent', reserveTokens: 100,
    stop: async () => { stopCalls += 1; },
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
  // Soft stop is reserved for the conversation master turn; a worker turn is an
  // independent unit that drains untouched, so pause blocks new dispatch but
  // does not interrupt it (stop is never asked).
  expect(stopCalls).toBe(0);
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

test('full access auto-approves a required grant and freezes its policy on the operation', async () => {
  let seen: unknown;
  let policy: AccessPolicy = fullAccessPolicy();
  let grant = 'artifact:write';
  const { runtime, task } = await singleAgent({
    work: {
      kind: 'agent',
      reserveTokens: 100,
      get grant() { return grant; },
      prepare: async operation => async () => {
        seen = operation.accessPolicy;
        expect(operation.grants).toContain('artifact:write');
        return { outcome: 'continue', output: null, usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } };
      },
    },
  }, () => policy);

  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  const view = await task.view();
  expect(view.questions).toEqual([
    expect.objectContaining({
      kind: 'permission',
      status: 'resolved',
      answer: expect.objectContaining({ type: 'grant', grant: 'artifact:write' }),
    }),
  ]);
  expect(seen).toMatchObject({
    mode: 'full',
    authorization: 'bypass',
    digest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });

  policy = standardAccessPolicy();
  grant = 'publish';
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  expect((await task.view()).questions).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'permission', status: 'open', data: { grant: 'publish' } }),
  ]));
});

test('full access auto-approves a grant requested by an operation result and retries the node', async () => {
  let sends = 0;
  const { runtime, task } = await singleAgent({
    work: {
      kind: 'agent',
      reserveTokens: 100,
      prepare: async () => async () => {
        sends += 1;
        if (sends === 1) {
          return {
            outcome: 'waiting',
            output: null,
            question: { prompt: 'Remote MCP needs a grant', grant: 'mcp:remote:echo' },
            usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 },
          };
        }
        return { outcome: 'continue', output: { granted: true }, usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } };
      },
    },
  }, () => fullAccessPolicy());

  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  const afterGrant = await task.view();
  expect(afterGrant.questions).toEqual([
    expect.objectContaining({ kind: 'permission', status: 'resolved', answer: { type: 'grant', grant: 'mcp:remote:echo' } }),
  ]);
  expect(afterGrant.nodes[0]).toMatchObject({ status: 'pending' });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect(sends).toBe(2);
});

test('full access no longer bypasses pause, but still bypasses budget and unknown usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-execution-full-pause-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const artifact = join(root, 'artifact.txt');
  let sends = 0;
  const { runtime, task } = await singleAgent({
    work: {
      kind: 'agent',
      reserveTokens: 20_000_001,
      prepare: async () => async () => {
        sends += 1;
        await writeFile(artifact, 'full access result');
        return { outcome: 'completed', output: { artifact } };
      },
    },
    check: {
      kind: 'program',
      prepare: async () => async () => ({
        outcome: 'completed',
        output: { passed: true },
        evidence: [{
          acceptanceId: 'works',
          summary: 'Full access bypassed the budget and usage gates',
          artifact: { path: artifact, digest: createHash('sha256').update('full access result').digest('hex') },
        }],
      }),
    },
  }, () => fullAccessPolicy());

  await task.pause('pause-full-access');
  // The pause now applies in full access too: nothing new is dispatched until
  // resume, even for a worker node.
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  expect(sends).toBe(0);
  expect(await task.view()).toMatchObject({ status: 'paused' });

  await task.resume('resume-full-access');
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  const view = await task.view();
  expect(view.phase).toBe('completed');
  expect(view.questions).toEqual([]);
  expect(view.operations).toHaveLength(2);
  // Budget and unknown-usage automatic gates stay bypassed under full access:
  // the reservation exceeds the cap yet the operation still succeeded.
  expect(view.nodes[0]).toMatchObject({ used: 0, reserved: 0, status: 'succeeded' });
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
  // A check that produced no usable evidence is a refused document, not an
  // unobservable external outcome: it becomes a repair problem for the owner.
  expect(result).toMatchObject({ phase: 'running', status: 'blocked', evidence: [], questions: [{ kind: 'result_noncompliant' }] });
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

test.each(['standard', 'full'] as const)('pause soft-stops the running master turn and a single resume continues it (%s access)', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pause-master-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  // A second connection to the runtime database lets the scripted adapter use
  // the real send gate, so the first provider send is recorded as an invocation
  // exactly like a live master turn (and the pause refusal settles interrupted).
  const store = new TaskStore(join(stateDir, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  const tool = deferred<void>();
  const partial = join(root, 'partial.txt');
  let sends = 0;
  let stopCalls = 0;
  let stopped = false;
  const entry = {
    id: 'm', modelId: 'm', provider: 'p', grade: 'high' as const, api: 'openai-completions' as const,
    baseUrl: 'https://master.example/v1', contextWindow: 32_000, maxTokens: 256, credentialId: 'c',
  };
  const adapter: ActionAdapter = {
    kind: 'agent', reserveTokens: 100,
    stop: async () => { stopCalls += 1; stopped = true; tool.resolve(); },
    prepare: async operation => async () => {
      sends += 1;
      if (sends === 1) {
        // The first provider send already happened and is durable; then the
        // in-flight tool call runs and the pause refuses the next send.
        const gate = taskGate(store, { id: operation.id, taskId: operation.taskId, instanceId: operation.instanceId!, nodeId: operation.nodeId }, entry);
        gate.dispatch('inv-1', 0, () => 'sent');
        gate.settle('inv-1', { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
        await writeFile(partial, 'completed tool effect');
        await tool.promise;
        // Standard access refuses the next send at the pause gate; full access
        // has no such gate, so the soft stop simply ends the turn normally.
        if (stopped && mode === 'standard') throw new RuntimeError('paused', 'Instance paused');
        return { outcome: 'completed', output: { text: 'first' }, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } };
      }
      // The resumed turn runs on the same session/instance and finishes.
      return { outcome: 'completed', output: { text: 'continued' }, usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 } };
    },
  };
  const runtime = await openTaskRuntime({
    stateDir,
    actions: { master: adapter },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
    ...(mode === 'full' ? { access: () => fullAccessPolicy() } : {}),
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: '第一问', requestId: 'create' });
  const driving = runtime.host.runReady();
  await expect.poll(async () => (await runtime.conversations.view(created.conversationId)).master?.status, { timeout: 10_000 }).toBe('running');
  const instanceId = (await runtime.user.task(created.taskId).view()).nodes.find(node => node.id === 'master')!.instanceId;

  await runtime.conversations.pause(created.conversationId, 'pause');
  await driving;

  // The pause soft-stopped the live master turn in both access modes: the
  // in-flight tool effect is retained and the turn closed.
  expect(stopCalls).toBe(1);
  // The pause recorded a durable wake-up for the unfinished turn.
  expect(store.db.prepare('SELECT state FROM pause_continuations').all()).toEqual([{ state: 'waiting' }]);
  expect(await readFile(partial, 'utf8')).toBe('completed tool effect');
  const paused = await runtime.user.task(created.taskId).view();
  expect(paused).toMatchObject({ status: 'paused', operations: [{ workerActive: false }] });
  if (mode === 'standard') {
    // The pause gate refused the next send, so the turn closed interrupted and
    // the node is queued for the continuation.
    expect(paused.operations[0]!.state).toBe('interrupted');
    expect(paused.nodes.find(node => node.id === 'master')?.status).toBe('pending');
  } else {
    // Full access has no pause gate: the soft stop ends the turn as completed
    // and the durable wake-up puts the node back on the queue at resume.
    expect(paused.operations[0]!.state).toBe('succeeded');
    expect(paused.nodes.find(node => node.id === 'master')?.status).toBe('succeeded');
  }
  // Nothing new is dispatched while paused, in full access too.
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });

  await runtime.conversations.resume(created.conversationId, 'resume');
  // Resume turned the waiting wake-up into a dispatchable one.
  expect(store.db.prepare('SELECT state FROM pause_continuations').all()).toEqual([{ state: 'ready' }]);
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  // The durable wake-up was consumed and the turn ran once on the same instance.
  const continued = await runtime.user.task(created.taskId).view();
  expect(continued.nodes.find(node => node.id === 'master')).toMatchObject({ status: 'succeeded', instanceId });
  expect(store.db.prepare('SELECT state FROM pause_continuations').all()).toEqual([{ state: 'consumed' }]);
  // The completed tool effect survived the stop and the continuation.
  expect(await readFile(partial, 'utf8')).toBe('completed tool effect');
  expect(sends).toBe(2);
  // A consumed wake-up is never replayed by another resume.
  await runtime.conversations.resume(created.conversationId, 'resume-again');
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  expect(sends).toBe(2);
}, 30_000);
