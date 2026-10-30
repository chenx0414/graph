import { createServer, type Server } from 'node:http';

import type { AddressInfo } from 'node:net';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';
import { type ToolCall, type ChatMessage, type ChatBody, DEFINITION, deferred, type MasterCall, masterProvider, nodeProvider } from "./go-node-queue.fixture.ts";



test('a failed node retains its later input across reopen while another node runs, and explicit skip and resume release it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-node-retain-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const definition = {
    schemaVersion: 2,
    name: 'Retained input',
    protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
    nodes: {
      a: {
        recipe: 'coder@1', model: 'a', task: 'Submit the assigned output for deliveries',
        inputs: { job: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] },
        retry: { automatic: 0, resubmit: 0 },
      },
      b: {
        recipe: 'coder@1', model: 'b', task: 'Submit the assigned output for deliveries',
        inputs: { job: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] },
      },
    },
    modules: {}, edges: {}, inputs: {},
    outputs: { a: { from: 'a.out', protocol: 'ping' }, b: { from: 'b.out', protocol: 'ping' } },
  };
  // Before the restart the master reads the queue of the failed node; after
  // it, the same queue and the results of the work that was released.
  let phase: 'before' | 'after' = 'before';
  const queueStates = (results: Map<string, string>, id: string) => {
    const raw = results.get(id);
    if (!raw) return '';
    try {
      const items = (JSON.parse(raw) as { items?: { state: string }[] }).items ?? [];
      return items.map(item => item.state).join(',');
    } catch { return ''; }
  };
  const master = await masterProvider((graphId) => phase === 'before' ? [
    { id: 'create-graph', name: 'graph_create', args: { requestId: 'create-graph', definition } },
    { id: 'send-a-1', name: 'graph_send', args: { graphId, nodeId: 'a', input: 'job', value: { n: 1 } } },
    { id: 'send-a-3', name: 'graph_send', args: { graphId, nodeId: 'a', input: 'job', value: { n: 3 } } },
    { id: 'send-b-2', name: 'graph_send', args: { graphId, nodeId: 'b', input: 'job', value: { n: 2 } } },
    { id: 'inspect-queue-a', name: 'graph_inspect', args: { graphId, query: 'queue', id: 'a' },
      until: results => queueStates(results, 'inspect-queue-a') === 'failed,queued' },
  ] : [
    { id: 'inspect-queue-a-after', name: 'graph_inspect', args: { graphId, query: 'queue', id: 'a' } },
    { id: 'inspect-results-after', name: 'graph_inspect', args: { graphId, query: 'results' },
      until: results => /"n"\s*:\s*3/.test(results.get('inspect-results-after') ?? '') },
  ], {});
  // The first turn forgets the required output, the second one submits it.
  const a = await nodeProvider(['text', 'submit:3', 'text']);
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
    const start = async () => launchCli(root, { configPath, env: { GRAPH_QUEUE_KEY: 'queue-synthetic' }, extraArgs: ['--execute'] });
    daemon = await start();
    const request = async (path: string, init: RequestInit = {}) => {
      const response = await daemon!.request(path, init);
      return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
    };

    const created = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Retain the later work.', requestId: 'node-retain' }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;

    // The first delivery of node a fails without its required output, the
    // second one waits in the queue, and node b finishes on its own.
    await expect.poll(async () => {
      const view = await request(`/api/tasks/${master.graphId()}/nodes/a/run`);
      return (view.body as { node: { status: string } }).node?.status;
    }, { timeout: 90_000, interval: 250 }).toBe('failed');
    await expect.poll(async () => {
      const view = await request(`/api/tasks/${master.graphId()}/nodes/b/run`);
      return (view.body as { node: { status: string } }).node?.status;
    }, { timeout: 90_000, interval: 250 }).toBe('succeeded');

    // The master reads the queue of node a: the failed delivery and the
    // delivery that still waits behind it.
    await request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ text: 'Read the queue of the failed node.', requestId: 'read-queue' }),
    });
    await expect.poll(() => queueStates(master.results, 'inspect-queue-a'), { timeout: 90_000, interval: 250 }).toBe('failed,queued');
    const queue = JSON.parse(master.results.get('inspect-queue-a')!) as { items: { seq: number; kind: string; state: string }[] };
    expect(queue.items.map(item => [item.kind, item.state])).toEqual([['delivery', 'failed'], ['delivery', 'queued']]);
    expect(a.turns()).toHaveLength(1);

    // A restart keeps the failed delivery and the delivery behind it.
    await daemon.close();
    daemon = await start();
    phase = 'after';
    await request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ text: 'Read the queue again.', requestId: 'read-queue-again' }),
    });
    await expect.poll(() => master.results.get('inspect-queue-a-after'), { timeout: 90_000, interval: 250 }).toBeTruthy();
    const afterRestart = JSON.parse(master.results.get('inspect-queue-a-after')!) as { items: { seq: number; kind: string; state: string }[] };
    expect(afterRestart.items.map(item => [item.kind, item.state])).toEqual([['delivery', 'failed'], ['delivery', 'queued']]);
    expect(a.turns()).toHaveLength(1);

    // Skipping the failed delivery and resuming the node releases the work
    // that was waiting behind it.
    const skipped = await request(`/api/tasks/${master.graphId()}/graph/control`, {
      method: 'POST', body: JSON.stringify({ action: 'skip', seq: afterRestart.items[0]!.seq }),
    });
    expect(skipped.status, JSON.stringify(skipped.body)).toBe(200);
    // Skipping releases the delivery that waited behind the failed one, and it
    // starts running at once. A resume that arrives while that call is in flight
    // is refused on purpose - the node has a pending provider call, so resuming
    // it would be work on top of usage nobody has accounted for yet. Both
    // answers are correct, and which one comes back depends on whether the
    // released delivery has started, so the test asserts the contract instead
    // of the status code: the released work runs, and no answer corrupts the
    // node. Asserting a single status here made the test race its own skip.
    const resumed = await request(`/api/tasks/${master.graphId()}/graph/control`, {
      method: 'POST', body: JSON.stringify({ action: 'resume', nodeId: 'a' }),
    });
    if (resumed.status === 400) {
      expect((resumed.body as { code?: string }).code).toBe('unknown_usage');
      expect(String((resumed.body as { message?: string }).message)).toContain("pending provider calls before resuming");
    } else {
      expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    }
    await expect.poll(() => /"n"\s*:\s*3/.test(master.results.get('inspect-results-after') ?? ''), { timeout: 90_000, interval: 250 }).toBe(true);
    expect(a.turns()).toHaveLength(3);

    // Work that was submitted cannot be sent again.
    const retried = await request(`/api/tasks/${master.graphId()}/graph/control`, {
      method: 'POST', body: JSON.stringify({ action: 'retry', seq: afterRestart.items[1]!.seq }),
    });
    expect(retried.status).toBe(400);
    expect((retried.body as { code?: string }).code).toBe('invalid_queue');
  } finally {
    await daemon?.close(); await master.close(); await a.close(); await b.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
