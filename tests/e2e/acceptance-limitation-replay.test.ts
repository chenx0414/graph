import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';

import {
  ACCEPTED_DEFINITION, CLOSABLE_DEFINITION, type ClosureResult, type LimitationRecord, type MasterCall,
  answeredGraphId, graphIdOf, limitationRows, masterProvider, waitForStep,
} from './acceptance-limitations.fixture.ts';

/**
 * One closure receipt. `records` is how many limitation rows the request wrote:
 * the empty closure writes none, and says so.
 */
interface ClosureReceipt extends ClosureResult { records: number }

/**
 * What a closure receipt is allowed to claim.
 *
 * A closure with an empty limitations list records nothing: there is nothing
 * left to limit, so it writes no row and has nothing to be recognised by. That
 * made a repeat of it answer `replayed: true`, which was a receipt lying about
 * a decision nobody made. The receipt now says what it did - this request wrote
 * no record - while a request that did write records still replays honestly:
 * the same requestId returns the same closure and appends nothing.
 *
 * The proof is a real daemon and real HTTP: both graphs are created and driven
 * through their own tools, the user's waiver goes through the one route that
 * speaks as the user, and every receipt is read as the model received it.
 */
test('an empty closure on a completed graph reports that it wrote nothing, and a recorded request still replays', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-acceptance-replay-'));
  const project = join(root, 'project');
  await mkdir(join(project, 'test'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'test', 'pass.js'), 'console.log("check passed");\n');

  // The plan is rebuilt on every provider request, so a step's arguments can
  // read what the earlier steps already answered.
  let plan: () => MasterCall[] = () => [];
  const master = await masterProvider(() => plan());
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon!.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as any };
  };
  const waive = async (graphId: string, body: Record<string, unknown>) =>
    request(`/api/tasks/${graphId}/graph/acceptance/waive`, { method: 'POST', body: JSON.stringify(body) });
  const waitPhase = async (graphId: string, wanted: string) => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const view = await request(`/api/tasks/${graphId}`);
      if ((view.body as { phase?: string }).phase === wanted) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`the graph never reached the phase ${wanted}`);
  };

  /** What the plan saw while it ran: receipts and the rows on disk beside them. */
  const receipts: Record<string, ClosureReceipt> = {};
  const rowsSeen: Record<string, LimitationRecord[]> = {};
  const rowsAt = (graphId: string, name: string) => { rowsSeen[name] = limitationRows(root, graphId); };

  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { replay: { secretRef: 'GRAPH_REPLAY_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', api: 'openai-completions',
        baseUrl: master.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'replay' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_REPLAY_KEY: 'replay-synthetic' }, extraArgs: ['--execute'] });

    plan = () => {
      const accepted = () => answeredGraphId(master, 'create-accepted');
      const closable = () => answeredGraphId(master, 'create-closable');
      return [
        { id: 'create-accepted', name: 'graph_create', args: { requestId: 'create-accepted', definition: ACCEPTED_DEFINITION } },
        { id: 'run-accepted', name: 'graph_send', args: { graphId: graphIdOf(master.results.get('create-accepted')), nodeId: 'check', input: 'job', value: { marker: 'go' } } },
        {
          id: 'operations-accepted', name: 'graph_inspect', args: { graphId: graphIdOf(master.results.get('create-accepted')), query: 'operations' },
          until: results => (results.get('operations-accepted') ?? '').includes('"passed":true'),
        },
        { id: 'complete-accepted', name: 'graph_control', args: { graphId: graphIdOf(master.results.get('create-accepted')), action: 'complete' } },
        {
          id: 'accepted-blocked', name: 'graph_inspect', args: { graphId: graphIdOf(master.results.get('create-accepted')), query: 'acceptance' },
          before: async () => { await waitPhase(graphIdOf(master.results.get('create-accepted')), 'blocked'); },
        },
        {
          // The user's own waiver: the only debt left is the one only they decide.
          id: 'close-accepted', name: 'graph_control',
          args: { graphId: graphIdOf(master.results.get('create-accepted')), action: 'complete_with_limitations', requestId: 'close-accepted', limitations: [] },
          before: async () => {
            const waived = await waive(accepted(), {
              acceptanceId: 'human', reason: 'The delivered result is what the user asked for',
              evidence: 'user message 2026-10-24 "ship it"', requestId: 'waive-human',
            });
            expect(waived.status, JSON.stringify(waived.body)).toBe(200);
            receipts['waived'] = waived.body as ClosureReceipt;
          },
        },
        { id: 'rows-after-close', name: 'graph_inspect', args: { graphId: graphIdOf(master.results.get('create-accepted')), query: 'limitations' }, before: async () => { rowsAt(accepted(), 'rowsAfterClose'); } },
        {
          // The same closure asked for again: nothing to write, so nothing is
          // written - and it does not claim to be a replay of a record.
          id: 'close-again', name: 'graph_control',
          args: { graphId: graphIdOf(master.results.get('create-accepted')), action: 'complete_with_limitations', requestId: 'close-accepted', limitations: [] },
        },
        { id: 'rows-after-again', name: 'graph_inspect', args: { graphId: graphIdOf(master.results.get('create-accepted')), query: 'limitations' }, before: async () => { rowsAt(accepted(), 'rowsAfterAgain'); } },
        { id: 'summary-accepted', name: 'graph_inspect', args: { graphId: graphIdOf(master.results.get('create-accepted')), query: 'summary' } },
        {
          // The same closure under a fresh requestId: still nothing to write, so
          // still nothing written and still no replay claimed.
          id: 'close-under-new-request', name: 'graph_control',
          args: { graphId: graphIdOf(master.results.get('create-accepted')), action: 'complete_with_limitations', requestId: 'close-accepted-2', limitations: [] },
        },
        { id: 'rows-after-fresh', name: 'graph_inspect', args: { graphId: graphIdOf(master.results.get('create-accepted')), query: 'limitations' }, before: async () => { rowsAt(accepted(), 'rowsAfterFresh'); } },

        // A second graph, where the closure really does record something: the
        // replay there has a row to be recognised by and must still report it.
        { id: 'create-closable', name: 'graph_create', args: { requestId: 'create-closable', definition: CLOSABLE_DEFINITION } },
        {
          id: 'complete-closable', name: 'graph_control',
          args: { graphId: graphIdOf(master.results.get('create-closable')), action: 'complete' },
        },
        {
          id: 'closable-blocked', name: 'graph_inspect', args: { graphId: graphIdOf(master.results.get('create-closable')), query: 'acceptance' },
          before: async () => { await waitPhase(graphIdOf(master.results.get('create-closable')), 'blocked'); },
        },
        {
          id: 'close-closable', name: 'graph_control',
          args: {
            graphId: graphIdOf(master.results.get('create-closable')), action: 'complete_with_limitations', requestId: 'close-closable',
            limitations: [{ acceptanceId: 'unrun', reason: 'The check is out of scope for this iteration', evidence: 'decision #2732: the check is not implemented' }],
          },
          before: async () => {
            const waived = await waive(closable(), {
              acceptanceId: 'human', reason: 'The delivered result is what the user asked for',
              evidence: 'user message 2026-10-24 "ship it"', requestId: 'waive-closable-human',
            });
            expect(waived.status, JSON.stringify(waived.body)).toBe(200);
          },
        },
        {
          id: 'replay-closable', name: 'graph_control',
          args: {
            graphId: graphIdOf(master.results.get('create-closable')), action: 'complete_with_limitations', requestId: 'close-closable',
            limitations: [{ acceptanceId: 'unrun', reason: 'The check is out of scope for this iteration', evidence: 'decision #2732: the check is not implemented' }],
          },
        },
        { id: 'rows-closable', name: 'graph_inspect', args: { graphId: graphIdOf(master.results.get('create-closable')), query: 'limitations' }, before: async () => { rowsAt(closable(), 'rowsClosable'); } },
      ];
    };

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Close both graphs the honest way.', requestId: 'replay-begin' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await waitForStep(master, 'rows-closable', 240_000);

    const acceptedId = answeredGraphId(master, 'create-accepted');
    const closableId = answeredGraphId(master, 'create-closable');

    // Asked again with the same requestId: nothing was written the first time,
    // so there is no record to replay - and the receipt does not invent one.
    const again = JSON.parse(master.results.get('close-again')!) as ClosureReceipt;
    expect(again.replayed).toBe(false);
    expect(again.records).toBe(0);
    expect(again.phase).toBe('completed');

    // Asked under a fresh requestId: the same answer, for the same reason.
    const fresh = JSON.parse(master.results.get('close-under-new-request')!) as ClosureReceipt;
    expect(fresh.replayed).toBe(false);
    expect(fresh.records).toBe(0);
    expect(fresh.phase).toBe('completed');

    // The first closure: the graph had nothing left to limit, so it wrote no
    // record, and its receipt says what it wrote rather than what it replayed.
    const closed = JSON.parse(master.results.get('close-accepted')!) as ClosureReceipt;
    expect(closed.phase).toBe('completed');
    expect(closed.replayed).toBe(false);
    expect(closed.records).toBe(0);
    // The only record it rests on is the user's own waiver.
    expect(closed.limitations.map(record => [record.acceptanceId, record.actor])).toEqual([['human', 'user']]);
    // The waiver itself wrote one record: its receipt counts what it wrote.
    expect(receipts['waived']!.records).toBe(1);
    expect(receipts['waived']!.replayed).toBe(false);

    // Nothing was written by any of the three empty closures, and the graph
    // really is completed rather than merely answering so.
    expect(limitationRows(root, acceptedId).map(record => [record.acceptanceId, record.actor])).toEqual([['human', 'user']]);
    expect((JSON.parse(master.results.get('summary-accepted')!) as { phase: string }).phase).toBe('completed');
    // The rows read while the plan ran agree with the rows read now: no closure
    // appended a second copy of the user's decision.
    expect(rowsSeen['rowsAfterClose']).toHaveLength(1);
    expect(rowsSeen['rowsAfterAgain']).toHaveLength(1);
    expect(rowsSeen['rowsAfterFresh']).toHaveLength(1);

    // The graph whose closure really records something: it wrote one record.
    const recorded = JSON.parse(master.results.get('close-closable')!) as ClosureReceipt;
    expect(recorded.phase).toBe('completed');
    expect(recorded.replayed).toBe(false);
    expect(recorded.records).toBe(1);
    // The same requestId replays: recognised by the row it wrote, no second row.
    const replayed = JSON.parse(master.results.get('replay-closable')!) as ClosureReceipt;
    expect(replayed.phase).toBe('completed');
    expect(replayed.replayed).toBe(true);
    expect(replayed.records).toBe(0);
    expect(replayed.limitations.map(record => record.acceptanceId)).toEqual(recorded.limitations.map(record => record.acceptanceId));
    const closableRows = limitationRows(root, closableId);
    expect(closableRows.map((record: LimitationRecord) => record.acceptanceId)).toEqual(['human', 'unrun']);
    expect(closableRows.find((record: LimitationRecord) => record.acceptanceId === 'unrun')!.requestId).toBe('close-closable');
    expect(rowsSeen['rowsClosable']).toHaveLength(2);
  } finally {
    await daemon?.close(); await master.close();
    await rm(root, { recursive: true, force: true });
  }
}, 420_000);
