import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

function child(file: string, args: string[]) {
  const process = fork(fileURLToPath(new URL(`../fixtures/m1/${file}`, import.meta.url)), args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  process.stderr!.on('data', data => { stderr += data; });
  cleanup.push(async () => { if (process.exitCode === null && process.signalCode === null) { process.kill('SIGKILL'); await once(process, 'exit'); } });
  return { process, message: new Promise<unknown>((resolve, reject) => {
    process.once('message', resolve); process.once('error', reject);
    process.once('exit', code => reject(new Error(`Child exited ${code}: ${stderr}`)));
  }) };
}
async function kill(process: ChildProcess) { process.kill('SIGKILL'); await once(process, 'exit'); }

test('one daemon owns disk state across processes, and the OS releases ownership after a hard kill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-owner-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const holder = child('owner.ts', [root]);
  expect(await holder.message).toEqual({ type: 'ready' });
  await expect(openTaskRuntime({ stateDir: root })).rejects.toMatchObject({ code: 'owner_busy' });
  const contender = child('owner.ts', [root]);
  expect(await contender.message).toEqual({ type: 'error', code: 'owner_busy' });
  await kill(holder.process);
  const recovered = await openTaskRuntime({ stateDir: root });
  cleanup.push(() => recovered.close());
  await expect(openTaskRuntime({ stateDir: root })).rejects.toMatchObject({ code: 'owner_busy' });
  await recovered.close();
  const next = child('owner.ts', [root]);
  expect(await next.message).toEqual({ type: 'ready' });
});

test.each(['intent', 'dispatched'])('hard restart recovers %s conservatively and rejects reports from the old worker generation', async stage => {
  const root = await mkdtemp(join(tmpdir(), 'graph-crash-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const worker = child('crash.ts', [root, stage]);
  const { taskId, operation } = await worker.message as { taskId: string; operation: import('../../src/core/types.ts').Operation };
  await kill(worker.process);
  let sends = 0;
  const result = { outcome: 'completed' as const, output: { artifact: join(root, 'artifact.txt') }, usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } };
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), actions: {
    work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => { sends++; return result; },
      reconcile: async () => ({ state: 'completed', result: JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8')), quiescent: true, proof: 'Durable receipt from completed scripted request' }),
    },
    check: { kind: 'program', prepare: async () => async () => {
      expect(await readFile(join(root, 'artifact.txt'), 'utf8')).toBe('Verified implementation');
      return { outcome: 'completed', output: { passed: true }, evidence: [{ acceptanceId: 'works', summary: 'Artifact content checked after process restart', artifact: { path: join(root, 'artifact.txt'), digest: createHash('sha256').update('Verified implementation').digest('hex') } }] };
    } },
  } });
  cleanup.push(() => runtime.close());
  const task = runtime.user.task(taskId);
  const restored = await task.view();
  expect(restored.nodes[0]).toMatchObject({ instanceId: operation.instanceId, used: 30, reserved: stage === 'intent' ? 0 : 100 });
  expect(restored.operations[1]!.state).toBe(stage === 'intent' ? 'not_sent' : 'unknown');
  // A restarted process owns no live worker, so a recovered dispatch must not
  // keep holding an execution slot.
  expect(restored.operations[1]!.workerActive).toBe(false);
  await expect(runtime.host.report(operation.id, operation.generation, result)).rejects.toMatchObject({ code: 'stale_generation' });
  if (stage === 'intent') {
    expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
    expect(sends).toBe(1);
  } else {
    expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
    expect(restored.questions[0]).toMatchObject({ kind: 'recovery', status: 'open' });
    await task.pause('pause');
    // The restarted process owns no live worker, so pause is immediate.
    expect((await task.view()).status).toBe('paused');
    await runtime.host.reconcile(operation.id);
    expect((await task.view()).status).toBe('paused');
    await task.resume('resume');
    expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
    expect((await task.view()).phase).toBe('completed');
    expect(sends).toBe(0);
  }
  expect((await task.view()).nodes[0]).toMatchObject({ used: 80, reserved: 0 });
});

test('recovery with a known output but missing usage turns into an answerable usage question', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-recovered-usage-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const worker = child('crash.ts', [root, 'dispatched']);
  const { taskId, operation } = await worker.message as { taskId: string; operation: import('../../src/core/types.ts').Operation };
  await kill(worker.process);
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), actions: {
    work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => { throw new Error('Must not replay'); }, reconcile: async () => {
      const { usage: _usage, ...result } = JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8')) as import('../../src/core/types.ts').OperationResult;
      return { state: 'completed', quiescent: true, proof: 'Receipt confirms output; billing must be checked separately', result };
    } },
  } });
  cleanup.push(() => runtime.close());
  const task = runtime.user.task(taskId);
  await runtime.host.reconcile(operation.id);
  const known = await task.view();
  expect(known.questions).toMatchObject([{ kind: 'recovery', status: 'resolved' }, { kind: 'unknown_usage', status: 'open' }]);
  await task.answer(known.questions[1]!.id, { type: 'usage', usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 }, proof: 'Authoritative billing receipt' }, 'usage');
  expect((await task.view()).nodes[0]).toMatchObject({ used: 80, reserved: 0, status: 'succeeded' });
});

test('full access releases an uncertain dispatch for retry instead of opening a recovery problem', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-crash-full-access-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const worker = child('crash.ts', [root, 'dispatched', 'full']);
  const { taskId } = await worker.message as { taskId: string };
  await kill(worker.process);
  let sends = 0;
  const artifact = join(root, 'artifact.txt');
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    access: () => fullAccessPolicy(),
    actions: {
      work: {
        kind: 'agent',
        reserveTokens: 100,
        prepare: async () => async () => {
          sends += 1;
          await writeFile(artifact, 'Verified implementation');
          return { outcome: 'completed', output: { artifact }, usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } };
        },
      },
      check: {
        kind: 'program',
        prepare: async () => async () => ({
          outcome: 'completed',
          output: { passed: true },
          evidence: [{
            acceptanceId: 'works',
            summary: 'Recovered full-access retry produced the artifact',
            artifact: { path: artifact, digest: createHash('sha256').update('Verified implementation').digest('hex') },
          }],
        }),
      },
    },
  });
  cleanup.push(() => runtime.close());
  const task = runtime.user.task(taskId);
  const restored = await task.view();
  expect(restored.questions).toEqual([]);
  expect(restored.operations.at(-1)).toMatchObject({ state: 'not_sent', workerActive: false });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect((await task.view()).phase).toBe('completed');
  expect(sends).toBe(1);
});
