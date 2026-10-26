import { createServer, type Server } from 'node:http';

import type { AddressInfo } from 'node:net';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';
import { type ToolCall, type ChatMessage, type ChatBody, type MasterCall, masterProvider, nodeProvider, BASE, withNode, type Refusal, REFUSALS, PROTOCOL, ROUND_TRIP } from "./go-graph-definitions.fixture.ts";



test('a definition that breaks one rule is refused by name and leaves no graph behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-graph-definitions-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const node = await nodeProvider();
  // Every refusal names its rule, and no two definitions share a name: a graph
  // that was really created would be visible in the task list.
  const master = await masterProvider(() => REFUSALS.map((refusal, index) => ({
    id: `reject-${index}`,
    name: 'graph_create',
    args: { requestId: `reject-${index}`, definition: { ...(refusal.definition as object), name: refusal.name } },
  })));
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon!.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };

  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'definitions' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { definitions: { secretRef: 'GRAPH_DEFINITIONS_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'sender', provider: 'graph-node-sender', modelId: 'sender-model', baseUrl: node.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_DEFINITIONS_KEY: 'definitions-synthetic' }, extraArgs: ['--execute'] });

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Try the broken definitions.', requestId: 'graph-definitions' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    await expect.poll(() => REFUSALS.every((_, index) => master.results.has(`reject-${index}`)), { timeout: 180_000, interval: 250 }).toBe(true);
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    // Every broken definition is refused, and the refusal names the rule.
    // The violations are collected first, so one run names every rule the
    // daemon let through.
    const violations: string[] = [];
    for (const [index, refusal] of REFUSALS.entries()) {
      const result = master.results.get(`reject-${index}`)!;
      if (!result.includes(refusal.fragment)) {
        violations.push(`${refusal.name}: the refusal does not name "${refusal.fragment}" (${result.slice(0, 200)})`);
      }
      // A refused definition is not a graph: it has no id to work with.
      if (result.includes('"graphId"')) {
        violations.push(`${refusal.name}: the daemon built a graph anyway`);
      }
    }
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);

    // No half-built graph is left behind.
    const tasks = await request('/api/tasks');
    const names = new Set(REFUSALS.map(refusal => refusal.name));
    const created = (tasks.body as { request: string }[]).filter(task => names.has(task.request));
    expect(created, JSON.stringify(created)).toEqual([]);

    // A refused definition never reaches a node: nobody was asked to work.
    expect(node.turns()).toHaveLength(0);
  } finally {
    await daemon?.close(); await master.close(); await node.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);



test('a value that breaks the receiving protocol is refused before any node is asked, and a valid value survives unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-graph-protocol-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const node = await nodeProvider({ echo: true });
  const notes: Record<string, unknown> = {};
  const master = await masterProvider(graphId => [
    { id: 'create', name: 'graph_create', args: { requestId: 'create', definition: ROUND_TRIP } },
    { id: 'bad-status', name: 'graph_send', args: { graphId, nodeId: 'worker', input: 'job', value: { status: 'made-up', items: [1] } } },
    { id: 'bad-empty', name: 'graph_send', args: { graphId, nodeId: 'worker', input: 'job', value: { status: 'approved', items: [] } } },
    { id: 'bad-element', name: 'graph_send', args: { graphId, nodeId: 'worker', input: 'job', value: { status: 'approved', items: [0] } } },
    { id: 'bad-extra', name: 'graph_send', args: { graphId, nodeId: 'worker', input: 'job', value: { status: 'approved', items: [1], extra: true } } },
    {
      id: 'queue', name: 'graph_inspect', args: { graphId, query: 'queue' },
      before: async () => { notes.turnsAfterRefusals = node.turns().length; },
    },
    { id: 'good', name: 'graph_send', args: { graphId, nodeId: 'worker', input: 'job', value: { status: 'approved', items: [1] } } },
    {
      id: 'results', name: 'graph_inspect', args: { graphId, query: 'results' },
      before: async () => {
        // The node really ran and really submitted the value it was given.
        await waitFor(async () => {
          const run = await request(`/api/tasks/${graphId}/nodes/worker/run`);
          const operations = (run.body as { operations: { state: string }[] }).operations ?? [];
          return operations.length >= 1 && !operations.some(operation => operation.state === 'running');
        });
      },
    },
    {
      id: 'summary', name: 'graph_inspect', args: { graphId, query: 'summary' },
      before: async () => {
        const completed = await request(`/api/tasks/${graphId}/graph/control`, { method: 'POST', body: JSON.stringify({ action: 'complete' }) });
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        await waitFor(async () => {
          const view = await request(`/api/tasks/${graphId}`);
          return (view.body as { phase?: string }).phase === 'completed';
        });
      },
    },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon!.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  const waitFor = async (read: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await read()) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('the graph never reached the expected state');
  };

  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'protocol' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { protocol: { secretRef: 'GRAPH_PROTOCOL_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'sender', provider: 'graph-node-sender', modelId: 'sender-model', baseUrl: node.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_PROTOCOL_KEY: 'protocol-synthetic' }, extraArgs: ['--execute'] });

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Deliver the values.', requestId: 'graph-protocol' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    await expect.poll(() => master.results.has('summary'), { timeout: 180_000, interval: 250 }).toBeTruthy();
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    // Every malformed value is refused, and the refusal names the field that
    // broke the protocol.
    const refused = ['bad-status', 'bad-empty', 'bad-element', 'bad-extra'];
    for (const id of refused) {
      const result = master.results.get(id)!;
      expect(result, id).toContain('worker.job');
      expect(result, id).not.toContain('"delivery"');
    }

    // Nothing was queued: the values never became work.
    const queue = JSON.parse(master.results.get('queue')!) as { items: unknown[] };
    expect(queue.items).toEqual([]);
    // And no node was asked about them.
    expect(notes.turnsAfterRefusals).toBe(0);

    // The valid value went through the node unchanged.
    const results = JSON.parse(master.results.get('results')!) as { value: unknown }[];
    expect(results).toMatchObject([{ value: { status: 'approved', items: [1] } }]);
    // The node was asked exactly about the value that was accepted.
    expect(node.turns().length).toBeGreaterThan(0);

    // The graph finished.
    const summary = JSON.parse(master.results.get('summary')!) as { phase: string };
    expect(summary.phase).toBe('completed');
  } finally {
    await daemon?.close(); await master.close(); await node.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
