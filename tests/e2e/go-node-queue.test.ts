import { createServer, type Server } from 'node:http';

import type { AddressInfo } from 'node:net';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';
import { type ToolCall, type ChatMessage, type ChatBody, DEFINITION, deferred, type MasterCall, masterProvider, nodeProvider } from "./go-node-queue.fixture.ts";



/**
 * One node attempt as the product records it.
 *
 * These two cases used to assert `retries_used`, `resubmits_used` and the number
 * of model turns: internal bookkeeping that changes whenever the scheduler does,
 * so a suite that only reads it can go red on a refactor and green while the work
 * silently ran twice. What is durable is which execution ran, whether it landed a
 * submission, and what the graph ended up holding.
 */
interface Attempt { id: string; state: string; submission: string | null }

interface RunView {
  operations: { id: string; state: string; submission_id?: string | null }[];
  invocations: { id: string }[];
}

function attempts(view: RunView): Attempt[] {
  return view.operations.map(operation => ({
    id: operation.id, state: operation.state, submission: operation.submission_id ?? null,
  }));
}

/** The graph's deliverables, decoded the way the daemon decodes them. */
function deliverables(root: string, taskId: string): number[] {
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true, timeout: 5000 });
  const decode = (value: string): unknown => {
    const prefix = 'graph-content:sha256:';
    if (!value.startsWith(prefix)) return JSON.parse(value);
    const body = (db.prepare('SELECT body FROM kernel_content WHERE digest=?').get(value.slice(prefix.length)) as { body?: string } | undefined)?.body ?? '';
    return JSON.parse(body);
  };
  try {
    const rows = db.prepare('SELECT value FROM kernel_graph_results WHERE task_id=?').all(taskId) as { value: string }[];
    return rows.map(row => Number((decode(row.value) as { n?: number }).n));
  } finally {
    db.close();
  }
}

/**
 * What every turn of the node asked the model to do: the last user message of
 * each request, which is this turn's prompt. The whole history would repeat an
 * earlier prompt in every later request and turn one repair into several.
 */
function rounds(node: { turns: () => { messages?: { role?: string; content?: unknown }[] }[] }): string[] {
  return node.turns().map(turn => {
    const messages = turn.messages ?? [];
    const lastUser = [...messages].reverse().find(message => message.role === 'user');
    return typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
  });
}

