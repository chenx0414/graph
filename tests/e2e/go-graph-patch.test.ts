import { createServer, type Server } from 'node:http';

import type { AddressInfo } from 'node:net';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';
import { type ToolCall, type ChatMessage, type ChatBody, DEFINITION, type MasterCall, masterProvider, nodeProvider } from "./go-graph-patch.fixture.ts";



test('a patch before the submit changes the routing of that submit, and accepted work survives a later patch that removes the connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-graph-patch-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const sender = await nodeProvider({ hold: true, submit: true });
  const receiver = await nodeProvider({ submit: false });
  let plan: (graphId: string) => MasterCall[] = () => [];
  const master = await masterProvider(graphId => plan(graphId));
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  const notes: Record<string, unknown> = {};

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon!.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  const control = async (graphId: string, body: Record<string, unknown>) => {
    const response = await request(`/api/tasks/${graphId}/graph/control`, {
      method: 'POST', body: JSON.stringify(body),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response;
  };
  const nodeRun = async (graphId: string, nodeId: string) => {
    const view = await request(`/api/tasks/${graphId}/nodes/${nodeId}/run`);
    return view.body as {
      node: { status: string };
      instance: { id: string };
      timing: { inProgress: boolean };
      entries: unknown[];
      operations: { state: string }[];
    };
  };
  /** The node has run at least this many times, and none of those runs is in flight. */
  const nodeSettled = async (graphId: string, nodeId: string, count: number) => {
    const run = await nodeRun(graphId, nodeId);
    const operations = run.operations ?? [];
    return operations.length >= count && !operations.some(operation => operation.state === 'running');
  };
  /** The node is working right now. */
  const nodeWorking = async (graphId: string, nodeId: string) => {
    const run = await nodeRun(graphId, nodeId);
    return (run.operations ?? []).some(operation => operation.state === 'running');
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
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'patch' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { patch: { secretRef: 'GRAPH_PATCH_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'a', provider: 'graph-node-a', modelId: 'a-model', baseUrl: sender.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'b', provider: 'graph-node-b', modelId: 'b-model', baseUrl: receiver.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_PATCH_KEY: 'patch-synthetic' }, extraArgs: ['--execute'] });

    plan = (graphId: string): MasterCall[] => [
      { id: 'create', name: 'graph_create', args: { requestId: 'create', definition: DEFINITION } },
      {
        id: 'send-a-1', name: 'graph_send', args: { graphId, nodeId: 'a', input: 'job', value: {} },
        before: async () => { await control(graphId, { action: 'pause', nodeId: 'b' }); },
      },
      {
        id: 'patch-disable', name: 'graph_patch',
        args: { graphId, baseRevision: 1, changes: { reason: 'Disable before the actual submit arrives', patch: { edges: { link: { enabled: false } } } } },
        before: async () => {
          // The node is working when the patch lands: the submit has not
          // arrived yet.
          await waitFor(async () => nodeWorking(graphId, 'a'));
          notes.aRunning = true;
        },
      },
      {
        id: 'inspect-edge-1', name: 'graph_inspect', args: { graphId, query: 'edge', id: 'link' },
        before: async () => {
          sender.release();
          await waitFor(async () => nodeSettled(graphId, 'a', 1));
          // Nothing reached the other node: it was not asked for a turn.
          notes.receiverTurns = receiver.turns().length;
        },
      },
      { id: 'patch-enable', name: 'graph_patch', args: { graphId, baseRevision: 2, changes: { reason: 'Enable a new future submission', patch: { edges: { link: { enabled: true } } } } } },
      { id: 'send-a-2', name: 'graph_send', args: { graphId, nodeId: 'a', input: 'job', value: {} } },
      {
        id: 'inspect-edge-2', name: 'graph_inspect', args: { graphId, query: 'edge', id: 'link' },
        before: async () => { await waitFor(async () => nodeSettled(graphId, 'a', 2)); },
      },
      { id: 'patch-remove', name: 'graph_patch', args: { graphId, baseRevision: 3, changes: { reason: 'Remove only the future connection', patch: { edges: { link: null } } } } },
      { id: 'patch-stale', name: 'graph_patch', args: { graphId, baseRevision: 3, changes: { reason: 'Stale name edit', patch: { name: 'stale' } } } },
      { id: 'inspect-revision', name: 'graph_inspect', args: { graphId, query: 'revision' } },
      { id: 'patch-ambiguous', name: 'graph_patch', args: { graphId, baseRevision: 4, changes: { reason: 'Ambiguous', definition: DEFINITION, patch: {} } } },
      { id: 'patch-not-object', name: 'graph_patch', args: { graphId, baseRevision: 4, changes: { reason: 'Not an object', patch: [] } } },
      { id: 'patch-unknown-protocol', name: 'graph_patch', args: { graphId, baseRevision: 4, changes: { reason: 'Unknown protocol', patch: { nodes: { b: { inputs: { job: { protocol: 'missing' } } } } } } } },
      { id: 'inspect-revision-2', name: 'graph_inspect', args: { graphId, query: 'revision' } },
      { id: 'inspect-queue-1', name: 'graph_inspect', args: { graphId, query: 'queue' } },
      {
        id: 'patch-pending-work', name: 'graph_patch',
        args: { graphId, baseRevision: 4, changes: { reason: 'Drop accepted work', patch: { nodes: { b: null } }, retire: ['b'] } },
        before: async () => {
          notes.bInstance = (await nodeRun(graphId, 'b')).instance.id;
          notes.bRun = await nodeRun(graphId, 'b');
        },
      },
      {
        id: 'patch-retire', name: 'graph_patch',
        args: { graphId, baseRevision: 4, changes: { reason: 'Retire explicitly after completion', patch: { nodes: { b: null } }, retire: ['b'] } },
        before: async () => {
          await control(graphId, { action: 'resume', nodeId: 'b' });
          await waitFor(async () => receiver.turns().length > 0);
          await waitFor(async () => nodeSettled(graphId, 'b', 1));
          notes.bHistory = (await nodeRun(graphId, 'b')).entries;
        },
      },
      {
        id: 'inspect-b', name: 'graph_inspect', args: { graphId, query: 'summary' },
        before: async () => { notes.bAfter = await nodeRun(graphId, 'b'); },
      },
      {
        id: 'final-inspect', name: 'graph_inspect', args: { graphId, query: 'summary' },
        before: async () => {
          await control(graphId, { action: 'complete' });
          await waitFor(async () => {
            const view = await request(`/api/tasks/${graphId}`);
            return (view.body as { phase?: string }).phase === 'completed';
          });
        },
      },
    ];

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Patch the graph while it works.', requestId: 'graph-patch' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await expect.poll(() => master.results.get('final-inspect'), { timeout: 180_000, interval: 250 }).toBeTruthy();

    // Every step of the plan ran.
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    // The node really was working when the patch landed.
    expect(notes.aRunning).toBe(true);

    // The submission that arrived after the connection was switched off did
    // not travel: the edge has no delivery at all.
    const edgeOne = JSON.parse(master.results.get('inspect-edge-1')!) as { deliveries: unknown[] };
    expect(edgeOne.deliveries).toEqual([]);
    // The other node was never asked: nothing reached it.
    expect(notes.receiverTurns).toBe(0);

    // The delivery that was accepted is still queued for the other node: it
    // has not run yet, and nobody was asked about it.
    const queue = JSON.parse(master.results.get('inspect-queue-1')!) as { items: { nodeId: string; state: string }[] };
    expect(queue.items.filter(item => item.nodeId === 'b')).toMatchObject([{ state: 'queued' }]);

    // The connection that was switched on again carried the next submission.
    const edgeTwo = JSON.parse(master.results.get('inspect-edge-2')!) as { deliveries: { value: { n: number }; receiver: { state: string } }[] };
    expect(edgeTwo.deliveries).toMatchObject([{ value: { n: 7 }, receiver: { state: 'queued' } }]);

    // A patch that is based on a revision that is no longer current changes
    // nothing, and the model is told which revision is the current one.
    expect(master.results.get('patch-stale')).toContain('current revision is 4');

    // The three broken patches are refused and leave the revision alone.
    expect(master.results.get('patch-ambiguous')).toContain('Supply exactly one full definition or local patch');
    expect(master.results.get('patch-not-object')).toContain('Graph patch must be a JSON object');
    expect(master.results.get('patch-unknown-protocol')).toBeTruthy();
    expect(master.results.get('inspect-revision-2')).toBe(master.results.get('inspect-revision'));

    // A patch that would drop a node with work queued for it is refused, and
    // the node keeps its instance.
    expect(master.results.get('patch-pending-work')).toContain('Cannot remove b');
    expect((notes.bAfter as { instance: { id: string } }).instance.id).toBe(notes.bInstance);

    // The accepted work runs once the node is released, and the value that
    // was accepted is the one the node was given.
    expect(receiver.turns()).toHaveLength(1);
    expect(JSON.stringify(receiver.turns()[0])).toContain('\\"n\\":7');

    // Retiring the node afterwards keeps its instance and its history.
    expect(master.results.get('patch-retire')).toContain('"revision":5');
    const bAfter = notes.bAfter as { node: { status: string }; instance: { id: string }; entries: unknown[] };
    expect(bAfter.node.status).toBe('retired');
    expect(bAfter.instance.id).toBe(notes.bInstance);
    expect(bAfter.entries).toEqual(notes.bHistory);

    // The graph settled on the revision the retire published.
    const summary = JSON.parse(master.results.get('final-inspect')!) as { phase: string; revision: number };
    expect(summary.phase).toBe('completed');
    expect(summary.revision).toBe(5);
  } finally {
    sender.release(); receiver.release();
    await daemon?.close(); await master.close(); await sender.close(); await receiver.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
