import { createServer, type Server } from 'node:http';

import type { AddressInfo } from 'node:net';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';
import { type ToolCall, type ChatMessage, type ChatBody, type MasterCall, masterProvider, nodeProvider, DATA, EXPRESSIONS } from "./go-graph-modules.fixture.ts";



test('a once module keeps the inputs it holds, judges again only when it is reopened, and never replays its output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-graph-once-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const definition = {
    schemaVersion: 2,
    name: 'Once join',
    protocols: { data: { type: 'object' } },
    nodes: {},
    modules: {
      join: {
        type: 'router', trigger: 'once', requiredInputs: ['a', 'b'],
        inputs: { a: DATA, b: DATA, control: DATA },
        outputs: { pair: DATA },
        control: { reopen: 'control' },
        rules: [{ when: '$exists(a) && $exists(b)', emit: { pair: { first: '$a', second: '$b' } } }],
      },
    },
    edges: {},
    inputs: {},
    outputs: { result: { from: 'join.pair', protocol: 'data' } },
  };

  const node = await nodeProvider();
  const graphs: string[] = [];
  const master = await masterProvider(() => {
    const graphId = graphs[0] ?? '';
    return [
      { id: 'create', name: 'graph_create', args: { requestId: 'create', definition } },
      { id: 'send-a-1', name: 'graph_send', args: { graphId, nodeId: 'join', input: 'a', value: { passed: true } } },
      {
        id: 'results-1', name: 'graph_inspect', args: { graphId, query: 'results' },
        before: async () => { await waitForTransitions(graphId, 'join', 1); },
      },
      { id: 'send-b-1', name: 'graph_send', args: { graphId, nodeId: 'join', input: 'b', value: { passed: false } } },
      {
        id: 'results-2', name: 'graph_inspect', args: { graphId, query: 'results' },
        before: async () => { await waitForTransitions(graphId, 'join', 2); },
      },
      { id: 'send-a-2', name: 'graph_send', args: { graphId, nodeId: 'join', input: 'a', value: { passed: false } } },
      {
        id: 'results-3', name: 'graph_inspect', args: { graphId, query: 'results' },
        before: async () => { await waitForTransitions(graphId, 'join', 3); },
      },
      { id: 'values-1', name: 'graph_inspect', args: { graphId, query: 'module_values', id: 'join' } },
      { id: 'reopen', name: 'graph_control', args: { graphId, action: 'reopen', moduleId: 'join' } },
      {
        id: 'results-4', name: 'graph_inspect', args: { graphId, query: 'results' },
        before: async () => { await waitForTransitions(graphId, 'join', 4); },
      },
      { id: 'send-b-2', name: 'graph_send', args: { graphId, nodeId: 'join', input: 'b', value: { passed: true } } },
      {
        id: 'results-5', name: 'graph_inspect', args: { graphId, query: 'results' },
        before: async () => { await waitForTransitions(graphId, 'join', 5); },
      },
      { id: 'send-control', name: 'graph_send', args: { graphId, nodeId: 'join', input: 'control', value: { reopen: true } } },
      {
        id: 'results-6', name: 'graph_inspect', args: { graphId, query: 'results' },
        before: async () => { await waitForTransitions(graphId, 'join', 6); },
      },
      { id: 'values-2', name: 'graph_inspect', args: { graphId, query: 'module_values', id: 'join' } },
      { id: 'send-a-3', name: 'graph_send', args: { graphId, nodeId: 'join', input: 'a', value: { passed: true } } },
      {
        id: 'results-7', name: 'graph_inspect', args: { graphId, query: 'results' },
        before: async () => { await waitForTransitions(graphId, 'join', 7); },
      },
    ];
  }, (id, content) => {
    if (id !== 'create') return;
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (found) graphs[0] = found[1]!;
  });
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
  const waitForTransitions = async (graphId: string, moduleId: string, count: number) => {
    await waitFor(async () => {
      const view = await request(`/api/tasks/${graphId}/graph/modules/${moduleId}`);
      const transitions = (view.body as { transitions?: unknown[] }).transitions ?? [];
      return transitions.length >= count;
    });
  };

  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'once' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { once: { secretRef: 'GRAPH_ONCE_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'sender', provider: 'graph-node-sender', modelId: 'sender-model', baseUrl: node.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_ONCE_KEY: 'once-synthetic' }, extraArgs: ['--execute'] });

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Join the values.', requestId: 'graph-once' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    await expect.poll(() => master.results.has('results-7'), { timeout: 180_000, interval: 250 }).toBeTruthy();
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    const read = (id: string) => JSON.parse(master.results.get(id)!) as { value: unknown }[];

    // One input is not enough: the module waits for the one it declared.
    expect(read('results-1')).toEqual([]);
    // Both are there: it judges once and pairs them.
    expect(read('results-2')).toMatchObject([{ value: { first: { passed: true }, second: { passed: false } } }]);
    // A latched module does not judge again, so nothing is replayed.
    expect(read('results-3')).toHaveLength(1);

    // The module kept the values it was given, including the updated one.
    const values = JSON.parse(master.results.get('values-1')!) as { inputs: { name: string; value: unknown; delivered: boolean }[] };
    expect(values.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'a', value: { passed: false }, delivered: true }),
      expect.objectContaining({ name: 'b', value: { passed: false }, delivered: true }),
    ]));

    // Reopening the module is not a judgment: it clears the latch and keeps the inputs.
    expect(read('results-4')).toHaveLength(1);
    // The next delivery judges again, with the values the module holds.
    expect(read('results-5')).toMatchObject([{}, { value: { first: { passed: false }, second: { passed: true } } }]);

    // A delivered control reopens the module without producing anything.
    expect(read('results-6')).toHaveLength(2);
    const afterControl = JSON.parse(master.results.get('values-2')!) as { inputs: { name: string; value: unknown; delivered: boolean }[] };
    expect(afterControl.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'control', delivered: false }),
      expect.objectContaining({ name: 'a', value: { passed: false } }),
      expect.objectContaining({ name: 'b', value: { passed: true } }),
    ]));

    // And the next delivery judges once more.
    expect(read('results-7')).toMatchObject([{}, {}, { value: { first: { passed: true }, second: { passed: true } } }]);
  } finally {
    await daemon?.close(); await master.close(); await node.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
