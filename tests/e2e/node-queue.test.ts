import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';
import type { GraphDefinition } from '../../src/core/interface-spec.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
const submit = (n: number): ResponsePlan => ({ tools: [{ id: `submit-${n}`, name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { n } } } }) }] });
async function fixture(plans: Record<string, ResponsePlan[]>, retry?: { automatic: number; resubmit: number }, unlimited = false) {
  const root = await mkdtemp(join(tmpdir(), 'graph-node-queue-e2e-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  const providers: Record<string, Awaited<ReturnType<typeof openaiServer>>> = {};
  for (const [id, replies] of Object.entries(plans)) { providers[id] = await openaiServer(replies); cleanup.push(() => providers[id]!.close()); }
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }], catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') },
    limits: { defaultBudgetTokens: unlimited ? null : 20_000_000 }, models: { apiKey: 'local-only', modelRuntime: Object.values(providers)[0]!.runtime,
      entries: Object.entries(providers).map(([id, provider]) => ({ id, provider: provider.model.provider, grade: 'medium' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 })) } } satisfies Parameters<typeof openTaskRuntime>[0];
  let runtime = await openTaskRuntime(options); cleanup.push(() => runtime.close()); runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium' }, 'worker');
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Exercise native node queues', requestId: 'begin' }); let main = runtime.supervisor(owner.taskId);
  const port = { protocol: 'ping' };
  const definition: GraphDefinition = { schemaVersion: 2, name: 'Node queue', protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
    nodes: Object.fromEntries(Object.keys(plans).map(id => [id, { recipe: 'worker@1', model: id, task: 'Submit the assigned output for deliveries; answer chats', inputs: { job: port }, outputs: { out: port }, submission: { required: ['out'] }, ...(retry ? { retry } : {}) }])),
    modules: {}, edges: {}, inputs: {}, outputs: Object.fromEntries(Object.keys(plans).map(id => [id, { from: `${id}.out`, protocol: 'ping' }])) };
  const { graphId } = await main.graphCreate({ definition }) as { graphId: string };
  return { providers, graphId, get runtime() { return runtime; }, get main() { return main; }, async reopen() { await runtime.close(); runtime = await openTaskRuntime(options); main = runtime.supervisor(owner.taskId); },
    async send(id: string, n: number) { await main.graphSend({ graphId, nodeId: id, input: 'job', value: { n } }); },
    async finish() { await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive(); expect(await runtime.user.task(graphId).view()).toMatchObject({ phase: 'completed' }); } };
}

test('one node serializes delivery, queued chat and later delivery while another node completes independently', async () => {
  let entered!: () => void; const arrived = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); cleanup.push(() => release());
  const f = await fixture({ a: [{ ...submit(1), beforeReply: async () => { entered(); await held; } }, { text: 'first done' }, { text: 'queued chat answered' }, submit(3), { text: 'third done' }], b: [submit(2), { text: 'independent done' }] });
  // Admit both independent nodes before the drive snapshots runnable work.
  await f.send('a', 1); await f.send('b', 2); const drive = f.runtime.host.drive(); await arrived;
  await f.main.graphSend({ graphId: f.graphId, nodeId: 'a', text: 'QUEUED_CHAT_AFTER_FIRST_STARTED' }); await f.send('a', 3);
  await expect.poll(async () => {
    const history = await f.main.graphInspect({ graphId: f.graphId, query: 'executions', id: 'b' }) as { items: { state: string }[] };
    return history.items[0]?.state;
  }, { timeout: 20_000 }).toBe('completed');
  await expect(f.main.graphInspect({ graphId: f.graphId, query: 'queue', id: 'a' })).resolves.toMatchObject({ items: [{ state: 'claimed', kind: 'delivery' }, { state: 'queued', kind: 'chat' }, { state: 'queued', kind: 'delivery' }] });
  expect(f.providers.a!.requests).toHaveLength(1); expect(JSON.stringify(f.providers.a!.requests[0])).not.toContain('QUEUED_CHAT_AFTER_FIRST_STARTED');
  release(); await drive; await f.runtime.host.drive();
  const history = await f.main.graphInspect({ graphId: f.graphId, query: 'queue', id: 'a' }) as { items: { kind: string; state: string }[] };
  expect(history.items.map(item => [item.kind, item.state])).toEqual([['delivery', 'done'], ['chat', 'done'], ['delivery', 'done']]);
  expect(f.providers.a!.requests).toHaveLength(5); expect(JSON.stringify(f.providers.a!.requests[2])).toContain('QUEUED_CHAT_AFTER_FIRST_STARTED');
  await expect(f.main.graphInspect({ graphId: f.graphId, query: 'executions', id: 'a' })).resolves.toMatchObject({ items: [{ state: 'completed' }, { state: 'completed' }, { state: 'completed' }] });
  const results = await f.main.graphInspect({ graphId: f.graphId, query: 'results' }) as { value: { n: number } }[];
  expect(results.filter(item => [1, 3].includes(item.value.n)).map(item => item.value.n)).toEqual([1, 3]); await f.finish();
}, 60_000);

