import { createServer, type Server } from 'node:http';

import type { AddressInfo } from 'node:net';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';
import { type ToolCall, type ChatMessage, type ChatBody, GATES_DEFINITION, MODULE_DEFINITION, type MasterCall, masterProvider, nodeProvider, type ControlRecord } from "./go-graph-lifecycle.fixture.ts";



test('a blocked completion stays closed until it is withdrawn, a stopped graph cancels its queued work and an ended graph refuses every control', async () => {
  for (const phase of ['stopped', 'completed'] as const) {
    const root = await mkdtemp(join(tmpdir(), `graph-e2e-go-graph-lifecycle-${phase}-`));
    const project = join(root, 'project');
    await mkdir(project, { recursive: true });
    await mkdir(join(root, 'web'), { recursive: true });
    await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

    const node = await nodeProvider();
    // The plan is filled in once the daemon is up; the master reads it on
    // every turn, so the order of the calls is the order of the plan.
    let plan: (graphId: string) => MasterCall[] = () => [];
    const master = await masterProvider(graphId => plan(graphId));
    const controls: ControlRecord[] = [];
    let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;

    const request = async (path: string, init: RequestInit = {}) => {
      const response = await daemon!.request(path, init);
      return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
    };
    const control = async (graphId: string, body: Record<string, unknown>, group = 'other') => {
      const response = await request(`/api/tasks/${graphId}/graph/control`, {
        method: 'POST', body: JSON.stringify(body),
      });
      const parsed = response.body as { code?: string; message?: string; phase?: string };
      controls.push({ group, action: String(body.action ?? ''), status: response.status, code: parsed.code, message: parsed.message, phase: parsed.phase });
      return response;
    };
    const waitPhase = async (graphId: string, wanted: string) => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const view = await request(`/api/tasks/${graphId}`);
        if ((view.body as { phase?: string }).phase === wanted) return;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new Error(`the graph never reached the phase ${wanted}`);
    };

    try {
      const configPath = join(root, 'graph.config.json');
      const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'lifecycle' };
      await writeFile(configPath, JSON.stringify({
        version: 1,
        projects: [{ id: 'p', root: project }],
        credentials: { lifecycle: { secretRef: 'GRAPH_LIFECYCLE_KEY' } },
        models: { entries: [
          { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
          { ...entry, id: 'work', provider: 'graph-node-work', modelId: 'work-model', baseUrl: node.baseUrl, contextWindow: 32000 },
        ] },
      }));
      daemon = await launchCli(root, { configPath, env: { GRAPH_LIFECYCLE_KEY: 'lifecycle-synthetic' }, extraArgs: ['--execute'] });

      plan = (graphId: string): MasterCall[] => {
        const calls: MasterCall[] = [
          { id: 'create', name: 'graph_create', args: { requestId: 'create', definition: GATES_DEFINITION } },
          {
            id: 'send-work', name: 'graph_send',
            args: { graphId, nodeId: 'work', input: 'job', value: { marker: phase } },
            before: async () => { await control(graphId, { action: 'pause', nodeId: 'work' }); },
          },
          {
            id: 'send-refused-value', name: 'graph_send',
            args: { graphId, nodeId: 'work', input: 'job', value: {} },
            before: async () => {
              const completed = await control(graphId, { action: 'complete' });
              expect(completed.status, JSON.stringify(completed.body)).toBe(200);
              // The completion is asked for and the outside is closed at once.
              expect((completed.body as { phase: string }).phase).toBe('completing');
              await waitPhase(graphId, 'blocked');
            },
          },
          { id: 'send-refused-chat', name: 'graph_send', args: { graphId, nodeId: 'work', text: 'Fresh external work' } },
          {
            id: 'inspect-queue', name: 'graph_inspect', args: { graphId, query: 'queue' },
            before: async () => {
              const withdrawn = await control(graphId, { action: 'withdraw_complete' });
              expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
            },
          },
        ];
        if (phase === 'stopped') {
          calls.push({
            id: 'inspect-queue-settled', name: 'graph_inspect', args: { graphId, query: 'queue' },
            before: async () => {
              await control(graphId, { action: 'pause' });
              // A paused graph keeps phase "running" in its task row and carries the
              // pause in its own column. The node chat reads this view to decide
              // whether to say the task is paused, so it has to see "paused" here.
              const pausedView = await request(`/api/tasks/${graphId}/nodes/work/run`);
              expect((pausedView.body as { phase?: string }).phase).toBe('paused');
              const stopped = await control(graphId, { action: 'stop' });
              expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
              await waitPhase(graphId, 'stopped');
            },
          });
        } else {
          calls.push({
            id: 'send-gate', name: 'graph_send',
            args: { graphId, nodeId: 'gate', input: 'job', value: { marker: 'LATCHED' } },
            before: async () => {
              const queue = JSON.parse(master.results.get('inspect-queue')!) as { items: { seq: number }[] };
              const cancelled = await control(graphId, { action: 'cancel', seq: queue.items[0]!.seq });
              expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
              const resumed = await control(graphId, { action: 'resume', nodeId: 'work' });
              expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
            },
          });
          calls.push({
            id: 'inspect-module', name: 'graph_inspect', args: { graphId, query: 'module', id: 'gate' },
            before: async () => {
              const completed = await control(graphId, { action: 'complete' });
              expect(completed.status, JSON.stringify(completed.body)).toBe(200);
              await waitPhase(graphId, 'completed');
            },
          });
          calls.push({ id: 'inspect-queue-settled', name: 'graph_inspect', args: { graphId, query: 'queue' } });
        }
        calls.push({
          id: 'patch-ended', name: 'graph_patch',
          args: { graphId, baseRevision: 1, changes: { reason: 'Attempt reopening', patch: { name: 'reopened' } } },
        });
        calls.push({
          id: 'final-inspect', name: 'graph_inspect', args: { graphId, query: 'summary' },
          before: async () => {
            const queue = JSON.parse(master.results.get('inspect-queue')!) as { items: { seq: number }[] };
            const seq = queue.items[0]!.seq;
            for (const body of [
              { action: 'pause' }, { action: 'resume' }, { action: 'pause', nodeId: 'work' }, { action: 'resume', nodeId: 'work' },
              { action: 'reopen', moduleId: 'gate' }, { action: 'retry', seq }, { action: 'skip', seq }, { action: 'cancel', seq },
            ]) await control(graphId, body, 'execution');
            await control(graphId, { action: 'withdraw_complete' }, 'ended');
            await control(graphId, { action: 'complete' }, 'ended');
            await control(graphId, { action: 'stop' }, 'ended');
          },
        });
        calls.push({ id: 'inspect-queue-final', name: 'graph_inspect', args: { graphId, query: 'queue' } });
        return calls;
      };

      const started = await request('/api/conversations', {
        method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Exercise the lifecycle gates.', requestId: `lifecycle-${phase}` }),
      });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      await expect.poll(() => master.results.get('final-inspect'), { timeout: 120_000, interval: 250 }).toBeTruthy();
      // The last call of the plan is the queue that is read back after the
      // refusals: once it is there, the whole plan has been played.
      await expect.poll(() => master.results.get('inspect-queue-final'), { timeout: 120_000, interval: 250 }).toBeTruthy();

      // The delivery that arrived while the completion was closed is refused,
      // and the model is told why.
      expect(master.results.get('send-refused-value')).toContain('is completing; external delivery is closed');
      expect(master.results.get('send-refused-chat')).toContain('is completing; execution-triggering chat is closed');
      // A patch cannot reopen a graph that has ended.
      expect(master.results.get('patch-ended')).toContain('Ended graph cannot be patched');

      // The queue is back to the work that was waiting, and it is the same
      // work: one generation, still queued.
      const queue = JSON.parse(master.results.get('inspect-queue')!) as { items: { seq: number; state: string; generation: number }[] };
      expect(queue.items).toMatchObject([{ state: 'queued', generation: 0 }]);

      const summary = JSON.parse(master.results.get('final-inspect')!) as { graphId: string; phase: string; revision: number };
      expect(summary.phase).toBe(phase);
      expect(summary.revision).toBe(1);

      if (phase === 'stopped') {
        // Stopping cancels the work that was queued for the graph.
        const settled = JSON.parse(master.results.get('inspect-queue-settled')!) as { items: { seq: number; state: string; reason: string }[] };
        expect(settled.items).toMatchObject([{ seq: queue.items[0]!.seq, state: 'done', reason: 'cancelled by stop' }]);
      } else {
        // The module ran on the delivery that was accepted, and the graph
        // settled on it.
        const module = JSON.parse(master.results.get('inspect-module')!) as { triggered: boolean };
        expect(module.triggered).toBe(true);
      }

      // Every execution control is refused once the graph has ended, with the
      // daemon's own code.
      const executionControls = controls.filter(record => record.group === 'execution');
      expect(executionControls).toHaveLength(8);
      for (const record of executionControls) {
        expect(record.status, JSON.stringify(record)).toBe(400);
        expect(record.code, JSON.stringify(record)).toBe('invalid_graph');
        expect(record.message, JSON.stringify(record)).toContain('Ended graph');
      }
      // The other controls of an ended graph are refused as well; only a graph
      // that already completed accepts another completion.
      const endedControls = controls.filter(record => record.group === 'ended');
      expect(endedControls).toHaveLength(3);
      const accepted = endedControls.filter(record => record.status === 200);
      expect(accepted.map(record => record.action)).toEqual(phase === 'completed' ? ['complete', 'stop'] : ['stop']);
      for (const record of endedControls.filter(record => record.status !== 200)) {
        expect(record.code, JSON.stringify(record)).toBe('invalid_graph');
      }
      // The refusals left the queue alone.
      expect(master.results.get('inspect-queue-final')).toBe(master.results.get('inspect-queue-settled'));

      // The node was parked for the whole run: it was never asked for a turn.
      expect(node.turns()).toEqual([]);
    } finally {
      await daemon?.close(); await master.close(); await node.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 300_000);



test('a public module input validates as a whole, reports the delivery it really accepted and drains after the external completion closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-graph-module-input-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const node = await nodeProvider();
  let plan: (graphId: string) => MasterCall[] = () => [];
  const master = await masterProvider(graphId => plan(graphId));
  const controls: ControlRecord[] = [];
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon!.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  const control = async (graphId: string, body: Record<string, unknown>, group = 'other') => {
    const response = await request(`/api/tasks/${graphId}/graph/control`, {
      method: 'POST', body: JSON.stringify(body),
    });
    const parsed = response.body as { code?: string; message?: string; phase?: string };
    controls.push({ group, action: String(body.action ?? ''), status: response.status, code: parsed.code, message: parsed.message, phase: parsed.phase });
    return response;
  };

  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'lifecycle' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { lifecycle: { secretRef: 'GRAPH_LIFECYCLE_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'work', provider: 'graph-node-work', modelId: 'work-model', baseUrl: node.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_LIFECYCLE_KEY: 'lifecycle-synthetic' }, extraArgs: ['--execute'] });

    plan = (graphId: string): MasterCall[] => [
      { id: 'create', name: 'graph_create', args: { requestId: 'create', definition: MODULE_DEFINITION } },
      { id: 'send-invalid', name: 'graph_send', args: { graphId, input: 'start', value: { n: 'bad' } } },
      { id: 'inspect-module', name: 'graph_inspect', args: { graphId, query: 'module', id: 'route' } },
      // The value that fits is handed over the way a model often does it: as an
      // encoded JSON string. It must arrive as the object, not as text.
      { id: 'send-valid', name: 'graph_send', args: { graphId, input: 'start', value: '{"n":7}' } },
      {
        id: 'send-refused', name: 'graph_send', args: { graphId, nodeId: 'route', input: 'job', value: { n: 8 } },
        before: async () => {
          const completed = await control(graphId, { action: 'complete' });
          expect(completed.status, JSON.stringify(completed.body)).toBe(200);
          // The completion is asked for and the outside is closed at once.
          expect((completed.body as { phase: string }).phase).toBe('completing');
        },
      },
      { id: 'inspect-results', name: 'graph_inspect', args: { graphId, query: 'results' } },
      { id: 'inspect-summary', name: 'graph_inspect', args: { graphId, query: 'summary' } },
    ];

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Feed the public module input.', requestId: 'module-input' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await expect.poll(() => master.results.get('inspect-summary'), { timeout: 120_000, interval: 250 }).toBeTruthy();

    // The value that does not fit the protocol is refused as a whole, and
    // the refusal names the field that does not fit.
    expect(master.results.get('send-invalid')).toContain('route.job/n');
    const module = JSON.parse(master.results.get('inspect-module')!) as { inputs: { name: string; missing: boolean }[]; transitions: unknown[] };
    expect(module.inputs).toMatchObject([{ name: 'job', missing: true }]);
    expect(module.transitions).toEqual([]);

    // The value that fits is accepted, and the delivery says where it came
    // from: the outside, directly, on the declared endpoint.
    const accepted = JSON.parse(master.results.get('send-valid')!) as { delivery: Record<string, unknown> };
    // The model sent "{\"n\":7}": the delivery reads as the object, not text.
    expect(accepted.delivery).toMatchObject({
      source: 'direct', edgeId: null, fromEndpoint: 'main', toEndpoint: 'route.job',
      protocol: 'number', value: { n: 7 }, revisionVersion: 1,
    });

    // While the completion is closing, the outside cannot hand in anything
    // new.
    expect(master.results.get('send-refused')).toContain('is completing; external delivery is closed');

    // The graph drained on the delivery it accepted.
    const results = JSON.parse(master.results.get('inspect-results')!) as { value: { n: number } }[];
    expect(results).toMatchObject([{ value: { n: 7 } }]);
    const summary = JSON.parse(master.results.get('inspect-summary')!) as { phase: string };
    expect(summary.phase).toBe('completed');

    // Exactly one delivery was accepted, and it is the one that was valid.
    const events = await request(`/api/tasks/${master.graphId()}/events`);
    const acceptedEvents = (events.body as { type: string }[]).filter(event => event.type === 'graph.delivery.accepted');
    expect(acceptedEvents).toHaveLength(1);

    // The graph had no node to run, so no model was ever asked for a turn.
    expect(node.turns()).toEqual([]);
  } finally {
    await daemon?.close(); await master.close(); await node.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
