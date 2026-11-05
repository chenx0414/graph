import { createServer, type Server } from 'node:http';

import type { AddressInfo } from 'node:net';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';
import { type ToolCall, type ChatMessage, type ChatBody, DEFINITION, deferred, type MasterCall, masterProvider, nodeProvider } from "./go-node-queue.fixture.ts";



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
    // The reader typed while the node was busy. The node chat has to say the
    // message is waiting, exactly as the main conversation says it, or a second
    // message looks like it went nowhere.
    const waiting = await request(`/api/tasks/${master.graphId()}/nodes/a/run`);
    expect((waiting.body as { queued: { text: string }[] }).queued.map(item => item.text))
      .toEqual(['QUEUED_CHAT_AFTER_FIRST_STARTED']);

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
    // Once the node took the message there is nothing left to wait for, so the
    // bar goes away instead of listing work that already happened.
    const drained = await request(`/api/tasks/${master.graphId()}/nodes/a/run`);
    expect((drained.body as { queued: unknown[] }).queued).toEqual([]);
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
      const operations = async () => {
        const view = await request(`/api/tasks/${master.graphId()}/nodes/a/run`);
        return (view.body as { operations: { state: string; retries_used: number; resubmits_used: number }[] }).operations;
      };

      const created = await request('/api/conversations', {
        method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Repair the work.', requestId: 'node-resubmit' }),
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);

      // The turn without its required output is repaired as often as the
      // allowance says, and the spent repair is part of the node's record.
      await expect.poll(async () => (await operations())[0]?.state, { timeout: 90_000, interval: 250 })
        .toBe(override ? 'completed' : 'failed');
      expect((await operations())[0]).toMatchObject({ retries_used: 0, resubmits_used: override ? 2 : 1 });
      expect(a.turns()).toHaveLength(override ? 4 : 2);

      // A restart keeps the spent repair and does not ask the model again.
      await daemon.close();
      daemon = await start();
      await expect.poll(async () => (await operations())[0]?.state, { timeout: 60_000, interval: 250 })
        .toBe(override ? 'completed' : 'failed');
      expect((await operations())[0]).toMatchObject({ retries_used: 0, resubmits_used: override ? 2 : 1 });
      expect(a.turns()).toHaveLength(override ? 4 : 2);
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
      const operations = async () => {
        const view = await request(`/api/tasks/${master.graphId()}/nodes/a/run`);
        return (view.body as { operations: { state: string; retries_used: number; resubmits_used: number }[] }).operations;
      };

      const created = await request('/api/conversations', {
        method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Fail the work.', requestId: 'node-retry' }),
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);

      // Every automatic retry the node is allowed is spent on a real
      // provider failure, and the spent retries stay on its record.
      await expect.poll(async () => (await operations())[0]?.state, { timeout: 90_000, interval: 250 }).toBe('failed');
      expect((await operations())[0]).toMatchObject({ retries_used: retries, resubmits_used: 0 });
      expect(a.turns().length).toBeGreaterThanOrEqual(retries + 1);

      // A restart neither spends another retry nor asks the model again.
      const sent = a.turns().length;
      await daemon.close();
      daemon = await start();
      await expect.poll(async () => (await operations())[0]?.state, { timeout: 60_000, interval: 250 }).toBe('failed');
      expect((await operations())[0]).toMatchObject({ retries_used: retries, resubmits_used: 0 });
      expect(a.turns()).toHaveLength(sent);
    } finally {
      await daemon?.close(); await master.close(); await a.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 240_000);