test('a failed node retains its later input across reopen while another node runs, and explicit skip and resume release it', async () => {
  const f = await fixture({ a: [{ text: 'Forgot required output' }, submit(3), { text: 'later work completed' }], b: [submit(2), { text: 'independent work completed' }] }, { automatic: 0, resubmit: 0 });
  await f.send('a', 1); await f.send('a', 3); await f.send('b', 2); await f.runtime.host.drive();
  const queue = await f.main.graphInspect({ graphId: f.graphId, query: 'queue', id: 'a' }) as { items: { seq: number; state: string }[] };
  expect(queue.items.map(item => item.state)).toEqual(['failed', 'queued']); expect(f.providers.a!.requests).toHaveLength(1);
  await expect(f.main.graphInspect({ graphId: f.graphId, query: 'executions', id: 'b' })).resolves.toMatchObject({ items: [{ state: 'completed' }] });
  await f.reopen(); await f.runtime.host.drive(); expect(f.providers.a!.requests).toHaveLength(1);
  await expect(f.main.graphInspect({ graphId: f.graphId, query: 'queue', id: 'a' })).resolves.toMatchObject({ items: [{ state: 'failed' }, { state: 'queued' }] });
  await f.main.graphControl({ graphId: f.graphId, action: 'skip', seq: queue.items[0]!.seq });
  await f.main.graphControl({ graphId: f.graphId, action: 'resume', nodeId: 'a' }); await f.runtime.host.drive();
  expect(f.providers.a!.requests).toHaveLength(3);
  await expect(f.main.graphInspect({ graphId: f.graphId, query: 'results' })).resolves.toMatchObject(expect.arrayContaining([expect.objectContaining({ value: { n: 3 } })]));
  const completed = await f.main.graphInspect({ graphId: f.graphId, query: 'queue', id: 'a' }) as { items: { seq: number; state: string }[] };
  await expect(f.main.graphControl({ graphId: f.graphId, action: 'retry', seq: completed.items[1]!.seq })).rejects.toMatchObject({ code: 'invalid_queue' });
  await f.finish();
}, 60_000);

test('default resubmission is spent once and persisted failure totals survive reopen, while a node override permits two repairs', async () => {
  for (const override of [undefined, { automatic: 4, resubmit: 2 }]) {
    const f = await fixture({ a: [{ text: 'first missing output' }, { text: 'still missing' }, ...(override ? [submit(7), { text: 'repaired on second chance' }] : [])] }, override);
    await f.send('a', 0); await f.runtime.host.drive();
    const before = f.runtime.nodeRun(f.graphId, 'a');
    expect(before.operations).toMatchObject([{ resubmits_used: override ? 2 : 1, retries_used: 0, state: override ? 'completed' : 'failed' }]);
    expect(f.providers.a!.requests).toHaveLength(override ? 4 : 2);
    await f.reopen(); await f.runtime.host.drive();
    expect(f.runtime.nodeRun(f.graphId, 'a').operations).toMatchObject([{ resubmits_used: override ? 2 : 1, retries_used: 0, state: override ? 'completed' : 'failed' }]);
    expect(f.providers.a!.requests).toHaveLength(override ? 4 : 2);
    if (override) await f.finish(); else { await f.main.graphControl({ graphId: f.graphId, action: 'stop' }); await f.runtime.host.drive(); }
  }
}, 60_000);


// Unlimited token authorization keeps missing provider usage as unknown without
// changing the independently declared automatic retry allowance under test.
test('real provider failures spend two default automatic retries or four node overrides and remain spent after reopen', async () => {
  for (const retries of [2, 4]) {
    const errors: ResponsePlan[] = Array.from({ length: 12 }, () => ({ status: 404, errorCode: 'model_not_found', error: 'NODE_QUEUE_AUTOMATIC_RETRY_FAILURE', usage: { prompt_tokens: 1, completion_tokens: 0 } }));
    const f = await fixture({ a: errors }, retries === 4 ? { automatic: 4, resubmit: 1 } : undefined, true);
    await f.send('a', 0); await f.runtime.host.drive();
    const before = f.runtime.nodeRun(f.graphId, 'a');
    expect(before.operations, JSON.stringify({ run: before, requests: f.providers.a!.requests })).toMatchObject([{ state: 'failed', retries_used: retries, resubmits_used: 0 }]);
    await expect(f.main.graphInspect({ graphId: f.graphId, query: 'executions', id: 'a' })).resolves.toMatchObject({ items: [{ state: 'failed', attempt: retries + 1, retriesUsed: retries, resubmitsUsed: 0 }] });
    const sent = f.providers.a!.requests.length;
    expect(sent).toBeGreaterThanOrEqual(retries + 1);
    await f.reopen(); await f.runtime.host.drive();
    expect(f.providers.a!.requests).toHaveLength(sent);
    expect(f.runtime.nodeRun(f.graphId, 'a').operations).toMatchObject([{ state: 'failed', retries_used: retries, resubmits_used: 0 }]);
    await f.main.graphControl({ graphId: f.graphId, action: 'stop' }); await f.runtime.host.drive();
  }
}, 90_000);