test('one node serializes delivery, queued chat and later delivery while another node completes independently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-node-queue-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  // The chat and the later delivery must be queued while the first delivery
  // is still running, so the master waits for the node to reach the provider.
  const firstTurnStarted = deferred();
  // The queue is read again once the first delivery settled.
  const firstTurnSettled = deferred();

  const master = await masterProvider((graphId) => [
    { id: 'create-graph', name: 'graph_create', args: { requestId: 'create-graph', definition: DEFINITION } },
    { id: 'send-a-1', name: 'graph_send', args: { graphId, nodeId: 'a', input: 'job', value: { n: 1 } } },
    { id: 'send-b-2', name: 'graph_send', args: { graphId, nodeId: 'b', input: 'job', value: { n: 2 } } },
    { id: 'chat-a', name: 'graph_send', args: { graphId, nodeId: 'a', text: 'QUEUED_CHAT_AFTER_FIRST_STARTED' } },
    { id: 'send-a-3', name: 'graph_send', args: { graphId, nodeId: 'a', input: 'job', value: { n: 3 } } },
    { id: 'inspect-queue-busy', name: 'graph_inspect', args: { graphId, query: 'queue', id: 'a' } },
    { id: 'inspect-executions-b', name: 'graph_inspect', args: { graphId, query: 'executions', id: 'b' } },
    { id: 'inspect-queue-done', name: 'graph_inspect', args: { graphId, query: 'queue', id: 'a' } },
    { id: 'inspect-executions-a', name: 'graph_inspect', args: { graphId, query: 'executions', id: 'a' } },
    { id: 'inspect-results', name: 'graph_inspect', args: { graphId, query: 'results' } },
  ], { 'chat-a': firstTurnStarted.promise, 'inspect-queue-done': firstTurnSettled.promise });

  const a = await nodeProvider(['submit:1', 'text', 'text', 'submit:3', 'text'], { holdFirst: true });
  const b = await nodeProvider(['submit:2', 'text']);

  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'queue' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { queue: { secretRef: 'GRAPH_QUEUE_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'a', provider: 'graph-node-a', modelId: 'a-model', baseUrl: a.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'b', provider: 'graph-node-b', modelId: 'b-model', baseUrl: b.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_QUEUE_KEY: 'queue-synthetic' }, extraArgs: ['--execute'] });
    const request = async (path: string, init: RequestInit = {}) => {
      const response = await daemon!.request(path, init);
      return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
    };

    const created = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Queue two nodes.', requestId: 'node-queue' }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    // The first delivery of node a is running at the provider.
    await Promise.race([
      a.arrived,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the first node turn never reached the provider')), 60_000)),
    ]);
    firstTurnStarted.resolve();

    // The queue of node a while its first delivery runs: the delivery is
    // claimed, the chat and the later delivery wait their turn.
    await expect.poll(() => master.results.get('inspect-queue-busy'), { timeout: 60_000, interval: 250 }).toBeTruthy();
    const busy = JSON.parse(master.results.get('inspect-queue-busy')!) as { items: { kind: string; state: string }[] };
    expect(busy.items.map(item => [item.kind, item.state])).toEqual([
      ['delivery', 'claimed'], ['chat', 'queued'], ['delivery', 'queued'],
    ]);
    // The other node is not part of that queue.
    await expect.poll(() => master.results.get('inspect-executions-b'), { timeout: 60_000, interval: 250 }).toBeTruthy();
    const executionsB = JSON.parse(master.results.get('inspect-executions-b')!) as { items: { state: string }[] };
    expect(executionsB.items[0]).toMatchObject({ state: 'completed' });
    // The running turn has not seen the chat that arrived behind it.
    expect(a.turns()).toHaveLength(1);
    expect(JSON.stringify(a.turns()[0])).not.toContain('QUEUED_CHAT_AFTER_FIRST_STARTED');

    a.release();
    // The queue settles only after the last turn of the node did, so the
    // master only reads the finished queue once the node is done.
    await expect.poll(async () => {
      const view = await request(`/api/tasks/${master.graphId()}/nodes/a/run`);
      return (view.body as { node: { status: string } }).node?.status;
    }, { timeout: 90_000, interval: 250 }).toBe('succeeded');
    firstTurnSettled.resolve();

    // The queue of node a once everything settled, in the order it was taken.
    await expect.poll(() => master.results.get('inspect-queue-done'), { timeout: 90_000, interval: 250 }).toBeTruthy();
    const done = JSON.parse(master.results.get('inspect-queue-done')!) as { items: { kind: string; state: string }[] };
    expect(done.items.map(item => [item.kind, item.state])).toEqual([
      ['delivery', 'done'], ['chat', 'done'], ['delivery', 'done'],
    ]);
    await expect.poll(() => master.results.get('inspect-executions-a'), { timeout: 90_000, interval: 250 }).toBeTruthy();
    const executionsA = JSON.parse(master.results.get('inspect-executions-a')!) as { items: { state: string }[] };
    expect(executionsA.items.map(item => item.state)).toEqual(['completed', 'completed', 'completed']);
    // The chat was answered after the delivery it queued behind.
    expect(a.turns()).toHaveLength(5);
    expect(JSON.stringify(a.turns()[2])).toContain('QUEUED_CHAT_AFTER_FIRST_STARTED');
    // The results of the graph are the two submitted values.
    await expect.poll(() => master.results.get('inspect-results'), { timeout: 90_000, interval: 250 }).toBeTruthy();
    const results = JSON.parse(master.results.get('inspect-results')!) as { value: { n: number } }[];
    expect(results.filter(item => [1, 3].includes(item.value.n)).map(item => item.value.n)).toEqual([1, 3]);
  } finally {
    a.release(); b.release();
    await daemon?.close(); await master.close(); await a.close(); await b.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);



test('default resubmission is spent once and persisted failure totals survive reopen, while a node override permits two repairs', async () => {
  for (const override of [undefined, { automatic: 4, resubmit: 2 }]) {
    const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-node-resubmit-'));
    const project = join(root, 'project');
    await mkdir(project, { recursive: true });
    await mkdir(join(root, 'web'), { recursive: true });
    await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

    const definition = {
      schemaVersion: 2,
      name: 'Resubmission',
      protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
      nodes: {
        a: {
          recipe: 'coder@1', model: 'a', task: 'Submit the assigned output for deliveries',
          inputs: { job: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] },
          ...(override ? { retry: override } : {}),
        },
      },
      modules: {}, edges: {}, inputs: {},
      outputs: { a: { from: 'a.out', protocol: 'ping' } },
    };
    const master = await masterProvider((graphId) => [
      { id: 'create-graph', name: 'graph_create', args: { requestId: 'create-graph', definition } },
      { id: 'send-a', name: 'graph_send', args: { graphId, nodeId: 'a', input: 'job', value: { n: 0 } } },
    ], {});
    // Without the override the node may be repaired once; with it, twice.
    const a = await nodeProvider(override ? ['text', 'text', 'submit:7', 'text'] : ['text', 'text']);

    let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
    try {
      const configPath = join(root, 'graph.config.json');
      const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'queue' };
      await writeFile(configPath, JSON.stringify({
        version: 1,
        projects: [{ id: 'p', root: project }],
        credentials: { queue: { secretRef: 'GRAPH_QUEUE_KEY' } },
        models: { entries: [
          { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
          { ...entry, id: 'a', provider: 'graph-node-a', modelId: 'a-model', baseUrl: a.baseUrl, contextWindow: 32000 },
        ] },
      }));
      const start = async () => launchCli(root, { configPath, env: { GRAPH_QUEUE_KEY: 'queue-synthetic' }, extraArgs: ['--execute'] });
      daemon = await start();
      const request = async (path: string, init: RequestInit = {}) => {
        const response = await daemon!.request(path, init);
        return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
      };
      const view = async () => {
        const answer = await request(`/api/tasks/${master.graphId()}/nodes/a/run`);
        return answer.body as RunView;
      };
      const operations = async () => (await view()).operations;

      const created = await request('/api/conversations', {
        method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Repair the work.', requestId: 'node-resubmit' }),
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);

      // The turn without its required output is repaired as often as the
      // allowance says. What proves it is what the model read and what the graph
      // now holds: every round after the first carries the refusal of the missing
      // output, and only the allowance that permits the last repair produces a
      // deliverable at all.
      await expect.poll(async () => (await operations())[0]?.state, { timeout: 90_000, interval: 250 })
        .toBe(override ? 'completed' : 'failed');
      const settled = await view();
      expect(settled.operations.map(operation => operation.state)).toEqual([override ? 'completed' : 'failed']);
      const seen = rounds(a);
      // The turn after the bare reply is the repair, and it carries the refusal
      // that says which output was missing - the prompt a model has to read to
      // be able to repair anything at all.
      expect(seen[0]).not.toContain('were not enabled');
      expect(seen[1]).toContain('were not enabled');
      expect(deliverables(root, master.graphId())).toEqual(override ? [7] : []);
      const before = attempts(settled);
      const calls = settled.invocations.map(call => call.id);

      // A restart keeps the same executions, submissions and provider calls, so
      // it neither spends another repair nor asks the model again.
      await daemon.close();
      daemon = await start();
      await expect.poll(async () => (await operations())[0]?.state, { timeout: 60_000, interval: 250 })
        .toBe(override ? 'completed' : 'failed');
      const reopened = await view();
      expect(attempts(reopened)).toEqual(before);
      expect(reopened.invocations.map(call => call.id)).toEqual(calls);
      expect(rounds(a)).toEqual(seen);
      expect(deliverables(root, master.graphId())).toEqual(override ? [7] : []);
    } finally {
      await daemon?.close(); await master.close(); await a.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 240_000);



test('real provider failures spend two default automatic retries or four node overrides and remain spent after reopen', async () => {
  for (const retries of [2, 4]) {
    const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-node-retry-'));
    const project = join(root, 'project');
    await mkdir(project, { recursive: true });
    await mkdir(join(root, 'web'), { recursive: true });
    await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

    const definition = {
      schemaVersion: 2,
      name: 'Provider failures',
      protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
      nodes: {
        a: {
          recipe: 'coder@1', model: 'a', task: 'Submit the assigned output for deliveries',
          inputs: { job: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] },
          ...(retries === 4 ? { retry: { automatic: 4, resubmit: 1 } } : {}),
        },
      },
      modules: {}, edges: {}, inputs: {},
      outputs: { a: { from: 'a.out', protocol: 'ping' } },
    };
    const master = await masterProvider((graphId) => [
      { id: 'create-graph', name: 'graph_create', args: { requestId: 'create-graph', definition } },
      { id: 'send-a', name: 'graph_send', args: { graphId, nodeId: 'a', input: 'job', value: { n: 0 } } },
    ], {});
    // The model never answers: every call is a real provider failure.
    const a = await nodeProvider(Array.from({ length: 12 }, () => 'error:404'));

    let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
    try {
      const configPath = join(root, 'graph.config.json');
      const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'queue' };
      await writeFile(configPath, JSON.stringify({
        version: 1,
        projects: [{ id: 'p', root: project }],
        credentials: { queue: { secretRef: 'GRAPH_QUEUE_KEY' } },
        models: { entries: [
          { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
          { ...entry, id: 'a', provider: 'graph-node-a', modelId: 'a-model', baseUrl: a.baseUrl, contextWindow: 32000 },
        ] },
      }));
      const start = async () => launchCli(root, { configPath, env: { GRAPH_QUEUE_KEY: 'queue-synthetic' }, extraArgs: ['--execute'] });
      daemon = await start();
      const request = async (path: string, init: RequestInit = {}) => {
        const response = await daemon!.request(path, init);
        return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
      };
      const view = async () => {
        const answer = await request(`/api/tasks/${master.graphId()}/nodes/a/run`);
        return answer.body as RunView;
      };
      const operations = async () => (await view()).operations;

      const created = await request('/api/conversations', {
        method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Fail the work.', requestId: 'node-retry' }),
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);

      // Every attempt the allowance permits is a round the model really answered,
      // and only the first of them was the full briefing: the rest are
      // continuations of the same work. Nothing was submitted, so the graph holds
      // no deliverable.
      await expect.poll(async () => (await operations())[0]?.state, { timeout: 90_000, interval: 250 }).toBe('failed');
      const settled = await view();
      expect(settled.operations.map(operation => operation.state)).toEqual(['failed']);
      const seen = rounds(a);
      // One provider round per attempt the allowance permits, and every one of
      // them is a real request the model answered.
      expect(seen).toHaveLength(retries + 1);
      expect(settled.invocations).toHaveLength(seen.length);
      expect(deliverables(root, master.graphId())).toEqual([]);
      const before = attempts(settled);
      const calls = settled.invocations.map(call => call.id);

      // A restart neither spends another attempt nor asks the model again: the
      // provider received the same conversation, and the node's record is the
      // same rows.
      await daemon.close();
      daemon = await start();
      await expect.poll(async () => (await operations())[0]?.state, { timeout: 60_000, interval: 250 }).toBe('failed');
      const reopened = await view();
      expect(attempts(reopened)).toEqual(before);
      expect(reopened.invocations.map(call => call.id)).toEqual(calls);
      expect(rounds(a)).toEqual(seen);
    } finally {
      await daemon?.close(); await master.close(); await a.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 240_000);
