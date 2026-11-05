import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import {
  commandGraph, harness, nestedSandboxAllowed, readable, rows, sandboxedGraph, waitFor,
  type OperationAnswer, type Step,
} from './go-module-operation.fixture.ts';

/**
 * What a module operation may spend, and what it has to show for spending it.
 *
 * A command that outlives its budget is not a command that judged its work
 * wrong: it never finished, and the difference has to survive into the record -
 * `timedOut`, a `verdict` of `unknown`, and the streams the killed command did
 * manage to print - because a `passed: false` with no reason is what made a
 * fifty minute kill look like a failed check.
 *
 * Two facts are pinned down here, each with a real daemon and a real command:
 *
 * 1. a budget of 1.5s kills a 30s command, settles the operation, and keeps its
 *    stdout, stderr and record; a definition asking for a day is refused;
 * 2. the time an operation spends queued for a program slot is not part of that
 *    budget: an operation that waited behind four running ones still runs its
 *    own command to the end, reports the wait separately, and reports its own
 *    elapsed time as the command's, not the queue's.
 *
 * Proofs are the published output, the operation record and the stream files -
 * the same facts the graph sees - not internal counters.
 */

test('a command that outlives its budget settles as a timeout with its logs kept, and a day-long budget is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-operation-timeout-'));
  const graphId = { over: '', inside: '' };
  // The command prints its first line and then keeps running: the budget kills
  // it, and the line is what survives.
  const plan = (): Step[] => [
    { id: 'create-over', name: 'graph_create', args: { requestId: 'create-over', definition: commandGraph('Outlives its budget', 'process.stdout.write("started\\n");setTimeout(()=>{},30000);', 1500) } },
    { id: 'send-over', name: 'graph_send', args: { graphId: graphId.over, nodeId: 'check', input: 'job', value: {} } },
    {
      id: 'operations-over', name: 'graph_inspect', args: { graphId: graphId.over, query: 'operations' },
      before: () => waitFor(() => {
        const found = rows<{ state: string }>(root, 'SELECT state FROM kernel_module_operations WHERE task_id=?', graphId.over);
        return found.length === 1 && found[0]!.state === 'settled' ? '' : `operations=${JSON.stringify(found)}`;
      }, 120_000),
    },
    // A budget nobody can explain is not a budget: a definition asking for a
    // whole day is refused where definitions are validated.
    { id: 'create-day', name: 'graph_create', args: { requestId: 'create-day', definition: commandGraph('A day', 'process.exit(0);', 86_400_000) } },
    // The bound itself is still a legal budget.
    { id: 'create-inside', name: 'graph_create', args: { requestId: 'create-inside', definition: commandGraph('Inside the bound', 'process.exit(0);', 300_000) } },
  ];
  const { master, request, started, close } = await harness(root, plan, (id, content) => {
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (!found) return;
    if (id === 'create-over') graphId.over = found[1]!;
    if (id === 'create-inside') graphId.inside = found[1]!;
  });
  try {
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await expect.poll(() => master.results.has('create-inside') || master.failures.length > 0, { timeout: 180_000, interval: 250 }).toBe(true);
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    const operations = JSON.parse(master.results.get('operations-over')!) as OperationAnswer[];
    expect(operations).toHaveLength(1);
    expect(operations[0]!.state, 'a timeout is settled like any other result, not dropped').toBe('settled');
    expect(operations[0]!.error).toBeNull();
    const output = operations[0]!.result!.outputs.result;

    // The judgement is "no verdict", and it says why.
    expect(output.timedOut, 'the operation did not report that its budget killed it').toBe(true);
    expect(output.verdict, 'a killed command is not a failed check').toBe('unknown');
    expect(output.code, 'a killed command has no exit code').toBeNull();
    expect(output.passed).toBe(false);
    // The budget that really applied is part of the result, not a guess.
    expect(output.timeoutMs).toBe(1500);

    // Both streams survive the kill, and stdout carries what the command managed
    // to print before it was stopped.
    expect(output.outputFiles?.stdout?.path, 'a timed-out operation kept no stdout log').toBeTruthy();
    expect(output.outputFiles?.stderr?.path, 'a timed-out operation kept no stderr log').toBeTruthy();
    expect(await readFile(readable(output.outputFiles!.stdout.path), 'utf8')).toBe('started\n');
    // The stream file holds what the command printed; why it was killed is the
    // host's own note, and it is published next to the streams.
    expect(await readFile(readable(output.outputFiles!.stderr.path), 'utf8')).toBe('');
    expect(output.stderr, 'the killed operation does not say its budget stopped it').toContain('it exceeded the 1500ms timeout');

    // The same facts are in the durable record the operation published.
    const record = JSON.parse(await readFile(readable(output.record), 'utf8')) as
      { verdict?: string; timedOut?: boolean; timeoutMs?: number; code: number | null; outputFiles?: { stdout: { path: string } } };
    expect(record).toMatchObject({ verdict: 'unknown', timedOut: true, timeoutMs: 1500, code: null });
    expect(record.outputFiles?.stdout.path).toBe(output.outputFiles!.stdout.path);

    // A day is refused, and the refusal names the bound; five minutes is accepted.
    const refused = master.results.get('create-day') ?? '';
    expect(refused, 'a definition asking for a day-long operation budget was accepted').toContain('1800000');
    expect(refused.toLowerCase()).toContain('timeout');
    expect(master.results.get('create-inside') ?? '').not.toContain('invalid_definition');
    expect(graphId.inside, 'a definition inside the bound was not created').toBeTruthy();
    const inside = await request(`/api/tasks/${graphId.inside}`);
    expect(inside.status, JSON.stringify(inside.body)).toBe(200);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);

