import { createServer, type Server } from 'node:http';

import type { AddressInfo } from 'node:net';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';
import { type ToolCall, type ChatMessage, type ChatBody, type MasterCall, masterProvider, nodeProvider, DATA, EXPRESSIONS } from "./go-graph-modules.fixture.ts";



test('each routing cascades through modules, keeps the order of the values and leaves disabled edges empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-graph-modules-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const definition = {
    schemaVersion: 2,
    name: 'Each cascade',
    protocols: { data: { type: 'object' } },
    nodes: {
      worker: {
        recipe: 'coder@1', model: 'sender', task: 'Read the received input and acknowledge it',
        inputs: { job: DATA }, outputs: {}, submission: {},
      },
    },
    modules: {
      gate: {
        type: 'router', trigger: 'each', inputs: { review: DATA }, outputs: { rework: DATA, approved: DATA },
        rules: [
          { when: 'review.passed == false', emit: { rework: '$review' } },
          { when: 'review.passed == true', emit: { approved: '$review' } },
        ],
      },
      second: {
        type: 'router', trigger: 'each', inputs: { review: DATA }, outputs: { out: DATA },
        rules: [{ when: 'review.passed == false', emit: { out: '$review' } }],
      },
    },
    edges: {
      rework: { from: 'gate.rework', to: 'worker.job', enabled: true },
      approve: { from: 'gate.approved', to: 'worker.job', enabled: true },
      cascade: { from: 'gate.rework', to: 'second.review', enabled: true },
      off: { from: 'gate.approved', to: 'second.review', enabled: false },
    },
    inputs: {},
    outputs: { result: { from: 'second.out', protocol: 'data' } },
  };

  const failed = { passed: false, reason: 'nope', reviewedCommit: 'abc' };
  const passed = { passed: true, reason: 'ok', reviewedCommit: 'def' };

  const node = await nodeProvider();
  const graphs: string[] = [];
  const master = await masterProvider(() => {
    const graphId = graphs[0] ?? '';
    return [
      { id: 'create', name: 'graph_create', args: { requestId: 'create', definition } },
      { id: 'pause-worker', name: 'graph_control', args: { graphId, action: 'pause', nodeId: 'worker' } },
      { id: 'send-unmatched', name: 'graph_send', args: { graphId, nodeId: 'gate', input: 'review', value: { passed: 'not matched' } } },
      {
        id: 'queue-empty', name: 'graph_inspect', args: { graphId, query: 'queue' },
        before: async () => {
          // The module really looked at the value and matched no rule.
          await waitForTransitions(graphId, 'gate', 1);
        },
      },
      { id: 'send-failed', name: 'graph_send', args: { graphId, nodeId: 'gate', input: 'review', value: failed } },
      { id: 'send-passed', name: 'graph_send', args: { graphId, nodeId: 'gate', input: 'review', value: passed } },
      {
        id: 'queue', name: 'graph_inspect', args: { graphId, query: 'queue' },
        before: async () => { await waitForTransitions(graphId, 'gate', 3); },
      },
      { id: 'edge-rework', name: 'graph_inspect', args: { graphId, query: 'edge', id: 'rework' } },
      { id: 'edge-off', name: 'graph_inspect', args: { graphId, query: 'edge', id: 'off' } },
      { id: 'module-values', name: 'graph_inspect', args: { graphId, query: 'module_values', id: 'second' } },
      { id: 'module', name: 'graph_inspect', args: { graphId, query: 'module', id: 'gate' } },
      { id: 'results', name: 'graph_inspect', args: { graphId, query: 'results' } },
      { id: 'resume-worker', name: 'graph_control', args: { graphId, action: 'resume', nodeId: 'worker' } },
      {
        id: 'executions', name: 'graph_inspect', args: { graphId, query: 'executions' },
        before: async () => { await waitForWorker(graphId); },
      },
      {
        id: 'summary', name: 'graph_inspect', args: { graphId, query: 'summary' },
        before: async () => {
          const completed = await request(`/api/tasks/${graphId}/graph/control`, { method: 'POST', body: JSON.stringify({ action: 'complete' }) });
          expect(completed.status, JSON.stringify(completed.body)).toBe(200);
          await waitFor(async () => (await request(`/api/tasks/${graphId}`)).body !== undefined
            && ((await request(`/api/tasks/${graphId}`)).body as { phase?: string }).phase === 'completed');
        },
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
  /** The module evaluated at least this many times. */
  const waitForTransitions = async (graphId: string, moduleId: string, count: number) => {
    await waitFor(async () => {
      const view = await request(`/api/tasks/${graphId}/graph/modules/${moduleId}`);
      const transitions = (view.body as { transitions?: unknown[] }).transitions ?? [];
      return transitions.length >= count;
    });
  };
  /** The node ran twice and is not running any more. */
  const waitForWorker = async (graphId: string) => {
    await waitFor(async () => {
      const view = await request(`/api/tasks/${graphId}/nodes/worker/run`);
      const operations = (view.body as { operations?: { state: string }[] }).operations ?? [];
      return operations.length >= 2 && !operations.some(operation => operation.state === 'running');
    });
  };

  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'modules' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { modules: { secretRef: 'GRAPH_MODULES_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'sender', provider: 'graph-node-sender', modelId: 'sender-model', baseUrl: node.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_MODULES_KEY: 'modules-synthetic' }, extraArgs: ['--execute'] });

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Route the reviews.', requestId: 'graph-modules' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    await expect.poll(() => master.results.has('summary'), { timeout: 180_000, interval: 250 }).toBeTruthy();
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    // A value that matched no rule became no work at all.
    const empty = JSON.parse(master.results.get('queue-empty')!) as { items: unknown[] };
    expect(empty.items).toEqual([]);

    // The values that did match kept their order on the queue.
    const queue = JSON.parse(master.results.get('queue')!) as { items: { payload: { value: unknown } }[] };
    expect(queue.items.map(item => item.payload.value)).toEqual([failed, passed]);

    // The rule that matched carried the value on its own edge.
    const rework = JSON.parse(master.results.get('edge-rework')!) as { deliveries: { source: string; value: unknown }[] };
    expect(rework.deliveries).toMatchObject([{ source: 'module', value: failed }]);
    // The edge that was switched off carried nothing.
    const off = JSON.parse(master.results.get('edge-off')!) as { deliveries: unknown[] };
    expect(off.deliveries).toEqual([]);

    // The module that was cascaded into really received the value.
    const values = JSON.parse(master.results.get('module-values')!) as { inputs: { name: string; value: unknown; delivered: boolean }[] };
    expect(values.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'review', value: failed, delivered: true })]));

    // Every evaluation says which rule it matched.
    const module = JSON.parse(master.results.get('module')!) as { transitions: { reason: string; ruleVersion: number }[] };
    expect(module.transitions.map(item => item.reason)).toEqual(['no rule matched', 'review.passed == false', 'review.passed == true']);
    expect(module.transitions.every(item => item.ruleVersion === 1)).toBe(true);

    // The cascaded output is on the graph.
    const results = JSON.parse(master.results.get('results')!) as { value: unknown }[];
    expect(results).toMatchObject([{ value: failed }]);

    // The node was asked once for each value that reached it.
    expect(node.turns()).toHaveLength(2);
    expect(JSON.stringify(node.turns()[0])).toContain('nope');
    expect(JSON.stringify(node.turns()[1])).toContain('ok');
    const executions = JSON.parse(master.results.get('executions')!) as { items: { nodeId: string; state: string }[] };
    expect(executions.items.filter(item => item.nodeId === 'worker')).toMatchObject([{ state: 'completed' }, { state: 'completed' }]);

    // The graph finished.
    const summary = JSON.parse(master.results.get('summary')!) as { phase: string };
    expect(summary.phase).toBe('completed');
  } finally {
    await daemon?.close(); await master.close(); await node.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);



test('rule expressions read the values, tell presence from absence and merge matching outputs in declaration order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-graph-rules-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const node = await nodeProvider();
  const graphs: string[] = [];
  const master = await masterProvider(() => {
    const calls: MasterCall[] = [];
    EXPRESSIONS.forEach((row, index) => {
      const graphId = graphs[index] ?? '';
      const definition = {
        schemaVersion: 2,
        name: `Expression ${index}`,
        protocols: { data: { type: 'object' } },
        nodes: {},
        modules: {
          rule: {
            type: 'router', trigger: 'each',
            inputs: { review: DATA, other: DATA, a: DATA, b: DATA, this: DATA },
            outputs: { out: DATA },
            rules: [{ when: row.when, emit: { out: { marker: 'matched' } } }],
          },
        },
        edges: {},
        inputs: {},
        outputs: { result: { from: 'rule.out', protocol: 'data' } },
      };
      calls.push({ id: `create-${index}`, name: 'graph_create', args: { requestId: `create-${index}`, definition } });
      let sent = 0;
      for (const [input, value] of Object.entries(row.inputs)) {
        sent += 1;
        calls.push({ id: `send-${index}-${input}`, name: 'graph_send', args: { graphId, nodeId: 'rule', input, value } });
      }
      calls.push({
        id: `results-${index}`, name: 'graph_inspect', args: { graphId, query: 'results' },
        before: async () => { await waitForTransitions(graphId, 'rule', sent); },
      });
    });
    return calls;
  }, (id, content) => {
    const match = /^create-(\d+)$/.exec(id);
    if (!match) return;
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (found) graphs[Number(match[1])] = found[1]!;
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
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'rules' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { rules: { secretRef: 'GRAPH_RULES_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'sender', provider: 'graph-node-sender', modelId: 'sender-model', baseUrl: node.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_RULES_KEY: 'rules-synthetic' }, extraArgs: ['--execute'] });

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Try the expressions.', requestId: 'graph-rules' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    await expect.poll(() => EXPRESSIONS.every((_, index) => master.results.has(`results-${index}`)), { timeout: 300_000, interval: 250 }).toBe(true);
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    // Every expression matches exactly what it claims to match.
    const violations: string[] = [];
    for (const [index, row] of EXPRESSIONS.entries()) {
      const results = JSON.parse(master.results.get(`results-${index}`)!) as { value: unknown }[];
      const matched = results.length > 0;
      if (matched !== row.matches) {
        violations.push(`${row.when}: expected ${row.matches ? 'a match' : 'no match'}, got ${JSON.stringify(results)}`);
      }
      if (matched) {
        const last = results[results.length - 1]!;
        if (JSON.stringify(last.value) !== JSON.stringify({ marker: 'matched' })) {
          violations.push(`${row.when}: the emitted value is ${JSON.stringify(last.value)}`);
        }
      }
    }
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  } finally {
    await daemon?.close(); await master.close(); await node.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