test.skipIf(!nestedSandboxAllowed())('a sandboxed command killed by its budget keeps the log it printed, like a public one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-operation-sandbox-timeout-'));
  const graphId = { over: '' };
  const plan = (): Step[] => [
    { id: 'create-over', name: 'graph_create', args: { requestId: 'create-over', definition: sandboxedGraph('Sandboxed and out of time', 'test/slow.js', 1500) } },
    { id: 'send-over', name: 'graph_send', args: { graphId: graphId.over, nodeId: 'check', input: 'job', value: {} } },
    {
      id: 'operations-over', name: 'graph_inspect', args: { graphId: graphId.over, query: 'operations' },
      before: () => waitFor(() => {
        const found = rows<{ state: string }>(root, 'SELECT state FROM kernel_module_operations WHERE task_id=?', graphId.over);
        return found.length === 1 && found[0]!.state === 'settled' ? '' : `operations=${JSON.stringify(found)}`;
      }, 120_000),
    },
  ];
  // The command the sandbox runs is a file in the project, not an inline
  // evaluation: a work copy refuses those.
  await mkdir(join(root, 'project', 'test'), { recursive: true });
  await writeFile(join(root, 'project', 'test', 'slow.js'),
    'console.log("slow started"); setTimeout(() => console.log("slow finished"), 30000);\n');
  const { master, started, close } = await harness(root, plan, (id, content) => {
    if (id !== 'create-over') return;
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (found) graphId.over = found[1]!;
  });
  try {
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await expect.poll(() => master.results.has('operations-over') || master.failures.length > 0, { timeout: 180_000, interval: 250 }).toBe(true);
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    const output = (JSON.parse(master.results.get('operations-over')!) as OperationAnswer[])[0]!.result!.outputs.result;
    expect(output.timedOut, 'the sandboxed operation did not report that its budget killed it').toBe(true);
    expect(output.verdict).toBe('unknown');
    expect(output.code).toBeNull();
    // The sandboxed branch used to keep a killed command's output in memory only.
    expect(output.outputFiles?.stdout?.path, 'a sandboxed timed-out operation kept no stdout log').toBeTruthy();
    expect(await readFile(readable(output.outputFiles!.stdout.path), 'utf8')).toBe('slow started\n');
    expect(output.stderr).toContain('it exceeded the 1500ms timeout');
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);

test('an operation queued behind a full program budget runs its own command to the end, and the wait is not its budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-operation-budget-'));
  // The four holders keep their slots for six seconds; the subject is asked for
  // only half a second of real work under a 1.2s budget, and is created once the
  // four are really holding: the queue it has to wait in is built, not hoped for.
  const holders = ['', '', '', ''];
  const subject = { id: '' };
  const constants = { graph: '' };
  const occupied = () => rows<{ n: number }>(root, 'SELECT COUNT(*) AS n FROM kernel_module_operations WHERE worker_active=1')[0]!.n;
  const plan = (): Step[] => {
    const steps: Step[] = [];
    holders.forEach((_, index) => {
      steps.push({ id: `create-holder-${index}`, name: 'graph_create',
        args: { requestId: `create-holder-${index}`, definition: commandGraph(`Holder ${index}`, 'setTimeout(()=>{},6000);', 60_000) } });
      steps.push({ id: `send-holder-${index}`, name: 'graph_send',
        args: { graphId: holders[index] ?? '', nodeId: 'check', input: 'job', value: {} } });
    });
    steps.push({
      id: 'hold', name: 'graph_inspect', args: { graphId: holders[0] ?? '', query: 'operations' },
      before: () => waitFor(() => (occupied() === 4 ? '' : `occupied=${occupied()}`), 120_000),
    });
    steps.push({ id: 'create-subject', name: 'graph_create',
      args: { requestId: 'create-subject', definition: commandGraph('Queued behind four', 'process.stdout.write("subject ran\\n");setTimeout(()=>{},200);', 1200) } });
    steps.push({ id: 'send-subject', name: 'graph_send', args: { graphId: subject.id, nodeId: 'check', input: 'job', value: {} } });
    steps.push({
      id: 'operations-subject', name: 'graph_inspect', args: { graphId: subject.id, query: 'operations' },
      before: () => waitFor(() => {
        const found = rows<{ state: string }>(root, 'SELECT state FROM kernel_module_operations WHERE task_id=?', subject.id);
        return found.length === 1 && found[0]!.state === 'settled' ? '' : `operations=${JSON.stringify(found)}`;
      }, 120_000),
    });
    return steps;
  };
  const { master, started, close } = await harness(root, plan, (id, content) => {
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (!found) return;
    const holder = /^create-holder-(\d)$/.exec(id);
    if (holder) holders[Number(holder[1])] = found[1]!;
    if (id === 'create-subject') subject.id = found[1]!;
    if (id === 'create-holder-0') constants.graph = found[1]!;
  });
  try {
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await expect.poll(() => master.results.has('operations-subject') || master.failures.length > 0, { timeout: 240_000, interval: 250 }).toBe(true);
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    const operations = JSON.parse(master.results.get('operations-subject')!) as OperationAnswer[];
    expect(operations).toHaveLength(1);
    const output = operations[0]!.result!.outputs.result;
    // The command ran to the end: waiting for a slot did not eat its budget.
    expect(output.timedOut, `the queued operation was killed by its own budget (waitMs=${output.waitMs})`).toBe(false);
    expect(output.verdict).toBe('passed');
    expect(output.passed).toBe(true);
    expect(await readFile(readable(output.outputFiles!.stdout.path), 'utf8')).toBe('subject ran\n');

    // The wait is reported separately from the command's time, and the two do
    // not overlap: the command's own elapsed time is a fraction of the queue
    // wait the same operation recorded, so a queue counted into elapsedMs would
    // make them equal. None of this compares a duration against a wall-clock
    // threshold - the machine may be as slow as it likes.
    const queued = output.waitMs;
    const budget = output.timeoutMs;
    // The record has to carry both numbers before they can be read as a fact
    // about each other: a missing wait would make the comparison below pass
    // for the wrong reason.
    expect(typeof queued === 'number', 'the operation never recorded the time it spent queued').toBe(true);
    expect(typeof budget === 'number', 'the operation never recorded the budget it was held to').toBe(true);
    expect(queued as number).toBeGreaterThan(0);
    expect(output.elapsedMs, `elapsedMs=${output.elapsedMs} counts the queue, not the command`)
      .toBeLessThan(queued as number);
    // The budget it declared bounds its own time: a command held past the
    // budget would have been killed, which timedOut already says it was not.
    expect(output.elapsedMs, `elapsedMs=${output.elapsedMs} is outside the declared budget ${budget}`)
      .toBeLessThan(budget as number);
    // The budget it declared is the budget it was held to.
    expect(output.timeoutMs).toBe(1200);

    // The holders really occupied the slots, and they all finished their work.
    const holderStates = rows<{ state: string }>(root, 'SELECT state FROM kernel_module_operations WHERE task_id IN (?,?,?,?)',
      holders[0]!, holders[1]!, holders[2]!, holders[3]!);
    expect(holderStates.map(row => row.state)).toEqual(['settled', 'settled', 'settled', 'settled']);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
